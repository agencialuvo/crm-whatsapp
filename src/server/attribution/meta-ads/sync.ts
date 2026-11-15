import { graphRequest } from "@/lib/meta/client";
import {
  ADS_BATCH,
  buildAdsPath,
  buildInsightsPath,
  chunk,
  classifyGraphError,
  parseAdsPage,
  parseInsightsPage,
  parseUsageHeaders,
  rateLimitBackoffMs,
  sanitizeError,
  USAGE_THROTTLE_PCT,
  type GraphProblem,
  type SpendRow,
} from "@/lib/meta/ads";
import { addDaysISO, todayInTz } from "@/lib/time/slots";
import {
  adsForSpend,
  claimDue,
  markFailed,
  markNotFound,
  markRetry,
  markSynced,
  refreshStale,
  releaseLocks,
  replaceSpend,
} from "@/server/attribution/meta-ads/catalog";
import {
  clearRateLimit,
  getMetaAdsSettings,
  markSettingsError,
  setCurrencyIfMissing,
  setPausedUntil,
  touchSpendSync,
  type MetaAdsSettings,
} from "@/server/attribution/meta-ads/settings";

/**
 * 038 — La sincronización con la Marketing API: jerarquía y gasto.
 *
 * Toda la red entra por `deps.graph`, así las pruebas la sustituyen y recorren
 * cada rama de error sin Meta. Nada de lo que pase aquí toca la ingesta ni los
 * conteos de Resultados: es trabajo de fondo que puede fallar sin consecuencias
 * para lo core (constitución II).
 */

export type GraphCall = (
  path: string,
  token: string,
  onHeaders: (headers: Headers) => void
) => Promise<unknown>;

export type SyncDeps = { now: () => Date; graph: GraphCall };

export const defaultSyncDeps: SyncDeps = {
  now: () => new Date(),
  graph: (path, token, onHeaders) => graphRequest<unknown>(path, { token, onHeaders }),
};

export type SyncSummary = {
  skipped: null | "sin_credenciales" | "error" | "pausa";
  /** Anuncios cuya jerarquía se resolvió / no se encontró en la cuenta. */
  synced: number;
  notFound: number;
  /** Anuncios cuyo gasto se actualizó. */
  spendAds: number;
  /** Por qué se detuvo la pasada antes de terminar, si lo hizo. */
  stopped: null | GraphProblem["kind"] | "uso_alto";
};

/** Tandas de consulta de jerarquía por pasada (50 anuncios cada una). */
const MAX_LOOKUP_BATCHES = 4;
/** Cada cuánto se sincroniza el gasto de una organización. */
export const SPEND_EVERY_MS = 3 * 60 * 60_000;
const BACKFILL_DAYS = 90;
const REFRESH_DAYS = 7;
const MAX_PAGES = 20;
/** Si Meta no dice cuánto esperar al pasar del 90 % de uso. */
const DEFAULT_USAGE_PAUSE_MS = 10 * 60_000;

type Ctx = {
  organizationId: string;
  settings: MetaAdsSettings;
  deps: SyncDeps;
  now: Date;
  summary: SyncSummary;
  /** Lo último que Meta dijo de su uso, para la espera si luego llega un límite. */
  regainMs: number | null;
  recovered: boolean;
};

type Called = { ok: true; json: unknown } | { ok: false; problem: GraphProblem };

async function call(ctx: Ctx, path: string): Promise<Called> {
  let usage = { maxPct: 0, regainMs: null as number | null };
  try {
    const json = await ctx.deps.graph(path, ctx.settings.token, (h) => {
      usage = parseUsageHeaders(h);
    });
    ctx.regainMs = usage.regainMs ?? ctx.regainMs;
    // Una llamada buena termina el castigo por límite y limpia el último error.
    if (!ctx.recovered && (ctx.settings.rateHits > 0 || ctx.settings.pausedUntil || ctx.settings.lastError)) {
      ctx.recovered = true;
      await clearRateLimit(ctx.organizationId);
    }
    if (usage.maxPct >= USAGE_THROTTLE_PCT) {
      // Frenar ANTES de que Meta responda con un límite: esta llamada sí valió.
      await setPausedUntil(
        ctx.organizationId,
        new Date(ctx.now.getTime() + (usage.regainMs ?? DEFAULT_USAGE_PAUSE_MS)),
        ctx.settings.rateHits,
        null
      );
      ctx.summary.stopped = "uso_alto";
    }
    return { ok: true, json };
  } catch (err) {
    return { ok: false, problem: classifyGraphError(err) };
  }
}

/**
 * Qué hacer con un fallo. Devuelve `true` si la pasada debe detenerse. `adIds`
 * son las filas tomadas (vacío para el gasto, que no usa la toma).
 */
