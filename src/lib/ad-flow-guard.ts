/**
 * Bloque 2 — Validación DETERMINISTA de salida para un flujo de anuncio EXCLUSIVO. Pura.
 *
 * El modo exclusivo vivía solo en la directiva del prompt («no ofrezcas ni cotices otro servicio»): el modelo
 * la cumple casi siempre, pero no siempre, y un anuncio exclusivo es una promesa del negocio (paga ese anuncio
 * para vender ESE servicio). Esto revisa el texto que va a salir:
 *
 *  - VIOLACIÓN `cotiza_otro`: nombra otro servicio u oferta del catálogo Y el mensaje trae un precio. La
 *    directiva permite decir en una frase que «aquí te ayudo con X» aunque el cliente pregunte por otro, pero
 *    nunca darle datos ni precios del otro.
 *  - VIOLACIÓN `ofrece_otro`: nombra otro servicio u oferta que el CLIENTE NO mencionó (lo ofrece por
 *    iniciativa propia).
 *  - No es violación nombrar el otro servicio que el cliente preguntó, sin precio, para redirigirlo.
 *
 * Conservador a propósito: compara nombres COMPLETOS del catálogo (sin tildes, palabra completa), ignora los
 * nombres de menos de 4 letras y los que forman parte del nombre del objetivo («Corte» cuando el anuncio es
 * «Corte + barba»). Lo que no ve (un sinónimo, una paráfrasis) lo sigue cubriendo la directiva del prompt.
 */

export type FugaExclusiva =
  | { violacion: false }
  | { violacion: true; motivo: "cotiza_otro" | "ofrece_otro"; nombres: string[] };

const normalizar = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function menciona(texto: string, nombre: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapar(nombre)}($|[^a-z0-9])`).test(texto);
}

/** Un precio escrito: «S/ 25», «$300», «25 soles», «120 pesos», «25.00». */
const PRECIO = /(s\/\.?\s*\d|\$\s*\d|\d+\s*(soles|sol|pesos|usd|dolares|euros|€)\b|\b\d+[.,]\d{2}\b)/;

export function detectarFugaExclusiva(input: {
  /** El texto que el agente va a enviar. */
  texto: string;
  /** Nombre del servicio u oferta del anuncio. */
  objetivo: string;
  /** Los demás servicios y ofertas activos del negocio. */
  rivales: readonly string[];
  /** Lo que escribió el cliente en este turno (para distinguir «preguntó por» de «se lo ofrecí»). */
  ultimoDelCliente: string | null;
}): FugaExclusiva {
  const texto = normalizar(input.texto);
  if (!texto) return { violacion: false };
  const objetivo = normalizar(input.objetivo);
  const cliente = normalizar(input.ultimoDelCliente ?? "");

  const nombrados = [
    ...new Set(
      input.rivales
        .map(normalizar)
        .filter((r) => r.length >= 4 && !objetivo.includes(r) && !r.includes(objetivo))
        .filter((r) => menciona(texto, r))
    ),
  ];
  if (nombrados.length === 0) return { violacion: false };

  // El precio cuenta si va en la MISMA oración que el otro servicio: «el tinte no lo vemos aquí; el corte
  // cuesta S/ 25» da el precio del objetivo, no del otro.
  const oraciones = texto.split(/(?<=[.!?;\n])\s+|\s+(?:y|pero|mientras que)\s+(?=el |la |los |las |nuestro |nuestra )/);
  const cotizados = nombrados.filter((r) => oraciones.some((o) => menciona(o, r) && PRECIO.test(o)));
  if (cotizados.length > 0) return { violacion: true, motivo: "cotiza_otro", nombres: cotizados };
  const ofrecidos = nombrados.filter((r) => !menciona(cliente, r));
  if (ofrecidos.length > 0) return { violacion: true, motivo: "ofrece_otro", nombres: ofrecidos };
  return { violacion: false };
}

/** Lo que el sistema le dice al modelo en el reintento. */
export function correccionExclusiva(objetivo: string, fuga: Extract<FugaExclusiva, { violacion: true }>): string {
  const que = fuga.nombres.map((n) => `«${n}»`).join(", ");
  return fuga.motivo === "cotiza_otro"
    ? `CORRECCIÓN DEL SISTEMA: tu respuesta dio precio o datos de ${que}, y esta conversación es EXCLUSIVA de «${objetivo}». Reescribe tu respuesta sin precios ni datos de otros servicios u ofertas: di en una frase que aquí lo ayudas con «${objetivo}» e invítalo a agendar. Responde con el mismo formato JSON.`
    : `CORRECCIÓN DEL SISTEMA: tu respuesta ofreció ${que}, y esta conversación es EXCLUSIVA de «${objetivo}». Reescribe tu respuesta hablando solo de «${objetivo}» e invitando a agendar. Responde con el mismo formato JSON.`;
}

/** Si el reintento también falla: una respuesta segura y fija, centrada en el objetivo. */
export function respuestaSeguraExclusiva(objetivo: string, precio: string | null): string {
  return `Por aquí te ayudo con «${objetivo}»${precio ? ` (${precio})` : ""}. ¿Quieres que lo agendemos?`;
}
