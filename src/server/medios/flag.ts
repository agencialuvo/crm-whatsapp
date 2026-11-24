/**
 * Medios — la bandera de plataforma `MEDIA_VIDEO_OPTIMIZE` (apagada por defecto).
 *
 * Apagada: la biblioteca admite video MP4 de hasta 16 MB, como siempre. Encendida: admite MP4 y MOV (QuickTime) de hasta
 * 250 MB y los optimiza en segundo plano a una variante apta para WhatsApp (< 16 MB, 720p, H.264 + AAC + faststart).
 * Mientras no haya variante, un original de más de 16 MB (y todo MOV) NO se puede enviar por WhatsApp: el envío sigue
 * exigiendo ≤ 16 MB.
 *
 * Encendida pero SIN `ffmpeg`/`ffprobe` utilizables (lo comprueba el arranque, `optimizar/binarios.ts`), la bandera queda
 * «efectivamente apagada» con un aviso en el log: aceptar videos de 250 MB que luego fallarían todos sería peor que no
 * aceptarlos. Mientras el arranque no haya comprobado nada (pruebas, o antes del primer chequeo) manda la variable sola.
 *
 * Se lee de `process.env` directo (mismo trato que `AUTOMATIONS`): preguntar si algo existe no puede depender de que TODO el
 * entorno valide. Ej.: MEDIA_VIDEO_OPTIMIZE=on
 */

const ON_VALUES = new Set(["on", "1", "true", "si", "sí", "yes"]);

export function parseVideoOptimizeFlag(raw: string | undefined): boolean {
  return ON_VALUES.has((raw ?? "").trim().toLowerCase());
}

/** Lo que el arranque averiguó de `ffmpeg`: `ok` = utilizable; `null` = aún no se comprobó. */
export type EstadoFfmpeg = {
  ok: boolean;
  /** Por qué no sirve (para el aviso del log). */
  motivo?: string;
  /** El filtro `zscale` (para convertir HDR a SDR con tone-mapping) está disponible. */
  zscale?: boolean;
};

const g = globalThis as unknown as { __voceroEstadoFfmpeg?: EstadoFfmpeg | null };

export function estadoFfmpeg(): EstadoFfmpeg | null {
  return g.__voceroEstadoFfmpeg ?? null;
}

export function fijarEstadoFfmpeg(estado: EstadoFfmpeg | null): void {
  g.__voceroEstadoFfmpeg = estado;
}

/** ¿Esta instancia admite video grande (MP4 y MOV hasta 250 MB)? La variable encendida Y, si ya se comprobó, ffmpeg utilizable. */
export function videoOptimizeEnabled(): boolean {
  if (!parseVideoOptimizeFlag(process.env.MEDIA_VIDEO_OPTIMIZE)) return false;
  return estadoFfmpeg()?.ok !== false;
}

/** ¿Un video recién confirmado se encola para optimizarse? Exige la bandera Y haber COMPROBADO que ffmpeg funciona. */
export function colaDeOptimizacionActiva(): boolean {
  return parseVideoOptimizeFlag(process.env.MEDIA_VIDEO_OPTIMIZE) && estadoFfmpeg()?.ok === true;
}