async function handleProblem(ctx: Ctx, problem: GraphProblem, adIds: string[]): Promise<boolean> {
  const { organizationId, now } = ctx;
  switch (problem.kind) {
    case "auth":
    case "permission": {
      const msg =
        problem.kind === "permission"
          ? `El token no tiene el permiso ads_read o no ve esta cuenta publicitaria. ${problem.message}`
          : `El token de Meta ya no es válido: ${problem.message}`;
      await markSettingsError(organizationId, sanitizeError(msg));
      await releaseLocks(organizationId, adIds);
      ctx.summary.stopped = problem.kind;
      return true;
    }
    case "rate_limit": {
      const hits = ctx.settings.rateHits + 1;
      ctx.settings.rateHits = hits;
      const wait = Math.max(ctx.regainMs ?? 0, rateLimitBackoffMs(hits));
      await setPausedUntil(
        organizationId,
        new Date(now.getTime() + wait),
        hits,
        `Meta pidió esperar (límite de uso). ${problem.message}`.slice(0, 300)
      );
      await releaseLocks(organizationId, adIds);
      ctx.summary.stopped = "rate_limit";
      return true;
    }
    case "transient": {
      await markRetry(organizationId, adIds, problem.message, now);
      ctx.summary.stopped = "transient";
      return true;
    }
    default: {
      await markFailed(organizationId, adIds, problem.message, now);
      return false;
    }
  }
}

async function syncLookups(ctx: Ctx): Promise<void> {
  for (let i = 0; i < MAX_LOOKUP_BATCHES && !ctx.summary.stopped; i++) {
    const rows = await claimDue(ctx.organizationId, ADS_BATCH, ctx.now);
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.adId);

    const res = await call(ctx, buildAdsPath(ctx.settings.adAccountId, ids));
    if (!res.ok) {
      if (await handleProblem(ctx, res.problem, ids)) return;
      continue;
    }

    const { ads } = parseAdsPage(res.json);
    const found = new Set(ads.map((a) => a.adId));
    const mine = ads.filter((a) => ids.includes(a.adId));
    await markSynced(ctx.organizationId, mine, ctx.now);
    const missing = ids.filter((id) => !found.has(id));
    await markNotFound(ctx.organizationId, missing, ctx.now);
    ctx.summary.synced += mine.length;
    ctx.summary.notFound += missing.length;
  }
}

async function fetchSpend(
  ctx: Ctx,
  adIds: string[],
  since: string,
  until: string
): Promise<{ rows: SpendRow[] } | { stop: true } | { skip: true }> {
  const rows: SpendRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await call(ctx, buildInsightsPath(ctx.settings.adAccountId, adIds, since, until, after));
    if (!res.ok) return (await handleProblem(ctx, res.problem, [])) ? { stop: true } : { skip: true };
    const parsed = parseInsightsPage(res.json);
    rows.push(...parsed.rows);
    if (!parsed.after) return { rows };
    after = parsed.after;
  }
  // Más páginas de las razonables: se escribe lo traído; el resto llega en la pasada siguiente.
  return { rows };
}

async function syncSpend(ctx: Ctx): Promise<void> {
  const today = todayInTz(ctx.now, "UTC");
  const ads = await adsForSpend(ctx.organizationId, ctx.now);
  const grupos: { ids: string[]; since: string }[] = [
    { ids: ads.filter((a) => !a.spendSyncedAt).map((a) => a.adId), since: addDaysISO(today, -(BACKFILL_DAYS - 1)) },
    { ids: ads.filter((a) => a.spendSyncedAt).map((a) => a.adId), since: addDaysISO(today, -(REFRESH_DAYS - 1)) },
  ];

  for (const grupo of grupos) {
    for (const lote of chunk(grupo.ids, ADS_BATCH)) {
      if (ctx.summary.stopped) return;
      const out = await fetchSpend(ctx, lote, grupo.since, today);
      if ("stop" in out) return;
      if ("skip" in out) continue;
      await replaceSpend({
        organizationId: ctx.organizationId,
        adIds: lote,
        since: grupo.since,
        until: today,
        rows: out.rows,
        now: ctx.now,
      });
      if (out.rows[0]) await setCurrencyIfMissing(ctx.organizationId, out.rows[0].currency);
      ctx.summary.spendAds += lote.length;
    }
  }
  // Solo una pasada completa cuenta como «sincronizado»: si algo la cortó, se reintenta pronto.
  if (!ctx.summary.stopped) await touchSpendSync(ctx.organizationId, ctx.now);
}

/**
 * Una pasada de UNA organización. Nunca lanza: el fallo de una cuenta no frena a
 * las demás ni a la ingesta.
 */
export async function syncOrganization(
  organizationId: string,
  deps: SyncDeps = defaultSyncDeps,
  opts: { forceSpend?: boolean } = {}
): Promise<SyncSummary> {
  const summary: SyncSummary = { skipped: null, synced: 0, notFound: 0, spendAds: 0, stopped: null };
  try {
    const settings = await getMetaAdsSettings(organizationId);
    if (!settings) return { ...summary, skipped: "sin_credenciales" };
    if (settings.status === "error") return { ...summary, skipped: "error" };
    const now = deps.now();
    if (settings.pausedUntil && settings.pausedUntil > now) return { ...summary, skipped: "pausa" };

    const ctx: Ctx = { organizationId, settings, deps, now, summary, regainMs: null, recovered: false };
    await refreshStale(organizationId, now);
    await syncLookups(ctx);

    const debe =
      opts.forceSpend ||
      !settings.lastSpendSyncAt ||
      now.getTime() - settings.lastSpendSyncAt.getTime() >= SPEND_EVERY_MS;
    if (debe && !summary.stopped) await syncSpend(ctx);
    return summary;
  } catch (err) {
    console.error(
      `[meta-ads] la sincronización de ${organizationId} falló:`,
      err instanceof Error ? sanitizeError(err.message) : err
    );
    return summary;
  }
}
