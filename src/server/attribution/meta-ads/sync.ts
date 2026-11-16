import { graphRequest } from "@/lib/meta/client";
import {
  ADS_BATCH,
  buildAccountPath,
  buildAdsListPath,
  buildAdsPath,
  buildSpendPath,
  classifyGraphError,
  parseAccountInsights,
  parseAdsPage,
  parseInsightsPage,
  parseUsageHeaders,
  rateLimitBackoffMs,
  sanitizeError,
  USAGE_THROTTLE_PCT,
  type AccountSpendRow,
  type AdNode,
  type GraphProblem,
  type SpendRow,
} from "@/lib/meta/ads";
import { addDaysISO, todayInTz } from "@/lib/time/slots";
import { syncCreatives, type Descargador } from "@/server/attribution/meta-ads/creatives";
import {
  claimDue,
  markFailed,
  markNotFound,
  markRetry,
  markSynced,
  refreshStale,
  releaseLocks,
  replaceAccountSpend,
  replaceSpendWindow,
  upsertAccountAds,
} from "@/server/attribution/meta-ads/catalog";
import {
  clearRateLimit,
  getMetaAdsSettings,
  markSettingsError,
  setCurrencyIfMissing,
  setPausedUntil,
  setSpendCoverage,
  setSyncWarning,
  touchCatalogSync,
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

export type SyncDeps = {
  now: () => Date;
  graph: GraphCall;
  /** 040 — La descarga de la imagen del creativo; las pruebas la sustituyen (por defecto, la acotada de la 018). */
  descargar?: Descargador;
};

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
  /** 039 — Anuncios que devolvió el listado de la cuenta y ventanas de gasto reemplazadas. */
  catalogAds: number;
  windows: number;
  /** 040 — Imágenes de creativos copiadas en esta pasada. */
  creatives: number;
  /** Por qué se detuvo la pasada antes de terminar, si lo hizo. */
  stopped: null | GraphProblem["kind"] | "uso_alto" | "ventana_incompleta";
};

/** Tandas de consulta de jerarquía por pasada (50 anuncios cada una). */
const MAX_LOOKUP_BATCHES = 4;
/** Cada cuánto se sincroniza el gasto de una organización. */
export const SPEND_EVERY_MS = 3 * 60 * 60_000;
/** Historial que se trae la primera vez, y más atrás solo si Resultados lo pide (039, D5). */
export const BACKFILL_DAYS = 90;
const REFRESH_DAYS = 7;
/** Páginas por ventana de gasto y por listado de la cuenta (039). */
const MAX_PAGES = 40;
const MAX_LIST_PAGES = 100;
/** Ventanas de gasto por pasada: la de refresco y las que rellenan hacia atrás (039). */
export const MAX_WINDOWS_PER_PASS = 4;
const WINDOW_DAYS = 7;
/** Cada cuánto se vuelve a listar la cuenta entera. */
export const CATALOG_EVERY_MS = 12 * 60 * 60_000;
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

type Pagina<T> = { rows: T[]; after: string | null };

/**
 * Todas las páginas de una consulta. `complete` es false si se cortó por el tope: quien llama decide qué hacer
 * con un resultado parcial (el gasto NO se reemplaza con él; el catálogo sí se escribe).
 */
async function fetchAllPages<T>(
  ctx: Ctx,
  pathOf: (after: string | null) => string,
  parse: (json: unknown) => Pagina<T>,
  maxPages: number
): Promise<{ rows: T[]; complete: boolean } | { problem: GraphProblem }> {
  const rows: T[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await call(ctx, pathOf(after));
    if (!res.ok) return { problem: res.problem };
    const parsed = parse(res.json);
    rows.push(...parsed.rows);
    if (!parsed.after) return { rows, complete: true };
    after = parsed.after;
  }
  return { rows, complete: false };
}

function dedupe(nodes: AdNode[]): AdNode[] {
  const por = new Map<string, AdNode>();
  for (const n of nodes) por.set(n.adId, { ...por.get(n.adId), ...n });
  return [...por.values()];
}

/** Hoy en la zona de la cuenta publicitaria (la de Meta); si no se conoce o no es válida, UTC. */
function hoyDeLaCuenta(now: Date, timezone: string | null): string {
  if (timezone) {
    try {
      return todayInTz(now, timezone);
    } catch {
      // zona inválida: se cae a UTC
    }
  }
  return todayInTz(now, "UTC");
}

