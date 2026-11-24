/**
 * Medios — la bandera de plataforma `MEDIA_VIDEO_OPTIMIZE` (apagada por defecto).
 *
 * Apagada: la biblioteca admite video MP4 de hasta 16 MB, como siempre. Encendida: admite MP4 y MOV (QuickTime) de hasta
 * 250 MB para optimizarlos después a una variante apta para WhatsApp. Mientras no haya variante, un original de más de
 * 16 MB (y todo MOV) NO se puede enviar por WhatsApp: el envío sigue exigiendo ≤ 16 MB.
 *
 * Se lee de `process.env` directo (mismo trato que `AUTOMATIONS`): preguntar si algo existe no puede depender de que TODO el
 * entorno valide. Ej.: MEDIA_VIDEO_OPTIMIZE=on
 */

const ON_VALUES = new Set(["on", "1", "true", "si", "sí", "yes"]);

export function parseVideoOptimizeFlag(raw: string | undefined): boolean {
  return ON_VALUES.has((raw ?? "").trim().toLowerCase());
}

export function videoOptimizeEnabled(): boolean {
  return parseVideoOptimizeFlag(process.env.MEDIA_VIDEO_OPTIMIZE);
}
