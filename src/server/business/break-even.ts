import { eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  DEFAULT_OPERATIONAL_WEEKDAYS,
  RECENT_DAYS,
  SALES_WEEKDAYS_DAYS,
  computeBreakEven,
  monthBounds,
  pickAvgTicket,
  pickCommissionRate,
  previousMonthStart,
  weekdaysFromWeeklyHours,
  type BreakEvenDto,
  type OperationalDaysSource,
  type SalesTotals,
} from "@/lib/salon/break-even";
import { addDaysISO } from "@/lib/time/slots";
import { resolvePeriod, type ResolvedPeriod } from "@/server/analytics/period";
import { agendaEnabled } from "@/server/agenda/flag";
import { tzLiteral } from "@/server/business/financial-funnel";

/**
 * Panel — Punto de Equilibrio: las consultas. Las cuentas están en `src/lib/salon/break-even.ts`.
 *
 * Es del NEGOCIO ENTERO: no usa los filtros de profesional ni de servicio (igual que los gastos
 * operativos, que no se reparten). Toda consulta pasa por `scoped()`.
 */

/** Ventas del NEGOCIO (sin filtros) entre dos instantes: ingresos, comisiones y cuántas. */
async function salesTotals(organizationId: string, start: Date, end: Date): Promise<SalesTotals> {
  const sale = schema.serviceSale;
  const [row] = await getDb()
    .select({
      revenue: sql<number>`coalesce(sum(${sale.amountCents}), 0)::float8`,
      commissions: sql<number>`coalesce(sum(${sale.staffCommissionCents}), 0)::float8`,
      count: sql<number>`count(*)::int`,
    })
    .from(sale)
    .where(scoped(sale.organizationId, organizationId, gte(sale.createdAt, start), lt(sale.createdAt, end)));
  return { revenueCents: row?.revenue ?? 0, commissionsCents: row?.commissions ?? 0, count: row?.count ?? 0 };
}

/** Los gastos FIJOS de un mes calendario (por el día del gasto en la zona del negocio): total y cuántos hay. */
async function fixedExpensesOfMonth(
  organizationId: string,
  monthFrom: string,
  timezone: string
): Promise<{ cents: number; rows: number }> {
  const { from, to } = monthBounds(monthFrom);
  const p = resolvePeriod({ from, to, timezone });
  const e = schema.expenseItem;
  const [row] = await getDb()
    .select({
      total: sql<number>`coalesce(sum(${e.totalPriceCents}), 0)::float8`,
      rows: sql<number>`count(*)::int`,
    })
    .from(e)
    .where(scoped(e.organizationId, organizationId, eq(e.isFixed, true), gte(e.expenseDate, p.start), lt(e.expenseDate, p.end)));
  return { cents: row?.total ?? 0, rows: row?.rows ?? 0 };
}

/** Porcentajes de comisión configurados en profesionales activos y servicios (la última red de seguridad de la tasa). */
async function configuredCommissionPercentages(organizationId: string): Promise<number[]> {
  const db = getDb();
  const st = schema.staff;
  const sv = schema.service;
  const [staffRows, serviceRows] = await Promise.all([
    db
      .select({ pct: st.globalCommissionPercentage })
      .from(st)
      .where(scoped(st.organizationId, organizationId, eq(st.active, true), isNotNull(st.globalCommissionPercentage))),
    db
      .select({ pct: sv.defaultCommissionPercentage })
      .from(sv)
      .where(scoped(sv.organizationId, organizationId, eq(sv.active, true), isNotNull(sv.defaultCommissionPercentage))),
  ]);
  return [...staffRows.map((r) => r.pct), ...serviceRows.map((r) => r.pct)].filter((p): p is number => p !== null);
}

/**
 * Los días de la semana (0 = lunes) en que el negocio abre. Con la agenda encendida y un horario con
 * algún día, ese horario. Si no, los días que tuvieron ventas en los últimos 60 días; si tampoco hay
 * ventas (cuenta nueva), lunes a sábado.
 */
async function operationalWeekdays(
  organizationId: string,
  timezone: string,
  today: string
): Promise<{ weekdays: number[]; source: OperationalDaysSource }> {
  const db = getDb();
  if (agendaEnabled()) {
    const [row] = await db
      .select({ hours: schema.calendarSettings.weeklyHours })
      .from(schema.calendarSettings)
      .where(scoped(schema.calendarSettings.organizationId, organizationId))
      .limit(1);
    const fromSchedule = weekdaysFromWeeklyHours(row?.hours);
    if (fromSchedule.length > 0) return { weekdays: fromSchedule, source: "schedule" };
  }

  const sale = schema.serviceSale;
  const window = resolvePeriod({ from: addDaysISO(today, -(SALES_WEEKDAYS_DAYS - 1)), to: today, timezone });
  const tz = tzLiteral(timezone);
  const rows = await db
    .selectDistinct({ dow: sql<number>`extract(isodow from (${sale.createdAt} at time zone 'UTC') at time zone ${tz})::int` })
    .from(sale)
    .where(scoped(sale.organizationId, organizationId, gte(sale.createdAt, window.start), lt(sale.createdAt, window.end)));
  const fromSales = rows.map((r) => r.dow - 1).sort((a, b) => a - b);
  if (fromSales.length > 0) return { weekdays: fromSales, source: "sales" };
  return { weekdays: [...DEFAULT_OPERATIONAL_WEEKDAYS], source: "default" };
}

/** El bloque de Punto de Equilibrio del Panel para el rango consultado. */
export async function getBreakEven(organizationId: string, period: ResolvedPeriod, today: string): Promise<BreakEvenDto> {
  const { from, to } = period.dto;
  const monthFrom = monthBounds(to).from;
  const recentWindow = resolvePeriod({ from: addDaysISO(to, -(RECENT_DAYS - 1)), to, timezone: period.timezone });

  const [currentFixed, periodTotals, recentTotals, configured, days] = await Promise.all([
    fixedExpensesOfMonth(organizationId, monthFrom, period.timezone),
    salesTotals(organizationId, period.start, period.end),
    salesTotals(organizationId, recentWindow.start, recentWindow.end),
    configuredCommissionPercentages(organizationId),
    operationalWeekdays(organizationId, period.timezone, today),
  ]);

  // Sin gastos fijos cargados este mes, se toman los del mes pasado (y se avisa).
  let fixed = currentFixed;
  let usingPrevious = false;
  if (currentFixed.rows === 0) {
    const previous = await fixedExpensesOfMonth(organizationId, previousMonthStart(monthFrom), period.timezone);
    if (previous.rows > 0) {
      fixed = previous;
      usingPrevious = true;
    }
  }

  const rate = pickCommissionRate({ period: periodTotals, recent: recentTotals, configuredPercentages: configured });
  return computeBreakEven({
    from,
    to,
    today,
    weekdays: days.weekdays,
    weekdaysSource: days.source,
    fixedExpensesMonthCents: fixed.cents,
    usingPreviousMonthFixedExpenses: usingPrevious,
    commissionRate: rate.rate,
    commissionRateSource: rate.source,
    avgTicketCents: pickAvgTicket(periodTotals, recentTotals),
    revenueCents: periodTotals.revenueCents,
  });
}
