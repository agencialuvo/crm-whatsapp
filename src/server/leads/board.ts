import { and, asc, eq, gt, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { encodeColumnCursor, type ColumnCursor } from "@/lib/pipeline-cursor";
import type { AutoStageRule, BoardFiltersDto, BoardLeadDto, BoardStageDto, StageTotalsDto } from "@/lib/types";
import { busquedaDeContacto, busquedaEnMensajes } from "@/server/search-sql";

/**
 * 044 — Las consultas del tablero del Pipeline.
 *
 * Una columna se pide por CURSOR sobre `(position, id)` (índice `lead_board_idx`): sin OFFSET, sin repetir
 * ni saltarse tarjetas, y el costo no crece con la profundidad. Los conteos y las sumas por columna los
 * calcula el servidor en UNA consulta agrupada y respetan los filtros: el cliente ya no suma lo que tiene.
 */

export const COLUMN_PAGE_DEFAULT = 25;
export const COLUMN_PAGE_MAX = 50;
export const BOARD_DELTA_MAX = 200;
/** Margen de solape del delta: una fila confirmada justo antes de `serverTime` no se pierde (el upsert es idempotente). */
const DELTA_OVERLAP_MS = 2000;

export type BoardFilters = BoardFiltersDto;

/** La conversación real (no del Laboratorio) del contacto de la tarjeta. Un contacto tiene a lo más una. */
const conversationOf = sql<string | null>`(
  select c.id from conversation c
  where c.organization_id = ${schema.lead.organizationId}
    and c.contact_id = ${schema.lead.contactId}
    and c.is_test = false
  limit 1
)`;

/** La última regla automática que movió el lead (si fue la última cosa que le pasó). */
const lastAutoRuleOf = sql<AutoStageRule | null>`(
  select e.auto_rule from lead_stage_event e
  where e.lead_id = ${schema.lead.id}
  order by e.occurred_at desc, e.id desc
  limit 1
)`;

/** Las condiciones de los filtros sobre `lead ⨝ contact`. Misma búsqueda que la Bandeja (nombre, teléfono, mensajes). */
function condicionesDeFiltros(f: BoardFilters): SQL | undefined {
  const parts: (SQL | undefined)[] = [];
  const q = f.q?.trim();
  if (q) {
    parts.push(
      or(
        busquedaDeContacto(schema.contact.name, schema.contact.phone, q),
        busquedaEnMensajes(conversationOf, q)
      )
    );
  }
  if (f.priority === "sin") parts.push(sql`${schema.lead.priority} is null`);
  else if (f.priority) parts.push(eq(schema.lead.priority, f.priority));
  if (f.tag) {
    parts.push(sql`exists (
      select 1 from contact_tag ct
      where ct.contact_id = ${schema.contact.id} and ct.tag_id = ${f.tag}
    )`);
  }
  if (f.channel) parts.push(eq(schema.contact.channel, f.channel));
  const real = parts.filter((p): p is SQL => p !== undefined);
  return real.length ? and(...real) : undefined;
}

function seleccionarTarjetas() {
  return getDb()
    .select({
      lead: schema.lead,
      contact: schema.contact,
      conversationId: conversationOf,
      lastAutoRule: lastAutoRuleOf,
    })
    .from(schema.lead)
    .innerJoin(schema.contact, eq(schema.lead.contactId, schema.contact.id));
}

type FilaTarjeta = Awaited<ReturnType<ReturnType<typeof seleccionarTarjetas>["limit"]>>[number];

export function aTarjeta(r: FilaTarjeta): BoardLeadDto {
  return {
    id: r.lead.id,
    stageId: r.lead.stageId,
    position: r.lead.position,
    lastActivityAt: r.lead.lastActivityAt?.toISOString() ?? null,
    contact: { id: r.contact.id, name: r.contact.name, phone: r.contact.phone },
    channel: r.contact.channel,
    conversationId: r.conversationId ?? null,
    amountCents: r.lead.amountCents,
    currency: r.lead.currency,
    priority: r.lead.priority,
    lastAutoRule: r.lastAutoRule ?? null,
  };
}

/** Una página de una columna. `cursor` ya validado (o null para la primera). */
export async function listColumnPage(
  organizationId: string,
  stageId: string,
  opts: { limit?: number; cursor?: ColumnCursor | null; filters?: BoardFilters }
): Promise<{ leads: BoardLeadDto[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? COLUMN_PAGE_DEFAULT, 1), COLUMN_PAGE_MAX);
  const c = opts.cursor;
  const rows = await seleccionarTarjetas()
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        and(
          eq(schema.lead.stageId, stageId),
          c
            ? or(
                gt(schema.lead.position, c.p),
                and(eq(schema.lead.position, c.p), gt(schema.lead.id, c.id))
              )
            : undefined,
          condicionesDeFiltros(opts.filters ?? {})
        )
      )
    )
    .orderBy(asc(schema.lead.position), asc(schema.lead.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    leads: page.map(aTarjeta),
    nextCursor: rows.length > limit && last ? encodeColumnCursor({ p: last.lead.position, id: last.lead.id }) : null,
  };
}

