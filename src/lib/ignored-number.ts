import type { Channel } from "@/lib/channels";
import { normalizeRecipient } from "@/lib/phone-normalize";

/**
 * Números que el agente de IA ignora — la parte PURA (sin base de datos): cómo se escribe un número, cómo se
 * convierte en la llave con la que se compara y cómo se lee una lista pegada.
 *
 * La llave tiene que salir IGUAL de lo que escribe el dueño («+51 987-654-321», «0051987654321») y de lo que
 * guarda el contacto (`contact.phone` / `wa_identity`, que ya vienen canonizados por la ingesta). Por eso las dos
 * puntas pasan por `normalizeRecipient`, la misma regla que usa el envío: México (521→52) y Argentina (549→54).
 */

/** Tope de entradas por organización. */
export const IGNORED_LIMIT = 500;
/** Largo máximo de la nota (lo garantiza también un CHECK en la tabla). */
export const IGNORED_LABEL_MAX = 80;
/** Un número internacional (E.164) tiene entre 8 y 15 dígitos, código de país incluido. */
export const MIN_DIGITS = 8;
export const MAX_DIGITS = 15;

export const NEEDS_COUNTRY_CODE = "Incluye el código de país, por ejemplo +51…";

export type KeyResult = { ok: true; key: string } | { ok: false; error: string };

const fail = (error: string): KeyResult => ({ ok: false, error });

/**
 * La llave de un número que ESCRIBE una persona.
 *
 * Sin «+» ni «00» al inicio no hay forma de saber cuál es el código de país, y un número de 10 dígitos o menos
 * (el «nacional» de casi todos los países) es justo el caso ambiguo: se rechaza con el aviso. Con «+» o «00» se
 * acepta cualquier largo válido. Un código de país jamás empieza en 0, así que «0987…» tampoco sirve.
 */
export function ignoreKeyOf(input: string): KeyResult {
  const raw = input.trim();
  if (!raw) return fail("Escribe un número.");

  let digits = raw.replace(/[\s\-().]/g, "");
  let explicit = false;
  if (digits.startsWith("+")) {
    explicit = true;
    digits = digits.slice(1);
  } else if (digits.startsWith("00")) {
    explicit = true;
    digits = digits.slice(2);
  }
  if (!/^\d+$/.test(digits)) {
    return fail("Solo puede llevar dígitos, espacios, guiones, paréntesis y un «+» al inicio.");
  }
  if (digits.startsWith("0") || (!explicit && digits.length <= 10)) return fail(NEEDS_COUNTRY_CODE);
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
    return fail(`Un número internacional tiene entre ${MIN_DIGITS} y ${MAX_DIGITS} dígitos; este tiene ${digits.length}.`);
  }
  return { ok: true, key: normalizeRecipient(digits) };
}

/**
 * La llave de un teléfono que YA guardó el sistema (contacto): sin exigir país ni largo, porque no lo escribió una
 * persona. `null` si no queda ningún dígito.
 */
export function phoneKeyOf(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits ? normalizeRecipient(digits) : null;
}

/** Lo que hace falta de un contacto para saber si está ignorado. */
export type ContactIdentity = {
  channel: Channel;
  waIdentity: string;
  phone?: string | null;
  waUserId?: string | null;
};

const BSUID_PREFIX = "bsuid:";

/**
 * Todas las llaves bajo las que puede estar ignorado un contacto, la principal primero.
 *
 * WhatsApp: el teléfono y el BSUID son la MISMA persona (la ingesta ya los reconcilia), así que se ignora por
 * cualquiera de los dos: quien se ignoró por su teléfono sigue ignorado el día que Meta lo mande con BSUID. Los demás
 * canales no tienen teléfono: su identidad cruda (`ig:…`, `fb:…`, `tt:…`) ES la llave.
 */
