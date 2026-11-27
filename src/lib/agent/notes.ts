/**
 * Mejora 2 — Las notas automáticas `[IA] …` que el agente deja en el contacto con `update_lead`. Pura.
 *
 * Antes cada turno añadía una línea sin límite: el modelo repetía la misma nota («Interesado en el corte»)
 * turno tras turno y las notas del contacto crecían sin fin. Ahora:
 *  - una nota igual a una `[IA]` que ya existe (sin distinguir mayúsculas ni espacios) no se repite;
 *  - se conservan solo las `AI_NOTES_MAX` notas `[IA]` más recientes (las escritas por personas no se tocan);
 *  - cada nota se acota a `AI_NOTE_MAX_CHARS`.
 */

export const AI_NOTE_PREFIX = "[IA] ";
export const AI_NOTES_MAX = 10;
export const AI_NOTE_MAX_CHARS = 300;

const normalizar = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Devuelve las notas nuevas, o `null` si no cambia nada (nota vacía o repetida). */
export function appendAiNote(notes: string | null | undefined, note: string): string | null {
  let limpia = note.replace(/\s+/g, " ").trim();
  if (!limpia) return null;
  if (limpia.length > AI_NOTE_MAX_CHARS) limpia = `${limpia.slice(0, AI_NOTE_MAX_CHARS - 1)}…`;

  const lineas = (notes ?? "").split("\n").filter((l) => l.trim() !== "");
  const esIa = (l: string) => l.startsWith(AI_NOTE_PREFIX);
  if (lineas.some((l) => esIa(l) && normalizar(l.slice(AI_NOTE_PREFIX.length)) === normalizar(limpia))) {
    return null;
  }

  lineas.push(`${AI_NOTE_PREFIX}${limpia}`);
  // Sobran notas de la IA: se quitan las más viejas, dejando intactas las de las personas y su orden.
  let sobran = lineas.filter(esIa).length - AI_NOTES_MAX;
  const resultado = lineas.filter((l) => {
    if (sobran > 0 && esIa(l)) {
      sobran -= 1;
      return false;
    }
    return true;
  });
  return resultado.join("\n");
}
