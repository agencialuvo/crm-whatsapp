import { eq, gte, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { computeFunnel, type FunnelTotalsDto, type ItemFilter } from "@/lib/salon/funnel";
import type { ResolvedPeriod } from "@/server/analytics/period";

/**
 * Módulo SALON — el embudo financiero del Panel: ingresos, comisiones y gastos por día,
 * con los filtros de profesional y de servicio o combo.
 *
 * Una sola pasada por día alimenta las tarjetas Y la gráfica (los totales son la suma de
 * los días), así que los dos nunca se contradicen. Toda consulta pasa por `scoped()`.
 *
 * - Ingresos y comisiones salen de `service_sale`; con filtro de servicio, de sus ÍTEMS
 *   (`service_sale_item`): cada ítem aporta lo que le tocó del total y, de la comisión de la
 *   venta, la parte proporcional a su monto (la comisión se guarda por venta, no por ítem:
 *   es exacta en ventas de un solo ítem).
 * - Gastos: `expense_item` por el día del gasto (el mismo criterio de la pantalla Gastos).
 *   Son del negocio: con filtro de profesional o de servicio NO se asignan.
 */

export type FunnelFilters = { staffId?: string | null; item?: ItemFilter | null };

/** Un día local del negocio. `expensesCents` es 0 cuando los gastos no aplican. */
export type FunnelDay = {
  day: string;
  revenueCents: number;
  commissionsCents: number;
  expensesCents: number;
  count: number;
};

/** ¿Los gastos del negocio entran en la cuenta? Solo sin filtros de profesional ni de servicio. */
export function expensesApply(filters: FunnelFilters): boolean {
  return !filters.staffId && !filters.item;
}

/** La zona ya viene validada (`resolvePeriod`): es un literal seguro. */
function tzLiteral(timezone: string): SQL {
  return sql.raw(`'${timezone.replace(/'/g, "''")}'`);
}

const localDay = (col: SQL | unknown, tz: SQL) =>
  sql<string>`to_char((${col} at time zone 'UTC') at time zone ${tz}, 'YYYY-MM-DD')`;

async function salesByDay(organizationId: string, period: ResolvedPeriod, filters: FunnelFilters) {
  const db = getDb();
  const sale = schema.serviceSale;
  const item = schema.serviceSaleItem;
  const tz = tzLiteral(period.timezone);
  const day = localDay(sale.createdAt, tz);
  const inPeriod = [
    gte(sale.createdAt, period.start),
    lt(sale.createdAt, period.end),
    filters.staffId ? eq(sale.staffId, filters.staffId) : undefined,
  ];

  if (!filters.item) {
    return db
      .select({
        day,
        revenue: sql<number>`coalesce(sum(${sale.amountCents}), 0)::float8`,
        commissions: sql<number>`coalesce(sum(${sale.staffCommissionCents}), 0)::float8`,
        count: sql<number>`count(*)::int`,
      })
      .from(sale)
      .where(scoped(sale.organizationId, organizationId, ...inPeriod))
      .groupBy(sql`1`);
  }

  const { kind, id } = filters.item;
  const column = kind === "service" ? item.serviceId : item.comboId;
  return db
    .select({
      day,
      revenue: sql<number>`coalesce(sum(${item.amountCents}), 0)::float8`,
      commissions: sql<number>`coalesce(sum(${item.amountCents}::float8 * ${sale.staffCommissionCents} / nullif(${sale.amountCents}, 0)), 0)::float8`,
      count: sql<number>`count(distinct ${sale.id})::int`,
    })
    .from(item)
    .innerJoin(sale, eq(sale.id, item.saleId))
    .where(
      scoped(
        sale.organizationId,
        organizationId,
        eq(item.organizationId, organizationId),
        ...inPeriod,
        id ? eq(column, id) : isNotNull(column)
      )
    )
    .groupBy(sql`1`);
}

async function expensesByDay(organizationId: string, period: ResolvedPeriod) {
  const expense = schema.expenseItem;
  const tz = tzLiteral(period.timezone);
  return getDb()
    .select({
      day: localDay(expense.expenseDate, tz),
      total: sql<number>`coalesce(sum(${expense.totalPriceCents}), 0)::float8`,
    })
    .from(expense)
    .where(scoped(expense.organizationId, organizationId, gte(expense.expenseDate, period.start), lt(expense.expenseDate, period.end)))
    .groupBy(sql`1`);
}

/** Lo gastado en el periodo (todo el negocio), con el mismo criterio de día que la pantalla Gastos. */
export async function getExpensesTotalCents(organizationId: string, period: ResolvedPeriod): Promise<number> {
  const days = await expensesByDay(organizationId, period);
  return days.reduce((n, d) => n + d.total, 0);
}

/** Ingresos, comisiones y gastos de cada día del periodo (solo los días con movimiento), por día local. */
export async function getFunnelDaily(
  organizationId: string,
  period: ResolvedPeriod,
  filters: FunnelFilters = {}
): Promise<FunnelDay[]> {
  const [sales, expenses] = await Promise.all([
    salesByDay(organizationId, period, filters),
    expensesApply(filters) ? expensesByDay(organizationId, period) : Promise.resolve([]),
  ]);

  const days = new Map<string, FunnelDay>();
  const at = (day: string): FunnelDay => {
    let d = days.get(day);
    if (!d) {
      d = { day, revenueCents: 0, commissionsCents: 0, expensesCents: 0, count: 0 };
      days.set(day, d);
    }
    return d;
  };
  for (const r of sales) {
    const d = at(r.day);
    d.revenueCents += r.revenue;
    // La comisión repartida por ítem es decimal: se redondea por día (el total es la suma de los días).
    d.commissionsCents += Math.round(r.commissions);
    d.count += r.count;
  }
  for (const r of expenses) at(r.day).expensesCents += r.total;
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Los totales del periodo: la suma de sus días. */
export function funnelTotals(days: FunnelDay[], filters: FunnelFilters): FunnelTotalsDto {
  const sum = (pick: (d: FunnelDay) => number) => days.reduce((n, d) => n + pick(d), 0);
  return computeFunnel({
    count: sum((d) => d.count),
    revenueCents: sum((d) => d.revenueCents),
    commissionsCents: sum((d) => d.commissionsCents),
    expensesCents: expensesApply(filters) ? sum((d) => d.expensesCents) : null,
  });
}
