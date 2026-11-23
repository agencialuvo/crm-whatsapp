import { addDaysISO } from "@/lib/time/slots";
import { weekdayIndex } from "@/lib/time/calendar";

/**
 * Panel — Punto de Equilibrio: cuánto hay que vender para cubrir los costos fijos del mes, y la meta
 * diaria que sale de ahí. Solo cuentas puras (sin base de datos), para poder probarlas; los datos los
 * junta `src/server/business/break-even.ts`. Todo el dinero va en centavos enteros.
 *
 *   punto de equilibrio mensual = gastos fijos del mes ÷ margen de contribución
 *   margen de contribución      = 1 − (comisiones ÷ ingresos)
 *   meta diaria                 = equilibrio mensual ÷ días operativos del mes
 *
 * Los días de la semana van como en el calendario del negocio: 0 = lunes … 6 = domingo.
 */

/** De dónde salen los días en que el negocio abre. */
export type OperationalDaysSource = "schedule" | "sales" | "default";
/** De dónde sale la tasa de comisión usada. */
export type CommissionRateSource = "period" | "recent" | "configured" | "none";
/** `ok` hay cuenta; `no_fixed_costs` no hay nada que cubrir todavía; `invalid_margin` las comisiones se comen todo. */
export type BreakEvenState = "ok" | "no_fixed_costs" | "invalid_margin";
/** Cómo va el periodo frente a la meta. */
export type BreakEvenProgress = "reached" | "on_track" | "below";

/** Con menos ventas que esto, la tasa de comisión del periodo no es de fiar y se usa la de los últimos 30 días. */
export const MIN_SALES_FOR_RATE = 5;
/** Ventana de la tasa y del ticket «recientes». */
export const RECENT_DAYS = 30;
/** Ventana para deducir qué días de la semana abre el negocio cuando no hay horario. */
export const SALES_WEEKDAYS_DAYS = 60;
/** Lunes a sábado: lo que se supone de una cuenta nueva sin horario ni ventas. */
export const DEFAULT_OPERATIONAL_WEEKDAYS: readonly number[] = [0, 1, 2, 3, 4, 5];
export type BreakEvenDto = {
  state: BreakEvenState;
  /** El mes calendario que se cubre (`AAAA-MM`): el del último día del rango consultado. */
  month: string;
  /** El rango consultado abarca el mes entero. Si no, los gastos fijos (de todo el mes) pueden diferir de «Gastos operativos». */
  coversWholeMonth: boolean;
  /**
   * Gastos fijos (`expense_item.isFixed`) de ese mes; si no había, los del mes anterior. Es el único costo
   * fijo de la cuenta: la publicidad, como cualquier otro gasto, se registra en Gastos (fija o variable).
   */
  fixedExpensesMonthCents: number;
  /** `true` cuando el mes no tenía gastos fijos cargados y se usaron los del mes pasado. */
  usingPreviousMonthFixedExpenses: boolean;
  /** Comisiones ÷ ingresos (0-1). */
  commissionRate: number;
  commissionRateSource: CommissionRateSource;
  /** `1 − commissionRate`. */
  contributionMargin: number;
  /** `null` si el estado no es `ok`. */
  monthlyBreakEvenCents: number | null;
  dailyBreakEvenCents: number | null;
  /** Meta del rango consultado (meta diaria × sus días operativos): sirve para el avance, no se muestra como cifra. */
  rangeBreakEvenCents: number | null;
  /** Ventas por día que hacen falta con el ticket promedio; `null` sin ticket. */
  dailyVisitsNeeded: number | null;
  avgTicketCents: number | null;
  operationalDaysInMonth: number;
  operationalDaysInRange: number;
  /** Días de la semana (0 = lunes) en que abre el negocio. */
  operationalWeekdays: number[];
  operationalDaysSource: OperationalDaysSource;
  /** Ingresos del NEGOCIO en el rango (sin filtro de profesional ni servicio). */
  revenueCents: number;
  /** Ingresos ÷ meta del rango, en %. `null` sin meta. */
  coveredPercent: number | null;
  progress: BreakEvenProgress | null;
  /** Días operativos del rango que ya pasaron (hasta hoy). */
  elapsedOperationalDays: number;
  /** Lo que se lleva vendido por día operativo transcurrido; `null` sin días transcurridos. */
  currentDailyPaceCents: number | null;
  /** Hoy en la zona del negocio y si ese día el negocio está cerrado según el horario. */
  today: { date: string; closed: boolean };
  /** El rango consultado incluye hoy. */
  rangeIncludesToday: boolean;
};

