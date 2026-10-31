import { eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  computeRepurchase,
  computeTicketSplit,
  type RepurchaseDto,
  type TicketSideInput,
  type TicketSplitDto,
} from "@/lib/salon/insights";
import type { ResolvedPeriod } from "@/server/analytics/period";
import { localDay, tzLiteral } from "@/server/business/financial-funnel";

/**
 * Módulo SALON — métricas de negocio del Panel, sacadas de `service_sale` y sus ítems (sin tablas
 * nuevas). Toda consulta pasa por `scoped()`. Las cuentas están en `src/lib/salon/insights.ts`.
 */

/**
 * El ticket de las ventas con oferta contra las de servicios sueltos, en el periodo. Una venta «lleva
 * oferta» si alguno de sus ítems es una oferta (o su ítem principal lo es); el resto son servicios sueltos.
 */
export async function getTicketSplit(
  organizationId: string,
  period: ResolvedPeriod,
  staffId?: string | null
): Promise<TicketSplitDto> {
  const sale = schema.serviceSale;
  const item = schema.serviceSaleItem;
  const rows = await getDb()
    .select({
      offer: sql<boolean>`(${sale.comboId} is not null or exists (select 1 from ${item} where ${item.saleId} = ${sale.id} and ${item.comboId} is not null))`,
      count: sql<number>`count(*)::int`,
      revenue: sql<number>`coalesce(sum(${sale.amountCents}), 0)::float8`,
    })
    .from(sale)
    .where(
      scoped(
        sale.organizationId,
        organizationId,
        gte(sale.createdAt, period.start),
        lt(sale.createdAt, period.end),
        staffId ? eq(sale.staffId, staffId) : undefined
      )
    )
    .groupBy(sql`1`);

  const side = (offer: boolean): TicketSideInput => {
    const r = rows.find((x) => x.offer === offer);
    return { count: r?.count ?? 0, revenueCents: r?.revenue ?? 0 };
  };
  return computeTicketSplit({ services: side(false), offers: side(true) });
}

/**
 * El ciclo de recompra con TODO el historial de cada cliente identificado hasta el fin del periodo
 * (el ciclo se mide con visitas, no con las del periodo suelto). Cada día con ventas cuenta una visita.
 * `asOf` es «hoy» (o el último día del periodo si ya pasó): de él salen los días sin venir.
 */
export async function getRepurchaseCycle(
  organizationId: string,
  period: ResolvedPeriod,
  asOf: string
): Promise<RepurchaseDto> {
  const db = getDb();
  const sale = schema.serviceSale;
  const contact = schema.contact;
  const visits = db
    .select({ contactId: sale.contactId, day: localDay(sale.createdAt, tzLiteral(period.timezone)).as("day") })
    .from(sale)
    .where(scoped(sale.organizationId, organizationId, lt(sale.createdAt, period.end), isNotNull(sale.contactId)))
    .groupBy(sale.contactId, sql`2`)
    .as("v");

  const rows = await db
    .select({
      id: contact.id,
      name: contact.name,
      phone: contact.phone,
      days: sql<string[]>`array_agg(${visits.day} order by ${visits.day})`,
    })
    .from(visits)
    .innerJoin(contact, eq(contact.id, visits.contactId))
    .where(scoped(contact.organizationId, organizationId))
    .groupBy(contact.id, contact.name, contact.phone)
    .having(sql`count(*) >= 2`);

  return computeRepurchase(rows, asOf);
}
