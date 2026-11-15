import { MetaApiError } from "@/lib/meta/client";

/**
 * 038 — Marketing API de Meta: la parte PURA del conector.
 *
 * Todo lo que se puede probar sin red ni base vive aquí: normalizar la cuenta,
 * armar las consultas, leer las páginas, clasificar los errores y calcular los
 * esperas. El orquestador (`server/attribution/meta-ads/`) solo une esto con la
 * base. Misma frontera de salida que el resto del CRM: `graphRequest`.
 */

/* ── La cuenta publicitaria ─────────────────────────────────────── */

/** `act_123…`, o el número solo, o pegado con espacios/guiones. Null si no parece una cuenta. */
export function normalizeAdAccountId(input: string): string | null {
  const limpio = input.trim().replace(/^act[_\s-]*/i, "").replace(/[\s-]/g, "");
  return /^\d{5,20}$/.test(limpio) ? `act_${limpio}` : null;
}

/* ── Errores ────────────────────────────────────────────────────── */

export type GraphErrorKind =
  | "auth" // el token no sirve: nada más se intenta hasta que el dueño lo cambie
  | "permission" // falta `ads_read` o la cuenta no es visible con este token
  | "rate_limit" // Meta pide esperar: no cuenta como intento
  | "transient" // red caída o 5xx: se reintenta con backoff
  | "permanent"; // la petición está mal: no se reintenta antes del siguiente ciclo

export type GraphProblem = { kind: GraphErrorKind; message: string };

const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613]);

function esLimiteDeUso(code: number | null): boolean {
  return code !== null && (RATE_LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014));
}

/** Clasifica un fallo de la Graph API. Lo desconocido es `permanent`: no se reintenta a ciegas. */
export function classifyGraphError(err: unknown): GraphProblem {
  if (!(err instanceof MetaApiError)) {
    return { kind: "transient", message: sanitizeError(err instanceof Error ? err.message : String(err)) };
  }
  const message = sanitizeError(err.message);
  const { status, code } = err;

  if (esLimiteDeUso(code)) return { kind: "rate_limit", message };
  if (err.isAuthError || code === 102) return { kind: "auth", message };
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return { kind: "permission", message };
  }
  if (status === 0 || status >= 500 || code === 1 || code === 2) {
    return { kind: "transient", message };
  }
  return { kind: "permanent", message };
}

/**
 * Lo que se guarda de un mensaje de error: sin nada que parezca un token y
 * acotado. Meta a veces repite el `access_token` de la URL en el mensaje.
 */
export function sanitizeError(message: string): string {
  return message
    .replace(/access_token=[^&\s"']+/gi, "access_token=[oculto]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [oculto]")
    .replace(/\bEAA[A-Za-z0-9]{10,}\b/g, "[oculto]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[oculto]")
    .slice(0, 300);
}

/* ── Esperas ────────────────────────────────────────────────────── */

const MIN = 60_000;
const TRANSIENT_STEPS = [1 * MIN, 5 * MIN, 30 * MIN, 120 * MIN, 360 * MIN] as const;

/** Intentos fallidos que se toleran antes de pasar a `failed`. */
export const MAX_ATTEMPTS = 6;
/** Cada cuánto se vuelve a mirar lo `failed` / `not_found` / `synced`. */
export const RECHECK_FAILED_MS = 12 * 60 * MIN;
export const RECHECK_NOT_FOUND_MS = 24 * 60 * MIN;
export const STALE_MS = 12 * 60 * MIN;

/** Espera tras el fallo transitorio número `attempts` (1, 2, …). */
export function transientBackoffMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), TRANSIENT_STEPS.length) - 1;
  return TRANSIENT_STEPS[i]!;
}

/** Espera tras el golpe número `hits` al límite de uso: 5 → 10 → 20 → … tope 120 min. */
export function rateLimitBackoffMs(hits: number): number {
  const h = Math.max(hits, 1);
  return Math.min(5 * MIN * 2 ** (h - 1), 120 * MIN);
}

export type Usage = {
  /** El indicador más alto (0-100) de los que Meta reporta. */
  maxPct: number;
  /** Lo que Meta dice que falta para recuperar el acceso, si lo dice. */
  regainMs: number | null;
};

/** Umbral a partir del cual se frena ANTES de que Meta responda con un límite. */
export const USAGE_THROTTLE_PCT = 90;

