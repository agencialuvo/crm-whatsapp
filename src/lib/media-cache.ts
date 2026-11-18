/**
 * 048 — Reglas puras de la caché del `media_id` de WhatsApp (sin base ni red, para poder probarse por unidad).
 *
 * Un `media_id` pertenece al `phone_number_id` que subió el archivo y Meta lo borra a los 30 días: se guarda 25 para
 * tener margen. Se reutiliza solo si sigue vigente, es del mismo número y el medio no cambió.
 */

export const CACHE_TTL_DAYS = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CachedMedia = {
  phoneNumberId: string;
  waMediaId: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: Date;
};

export type MediaSourceDecision =
  | { action: "reuse"; waMediaId: string }
  | { action: "upload"; reason: "none" | "expired" | "other_phone" | "changed" };

/** ¿Hay que volver a subir el archivo a Meta o basta con el `media_id` guardado? */
export function decideMediaSource(
  cache: CachedMedia | null | undefined,
  item: { mimeType: string; sizeBytes: number },
  phoneNumberId: string,
  now: Date
): MediaSourceDecision {
  if (!cache) return { action: "upload", reason: "none" };
  if (cache.phoneNumberId !== phoneNumberId) return { action: "upload", reason: "other_phone" };
  if (cache.expiresAt.getTime() <= now.getTime()) return { action: "upload", reason: "expired" };
  if (cache.mimeType !== item.mimeType || cache.sizeBytes !== item.sizeBytes) return { action: "upload", reason: "changed" };
  return { action: "reuse", waMediaId: cache.waMediaId };
}

/** Cuándo vence un `media_id` recién subido. */
export function cacheExpiry(now: Date): Date {
  return new Date(now.getTime() + CACHE_TTL_DAYS * DAY_MS);
}

/** Códigos con los que Meta dice «ese media no existe / expiró / no es tuyo». Se confirman contra el sandbox (spec 048, Q7). */
const STALE_MEDIA_CODES = new Set([131052, 131053, 131047]);
const STALE_MEDIA_SUBCODES = new Set([1357004, 2018047]);

type MetaErrorLike = { code?: number | null; message?: string; details?: unknown };

function subcodeOf(details: unknown): number | null {
  const d = details as { error?: { error_subcode?: unknown } } | null | undefined;
  const n = Number(d?.error?.error_subcode);
  return Number.isFinite(n) ? n : null;
}

/**
 * ¿El rechazo de Meta apunta a un `media_id` vencido o inválido? Solo entonces se invalida la caché y se reintenta UNA
 * vez subiendo de nuevo. El 100 es genérico («parámetro inválido»), así que solo cuenta si habla del media.
 */
export function isStaleMediaError(err: MetaErrorLike | null | undefined): boolean {
  if (!err) return false;
  if (err.code != null && STALE_MEDIA_CODES.has(err.code)) return true;
  const sub = subcodeOf(err.details);
  if (sub != null && STALE_MEDIA_SUBCODES.has(sub)) return true;
  if (err.code === 100 && /media|\bid\b/i.test(err.message ?? "")) return true;
  return false;
}

/** Señal interna: el `media_id` guardado ya no sirve (Meta lo rechazó); el envío se reintenta UNA vez subiendo de nuevo. */
export class StaleMediaRetry extends Error {
  constructor() {
    super("media_id vencido o inválido");
    this.name = "StaleMediaRetry";
  }
}

/**
 * Corre `run(false)` (reutilizando la caché); si lanza `StaleMediaRetry`, corre `run(true)` (subiendo de nuevo) y NADA
 * más: a lo sumo dos intentos, nunca un bucle. Cualquier otro error pasa tal cual.
 */
export async function withStaleMediaRetry<T>(run: (forceRefresh: boolean) => Promise<T>): Promise<T> {
  try {
    return await run(false);
  } catch (err) {
    if (err instanceof StaleMediaRetry) return await run(true);
    throw err;
  }
}
