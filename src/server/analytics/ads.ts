import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  comparable,
  rate,
  type AdRowDto,
  type AdsBlockDto,
  type SourceKey,
  type SourceRowDto,
} from "@/lib/analytics";
import { agendaEnabled } from "@/server/agenda/flag";
import { atribucionEnabled } from "@/server/attribution/flag";
import { SOURCE_LABELS, SOURCE_VALUES } from "@/server/contact-source";
import {
  armarJerarquia,
  cargarCatalogo,
  cargarCitasPorAnuncio,
  cargarEstado,
  cargarGasto,
  CONSULTA_POR_DEFECTO,
  leerCobertura,
  type AdsQuery,
} from "@/server/analytics/ads-hierarchy";
import { requestSpendBackfill } from "@/server/attribution/meta-ads/settings";
import type { ResolvedPeriod } from "@/server/analytics/period";
import {
  effectiveSourceExpr,
  firstAttributionIdExpr,
  notLabContact,
} from "@/server/analytics/shared";

/**
 * 019 — De dónde llegan: por origen y por anuncio, SOLO en conteos.
 *
 * Sin gasto ni costo ni retorno (spec 019, D1-D2): lo único que el raíz sabe
 * de un anuncio es lo que Meta manda en el `referral` del webhook y la 018 ya
 * guarda. Contar conversaciones, prospectos y ventas no pide la API de
 * Marketing ni un conector.
 *
 * Tres conteos por fila, con significados que no se mezclan:
 *  - conversaciones: las que EMPEZARON en el periodo;
 *  - prospectos: los leads creados en el periodo;
 *  - ventas: de esos prospectos, los que hoy están en Ganado. Es una cohorte a
 *    propósito: así «ventas ÷ prospectos» es la conversión de la fila y no
 *    puede pasar de 100 %.
 */

const FUENTES: readonly SourceKey[] = [...SOURCE_VALUES, "desconocida"];

/** Cuántas filas enseña la tabla por anuncio: más no se lee en una pantalla. */
export const MAX_ANUNCIOS = 50;

export async function adsBlock(
  organizationId: string,
  period: ResolvedPeriod,
  query: AdsQuery = CONSULTA_POR_DEFECTO
): Promise<AdsBlockDto> {
  const [convsPorFuente, leadsPorFuente, convsPorAnuncio, leadsPorAnuncio, previas] =
    await Promise.all([
      conversacionesPorFuente(organizationId, period.start, period.end),
      prospectosPorFuente(organizationId, period.start, period.end),
      conversacionesPorAnuncio(organizationId, period.start, period.end),
      prospectosPorAnuncio(organizationId, period.start, period.end),
      contarConversaciones(organizationId, period.previousStart, period.previousEnd),
    ]);

  const sources = unirFuentes(convsPorFuente, leadsPorFuente);
  const todos = unirAnunciosTodos(convsPorAnuncio, leadsPorAnuncio);
  const ads = recortar(todos);
  const conversaciones = sources.reduce((a, s) => a + s.conversations, 0);
  const deAnuncio = sources.find((s) => s.value === "anuncio")?.conversations ?? 0;
  const prospectos = sources.reduce((a, s) => a + s.leads, 0);

  const base: AdsBlockDto = {
    period: period.dto,
    conversations: comparable(conversaciones, previas),
    adShare: rate(deAnuncio, conversaciones),
    sources,
    ads,
    empty: conversaciones === 0 && prospectos === 0,
  };

  // Sin la bandera `ATRIBUCION` el bloque es exactamente el de 019: ni una clave más.
  if (!atribucionEnabled()) return base;

  // 038 — La jerarquía de la Marketing API y el gasto. Si falla, el bloque de 019 sale igual:
  // el conector es contexto, los conteos no dependen de él.
  try {
    const [catalog, spend, bookings] = await Promise.all([
      cargarCatalogo(organizationId),
      cargarGasto(organizationId, period),
      agendaEnabled() ? cargarCitasPorAnuncio(organizationId, period) : Promise.resolve(null),
    ]);
    const out = armarJerarquia({ rows: todos, catalog, spend, bookings, query, maxAds: MAX_ANUNCIOS });
    const moneda = [...spend.values()][0]?.currencies[0] ?? null;

    // 039 — Un rango más viejo que lo ya traído de Meta encarga el relleno (un UPDATE local: la ruta no espera a Meta).
    const cobertura = await leerCobertura(organizationId, period);
    if (cobertura.needsRequest) await requestSpendBackfill(organizationId, period.dto.from).catch(() => {});
    const listedSpend = [...spend.values()].reduce((a, s) => a + s.amount, 0);
    const hierarchy = await cargarEstado(organizationId, catalog, out.mixedCurrency, moneda, {
      period,
      listedSpend,
      syncing: cobertura.syncing,
    });
    return {
      ...base,
      ads: out.ads,
      total: out.total,
      selectedCount: out.selectedCount,
      hierarchy,
      groupBy: query.group,
      groups: out.groups,
      campaigns: out.campaigns,
      adsets: out.adsets,
      // Con gasto sin una sola conversación el bloque no está vacío.
      empty: base.empty && out.ads.length === 0,
    };
  } catch (err) {
    console.warn(
      "[resultados] la jerarquía de anuncios no se pudo calcular:",
      err instanceof Error ? err.message : err
    );
    return base;
  }
}

