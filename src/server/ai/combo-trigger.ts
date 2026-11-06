import { money } from "@/lib/salon/format";

/**
 * Módulo SALON — detección de la palabra clave de un combo en el mensaje del
 * cliente (el texto que Meta/TikTok precargan al abrir el chat desde un anuncio).
 *
 * Puro: sin base de datos ni red, para poder probarlo con tablas de casos.
 */

/** Lo mínimo de un combo que necesita el detector. */
export interface TriggerCombo {
  name: string;
  description: string;
  priceCents: number;
  /** Normalizada al guardar (`COMBO_FRESH`); nula si el combo no tiene. */
  keywordTrigger: string | null;
}

/**
 * Deja un texto en una forma comparable: sin acentos, en mayúsculas y con
 * espacios, guiones y guiones bajos tratados como el mismo separador. Así
 * `COMBO_FRESH` coincide con «quiero el combo fresh» y con «Combo-Fresh».
 */
function comparable(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * Devuelve el combo cuya palabra clave aparece en el mensaje, o `null`.
 * Insensible a mayúsculas, acentos y separadores, y por PALABRA COMPLETA:
 * «COMBO_FRESH» no se dispara con «combofreshisimo». Si coinciden varias, gana
 * la más larga (la más específica: «COMBO_FRESH_VIP» antes que «COMBO_FRESH»).
 */
export function detectComboTrigger<T extends TriggerCombo>(
  messageText: string | null | undefined,
  combos: readonly T[]
): T | null {
  if (!messageText) return null;
  const haystack = ` ${comparable(messageText)} `;
  if (haystack.trim() === "") return null;

  let best: { combo: T; length: number } | null = null;
  for (const c of combos) {
    if (!c.keywordTrigger) continue;
    const needle = comparable(c.keywordTrigger);
    if (needle === "" || !haystack.includes(` ${needle} `)) continue;
    if (!best || needle.length > best.length) best = { combo: c, length: needle.length };
  }
  return best?.combo ?? null;
}

/**
 * La instrucción del turno. Va como mensaje de sistema DESPUÉS del historial,
 * donde el modelo la lee con más peso que el prompt base. Los datos del combo
 * (nombre, descripción) los escribió el dueño del negocio; aun así se citan como
 * datos, no como órdenes, y el precio sale formateado en la moneda del negocio.
 */
export function buildComboTriggerInstruction(combo: TriggerCombo, currency: string): string {
  // La descripción es opcional: sin ella se salta ese paso (y no se inventa qué incluye).
  const steps = [
    "Salúdalo reconociendo que vio la promoción.",
    ...(combo.description.trim() ? [`Dile qué incluye: ${combo.description}`] : []),
    `Dile el precio especial: ${money(combo.priceCents, currency)}.`,
    "Cierra invitándolo a agendar y pregúntale qué día y hora le conviene.",
  ];
  return [
    "INSTRUCCIÓN PRIORITARIA PARA ESTE TURNO — el cliente llegó por una promoción activa.",
    `Su mensaje contiene la palabra clave de la oferta «${combo.name}». Respóndele con {"action":"reply"}:`,
    ...steps.map((t, i) => `${i + 1}. ${t}`),
    "Usa exactamente esos datos; no inventes beneficios ni precios distintos.",
  ].join("\n");
}
