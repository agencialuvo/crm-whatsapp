import { and, between, eq, gte, lt, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  costOf,
  cuadrarCuenta,
  estadoDeAnuncio,
  estadoDeGrupo,
  rate,
  type AdGroupBy,
  type AdGroupRowDto,
  type AdCreativeDto,
  type AdRowDto,
  type AdStatus,
  type AdsHierarchyDto,
  type AdTotalDto,
  type SpendDto,
} from "@/lib/analytics";
import { safePreviewLink } from "@/lib/meta/ads";
import { countsByStatus } from "@/server/attribution/meta-ads/catalog";
import type { ResolvedPeriod } from "@/server/analytics/period";
import { firstAttributionIdExpr, notLabContact } from "@/server/analytics/shared";

/**
 * 038 — Campaña › Conjunto › Anuncio y gasto sobre los conteos de 019.
 *
 * Dos mitades a propósito: cargadores de base de datos al final, y una función
 * PURA (`armarJerarquia`) que combina lo cargado. Así cada regla —qué fila
 * aparece, cuándo un costo es «—», cómo se agrupa— se prueba sin base.
 *
 * Reglas que no se mezclan (spec 038, D9):
 *  - el gasto de una fila es la suma de sus días del rango; sin ningún día
 *    registrado es `null`, no 0;
 *  - un costo es `gasto ÷ resultados` y es `null` si falta el gasto o el
 *    denominador es 0;
 *  - al agrupar, el denominador cuenta solo los anuncios CON gasto conocido: con
 *    los demás el costo saldría más barato de lo que fue.
 */

export const SIN_IDENTIFICAR = "sin-identificar";
export const MAX_GRUPOS = 100;

export type AdsQuery = {
  group: AdGroupBy;
  /** Id de campaña, o `sin-identificar`. */
  campaignId: string | null;
  adsetId: string | null;
  /** 040 — Varias campañas / conjuntos (unión). Si se dan, mandan sobre `campaignId` / `adsetId`. */
  campaignIds?: string[] | null;
  adsetIds?: string[] | null;
  /** 040 — Llaves marcadas en la pestaña actual (campaña, conjunto o anuncio según `group`): solo para el Total. */
  selected?: string[] | null;
};

export const CONSULTA_POR_DEFECTO: AdsQuery = { group: "ad", campaignId: null, adsetId: null };

export type CatalogEntry = {
  adId: string;
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  /** 039 — `effective_status` de Meta, tal cual. */
  effectiveStatus?: string | null;
  /** 040 — El creativo copiado y sus textos. */
  creativeAssetId?: string | null;
  creativeTitle?: string | null;
  creativeBody?: string | null;
  previewLink?: string | null;
};

export type SpendEntry = { amount: number; currencies: string[] };

export type FilaConInstante = AdRowDto & { lastAt: number };

export type HierarchyInput = {
  rows: FilaConInstante[];
  catalog: Map<string, CatalogEntry>;
  spend: Map<string, SpendEntry>;
  /** `null` con la agenda apagada: ni citas ni costo por cita. */
  bookings: Map<string, number> | null;
  query: AdsQuery;
  maxAds: number;
};

export type HierarchyOutput = {
  ads: AdRowDto[];
  groups: AdGroupRowDto[];
  campaigns: { id: string; name: string }[];
  adsets: { id: string; name: string; campaignId: string | null }[];
  mixedCurrency: boolean;
  /** 039 — Total de TODAS las filas del filtro (la lista de anuncios muestra solo las primeras). */
  total: AdTotalDto;
  /** 040 — Cuántas filas marcadas se encontraron (0 = el Total es el de toda la vista). */
  selectedCount: number;
};

/** 040 — La llave de una fila en su pestaña: lo que las casillas guardan y `selected` manda. */
export function llaveDeFila(
  group: AdGroupBy,
  r: { key: string; campaignId?: string | null; adsetId?: string | null }
): string {
  if (group === "campaign") return r.campaignId ?? SIN_IDENTIFICAR;
  if (group === "adset") return r.adsetId ?? SIN_IDENTIFICAR;
  return r.key;
}

/** 040 — Los ids de filtro de una consulta: la lista si viene, o el valor único de 039. */
function idsDe(lista: string[] | null | undefined, unico: string | null): string[] | null {
  if (lista && lista.length > 0) return lista;
  return unico ? [unico] : null;
}

