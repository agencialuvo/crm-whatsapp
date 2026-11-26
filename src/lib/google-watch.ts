import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isBlockedHost } from "@/lib/net-guard";
import type { WatchStatus } from "@/lib/google-watch-status";

export type { WatchStatus } from "@/lib/google-watch-status";

/**
 * Mejora 4 — Avisos al instante de Google Calendar (`events.watch`): las reglas PURAS.
 *
 * Google avisa (POST sin cuerpo útil, solo encabezados `X-Goog-*`) cuando cambia un calendario vigilado. Vocero
 * NO confía en el aviso como dato: solo dispara la lectura de siempre (`events.list`). Aquí vive lo que se
 * puede decidir sin base ni red:
 *
 *  - El token del canal: un HMAC del `channel_id` con el secreto de la instancia y un contexto PROPIO (no sirve
 *    el `state` del OAuth del negocio ni el del profesional, ni al revés). No se guarda: se recalcula y se
 *    compara en tiempo constante.
 *  - Los encabezados del aviso (`parseWatchHeaders`).
 *  - Si la dirección pública admite avisos (`watchUrlOk`: Google solo avisa a https con dominio público).
 *  - Qué canales crear, renovar (con solapamiento) o detener (`planWatchChanges`).
 */

export const WATCH_WEBHOOK_PATH = "/api/webhooks/google-calendar";
/** Lo que se pide de vida al canal: el máximo que Google da a los eventos (7 días). */
export const WATCH_TTL_SECONDS = 7 * 24 * 3600;
/** Un canal al que le queda menos que esto se reemplaza (el viejo se detiene cuando el nuevo responde). */
export const WATCH_RENEW_BEFORE_MS = 24 * 3_600_000;
/** Un canal pedido que no se confirmó en este tiempo se da por perdido. */
export const WATCH_PENDING_STALE_MS = 5 * 60_000;
/** Como mucho una lectura por fuente cada 10 s, aunque Google mande una ráfaga de avisos. */
export const WATCH_MIN_GAP_MS = 10_000;

const TOKEN_CONTEXT = "google-watch";

/** Id del canal: 128 bits al azar (Google admite `[A-Za-z0-9-_+/=]`, hasta 64). */
export function newChannelId(): string {
  return randomBytes(16).toString("base64url");
}

/** El token que Google devuelve en `X-Goog-Channel-Token` (≤ 256 caracteres). */
export function channelToken(secret: string, channelId: string): string {
  return createHmac("sha256", secret).update(`${TOKEN_CONTEXT}|${channelId}`).digest("base64url");
}