type Conteo = { key: string | null; n: number };
type ConteoLeads = { key: string | null; leads: number; won: number };

/** Conversaciones reales que empezaron en el rango, por el origen del contacto. */
async function conversacionesPorFuente(
  organizationId: string,
  start: Date,
  end: Date
): Promise<Conteo[]> {
  return getDb()
    .select({
      key: effectiveSourceExpr(
        schema.conversation.organizationId,
        schema.conversation.contactId,
        schema.contact.source
      ),
      n: sql<number>`count(*)::int`,
    })
    .from(schema.conversation)
    .innerJoin(schema.contact, eq(schema.contact.id, schema.conversation.contactId))
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.isTest, false),
        gte(schema.conversation.createdAt, start),
        lt(schema.conversation.createdAt, end)
      )
    )
    .groupBy(sql`1`);
}

async function contarConversaciones(
  organizationId: string,
  start: Date,
  end: Date
): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.isTest, false),
        gte(schema.conversation.createdAt, start),
        lt(schema.conversation.createdAt, end)
      )
    );
  return rows[0]?.n ?? 0;
}

/** Prospectos creados en el rango y cuántos de ellos están hoy en Ganado. */
async function prospectosPorFuente(
  organizationId: string,
  start: Date,
  end: Date
): Promise<ConteoLeads[]> {
  return getDb()
    .select({
      key: effectiveSourceExpr(
        schema.lead.organizationId,
        schema.lead.contactId,
        schema.contact.source
      ),
      leads: sql<number>`count(*)::int`,
      won: sql<number>`count(*) filter (where ${schema.pipelineStage.kind} = 'won')::int`,
    })
    .from(schema.lead)
    .innerJoin(schema.contact, eq(schema.contact.id, schema.lead.contactId))
    .innerJoin(schema.pipelineStage, eq(schema.pipelineStage.id, schema.lead.stageId))
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        gte(schema.lead.createdAt, start),
        lt(schema.lead.createdAt, end),
        notLabContact(schema.lead.contactId)
      )
    )
    .groupBy(sql`1`);
}

/** Las filas por anuncio: la llave es el `source_id`, o la fila si no hay. */
const llave = sql<string>`coalesce(${schema.adAttribution.sourceId}, ${schema.adAttribution.id})`;
const metadatos = {
  sourceId: sql<string | null>`max(${schema.adAttribution.sourceId})`,
  sourceType: sql<string | null>`max(${schema.adAttribution.sourceType})`,
  headline: sql<string | null>`max(${schema.adAttribution.headline})`,
  imageAssetId: sql<string | null>`max(${schema.adAttribution.imageAssetId})`,
  lastAt: sql<number>`extract(epoch from max(${schema.adAttribution.createdAt}))::float`,
};

type Metadatos = {
  key: string;
  sourceId: string | null;
  sourceType: string | null;
  headline: string | null;
  imageAssetId: string | null;
  lastAt: number;
};

/**
 * Conversaciones reales que empezaron en el rango, por el anuncio que las
 * abrió. Cada fila de `ad_attribution` es de UNA conversación (el primer
 * anuncio gana, 016), así que no hay doble conteo.
 */
async function conversacionesPorAnuncio(
  organizationId: string,
  start: Date,
  end: Date
): Promise<(Metadatos & { conversations: number })[]> {
  return getDb()
    .select({
      key: llave,
      ...metadatos,
      conversations: sql<number>`count(*)::int`,
    })
    .from(schema.adAttribution)
    .innerJoin(
      schema.conversation,
      and(
        eq(schema.conversation.id, schema.adAttribution.conversationId),
        eq(schema.conversation.isTest, false)
      )
    )
    .where(
      scoped(
        schema.adAttribution.organizationId,
        organizationId,
        gte(schema.conversation.createdAt, start),
        lt(schema.conversation.createdAt, end)
      )
    )
    .groupBy(llave);
}