const SIN_COSTOS: SpendDto = {
  spend: null,
  costPerConversation: null,
  costPerLead: null,
  costPerBooking: null,
};

function redondear(n: number): number {
  return Math.round(n * 100) / 100;
}

function costos(
  spend: number | null,
  base: { conversations: number; leads: number; bookings: number | null }
): SpendDto {
  if (spend === null) return SIN_COSTOS;
  return {
    spend: redondear(spend),
    costPerConversation: costOf(spend, base.conversations),
    costPerLead: costOf(spend, base.leads),
    costPerBooking: costOf(spend, base.bookings),
  };
}

export function armarJerarquia(i: HierarchyInput): HierarchyOutput {
  const monedas = new Set<string>();
  for (const s of i.spend.values()) for (const c of s.currencies) monedas.add(c);
  const mixedCurrency = monedas.size > 1;

  // 1. Las filas de 019 más los anuncios que solo tienen gasto (dinero sin una sola conversación).
  const porClave = new Map<string, FilaConInstante>();
  for (const r of i.rows) porClave.set(r.key, r);
  for (const [adId] of i.spend) {
    if (porClave.has(adId)) continue;
    const nombre = i.catalog.get(adId)?.adName ?? null;
    porClave.set(adId, {
      key: adId,
      sourceId: adId,
      sourceType: "ad",
      headline: nombre,
      imageAssetId: null,
      conversations: 0,
      leads: 0,
      won: 0,
      winRate: rate(0, 0),
      lastAt: 0,
    });
  }

  // 2. Jerarquía, citas y gasto de cada fila.
  const enriquecidas = [...porClave.values()].map((r) => {
    const cat = r.sourceId ? i.catalog.get(r.sourceId) : undefined;
    const gasto = i.spend.get(r.key) ?? (r.sourceId ? i.spend.get(r.sourceId) : undefined);
    const bookings = i.bookings ? (i.bookings.get(r.key) ?? 0) : null;
    const spend = gasto && !mixedCurrency ? gasto.amount : null;
    return {
      ...r,
      adName: cat?.adName ?? null,
      adsetId: cat?.adsetId ?? null,
      adsetName: cat?.adsetName ?? null,
      campaignId: cat?.campaignId ?? null,
      campaignName: cat?.campaignName ?? null,
      status: estadoDeAnuncio(cat?.effectiveStatus),
      creative: creativoDe(cat),
      bookings,
      ...costos(spend, { conversations: r.conversations, leads: r.leads, bookings }),
    };
  });

  // 3. Opciones de los filtros: lo que hay en el rango, sin filtrar todavía.
  const campaigns = new Map<string, string>();
  const adsets = new Map<string, { name: string; campaignId: string | null }>();
  for (const r of enriquecidas) {
    if (r.campaignId) campaigns.set(r.campaignId, r.campaignName ?? r.campaignId);
    if (r.adsetId) adsets.set(r.adsetId, { name: r.adsetName ?? r.adsetId, campaignId: r.campaignId });
  }

  // 4. Filtros.
  // Unión de ids (040): una fila coincide si su valor está en la lista; `sin-identificar` es «sin campaña/conjunto».
  const coincide = (valor: string | null, filtro: string[] | null) =>
    filtro === null || filtro.includes(valor ?? SIN_IDENTIFICAR);
  const filtroCampanas = idsDe(i.query.campaignIds, i.query.campaignId);
  const filtroConjuntos = idsDe(i.query.adsetIds, i.query.adsetId);
  const filtradas = enriquecidas.filter(
    (r) => coincide(r.campaignId, filtroCampanas) && coincide(r.adsetId, filtroConjuntos)
  );

  const ordenadas = [...filtradas].sort(
    (a, b) =>
      b.conversations - a.conversations ||
      b.leads - a.leads ||
      (b.spend ?? -1) - (a.spend ?? -1) ||
      b.lastAt - a.lastAt
  );

  const ads: AdRowDto[] = ordenadas.slice(0, i.maxAds).map(({ lastAt: _lastAt, ...fila }) => fila);
  // 040 — Con filas marcadas en esta pestaña el Total es el de ellas; si ninguna marcada existe ya (cambió el rango o el
  // filtro), el de toda la vista en vez de ceros.
  const marcadas = new Set(i.query.selected ?? []);
  const deLaSeleccion = marcadas.size > 0 ? filtradas.filter((r) => marcadas.has(llaveDeFila(i.query.group, r))) : [];
  const total = totalDeFilas(deLaSeleccion.length > 0 ? deLaSeleccion : filtradas, i.bookings !== null);

  // 5. Agrupar por conjunto o campaña.
  let groups: AdGroupRowDto[] = [];
  if (i.query.group !== "ad") {
    const nivel = i.query.group;
    type Acum = {
      key: string;
      name: string;
      campaignName: string | null;
      campaignId: string | null;
      estados: AdStatus[];
      ads: number;
      conversations: number;
      leads: number;
      won: number;
      bookings: number | null;
      spend: number | null;
      cConv: number;
      cLeads: number;
      cBook: number | null;
    };
    const acum = new Map<string, Acum>();
    for (const r of filtradas) {
      const id = nivel === "campaign" ? r.campaignId : r.adsetId;
      const key = id ?? SIN_IDENTIFICAR;
      const name = id
        ? ((nivel === "campaign" ? r.campaignName : r.adsetName) ?? id)
        : "Sin identificar";
      const g =
        acum.get(key) ??
        ({
          key,
          name,
          campaignName: nivel === "adset" ? r.campaignName : null,
          campaignId: nivel === "adset" ? r.campaignId : null,
          estados: [],
          ads: 0,
          conversations: 0,
          leads: 0,
          won: 0,
          bookings: i.bookings ? 0 : null,
          spend: null,
          cConv: 0,
          cLeads: 0,
          cBook: i.bookings ? 0 : null,
        } satisfies Acum);
      g.ads += 1;
      g.estados.push(r.status ?? null);
      g.conversations += r.conversations;
      g.leads += r.leads;
      g.won += r.won;
      if (g.bookings !== null) g.bookings += r.bookings ?? 0;
      if (r.spend !== null && r.spend !== undefined) {
        g.spend = (g.spend ?? 0) + r.spend;
        g.cConv += r.conversations;
        g.cLeads += r.leads;
        if (g.cBook !== null) g.cBook += r.bookings ?? 0;
      }
      acum.set(key, g);
    }
    groups = [...acum.values()]
      .map((g): AdGroupRowDto => ({
        key: g.key,
        level: nivel,
        name: g.name,
        campaignName: g.campaignName,
        campaignId: g.campaignId,
        status: estadoDeGrupo(g.estados),
        ads: g.ads,
        conversations: g.conversations,
        leads: g.leads,
        won: g.won,
        winRate: rate(g.won, g.leads),
        bookings: g.bookings,
        ...costos(g.spend, { conversations: g.cConv, leads: g.cLeads, bookings: g.cBook }),
      }))
      .sort(
        (a, b) =>
          b.conversations - a.conversations ||
          (b.spend ?? -1) - (a.spend ?? -1) ||
          a.name.localeCompare(b.name, "es")
      )
      .slice(0, MAX_GRUPOS);
  }

  return {
    ads,
    groups,
    campaigns: [...campaigns].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "es")),
    adsets: [...adsets]
      .map(([id, v]) => ({ id, name: v.name, campaignId: v.campaignId }))
      .sort((a, b) => a.name.localeCompare(b.name, "es")),
    mixedCurrency,
    total,
    // Cuántas FILAS de la pestaña (campañas, conjuntos o anuncios) quedaron marcadas, no cuántos anuncios las componen.
    selectedCount: new Set(deLaSeleccion.map((r) => llaveDeFila(i.query.group, r))).size,
  };
}