/**
 * 039 — Lista TODA la cuenta publicitaria: campañas pausadas y anuncios sin una sola conversación incluidos. Un
 * listado cortado por el tope se escribe igual (es catálogo, no dinero) y avisa. También refresca la zona
 * horaria de la cuenta con una llamada barata.
 */
async function syncCatalog(ctx: Ctx): Promise<void> {
  const cuenta = await call(ctx, buildAccountPath(ctx.settings.adAccountId));
  if (!cuenta.ok) {
    await handleProblem(ctx, cuenta.problem, []);
    return;
  }
  const info = cuenta.json as { timezone_name?: unknown } | null;
  const timezone = typeof info?.timezone_name === "string" ? info.timezone_name : null;
  if (timezone) ctx.settings.accountTimezone = timezone;

  const listar = (creative: boolean) =>
    fetchAllPages(
      ctx,
      (after) => buildAdsListPath(ctx.settings.adAccountId, after, { creative }),
      (j) => {
        const p = parseAdsPage(j);
        return { rows: p.ads, after: p.after };
      },
      MAX_LIST_PAGES
    );

  // 040 — Con creativos (imagen, titular, texto, enlace). Es la consulta pesada: si Meta la rechaza por tamaño o por
  // un error propio (no por token, permiso o límite de uso) se reintenta UNA vez sin creativos, para que el catálogo y el
  // gasto sigan llegando; los creativos quedan para el siguiente listado.
  let out = await listar(true);
  if ("problem" in out && (out.problem.kind === "transient" || out.problem.kind === "permanent")) {
    const primero = out.problem;
    const sin = await listar(false);
    if (!("problem" in sin)) {
      out = sin;
      await setSyncWarning(
        ctx.organizationId,
        `Meta no devolvió los creativos de los anuncios (${primero.message}). El catálogo y el gasto siguen al día; se reintenta en el siguiente listado.`
      );
    }
  }
  if ("problem" in out) {
    await handleProblem(ctx, out.problem, []);
    return;
  }
  ctx.summary.catalogAds += await upsertAccountAds(ctx.organizationId, dedupe(out.rows), ctx.now, { listed: true });
  await touchCatalogSync(ctx.organizationId, ctx.now, timezone);
  if (!out.complete) {
    await setSyncWarning(
      ctx.organizationId,
      `La cuenta tiene muchos anuncios: se listaron los primeros ${out.rows.length}. Los demás se conocen por su gasto.`
    );
  }
}

/** Una ventana de gasto: por anuncio y de la cuenta, cada una reemplazada completa o no tocada. */
async function syncSpendWindow(ctx: Ctx, since: string, until: string): Promise<"ok" | "stop" | "skip"> {
  const porAnuncio = await fetchAllPages(
    ctx,
    (after) => buildSpendPath(ctx.settings.adAccountId, "ad", since, until, after),
    parseInsightsPage,
    MAX_PAGES
  );
  if ("problem" in porAnuncio) return (await handleProblem(ctx, porAnuncio.problem, [])) ? "stop" : "skip";
  if (!porAnuncio.complete) {
    // Dinero a medias es peor que dinero viejo: esta ventana se queda como estaba.
    await setSyncWarning(
      ctx.organizationId,
      `El gasto del ${since} al ${until} trae demasiadas filas para una consulta: se conserva lo anterior.`
    );
    ctx.summary.stopped = "ventana_incompleta";
    return "stop";
  }
  const filas: SpendRow[] = porAnuncio.rows;

  const cuenta = await fetchAllPages(
    ctx,
    (after) => buildSpendPath(ctx.settings.adAccountId, "account", since, until, after),
    parseAccountInsights,
    MAX_PAGES
  );
  let filasCuenta: AccountSpendRow[] | null = null;
  if ("problem" in cuenta) {
    if (await handleProblem(ctx, cuenta.problem, [])) return "stop";
  } else if (cuenta.complete) {
    filasCuenta = cuenta.rows;
  }

  // Los anuncios que gastaron y no están en el catálogo (borrados, o de antes del listado) entran con su jerarquía.
  const conNombre = filas.flatMap((r) => (r.node ? [r.node] : []));
  if (conNombre.length > 0) await upsertAccountAds(ctx.organizationId, dedupe(conNombre), ctx.now, { listed: false });
  await replaceSpendWindow({ organizationId: ctx.organizationId, since, until, rows: filas, now: ctx.now });
  if (filasCuenta) {
    await replaceAccountSpend({ organizationId: ctx.organizationId, since, until, rows: filasCuenta, now: ctx.now });
  }

  const primero = filas[0] ?? filasCuenta?.[0];
  if (primero) await setCurrencyIfMissing(ctx.organizationId, primero.currency);
  ctx.summary.spendAds += new Set(filas.map((r) => r.adId)).size;
  ctx.summary.windows += 1;
  return "ok";
}