/**
 * Prospectos del periodo por el anuncio que los trajo, y cuántos están hoy en
 * Ganado.
 *
 * Cada contacto cuenta UNA vez, con su PRIMER anuncio (el que enseña su
 * ficha): unir contra todas sus filas lo contaría dos veces si escribió desde
 * dos conversaciones.
 */
async function prospectosPorAnuncio(
  organizationId: string,
  start: Date,
  end: Date
): Promise<(Metadatos & { leads: number; won: number })[]> {
  return getDb()
    .select({
      key: llave,
      ...metadatos,
      leads: sql<number>`count(*)::int`,
      won: sql<number>`count(*) filter (where ${schema.pipelineStage.kind} = 'won')::int`,
    })
    .from(schema.lead)
    .innerJoin(schema.pipelineStage, eq(schema.pipelineStage.id, schema.lead.stageId))
    .innerJoin(
      schema.adAttribution,
      and(
        eq(schema.adAttribution.organizationId, schema.lead.organizationId),
        eq(schema.adAttribution.contactId, schema.lead.contactId),
        sql`${schema.adAttribution.id} = ${firstAttributionIdExpr(
          schema.lead.organizationId,
          schema.lead.contactId
        )}`
      )
    )
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        gte(schema.lead.createdAt, start),
        lt(schema.lead.createdAt, end),
        notLabContact(schema.lead.contactId)
      )
    )
    .groupBy(llave);
}

/** Las seis fuentes en su orden fijo, solo las que tienen algo. */
export function unirFuentes(convs: Conteo[], leads: ConteoLeads[]): SourceRowDto[] {
  const conv = new Map(convs.map((c) => [c.key ?? "desconocida", c.n]));
  const lead = new Map(leads.map((l) => [l.key ?? "desconocida", l]));

  return FUENTES.map((value) => {
    const l = lead.get(value);
    const won = l?.won ?? 0;
    const leadsN = l?.leads ?? 0;
    return {
      value,
      label: SOURCE_LABELS[value],
      conversations: conv.get(value) ?? 0,
      leads: leadsN,
      won,
      winRate: rate(won, leadsN),
    };
  }).filter((f) => f.conversations > 0 || f.leads > 0);
}

/**
 * Une las dos vistas por anuncio. Más conversaciones primero; a igualdad, más
 * prospectos, y luego el anuncio que trajo a alguien más recientemente, que
 * es el que el dueño está mirando.
 */
export function unirAnuncios(
  convs: (Metadatos & { conversations: number })[],
  leads: (Metadatos & { leads: number; won: number })[]
): AdRowDto[] {
  return recortar(unirAnunciosTodos(convs, leads));
}

/** Las filas ya ordenadas, sin recortar y con su último instante (la jerarquía las necesita todas). */
export function unirAnunciosTodos(
  convs: (Metadatos & { conversations: number })[],
  leads: (Metadatos & { leads: number; won: number })[]
): (AdRowDto & { lastAt: number })[] {
  const filas = new Map<string, AdRowDto & { lastAt: number }>();
  const base = (m: Metadatos) => ({
    key: m.key,
    sourceId: m.sourceId,
    sourceType: m.sourceType,
    headline: m.headline,
    imageAssetId: m.imageAssetId,
    lastAt: m.lastAt,
    conversations: 0,
    leads: 0,
    won: 0,
    winRate: rate(0, 0),
  });

  for (const c of convs) {
    filas.set(c.key, { ...base(c), conversations: c.conversations });
  }
  for (const l of leads) {
    const fila = filas.get(l.key) ?? base(l);
    fila.leads = l.leads;
    fila.won = l.won;
    fila.winRate = rate(l.won, l.leads);
    // La imagen se descarga una vez por anuncio y puede llegar después: la que
    // haya, de cualquiera de las dos vistas.
    fila.imageAssetId ??= l.imageAssetId;
    fila.headline ??= l.headline;
    if (l.lastAt > fila.lastAt) fila.lastAt = l.lastAt;
    filas.set(l.key, fila);
  }

  return [...filas.values()].sort(
    (a, b) =>
      b.conversations - a.conversations ||
      b.leads - a.leads ||
      b.lastAt - a.lastAt
  );
}

function recortar(filas: (AdRowDto & { lastAt: number })[]): AdRowDto[] {
  return filas.slice(0, MAX_ANUNCIOS).map(({ lastAt: _lastAt, ...fila }) => fila);
}