function creativoDe(cat: CatalogEntry | undefined): AdCreativeDto | null {
  if (!cat) return null;
  const c: AdCreativeDto = {
    assetId: cat.creativeAssetId ?? null,
    title: cat.creativeTitle ?? null,
    body: cat.creativeBody ?? null,
    previewLink: safePreviewLink(cat.previewLink),
  };
  return c.assetId || c.title || c.body || c.previewLink ? c : null;
}

/**
 * 039 — El total de las filas que se ven: conteos sumados y costos con las MISMAS reglas que cada fila
 * (solo cuentan, como denominador, las filas con gasto conocido; sin gasto o sin resultados, «—»).
 */
export function totalDeFilas(
  filas: readonly { conversations: number; leads: number; won: number; bookings: number | null; spend?: number | null }[],
  conCitas: boolean
): AdTotalDto {
  let conversations = 0;
  let leads = 0;
  let won = 0;
  let bookings = 0;
  let spend: number | null = null;
  let cConv = 0;
  let cLeads = 0;
  let cBook = 0;
  for (const r of filas) {
    conversations += r.conversations;
    leads += r.leads;
    won += r.won;
    bookings += r.bookings ?? 0;
    if (r.spend !== null && r.spend !== undefined) {
      spend = (spend ?? 0) + r.spend;
      cConv += r.conversations;
      cLeads += r.leads;
      cBook += r.bookings ?? 0;
    }
  }
  return {
    ads: filas.length,
    conversations,
    leads,
    won,
    bookings: conCitas ? bookings : null,
    ...costos(spend, { conversations: cConv, leads: cLeads, bookings: conCitas ? cBook : null }),
  };
}

