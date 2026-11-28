import { and, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type {
  DashboardComparisonDto,
  RetentionDto,
  RevenuePointDto,
  SalonDashboardDto,
} from "@/lib/salon/types";
import { addDaysISO } from "@/lib/time/slots";
import { resolvePeriod, type ResolvedPeriod } from "@/server/analytics/period";
import { agendaEnabled } from "@/server/agenda/flag";
import { getFunnelDaily, funnelTotals, type FunnelDay, type FunnelFilters } from "@/server/business/financial-funnel";
import { getBreakEven } from "@/server/business/break-even";
import { getBirthdayCampaign } from "@/server/business/birthday-campaign";
import { getRepurchaseCycle } from "@/server/business/business-insights";
import { getSalesReport } from "@/server/business/sales-service";

/**
 * Módulo SALON — el panel ejecutivo: los números del periodo (los mismos de
 * Caja, sin la tabla de ventas), las citas del periodo y los clientes que
 * cumplen años este mes. Todo acotado a la organización.
 */

/** Citas del periodo (agendadas o realizadas; ni bloqueos, ni canceladas, ni de prueba). */
async function countAppointments(
  organizationId: string,
  period: ResolvedPeriod,
  staffId?: string | null
): Promise<number> {
  const b = schema.booking;
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(b)
    .where(
      and(
        scoped(
          b.organizationId,
          organizationId,
          gte(b.scheduledAt, period.start),
          lt(b.scheduledAt, period.end),
          eq(b.kind, "session"),
          eq(b.isTest, false),
          ne(b.status, "cancelada"),
          ne(b.status, "no_show"),
          staffId ? eq(b.staffId, staffId) : undefined
        )
      )
    );
  return row?.n ?? 0;
}

/**
 * ¿Hay alguna regla de comisión? Un porcentaje por defecto en un servicio, uno global en un
 * profesional o uno pactado profesional × servicio. Una sola consulta, acotada a la organización.
 */
async function hasCommissionRules(organizationId: string): Promise<boolean> {
  const db = getDb();
  const sv = schema.service;
  const st = schema.staff;
  const ssc = schema.staffServiceCommission;
  const one = sql`1`;
  const services = db
    .select({ one })
    .from(sv)
    .where(scoped(sv.organizationId, organizationId, isNotNull(sv.defaultCommissionPercentage)));
  const staff = db
    .select({ one })
    .from(st)
    .where(scoped(st.organizationId, organizationId, isNotNull(st.globalCommissionPercentage)));
  const pairs = db.select({ one }).from(ssc).where(scoped(ssc.organizationId, organizationId));
  const rows = await db.execute<{ configured: boolean }>(
    sql`select (exists(${services}) or exists(${staff}) or exists(${pairs})) as configured`
  );
  return rows[0]?.configured === true;
}

/**
 * Con qué se compara el periodo: «este mes» contra el mismo tramo del mes
 * anterior; cualquier otro, contra el tramo anterior de igual duración.
 */
export function comparisonRange(period: ResolvedPeriod): {
  kind: "month" | "previous";
  from: string;
  to: string;
} {
  const { from, to } = period.dto;
  const startsMonth = from.endsWith("-01") && from.slice(0, 7) === to.slice(0, 7);
  if (!startsMonth) {
    return { kind: "previous", from: period.dto.previousFrom, to: period.dto.previousTo };
  }
  const prevLast = addDaysISO(from, -1); // último día del mes anterior
  const prevFrom = `${prevLast.slice(0, 8)}01`;
  const span = Math.min(Number(to.slice(8, 10)), Number(prevLast.slice(8, 10)));
  return {
    kind: "month",
    from: prevFrom,
    to: `${prevLast.slice(0, 8)}${String(span).padStart(2, "0")}`,
  };
}

/**
 * Retención de un periodo: de los clientes identificados que se atendieron en
 * él, cuántos suman 2 o más visitas (contando las anteriores y las del propio
 * periodo). Las ventas sin cliente (mostrador) no cuentan.
 */
async function getRetention(
  organizationId: string,
  period: ResolvedPeriod,
  staffId?: string | null
): Promise<RetentionDto> {
  const db = getDb();
  const sale = schema.serviceSale;
  const attended = db
    .select({ id: sale.contactId })
    .from(sale)
    .where(
      scoped(
        sale.organizationId,
        organizationId,
        gte(sale.createdAt, period.start),
        lt(sale.createdAt, period.end),
        sql`${sale.contactId} is not null`,
        staffId ? eq(sale.staffId, staffId) : undefined
      )
    );
  const rows = await db
    .select({ contactId: sale.contactId, visits: sql<number>`count(*)::int` })
    .from(sale)
    .where(
      scoped(
        sale.organizationId,
        organizationId,
        lt(sale.createdAt, period.end),
        inArray(sale.contactId, attended)
      )
    )
    .groupBy(sale.contactId);
  const returning = rows.filter((r) => r.visits >= 2).length;
  return {
    rate: rows.length > 0 ? Math.round((returning / rows.length) * 100) : null,
    clients: rows.length,
    returning,
  };
}

/**
 * Ingresos, comisiones, gastos y ganancia neta en el tiempo, con los huecos en cero: por día,
 * por semana o por mes. Sale de los mismos días que las tarjetas, así que nunca se contradicen.
 */
function buildSeries(period: ResolvedPeriod, days: FunnelDay[]): SalonDashboardDto["series"] {
  const total = period.dto.days;
  const granularity = total <= 31 ? "day" : total <= 92 ? "week" : "month";
  const byDay = new Map(days.map((d) => [d.day, d]));

  const bucketOf = (day: string, index: number): string =>
    granularity === "day"
      ? day
      : granularity === "week"
        ? addDaysISO(period.dto.from, Math.floor(index / 7) * 7)
        : day.slice(0, 7);
  const points = new Map<string, RevenuePointDto>();
  for (let i = 0; i < total; i++) {
    const day = addDaysISO(period.dto.from, i);
    const key = bucketOf(day, i);
    const point =
      points.get(key) ?? { bucket: key, revenueCents: 0, commissionsCents: 0, expensesCents: 0, netCents: 0, count: 0 };
    const hit = byDay.get(day);
    if (hit) {
      point.revenueCents += hit.revenueCents;
      point.commissionsCents += hit.commissionsCents;
      point.expensesCents += hit.expensesCents;
      point.count += hit.count;
    }
    point.netCents = point.revenueCents - point.commissionsCents - point.expensesCents;
    points.set(key, point);
  }
  return { granularity, points: [...points.values()] };
}

/**
 * `today`: el día de hoy EN LA ZONA DEL NEGOCIO (AAAA-MM-DD); de él sale «este mes».
 * `filters`: acotan las tarjetas, la gráfica, el equipo y las citas a un profesional y,
 * las tarjetas y la gráfica, también a un servicio u oferta.
 */
export async function getDashboard(
  organizationId: string,
  period: ResolvedPeriod,
  today: string,
  filters: FunnelFilters = {}
): Promise<SalonDashboardDto> {
  const staffId = filters.staffId ?? null;
  const cmp = comparisonRange(period);
  const previous = resolvePeriod({ from: cmp.from, to: cmp.to, timezone: period.timezone });
  // «Hoy» para contar los días sin venir: el de hoy, o el último del periodo si este ya pasó.
  const asOf = period.dto.to < today ? period.dto.to : today;
  const [
    report,
    appointments,
    birthdays,
    retention,
    days,
    previousDays,
    previousRetention,
    repurchase,
    breakEven,
    commissionRulesConfigured,
  ] = await Promise.all([
    getSalesReport(organizationId, period, staffId, false),
    agendaEnabled() ? countAppointments(organizationId, period, staffId) : Promise.resolve(null),
    getBirthdayCampaign(organizationId, today, period.timezone),
    getRetention(organizationId, period, staffId),
    getFunnelDaily(organizationId, period, filters),
    getFunnelDaily(organizationId, previous, filters),
    getRetention(organizationId, previous, staffId),
    getRepurchaseCycle(organizationId, period, asOf),
    getBreakEven(organizationId, period, today),
    hasCommissionRules(organizationId),
  ]);
  const funnel = funnelTotals(days, filters);
  const previousFunnel = funnelTotals(previousDays, filters);
  const comparison: DashboardComparisonDto = {
    kind: cmp.kind,
    from: cmp.from,
    to: cmp.to,
    revenueCents: previousFunnel.revenueCents,
    count: previousFunnel.count,
    retentionRate: previousRetention.rate,
    funnel: previousFunnel,
  };
  return {
    retention,
    repurchase,
    breakEven,
    comparison,
    funnel,
    commissionRulesConfigured,
    series: buildSeries(period, days),
    report,
    appointments,
    // Cumpleaños del mes del negocio (no dependen del rango ni de los filtros): estado, KPIs y automatizaciones.
    birthdays,
  };
}