/** ¿El token del aviso es el de ESE canal? En tiempo constante. */
export function verifyChannelToken(secret: string, channelId: string, token: string | null | undefined): boolean {
  if (!token) return false;
  const expected = Buffer.from(channelToken(secret, channelId));
  const got = Buffer.from(token);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export type WatchResourceState = "sync" | "exists" | "not_exists";

export type WatchHeaders = {
  channelId: string;
  token: string | null;
  resourceId: string;
  state: WatchResourceState;
  messageNumber: string | null;
};

const CHANNEL_ID_RE = /^[A-Za-z0-9\-_+/=]{1,64}$/;
const STATES: readonly WatchResourceState[] = ["sync", "exists", "not_exists"];

/** Los encabezados de un aviso de Google, o `null` si no lo parecen. */
export function parseWatchHeaders(h: Headers): WatchHeaders | null {
  const channelId = h.get("x-goog-channel-id")?.trim() ?? "";
  const resourceId = h.get("x-goog-resource-id")?.trim() ?? "";
  const state = (h.get("x-goog-resource-state")?.trim() ?? "") as WatchResourceState;
  const messageNumber = h.get("x-goog-message-number")?.trim() || null;
  const token = h.get("x-goog-channel-token")?.trim() || null;
  if (!CHANNEL_ID_RE.test(channelId)) return null;
  if (!resourceId || resourceId.length > 256) return null;
  if (!STATES.includes(state)) return null;
  if (messageNumber !== null && !/^\d{1,20}$/.test(messageNumber)) return null;
  if (token !== null && token.length > 256) return null;
  return { channelId, token, resourceId, state, messageNumber };
}

/**
 * ¿Google puede avisar a esta instancia? Solo a https con un dominio público (ni http, ni localhost, ni IP
 * privada). `allowLocal`: solo con los mocks del entorno de pruebas (`isMockEnabled()`), nunca en producción.
 * Devuelve la dirección del aviso o `null`.
 */
export function watchUrlOk(appBaseUrl: string | undefined, opts: { allowLocal?: boolean } = {}): string | null {
  if (!appBaseUrl) return null;
  let url: URL;
  try {
    url = new URL(appBaseUrl);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (!opts.allowLocal) {
    if (url.protocol !== "https:") return null;
    if (isBlockedHost(url.hostname)) return null;
    // Una IP pública suelta no tiene certificado válido para Google: se exige un nombre.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(":")) return null;
    if (!url.hostname.includes(".")) return null;
  } else if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}${WATCH_WEBHOOK_PATH}`;
}

/** Espera tras un fallo al crear el canal: 1 min → 5 → 15 → 60 → 6 h. Un rechazo permanente, 6 h directo. */
export function watchRetryDelayMs(attempts: number, permanent = false): number {
  if (permanent) return 6 * 3_600_000;
  const steps = [60_000, 5 * 60_000, 15 * 60_000, 3_600_000, 6 * 3_600_000];
  return steps[Math.min(Math.max(attempts, 1), steps.length) - 1]!;
}

/** ¿Google rechaza el aviso para siempre en ese calendario (no lo admite, o la URL no le sirve)? */
export function isPermanentWatchError(status: number | null | undefined, text: string): boolean {
  if (status !== 400 && status !== 401 && status !== 403) return false;
  return /pushNotSupportedForRequestedResource|webhookUrlNotHttps|webhookUrlUnauthorized|push\.webhookUrl|not supported/i.test(text);
}

/* ---------- qué canales crear, renovar o detener ---------- */

/** Un calendario que DEBE estar vigilado: del negocio (`staffId` null) o de un profesional. */
export type WatchTarget = { organizationId: string; staffId: string | null; calendarId: string };

/** Lo que interesa de una fila `google_watch_channel`. */
export type WatchChannelRow = {
  id: string;
  organizationId: string;
  staffId: string | null;
  calendarId: string;
  channelId: string;
  resourceId: string | null;
  status: "pending" | "active" | "failed";
  expiresAt: Date | null;
  attempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  lastError?: string | null;
};

export type WatchPlan = {
  /** Calendarios a los que hay que pedirles un canal (nuevo o de reemplazo). `retry`: la fila fallida a reusar. */
  create: { target: WatchTarget; retry: WatchChannelRow | null }[];
  /** Canales que sobran: detenerlos en Google (si llegaron a existir) y borrarlos. */
  stop: WatchChannelRow[];
};

export function watchKey(t: { organizationId: string; staffId: string | null; calendarId: string }): string {
  return `${t.organizationId}|${t.staffId ?? "-"}|${t.calendarId}`;
}

/**
 * Compara lo que DEBE estar vigilado con lo que HAY:
 *  - Un calendario sin canal sano (activo y con más de 24 h de vida, o pedido hace menos de 5 min) → crear;
 *    salvo que su último intento haya fallado y aún no toque reintentar.
 *  - Renovar = crear otro mientras el viejo sigue; cuando el nuevo está activo y sano, el viejo sobra → detener.
 *  - Un canal vencido, un pedido que nunca se confirmó, o uno de un calendario que ya no se lee → detener.
 */
export function planWatchChanges(desired: WatchTarget[], existing: WatchChannelRow[], now: Date): WatchPlan {
  const t = now.getTime();
  const create: WatchPlan["create"] = [];
  const stop: WatchChannelRow[] = [];
  const wanted = new Map(desired.map((d) => [watchKey(d), d]));
  const byKey = new Map<string, WatchChannelRow[]>();
  for (const row of existing) {
    const k = watchKey(row);
    if (!wanted.has(k)) {
      stop.push(row);
      continue;
    }
    byKey.set(k, [...(byKey.get(k) ?? []), row]);
  }

  for (const [k, target] of wanted) {
    const rows = byKey.get(k) ?? [];
    const active = rows.filter((r) => r.status === "active");
    const pending = rows.filter((r) => r.status === "pending");
    const failed = rows.filter((r) => r.status === "failed");

    const expired = active.filter((r) => !r.expiresAt || r.expiresAt.getTime() <= t);
    const alive = active.filter((r) => r.expiresAt && r.expiresAt.getTime() > t);
    const healthy = alive
      .filter((r) => r.expiresAt!.getTime() - t > WATCH_RENEW_BEFORE_MS)
      .sort((a, b) => b.expiresAt!.getTime() - a.expiresAt!.getTime());
    const stalePending = pending.filter((r) => t - r.createdAt.getTime() > WATCH_PENDING_STALE_MS);
    const freshPending = pending.filter((r) => t - r.createdAt.getTime() <= WATCH_PENDING_STALE_MS);

    stop.push(...expired, ...stalePending);

    if (healthy.length > 0) {
      // El más nuevo se queda; los demás vivos (los que se están renovando) y los fallidos sobran.
      const [, ...older] = healthy;
      const keep = healthy[0]!;
      stop.push(...older, ...alive.filter((r) => r !== keep && !older.includes(r)), ...failed);
      continue;
    }
    if (freshPending.length > 0) continue; // ya se pidió uno: a esperar a Google
    const retry = failed.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
    stop.push(...failed.filter((r) => r !== retry));
    if (retry?.nextAttemptAt && retry.nextAttemptAt.getTime() > t) continue; // aún en espera
    create.push({ target, retry });
  }
  return { create, stop };
}

/** El estado de una fuente a partir de sus calendarios y sus canales. */
export function summarizeWatch(calendarIds: string[], rows: WatchChannelRow[], now: Date): WatchStatus {
  if (calendarIds.length === 0) return { status: "starting" };
  let anyFailed: WatchChannelRow | null = null;
  let allActive = true;
  for (const cal of calendarIds) {
    const mine = rows.filter((r) => r.calendarId === cal);
    const ok = mine.some((r) => r.status === "active" && r.expiresAt && r.expiresAt.getTime() > now.getTime());
    if (!ok) allActive = false;
    if (!ok) anyFailed ??= mine.find((r) => r.status === "failed") ?? null;
  }
  if (allActive) return { status: "active" };
  if (anyFailed) return { status: "failed", error: anyFailed.lastError ?? null };
  return { status: "starting" };
}