/* ── Cargadores ─────────────────────────────────────────────────── */

export async function cargarCatalogo(organizationId: string): Promise<Map<string, CatalogEntry>> {
  const filas = await getDb()
    .select({
      adId: schema.metaAd.adId,
      adName: schema.metaAd.adName,
      adsetId: schema.metaAd.adsetId,
      adsetName: schema.metaAd.adsetName,
      campaignId: schema.metaAd.campaignId,
      campaignName: schema.metaAd.campaignName,
      effectiveStatus: schema.metaAd.effectiveStatus,
      creativeAssetId: schema.metaAd.creativeAssetId,
      creativeTitle: schema.metaAd.creativeTitle,
      creativeBody: schema.metaAd.creativeBody,
      previewLink: schema.metaAd.previewLink,
    })
    .from(schema.metaAd)
    .where(scoped(schema.metaAd.organizationId, organizationId, eq(schema.metaAd.status, "synced")));
  return new Map(filas.map((f) => [f.adId, f]));
}

/** Gasto por anuncio en las fechas locales del periodo (inclusivas). */
export async function cargarGasto(
  organizationId: string,
  period: ResolvedPeriod
): Promise<Map<string, SpendEntry>> {
  const filas = await getDb()
    .select({
      adId: schema.metaAdSpend.adId,
      amount: sql<string>`sum(${schema.metaAdSpend.spend})::text`,
      currencies: sql<string[]>`array_agg(distinct ${schema.metaAdSpend.currency})`,
    })
    .from(schema.metaAdSpend)
    .where(
      scoped(
        schema.metaAdSpend.organizationId,
        organizationId,
        between(schema.metaAdSpend.day, period.dto.from, period.dto.to)
      )
    )
    .groupBy(schema.metaAdSpend.adId);
  return new Map(filas.map((f) => [f.adId, { amount: Number(f.amount), currencies: f.currencies }]));
}

/**
 * Citas agendadas en el periodo por quienes llegaron de cada anuncio (su PRIMER
 * anuncio, como en 019: un contacto cuenta una vez). Sin canceladas ni pruebas.
 */
export async function cargarCitasPorAnuncio(
  organizationId: string,
  period: ResolvedPeriod
): Promise<Map<string, number>> {
  const llave = sql<string>`coalesce(${schema.adAttribution.sourceId}, ${schema.adAttribution.id})`;
  const filas = await getDb()
    .select({ key: llave, n: sql<number>`count(*)::int` })
    .from(schema.booking)
    .innerJoin(
      schema.adAttribution,
      and(
        eq(schema.adAttribution.organizationId, schema.booking.organizationId),
        eq(schema.adAttribution.contactId, schema.booking.contactId),
        sql`${schema.adAttribution.id} = ${firstAttributionIdExpr(schema.booking.organizationId, schema.booking.contactId)}`
      )
    )
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.kind, "session"),
        eq(schema.booking.isTest, false),
        ne(schema.booking.status, "cancelada"),
        gte(schema.booking.createdAt, period.start),
        lt(schema.booking.createdAt, period.end),
        notLabContact(schema.booking.contactId)
      )
    )
    .groupBy(llave);
  return new Map(filas.map((f) => [f.key, f.n]));
}

/** ¿Dos zonas horarias dan la misma hora en ese instante? (México y Monterrey sí; Madrid no). */
export function mismoHuso(a: string, b: string, at: Date): boolean {
  if (a === b) return true;
  try {
    const f = (tz: string) =>
      new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")?.value;
    return f(a) === f(b);
  } catch {
    return true;
  }
}