function numero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Lee `x-business-use-case-usage` y `x-app-usage`. Cabeceras ausentes o rotas = sin dato. */
export function parseUsageHeaders(headers: Pick<Headers, "get">): Usage {
  let maxPct = 0;
  let regainMin = 0;

  const bucs = headers.get("x-business-use-case-usage");
  if (bucs) {
    try {
      const parsed = JSON.parse(bucs) as Record<string, unknown>;
      for (const lista of Object.values(parsed)) {
        if (!Array.isArray(lista)) continue;
        for (const u of lista as Record<string, unknown>[]) {
          maxPct = Math.max(maxPct, numero(u.call_count), numero(u.total_cputime), numero(u.total_time));
          regainMin = Math.max(regainMin, numero(u.estimated_time_to_regain_access));
        }
      }
    } catch {
      // cabecera ilegible: se ignora
    }
  }

  const app = headers.get("x-app-usage");
  if (app) {
    try {
      const u = JSON.parse(app) as Record<string, unknown>;
      maxPct = Math.max(maxPct, numero(u.call_count), numero(u.total_cputime), numero(u.total_time));
    } catch {
      // idem
    }
  }

  return { maxPct, regainMs: regainMin > 0 ? regainMin * MIN : null };
}

/* ── Consultas ──────────────────────────────────────────────────── */

export const ADS_BATCH = 50;
export const INSIGHTS_PAGE = 500;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const enc = encodeURIComponent;

/** `GET act_X?fields=…`: valida la cuenta y trae su nombre y moneda. */
export function buildAccountPath(accountId: string): string {
  return `${accountId}?fields=${enc("name,currency,account_status")}`;
}

/** Jerarquía de hasta 50 anuncios de la cuenta (un id ajeno o borrado simplemente no vuelve). */
export function buildAdsPath(accountId: string, adIds: readonly string[]): string {
  const filtering = JSON.stringify([{ field: "id", operator: "IN", value: adIds }]);
  const fields = "id,name,adset{id,name},campaign{id,name}";
  return `${accountId}/ads?fields=${enc(fields)}&filtering=${enc(filtering)}&limit=${ADS_BATCH}`;
}

/** Gasto diario por anuncio en `[since, until]` (fechas `YYYY-MM-DD`), paginado con `after`. */
export function buildInsightsPath(
  accountId: string,
  adIds: readonly string[],
  since: string,
  until: string,
  after?: string | null
): string {
  const filtering = JSON.stringify([{ field: "ad.id", operator: "IN", value: adIds }]);
  const range = JSON.stringify({ since, until });
  const base =
    `${accountId}/insights?level=ad&fields=${enc("ad_id,spend,account_currency")}` +
    `&time_increment=1&time_range=${enc(range)}&filtering=${enc(filtering)}&limit=${INSIGHTS_PAGE}`;
  return after ? `${base}&after=${enc(after)}` : base;
}

/* ── Respuestas ─────────────────────────────────────────────────── */

export type AdNode = {
  adId: string;
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
};

export type SpendRow = { adId: string; day: string; spend: string; currency: string };

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cadena(v: unknown, max = 300): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function nextCursor(json: unknown): string | null {
  if (!esObjeto(json) || !esObjeto(json.paging)) return null;
  const paging = json.paging;
  // Sin `next` no hay otra página aunque venga el cursor.
  if (typeof paging.next !== "string" || !esObjeto(paging.cursors)) return null;
  return cadena(paging.cursors.after);
}

export function parseAdsPage(json: unknown): { ads: AdNode[]; after: string | null } {
  const data = esObjeto(json) && Array.isArray(json.data) ? json.data : [];
  const ads: AdNode[] = [];
  for (const raw of data) {
    if (!esObjeto(raw)) continue;
    const adId = cadena(raw.id, 128);
    if (!adId) continue;
    const adset = esObjeto(raw.adset) ? raw.adset : {};
    const campaign = esObjeto(raw.campaign) ? raw.campaign : {};
    ads.push({
      adId,
      adName: cadena(raw.name),
      adsetId: cadena(adset.id, 128),
      adsetName: cadena(adset.name),
      campaignId: cadena(campaign.id, 128),
      campaignName: cadena(campaign.name),
    });
  }
  return { ads, after: nextCursor(json) };
}

/** Importe de Meta («12.5», «0») a texto con dos decimales; null si no es un importe válido. */
export function normalizeSpend(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  // `Number("")` es 0: un importe en blanco no puede pasar por un gasto de cero.
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 999_999_999_999) return null;
  return n.toFixed(2);
}

export function parseInsightsPage(json: unknown): { rows: SpendRow[]; after: string | null } {
  const data = esObjeto(json) && Array.isArray(json.data) ? json.data : [];
  const rows: SpendRow[] = [];
  for (const raw of data) {
    if (!esObjeto(raw)) continue;
    const adId = cadena(raw.ad_id, 128);
    const day = cadena(raw.date_start, 10);
    const spend = normalizeSpend(raw.spend);
    const currency = cadena(raw.account_currency, 8);
    if (!adId || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || spend === null || !currency) continue;
    rows.push({ adId, day, spend, currency });
  }
  return { rows, after: nextCursor(json) };
}