/* ------------------------------ fechas ------------------------------ */

/** Primer y último día (AAAA-MM-DD) del mes de una fecha. */
export function monthBounds(iso: string): { from: string; to: string; days: number } {
  const from = `${iso.slice(0, 7)}-01`;
  const [y, m] = [Number(iso.slice(0, 4)), Number(iso.slice(5, 7))];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from, to: `${iso.slice(0, 7)}-${String(days).padStart(2, "0")}`, days };
}

/** El mes anterior al de una fecha (`AAAA-MM-01`). */
export function previousMonthStart(iso: string): string {
  return addDaysISO(`${iso.slice(0, 7)}-01`, -1).slice(0, 7) + "-01";
}

/** Cuántos días de `[from, to]` (inclusivos) caen en un día de la semana en que el negocio abre. */
export function countOperationalDays(from: string, to: string, weekdays: readonly number[]): number {
  if (from > to) return 0;
  const open = new Set(weekdays);
  let n = 0;
  for (let d = from; d <= to; d = addDaysISO(d, 1)) if (open.has(weekdayIndex(d))) n++;
  return n;
}

/**
 * Los días de la semana (0 = lunes) con al menos un rango horario en `weeklyHours`
 * (`{"mon":[{"start":"09:00","end":"18:00"}]}`). Una forma inesperada no rompe: cuenta como sin horario.
 */
export function weekdaysFromWeeklyHours(hours: unknown): number[] {
  if (typeof hours !== "object" || hours === null) return [];
  const keys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const rec = hours as Record<string, unknown>;
  return keys.flatMap((k, i) => (Array.isArray(rec[k]) && (rec[k] as unknown[]).length > 0 ? [i] : []));
}

/* ------------------------- tasa de comisión y ticket ------------------------- */

export type SalesTotals = { revenueCents: number; commissionsCents: number; count: number };

/**
 * La tasa de comisión a usar. Del periodo si tiene ventas de sobra; si no, la de los últimos 30 días;
 * si tampoco hay, el promedio de los porcentajes configurados (profesionales y servicios); si nada, 0.
 */
export function pickCommissionRate(input: {
  period: SalesTotals;
  recent: SalesTotals;
  /** Porcentajes (0-100) de comisión configurados en profesionales y servicios. */
  configuredPercentages: number[];
}): { rate: number; source: CommissionRateSource } {
  const { period, recent, configuredPercentages } = input;
  if (period.count >= MIN_SALES_FOR_RATE && period.revenueCents > 0) {
    return { rate: period.commissionsCents / period.revenueCents, source: "period" };
  }
  if (recent.count > 0 && recent.revenueCents > 0) {
    return { rate: recent.commissionsCents / recent.revenueCents, source: "recent" };
  }
  const valid = configuredPercentages.filter((p) => Number.isFinite(p) && p >= 0 && p <= 100);
  if (valid.length > 0) {
    return { rate: valid.reduce((a, b) => a + b, 0) / valid.length / 100, source: "configured" };
  }
  return { rate: 0, source: "none" };
}

/** El ticket promedio: el del periodo; sin ventas en él, el de los últimos 30 días; sin ninguno, `null`. */
export function pickAvgTicket(period: SalesTotals, recent: SalesTotals): number | null {
  const t = period.count > 0 ? period : recent.count > 0 ? recent : null;
  return t ? Math.round(t.revenueCents / t.count) : null;
}