/** Gasto total de la cuenta en el periodo (lo que Meta dice), o null si no se ha traído. */
export async function cargarGastoCuenta(
  organizationId: string,
  period: ResolvedPeriod
): Promise<{ amount: number; currencies: string[] } | null> {
  const [fila] = await getDb()
    .select({
      amount: sql<string | null>`sum(${schema.metaAccountSpend.spend})::text`,
      currencies: sql<string[]>`coalesce(array_agg(distinct ${schema.metaAccountSpend.currency}), '{}')`,
      dias: sql<number>`count(*)::int`,
    })
    .from(schema.metaAccountSpend)
    .where(
      scoped(
        schema.metaAccountSpend.organizationId,
        organizationId,
        between(schema.metaAccountSpend.day, period.dto.from, period.dto.to)
      )
    );
  if (!fila || fila.dias === 0 || fila.amount === null) return null;
  return { amount: Number(fila.amount), currencies: fila.currencies };
}

/**
 * 039 — ¿Resultados pide un rango que empieza antes de lo que ya se trajo de Meta? Una consulta local; la ruta
 * NUNCA llama a Meta. Devuelve el estado de cobertura para pintar «trayendo…» y para encargar el relleno.
 */
export async function leerCobertura(
  organizationId: string,
  period: ResolvedPeriod
): Promise<{ connected: boolean; syncing: boolean; needsRequest: boolean }> {
  const [s] = await getDb()
    .select({
      status: schema.metaAdsSettings.status,
      covered: schema.metaAdsSettings.spendCoveredSince,
      requested: schema.metaAdsSettings.spendBackfillFrom,
    })
    .from(schema.metaAdsSettings)
    .where(scoped(schema.metaAdsSettings.organizationId, organizationId))
    .limit(1);
  if (!s) return { connected: false, syncing: false, needsRequest: false };
  if (s.status === "error") return { connected: true, syncing: false, needsRequest: false };
  const faltaCubrir = s.covered === null || period.dto.from < s.covered;
  const yaPedido = s.requested !== null && s.requested <= period.dto.from;
  return { connected: true, syncing: faltaCubrir, needsRequest: faltaCubrir && !yaPedido };
}

/** El estado del conector para la pantalla: sin descifrar nada. */
export async function cargarEstado(
  organizationId: string,
  catalog: Map<string, CatalogEntry>,
  mixedCurrency: boolean,
  monedaDelGasto: string | null,
  contexto?: { period: ResolvedPeriod; listedSpend: number; syncing: boolean }
): Promise<AdsHierarchyDto> {
  const filas = await getDb()
    .select({
      status: schema.metaAdsSettings.status,
      lastError: schema.metaAdsSettings.lastError,
      currency: schema.metaAdsSettings.currency,
      lastSpendSyncAt: schema.metaAdsSettings.lastSpendSyncAt,
      timezone: schema.metaAdsSettings.accountTimezone,
    })
    .from(schema.metaAdsSettings)
    .where(scoped(schema.metaAdsSettings.organizationId, organizationId))
    .limit(1);
  const s = filas[0];
  const counts = s ? await countsByStatus(organizationId) : { pending: 0, failed: 0 };

  let account: AdsHierarchyDto["account"] = null;
  let timezoneNote: string | null = null;
  if (s && contexto) {
    const cuenta = await cargarGastoCuenta(organizationId, contexto.period);
    if (cuenta && cuenta.currencies.length <= 1 && !mixedCurrency) {
      account = cuadrarCuenta(cuenta.amount, contexto.listedSpend);
    }
    if (s.timezone && !mismoHuso(s.timezone, contexto.period.timezone, contexto.period.start)) {
      timezoneNote = `Meta corta los días en ${s.timezone} y tu negocio en ${contexto.period.timezone}: el gasto de un día puede no coincidir al centavo con el de tu Administrador de Anuncios.`;
    }
  }

  return {
    connected: !!s,
    problem: s?.status === "error" ? (s.lastError ?? "El conector tiene un problema") : null,
    currency: s?.currency ?? monedaDelGasto,
    lastSyncAt: s?.lastSpendSyncAt?.toISOString() ?? null,
    pending: counts.pending,
    mixedCurrency,
    hasData: catalog.size > 0,
    syncing: contexto?.syncing ?? false,
    account,
    timezoneNote,
  };
}
