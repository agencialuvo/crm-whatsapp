/**
 * Hallazgo J — reglas puras del reintento proactivo de adjuntos ENTRANTES que quedaron `pending` o `failed`
 * (R2 caído al llegar el webhook, reinicio a media descarga, error transitorio de Meta…). Sin base ni red.
 *
 * Meta conserva un adjunto ~30 días: se reintenta mientras el adjunto tenga menos de `REINTENTO_VENTANA_DIAS` (28, con
 * margen), con espera creciente entre intentos, y se deja de intentar cuando Meta dice que ya no existe (`gone`) o se
 * agotan los intentos. El número de intento y el estado «permanente» viajan en `media_asset.fetch_error` (columna de
 * texto que nadie más lee) para no necesitar una migración: `[intento 3] mensaje` o `[gone] mensaje`.
 */

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

/** Meta borra el adjunto a los ~30 días; se deja de intentar a los 28. */
export const REINTENTO_VENTANA_DIAS = 28;
/** Con la espera máxima de 12 h son ~19 días de intentos: de sobra para una caída larga, y no es un bucle infinito. */
export const MAX_INTENTOS = 40;
/** Espera tras el primer fallo; se duplica en cada intento hasta `MAX_ESPERA_MS`. */
export const BASE_ESPERA_MS = 15 * MIN;
export const MAX_ESPERA_MS = 12 * HORA;
/** Un `pending` más reciente que esto aún lo está bajando la descarga normal del webhook: no se toca. */
export const PENDIENTE_MIN_EDAD_MS = 10 * MIN;

export type EstadoDeDescarga = { intentos: number; gone: boolean; mensaje: string };

const MARCA = /^\[(?:(gone)|intento (\d+))\] ?/;

/** Lee lo que dejó la última falla. Un texto antiguo, sin marca, cuenta como 0 intentos registrados. */
export function leerFetchError(raw: string | null | undefined): EstadoDeDescarga {
  const texto = raw ?? "";
  const m = MARCA.exec(texto);
  if (!m) return { intentos: 0, gone: false, mensaje: texto };
  return { intentos: m[1] ? 0 : Number(m[2]), gone: m[1] === "gone", mensaje: texto.slice(m[0].length) };
}

/** Lo que se guarda en `fetch_error` tras una falla. `gone` = Meta ya no tiene el archivo: no se reintenta jamás. */
export function escribirFetchError(e: EstadoDeDescarga): string {
  const mensaje = e.mensaje.slice(0, 300);
  return e.gone ? `[gone] ${mensaje}` : `[intento ${e.intentos}] ${mensaje}`;
}

/** Cuánto esperar antes del siguiente intento, habiendo fallado `intentos` veces: 15 min, 30, 1 h, 2 h… tope 12 h. */
export function esperaTrasIntentos(intentos: number): number {
  if (intentos <= 0) return 0;
  return Math.min(BASE_ESPERA_MS * 2 ** (intentos - 1), MAX_ESPERA_MS);
}

export type AdjuntoParaReintento = {
  kind: string;
  fetchStatus: "available" | "pending" | "failed";
  waMediaId: string | null;
  libraryItemId: string | null;
  fetchError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DecisionDeReintento = { reintentar: true } | { reintentar: false; motivo: "disponible" | "sin_binario" | "vencido" | "permanente" | "agotado" | "reciente" | "en_espera" };

/** ¿Toca reintentar la descarga de este adjunto ahora? */
export function decidirReintento(a: AdjuntoParaReintento, now: Date): DecisionDeReintento {
  if (a.fetchStatus === "available") return { reintentar: false, motivo: "disponible" };
  if (!a.waMediaId || a.libraryItemId || a.kind === "location" || a.kind === "contacts") return { reintentar: false, motivo: "sin_binario" };
  if (now.getTime() - a.createdAt.getTime() >= REINTENTO_VENTANA_DIAS * DIA) return { reintentar: false, motivo: "vencido" };
  const estado = leerFetchError(a.fetchError);
  if (estado.gone) return { reintentar: false, motivo: "permanente" };
  if (estado.intentos >= MAX_INTENTOS) return { reintentar: false, motivo: "agotado" };
  const desdeUltimo = now.getTime() - a.updatedAt.getTime();
  if (a.fetchStatus === "pending") {
    return desdeUltimo < PENDIENTE_MIN_EDAD_MS ? { reintentar: false, motivo: "reciente" } : { reintentar: true };
  }
  return desdeUltimo < esperaTrasIntentos(estado.intentos) ? { reintentar: false, motivo: "en_espera" } : { reintentar: true };
}