export function ignoreKeysOfContact(c: ContactIdentity): string[] {
  const keys: string[] = [];
  const add = (k: string | null | undefined) => {
    if (k && !keys.includes(k)) keys.push(k);
  };
  const identity = (c.waIdentity ?? "").trim();
  if (c.channel === "whatsapp") {
    add(phoneKeyOf(c.phone));
    if (identity.startsWith(BSUID_PREFIX)) add(identity);
    else add(phoneKeyOf(identity));
    if (c.waUserId) add(`${BSUID_PREFIX}${c.waUserId}`);
  } else {
    add(identity);
  }
  return keys;
}

/** La llave con la que se GUARDA un contacto ignorado desde la Bandeja. `null` si no tiene ninguna. */
export function primaryIgnoreKey(c: ContactIdentity): string | null {
  return ignoreKeysOfContact(c)[0] ?? null;
}

/** La nota, recortada. `null` si queda vacía; error si pasa del máximo. */
export function cleanLabel(label: string | null | undefined): { ok: true; label: string | null } | { ok: false; error: string } {
  const t = (label ?? "").trim();
  if (!t) return { ok: true, label: null };
  if (t.length > IGNORED_LABEL_MAX) {
    return { ok: false, error: `La nota admite hasta ${IGNORED_LABEL_MAX} caracteres; esta tiene ${t.length}.` };
  }
  return { ok: true, label: t };
}

export type ParsedIgnoredEntry = { line: number; key: string; label: string | null };
export type InvalidIgnoredLine = { line: number; text: string; reason: string };
export type ParsedIgnored = { valid: ParsedIgnoredEntry[]; invalid: InvalidIgnoredLine[] };

/** Entre el número y la nota: coma, punto y coma, barra vertical o tabulador. */
const NOTE_SEPARATOR = /[,;|\t]/;

/**
 * Lee una lista pegada: un número por línea, con una nota opcional.
 *
 *   +51 987 654 321
 *   +51 987 654 321, Mamá
 *   +52 55 1234 5678 - Proveedor de harina
 *
 * Las líneas vacías se saltan. Cada línea inválida vuelve con su número de línea y el motivo (la lista no se
 * descarta entera por una línea mala). Un número repetido dentro del texto se reporta en su segunda aparición.
 * Una nota que empieza con dígitos tiene que ir tras una coma, punto y coma o barra: sin ella se confundiría con
 * el número.
 */
export function parseIgnoredInput(rawText: string): ParsedIgnored {
  const valid: ParsedIgnoredEntry[] = [];
  const invalid: InvalidIgnoredLine[] = [];
  const seen = new Map<string, number>();

  rawText.split(/\r?\n/).forEach((original, index) => {
    const line = index + 1;
    const text = original.trim();
    if (!text) return;
    const bad = (reason: string) => invalid.push({ line, text, reason });

    let numberPart: string;
    let notePart: string;
    const sep = text.search(NOTE_SEPARATOR);
    if (sep >= 0) {
      numberPart = text.slice(0, sep);
      notePart = text.slice(sep + 1);
    } else {
      const m = text.match(/^(\+?\d[\d\s().-]*)(.*)$/);
      if (!m) return bad("No parece un número de teléfono.");
      numberPart = m[1]!;
      notePart = m[2]!;
      // Letras pegadas al número («+51987654321abc») no son una nota: es un número mal escrito.
      if (notePart && !/\s$/.test(numberPart) && !/^[\s:–—]/.test(notePart)) {
        return bad("Solo puede llevar dígitos, espacios, guiones, paréntesis y un «+» al inicio.");
      }
      notePart = notePart.replace(/^[\s:–—-]+/, "");
    }

    const key = ignoreKeyOf(numberPart);
    if (!key.ok) return bad(key.error);
    const label = cleanLabel(notePart);
    if (!label.ok) return bad(label.error);

    const first = seen.get(key.key);
    if (first !== undefined) return bad(`Repetido: ya está en la línea ${first}.`);
    seen.set(key.key, line);
    valid.push({ line, key: key.key, label: label.label });
  });

  return { valid, invalid };
}
