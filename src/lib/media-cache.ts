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

/**
 * Hallazgo G — «arrendamiento» de una subida en curso. En vez de mantener una transacción de Postgres abierta mientras se
 * lee de R2 y se sube a Meta, quien va a subir deja en la fila de la caché un marcador `pending:<token>` con vencimiento
 * corto (`LEASE_MS`). Mientras esté vigente, nadie más sube ese (medio, número): esperan. Si quien subía se cae, el
 * marcador vence solo y otro lo retoma. Un marcador NUNCA es un `media_id` y no se reutiliza.
 */
export const LEASE_PREFIX = "pending:";
export const LEASE_MS = 2 * 60 * 1000;

export const leaseId = (token: string): string => `${LEASE_PREFIX}${token}`;
export const esLease = (waMediaId: string): boolean => waMediaId.startsWith(LEASE_PREFIX);

export type MediaSourceDecision =
  | { action: "reuse"; waMediaId: string }
  | { action: "upload"; reason: "none" | "expired" | "other_phone" | "changed" | "in_progress" };

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
  if (esLease(cache.waMediaId)) return { action: "upload", reason: "in_progress" }; // otro envío la está subiendo ahora
  if (cache.mimeType !== item.mimeType || cache.sizeBytes !== item.sizeBytes) return { action: "upload", reason: "changed" };
  return { action: "reuse", waMediaId: cache.waMediaId };
}

/** Cuándo vence un `media_id` recién subido. */
export function cacheExpiry(now: Date): Date {
  return new Date(now.getTime() + CACHE_TTL_DAYS * DAY_MS);
}

/**
 * Cómo se reconoce un rechazo de Meta por «ese `media_id` no sirve» (vencido, borrado o de otro número). TODO el criterio
 * vive en esta constante para ajustarlo en un solo sitio cuando se pruebe contra un número real (spec 048, Q7):
 *
 * - `codes`: el código de error basta. Son los que Meta documenta para media (131052 = error al descargar el media,
 *   131053 = error al subirlo). **131047 NO va aquí**: es «ventana de 24 h cerrada» (re-engagement); tratarlo como
 *   media vencido descartaba un id válido y re-subía el archivo para fallar igual.
 * - `subcodes`: subcódigos (`error.error_subcode`) que apuntan a un media inexistente o ajeno.
 * - `generic`: códigos genéricos de «parámetro inválido» que por sí solos NO dicen nada (un número mal escrito también
 *   da 100 / 131009). Cuentan solo si el texto del error habla del media.
 */
export const STALE_MEDIA_RULES = {
  codes: [131052, 131053] as readonly number[],
  subcodes: [1357004, 2018047] as readonly number[],
  generic: [
    { code: 100, texto: /media|\bid\b/i },
    { code: 131009, texto: /media/i },
  ] as readonly { code: number; texto: RegExp }[],
};

type MetaErrorLike = { code?: number | null; message?: string; details?: unknown };

type MetaErrorBody = { error?: { error_subcode?: unknown; error_user_msg?: unknown; error_data?: { details?: unknown } } };

function cuerpo(details: unknown): MetaErrorBody["error"] | undefined {
  return (details as MetaErrorBody | null | undefined)?.error;
}

function subcodeOf(details: unknown): number | null {
  const n = Number(cuerpo(details)?.error_subcode);
  return Number.isFinite(n) ? n : null;
}

/** Todo el texto que Meta mandó en el rechazo (mensaje, `error_user_msg`, `error_data.details`) para buscar «media». */
function textoDelError(err: MetaErrorLike): string {
  const e = cuerpo(err.details);
  return [err.message, e?.error_user_msg, e?.error_data?.details].filter((t): t is string => typeof t === "string").join(" ");
}

/**
 * ¿El rechazo de Meta apunta a un `media_id` vencido o inválido? Solo entonces se invalida la caché y se reintenta UNA
 * vez subiendo de nuevo. Las reglas están en `STALE_MEDIA_RULES`.
 */
export function isStaleMediaError(err: MetaErrorLike | null | undefined): boolean {
  if (!err) return false;
  const code = err.code ?? null;
  if (code !== null && STALE_MEDIA_RULES.codes.includes(code)) return true;
  const sub = subcodeOf(err.details);
  if (sub !== null && STALE_MEDIA_RULES.subcodes.includes(sub)) return true;
  if (code !== null) {
    const texto = textoDelError(err);
    if (STALE_MEDIA_RULES.generic.some((g) => g.code === code && g.texto.test(texto))) return true;
  }
  return false;
}

/**
 * Señal interna: el `media_id` guardado ya no sirve (Meta lo rechazó); el envío se reintenta UNA vez subiendo de nuevo.
 * Lleva el id que falló, para que la renovación sepa qué NO reutilizar (otro envío pudo renovarlo ya).
 */
export class StaleMediaRetry extends Error {
  constructor(readonly rejectedWaMediaId?: string) {
    super("media_id vencido o inválido");
    this.name = "StaleMediaRetry";
  }
}

/**
 * Corre `run(false)` (reutilizando la caché); si lanza `StaleMediaRetry`, corre `run(true, <id que falló>)` (renovando) y
 * NADA más: a lo sumo dos intentos, nunca un bucle. Cualquier otro error pasa tal cual.
 */
export async function withStaleMediaRetry<T>(run: (forceRefresh: boolean, rejectedWaMediaId?: string) => Promise<T>): Promise<T> {
  try {
    return await run(false);
  } catch (err) {
    if (err instanceof StaleMediaRetry) return await run(true, err.rejectedWaMediaId);
    throw err;
  }
}
