/**
 * Módulo SALON — reglas de los campos de un profesional, compartidas por el
 * formulario (que las aplica mientras se escribe) y la API (que las hace valer).
 */

/** Celular peruano: exactamente 9 dígitos, con el prefijo +51 fijo. */
export const STAFF_PHONE_DIGITS = 9;
const STAFF_PHONE_PREFIX = "+51";

/** Un nombre de persona: solo letras (con tildes y ñ) y espacios. */
const NAME_ALLOWED = /^[\p{L}\p{M} ]+$/u;
const NAME_FORBIDDEN = /[^\p{L}\p{M} ]/gu;

export function isPersonName(text: string): boolean {
  return NAME_ALLOWED.test(text);
}

/**
 * Lo que queda de lo escrito o pegado en el campo Nombre: se quita todo lo que no
 * sea letra o espacio (números, signos, símbolos), así no se puede teclear.
 */
export function sanitizePersonName(raw: string): string {
  return raw.replace(NAME_FORBIDDEN, "");
}

/** Espacios de los extremos fuera y uno solo entre palabras. */
export function tidyPersonName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Los 9 dígitos de un celular guardado, sea cual sea la forma en que se escribió
 * antes (`+51 987 654 321`, `987-654-321`, `51987654321`). Un valor que no cabe
 * en 9 dígitos se devuelve tal cual (solo dígitos) para que el formulario lo
 * muestre y la validación pida corregirlo, en vez de borrarlo en silencio.
 */
export function phoneToDigits(stored: string | null | undefined): string {
  const digits = (stored ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("51")) return digits.slice(2);
  return digits.slice(0, 15);
}

/**
 * El celular tal como se guarda: `+51` y los 9 dígitos, sin espacios. Acepta lo
 * que mande un cliente de la API: 9 dígitos, o `+51` seguido de 9 dígitos
 * (espacios y guiones se ignoran). `null` si no es un celular de 9 dígitos.
 */
export function normalizeStaffPhone(raw: string): string | null {
  const compact = raw.replace(/[\s-]/g, "");
  const m = /^(?:\+51)?(\d{9})$/.exec(compact);
  return m ? `${STAFF_PHONE_PREFIX}${m[1]}` : null;
}

/** `+51987654321` → `+51 987 654 321`, para mostrarlo. */
export function formatStaffPhone(stored: string | null | undefined): string {
  if (!stored) return "";
  const digits = phoneToDigits(stored);
  if (digits.length !== STAFF_PHONE_DIGITS) return stored;
  return `${STAFF_PHONE_PREFIX} ${digits.replace(/(\d{3})(?=\d)/g, "$1 ")}`;
}

/** Cómo se llama, en pantallas y reportes, una venta sin profesional (un negocio sin equipo): todo es del negocio. */
export const NO_STAFF_LABEL = "Sin asignar";
