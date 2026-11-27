/**
 * Mejora 5 — El presupuesto del conocimiento del agente. Puro y compartido (servidor y pantalla).
 *
 * El conocimiento entra COMPLETO en el system prompt de cada turno: sin tope, cada entrada nueva encarecía todos
 * los turnos y, pasado el contexto del modelo, el proveedor rechazaba la llamada y CADA mensaje terminaba en
 * traspaso por «error». Ahora:
 *  - guardar una entrada que deje el conocimiento por encima de `KB_MAX_CHARS` (o de `KB_MAX_ENTRIES`) se rechaza
 *    con un mensaje claro (422 `kb_limit`);
 *  - al armar el prompt, lo que pase de `KB_MAX_CHARS` (un conocimiento guardado antes del tope) se RECORTA entero
 *    por entradas, con una nota al modelo para que no invente lo que quedó fuera.
 */

/** Aviso en pantalla: ya pesa en cada turno (≈6k tokens). */
export const KB_WARN_CHARS = 24_000;
/** Tope duro al guardar y presupuesto del prompt (≈10k tokens). */
export const KB_MAX_CHARS = 40_000;
export const KB_MAX_ENTRIES = 300;

export type KbEntryLike = {
  kind: string;
  question: string | null;
  answer: string | null;
  content: string | null;
};

const SEPARADOR = "\n\n";

/** El texto de UNA entrada, tal como va al prompt («P: …\nR: …» o el bloque). */
export function renderKbEntry(e: KbEntryLike): string {
  return e.kind === "qa" ? `P: ${e.question ?? ""}\nR: ${e.answer ?? ""}` : (e.content ?? "");
}

/** El conocimiento completo, sin tope (lo que mide la pantalla y lo que lee el juez del Laboratorio). */
export function renderKbText(entries: readonly KbEntryLike[]): string {
  if (entries.length === 0) return "(knowledge base vacío)";
  return entries.map(renderKbEntry).filter(Boolean).join(SEPARADOR);
}

/** Caracteres que ocupa el conocimiento en el prompt. */
export function kbChars(entries: readonly KbEntryLike[]): number {
  return entries.length === 0 ? 0 : renderKbText(entries).length;
}

/** Nota para el modelo cuando el conocimiento no cupo entero. */
export function kbTruncationNote(omitidas: number): string {
  return `(Aviso del sistema: ${omitidas} entrada(s) del conocimiento no cupieron en este turno. Si el cliente pregunta algo que no está arriba, no lo inventes: ofrece confirmarlo con el equipo.)`;
}

/**
 * El conocimiento para el prompt, acotado a `budget`. Entra por entradas COMPLETAS en su orden (las primeras que
 * el dueño cargó); nunca corta una respuesta a la mitad, que es peor que no tenerla.
 */
export function renderKbForPrompt(
  entries: readonly KbEntryLike[],
  budget = KB_MAX_CHARS
): { text: string; omitted: number; chars: number } {
  if (entries.length === 0) return { text: "(knowledge base vacío)", omitted: 0, chars: 0 };
  const partes: string[] = [];
  let usados = 0;
  let omitidas = 0;
  for (const e of entries) {
    const t = renderKbEntry(e);
    if (!t) continue;
    const costo = t.length + (partes.length ? SEPARADOR.length : 0);
    if (usados + costo > budget) {
      omitidas += 1;
      continue;
    }
    partes.push(t);
    usados += costo;
  }
  const cuerpo = partes.join(SEPARADOR) || "(knowledge base vacío)";
  return {
    text: omitidas > 0 ? `${cuerpo}${SEPARADOR}${kbTruncationNote(omitidas)}` : cuerpo,
    omitted: omitidas,
    chars: usados,
  };
}

/**
 * ¿Cabe este cambio? `entries` es el conocimiento como quedaría DESPUÉS de guardar. Devuelve el mensaje para el
 * dueño, o `null` si cabe.
 */
export function kbLimitError(entries: readonly KbEntryLike[]): string | null {
  if (entries.length > KB_MAX_ENTRIES) {
    return `El conocimiento admite hasta ${KB_MAX_ENTRIES} entradas. Une o borra algunas antes de agregar más.`;
  }
  const chars = kbChars(entries);
  if (chars > KB_MAX_CHARS) {
    return `El conocimiento quedaría en ${chars.toLocaleString("es-MX")} caracteres y el máximo es ${KB_MAX_CHARS.toLocaleString("es-MX")}: el agente lo lee entero en cada mensaje. Acorta o borra entradas antes de agregar más.`;
  }
  return null;
}
