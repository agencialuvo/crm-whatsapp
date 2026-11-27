/**
 * Mejora 10 — Cómo ve el modelo cada mensaje del historial. Pura.
 *
 * Antes se descartaba todo mensaje sin texto: si el cliente mandaba solo una nota de voz o una foto, el modelo
 * veía una conversación que terminaba en su propia respuesta y se callaba o repetía lo anterior. Ahora cada
 * adjunto llega como un marcador entre corchetes, con su pie de foto si lo tiene, y el prompt le dice al agente
 * qué hacer con ellos (`MEDIA_GUIDELINES`).
 */

export type MensajeHistorial = {
  direction: "in" | "out";
  type: string;
  text: string | null;
  /** El pie de foto del adjunto (`media_asset.caption`), si lo hay. */
  caption?: string | null;
};

const QUE_ES: Record<string, string> = {
  audio: "una nota de voz o audio",
  voice: "una nota de voz",
  image: "una imagen",
  video: "un video",
  document: "un documento",
  sticker: "un sticker",
  location: "una ubicación",
  contacts: "una tarjeta de contacto",
  reaction: "una reacción",
};

const limpiar = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** El pie de foto lo escribe el cliente: una línea, sin comillas que cierren la cita y acotado. */
const citar = (s: string) => {
  const t = limpiar(s).replace(/["“”]/g, "'");
  return t.length > 500 ? `${t.slice(0, 500)}…` : t;
};

/** El contenido para el modelo, o `null` si no hay nada que mostrar (un saliente vacío). */
export function textoParaModelo(m: MensajeHistorial): string | null {
  const texto = limpiar(m.text);
  if (m.type === "text" || !m.type) return texto || null;

  const que = QUE_ES[m.type] ?? "un archivo o mensaje que no es texto";
  const adjunto = limpiar(m.caption) || (m.type !== "text" ? texto : "");
  if (m.direction === "in") {
    return adjunto
      ? `[El cliente envió ${que} con este texto: "${citar(adjunto)}"]`
      : `[El cliente envió ${que} sin texto]`;
  }
  return adjunto ? `[Se le envió al cliente ${que}: "${citar(adjunto)}"]` : `[Se le envió al cliente ${que}]`;
}

/** Directrices del system prompt para los marcadores de adjuntos. */
export const MEDIA_GUIDELINES = [
  "- Los mensajes entre corchetes como «[El cliente envió una nota de voz o audio sin texto]» o «[El cliente envió una imagen con este texto: …]» son adjuntos que NO puedes ver ni escuchar. Nunca finjas que los entendiste ni inventes lo que dicen.",
  "- Si es una nota de voz o un audio: pide con amabilidad y en una frase que te lo escriba («No puedo escuchar audios por aquí, ¿me lo escribes, por favor?»), y si ya habías pedido algo, recuérdalo en la misma frase.",
  "- Si es una imagen, video o documento con texto: responde usando ese texto. Sin texto: pregunta brevemente qué necesita sobre lo que envió.",
  "- Si el adjunto parece un comprobante de pago, una receta, una queja con evidencia o algo que alguien del equipo debe revisar → handoff con una despedida breve.",
  "- Tú nunca escribes esos corchetes: responde solo con texto normal.",
].join("\n");