/** Conteos y sumas por etapa, con los filtros aplicados, en una sola consulta. Las etapas vacías salen en cero. */
export async function stageTotals(
  organizationId: string,
  businessCurrency: string,
  filters: BoardFilters = {}
): Promise<Map<string, StageTotalsDto>> {
  const rows = await getDb()
    .select({
      stageId: schema.lead.stageId,
      count: sql<number>`count(*)::int`,
      sumCents: sql<number>`coalesce(sum(${schema.lead.amountCents}) filter (
        where ${schema.lead.amountCents} is not null
          and coalesce(${schema.lead.currency}, ${businessCurrency}) = ${businessCurrency}
      ), 0)::bigint`.mapWith(Number),
      withoutAmount: sql<number>`count(*) filter (where ${schema.lead.amountCents} is null)::int`,
      otherCurrency: sql<number>`count(*) filter (
        where ${schema.lead.amountCents} is not null
          and coalesce(${schema.lead.currency}, ${businessCurrency}) <> ${businessCurrency}
      )::int`,
    })
    .from(schema.lead)
    .innerJoin(schema.contact, eq(schema.lead.contactId, schema.contact.id))
    .where(scoped(schema.lead.organizationId, organizationId, condicionesDeFiltros(filters)))
    .groupBy(schema.lead.stageId);
  const out = new Map<string, StageTotalsDto>();
  for (const r of rows) {
    out.set(r.stageId, {
      count: r.count,
      sumCents: r.sumCents,
      withoutAmount: r.withoutAmount,
      otherCurrency: r.otherCurrency,
    });
  }
  return out;
}

const VACIO: StageTotalsDto = { count: 0, sumCents: 0, withoutAmount: 0, otherCurrency: 0 };

/** El tablero completo: etapas con su total y su primera página. */
export async function boardSnapshot(
  organizationId: string,
  businessCurrency: string,
  opts: { limit?: number; filters?: BoardFilters } = {}
): Promise<BoardStageDto[]> {
  const db = getDb();
  const filters = opts.filters ?? {};
  const [stages, totals] = await Promise.all([
    db
      .select()
      .from(schema.pipelineStage)
      .where(scoped(schema.pipelineStage.organizationId, organizationId))
      .orderBy(asc(schema.pipelineStage.position)),
    stageTotals(organizationId, businessCurrency, filters),
  ]);
  const pages = await Promise.all(
    stages.map((s) => listColumnPage(organizationId, s.id, { limit: opts.limit, filters }))
  );
  return stages.map((s, i) => ({
    id: s.id,
    name: s.name,
    position: s.position,
    kind: s.kind,
    autoRole: s.autoRole,
    totals: totals.get(s.id) ?? VACIO,
    leads: pages[i]!.leads,
    nextCursor: pages[i]!.nextCursor,
  }));
}

export type BoardDelta = {
  /** Tarjetas que cambiaron. `matches` = siguen cumpliendo los filtros (si no, el cliente las retira). */
  changed: (BoardLeadDto & { matches: boolean })[];
  truncated: boolean;
  totals: Record<string, StageTotalsDto>;
};

/** Lo que cambió desde `since` (con solape de 2 s). Tope de 200: más allá, `truncated` y el cliente recarga. */
export async function boardDelta(
  organizationId: string,
  businessCurrency: string,
  since: Date,
  filters: BoardFilters = {}
): Promise<BoardDelta> {
  const filtros = condicionesDeFiltros(filters);
  const matches = filtros ? sql<boolean>`coalesce(${filtros}, false)` : sql<boolean>`true`;
  const desde = new Date(since.getTime() - DELTA_OVERLAP_MS);
  const rows = await getDb()
    .select({
      lead: schema.lead,
      contact: schema.contact,
      conversationId: conversationOf,
      lastAutoRule: lastAutoRuleOf,
      matches,
    })
    .from(schema.lead)
    .innerJoin(schema.contact, eq(schema.lead.contactId, schema.contact.id))
    .where(scoped(schema.lead.organizationId, organizationId, gt(schema.lead.updatedAt, desde)))
    .orderBy(asc(schema.lead.updatedAt), asc(schema.lead.id))
    .limit(BOARD_DELTA_MAX + 1);
  const truncated = rows.length > BOARD_DELTA_MAX;
  const totals = await stageTotals(organizationId, businessCurrency, filters);
  const stages = await getDb()
    .select({ id: schema.pipelineStage.id })
    .from(schema.pipelineStage)
    .where(scoped(schema.pipelineStage.organizationId, organizationId));
  return {
    changed: rows.slice(0, BOARD_DELTA_MAX).map((r) => ({ ...aTarjeta(r), matches: Boolean(r.matches) })),
    truncated,
    totals: Object.fromEntries(stages.map((s) => [s.id, totals.get(s.id) ?? VACIO])),
  };
}

/** Una tarjeta por id (respuesta del `PATCH`). */
export async function getBoardLead(organizationId: string, leadId: string): Promise<BoardLeadDto | null> {
  const rows = await seleccionarTarjetas()
    .where(scoped(schema.lead.organizationId, organizationId, eq(schema.lead.id, leadId)))
    .limit(1);
  return rows[0] ? aTarjeta(rows[0]) : null;
}