/* ------------------------------ el cálculo ------------------------------ */

export function computeBreakEven(input: {
  /** El rango consultado (inclusivo). */
  from: string;
  to: string;
  today: string;
  weekdays: readonly number[];
  weekdaysSource: OperationalDaysSource;
  fixedExpensesMonthCents: number;
  usingPreviousMonthFixedExpenses: boolean;
  commissionRate: number;
  commissionRateSource: CommissionRateSource;
  avgTicketCents: number | null;
  revenueCents: number;
}): BreakEvenDto {
  const month = monthBounds(input.to);
  const weekdays = [...input.weekdays];
  const operationalDaysInMonth = countOperationalDays(month.from, month.to, weekdays);
  const operationalDaysInRange = countOperationalDays(input.from, input.to, weekdays);
  const contributionMargin = 1 - input.commissionRate;

  const state: BreakEvenState =
    contributionMargin <= 0 ? "invalid_margin" : input.fixedExpensesMonthCents <= 0 ? "no_fixed_costs" : "ok";

  const ok = state === "ok" && operationalDaysInMonth > 0;
  const monthlyBreakEvenCents = ok ? Math.round(input.fixedExpensesMonthCents / contributionMargin) : null;
  const dailyBreakEvenCents = monthlyBreakEvenCents === null ? null : Math.round(monthlyBreakEvenCents / operationalDaysInMonth);
  const rangeBreakEvenCents = dailyBreakEvenCents === null ? null : dailyBreakEvenCents * operationalDaysInRange;
  const dailyVisitsNeeded =
    dailyBreakEvenCents !== null && input.avgTicketCents !== null && input.avgTicketCents > 0
      ? Math.ceil(dailyBreakEvenCents / input.avgTicketCents)
      : null;

  const rangeIncludesToday = input.from <= input.today && input.today <= input.to;
  const lastElapsed = input.to < input.today ? input.to : input.today;
  const elapsedOperationalDays = countOperationalDays(input.from, lastElapsed, weekdays);
  const currentDailyPaceCents = elapsedOperationalDays > 0 ? Math.round(input.revenueCents / elapsedOperationalDays) : null;

  let coveredPercent: number | null = null;
  let progress: BreakEvenProgress | null = null;
  if (rangeBreakEvenCents !== null && rangeBreakEvenCents > 0) {
    coveredPercent = Math.round((input.revenueCents / rangeBreakEvenCents) * 100);
    const ended = input.to < input.today;
    if (input.revenueCents >= rangeBreakEvenCents) progress = "reached";
    else if (!ended && (elapsedOperationalDays === 0 || input.revenueCents >= (dailyBreakEvenCents ?? 0) * elapsedOperationalDays)) {
      // El periodo sigue en curso y va al ritmo que pide la meta (o aún no ha pasado ningún día de trabajo).
      progress = "on_track";
    } else progress = "below";
  }

  return {
    state,
    month: input.to.slice(0, 7),
    coversWholeMonth: input.from <= month.from && input.to >= month.to,
    fixedExpensesMonthCents: input.fixedExpensesMonthCents,
    usingPreviousMonthFixedExpenses: input.usingPreviousMonthFixedExpenses,
    commissionRate: input.commissionRate,
    commissionRateSource: input.commissionRateSource,
    contributionMargin,
    monthlyBreakEvenCents,
    dailyBreakEvenCents,
    rangeBreakEvenCents,
    dailyVisitsNeeded,
    avgTicketCents: input.avgTicketCents,
    operationalDaysInMonth,
    operationalDaysInRange,
    operationalWeekdays: weekdays,
    operationalDaysSource: input.weekdaysSource,
    revenueCents: input.revenueCents,
    coveredPercent,
    progress,
    elapsedOperationalDays,
    currentDailyPaceCents,
    today: { date: input.today, closed: !weekdays.includes(weekdayIndex(input.today)) },
    rangeIncludesToday,
  };
}