/** Fecha objetivo del historial: 90 días por defecto, o más atrás si Resultados lo pidió. */
function objetivoDeHistorial(settings: MetaAdsSettings, hoy: string): string {
  const porDefecto = addDaysISO(hoy, -(BACKFILL_DAYS - 1));
  const pedido = settings.spendBackfillFrom;
  return pedido && pedido < porDefecto ? pedido : porDefecto;
}

/**
 * 039 — El gasto de TODA la cuenta, por ventanas de 7 días: primero la de refresco (Meta revisa lo reciente), luego,
 * hacia atrás, las que faltan para cubrir el historial inicial o lo que Resultados pidió. Como máximo
 * `MAX_WINDOWS_PER_PASS` por pasada, así una cuenta enorme no agota la cuota de golpe.
 */
async function syncSpend(ctx: Ctx): Promise<void> {
  const hoy = hoyDeLaCuenta(ctx.now, ctx.settings.accountTimezone);
  const objetivo = objetivoDeHistorial(ctx.settings, hoy);
  const desdeRefresco = addDaysISO(hoy, -(REFRESH_DAYS - 1));
  let cubierto = ctx.settings.spendCoveredSince;
  let hechas = 0;

  const refresco = await syncSpendWindow(ctx, desdeRefresco, hoy);
  if (refresco === "stop") return;
  hechas += 1;
  if (refresco === "ok") {
    cubierto = cubierto && cubierto < desdeRefresco ? cubierto : desdeRefresco;
    await setSpendCoverage(ctx.organizationId, cubierto);
  }

  while (cubierto && cubierto > objetivo && hechas < MAX_WINDOWS_PER_PASS && !ctx.summary.stopped) {
    const hasta = addDaysISO(cubierto, -1);
    const inicio = addDaysISO(hasta, -(WINDOW_DAYS - 1));
    const desde = inicio < objetivo ? objetivo : inicio;
    const r = await syncSpendWindow(ctx, desde, hasta);
    if (r !== "ok") break;
    hechas += 1;
    cubierto = desde;
    await setSpendCoverage(ctx.organizationId, desde);
  }

  // Solo una pasada completa cuenta como «sincronizado»: si algo la cortó, se reintenta pronto.
  if (!ctx.summary.stopped) await touchSpendSync(ctx.organizationId, ctx.now);
}

/** ¿Queda historial por rellenar? (la primera vez, o lo que Resultados pidió). */
export function hayRellenoPendiente(settings: MetaAdsSettings, now: Date): boolean {
  const hoy = hoyDeLaCuenta(now, settings.accountTimezone);
  return !settings.spendCoveredSince || settings.spendCoveredSince > objetivoDeHistorial(settings, hoy);
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
  const summary: SyncSummary = {
    skipped: null,
    synced: 0,
    notFound: 0,
    spendAds: 0,
    catalogAds: 0,
    windows: 0,
    creatives: 0,
    stopped: null,
  };
  try {
    const settings = await getMetaAdsSettings(organizationId);
    if (!settings) return { ...summary, skipped: "sin_credenciales" };
    if (settings.status === "error") return { ...summary, skipped: "error" };
    const now = deps.now();
    if (settings.pausedUntil && settings.pausedUntil > now) return { ...summary, skipped: "pausa" };

    const ctx: Ctx = { organizationId, settings, deps, now, summary, regainMs: null, recovered: false };
    await refreshStale(organizationId, now);

    // 039 — Primero la cuenta entera: lo que el listado resuelve ya no necesita consulta suelta.
    const catalogoVencido =
      opts.forceSpend ||
      !settings.catalogSyncedAt ||
      now.getTime() - settings.catalogSyncedAt.getTime() >= CATALOG_EVERY_MS;
    if (catalogoVencido) await syncCatalog(ctx);
    if (!summary.stopped) await syncLookups(ctx);
    // 040 — Las imágenes de los creativos: red y disco locales, nunca frenan lo demás.
    if (!summary.stopped) {
      const c = await syncCreatives(organizationId, { descargar: deps.descargar });
      summary.creatives = c.downloaded;
    }

    const debe =
      opts.forceSpend ||
      !settings.lastSpendSyncAt ||
      now.getTime() - settings.lastSpendSyncAt.getTime() >= SPEND_EVERY_MS ||
      hayRellenoPendiente(settings, now);
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
