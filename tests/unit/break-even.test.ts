import { describe, expect, it } from "vitest";
import {
  MIN_SALES_FOR_RATE,
  computeBreakEven,
  countOperationalDays,
  monthBounds,
  pickAvgTicket,
  pickCommissionRate,
  previousMonthStart,
  weekdaysFromWeeklyHours,
  type SalesTotals,
} from "@/lib/salon/break-even";

/**
 * Punto de Equilibrio (Panel): las cuentas puras. Días de la semana: 0 = lunes … 6 = domingo.
 * Referencia de calendario (2026): 1 de noviembre es domingo; 30 de noviembre, lunes.
 */

const t = (revenueCents: number, commissionsCents: number, count: number): SalesTotals => ({ revenueCents, commissionsCents, count });
const MON_SAT = [0, 1, 2, 3, 4, 5];

const base = {
  from: "2026-11-01",
  to: "2026-11-30",
  today: "2026-11-30",
  weekdays: MON_SAT,
  weekdaysSource: "schedule" as const,
  fixedExpensesMonthCents: 300_000,
  usingPreviousMonthFixedExpenses: false,
  commissionRate: 0.4,
  commissionRateSource: "period" as const,
  avgTicketCents: 5_000,
  revenueCents: 0,
};

describe("fechas del mes", () => {
  it("límites de cada mes (28, 29, 30 y 31 días)", () => {
    expect(monthBounds("2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28", days: 28 });
    expect(monthBounds("2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29", days: 29 });
    expect(monthBounds("2026-11-05")).toEqual({ from: "2026-11-01", to: "2026-11-30", days: 30 });
    expect(monthBounds("2026-12-31")).toEqual({ from: "2026-12-01", to: "2026-12-31", days: 31 });
  });

  it("el mes anterior, también cruzando de año", () => {
    expect(previousMonthStart("2026-11-15")).toBe("2026-10-01");
    expect(previousMonthStart("2026-01-31")).toBe("2025-12-01");
  });

  it("cuenta solo los días de la semana en que el negocio abre", () => {
    // Noviembre 2026: 4 domingos (1, 8, 15, 22, 29 → son 5) → 30 − 5 = 25 de lunes a sábado.
    expect(countOperationalDays("2026-11-01", "2026-11-30", MON_SAT)).toBe(25);
    expect(countOperationalDays("2026-11-01", "2026-11-30", [0, 1, 2, 3, 4, 5, 6])).toBe(30);
    expect(countOperationalDays("2026-11-02", "2026-11-02", [0])).toBe(1); // un lunes
    expect(countOperationalDays("2026-11-01", "2026-11-01", MON_SAT)).toBe(0); // un domingo
    expect(countOperationalDays("2026-11-10", "2026-11-09", MON_SAT)).toBe(0); // rango al revés
  });
});

describe("días operativos desde el horario", () => {
  it("un día cuenta si tiene al menos un rango; vacío o ausente, no", () => {
    expect(
      weekdaysFromWeeklyHours({ mon: [{ start: "09:00", end: "18:00" }], tue: [], wed: [{ start: "10:00", end: "14:00" }], sun: [{ start: "10:00", end: "12:00" }] })
    ).toEqual([0, 2, 6]);
  });

  it("una forma inesperada no rompe: es «sin horario»", () => {
    for (const bad of [null, undefined, "x", 5, [], { mon: "09:00" }, { mon: null }]) expect(weekdaysFromWeeklyHours(bad)).toEqual([]);
  });
});

describe("tasa de comisión", () => {
  it("usa la del periodo si tiene ventas de sobra", () => {
    const r = pickCommissionRate({ period: t(100_000, 40_000, MIN_SALES_FOR_RATE), recent: t(1, 1, 1), configuredPercentages: [50] });
    expect(r).toEqual({ rate: 0.4, source: "period" });
  });

  it("con pocas ventas en el periodo cae a los últimos 30 días", () => {
    const r = pickCommissionRate({ period: t(10_000, 9_000, MIN_SALES_FOR_RATE - 1), recent: t(200_000, 60_000, 30), configuredPercentages: [50] });
    expect(r).toEqual({ rate: 0.3, source: "recent" });
  });

  it("sin ventas en el periodo ni recientes, el promedio de lo configurado", () => {
    const r = pickCommissionRate({ period: t(0, 0, 0), recent: t(0, 0, 0), configuredPercentages: [40, 50, 60] });
    expect(r.source).toBe("configured");
    expect(r.rate).toBeCloseTo(0.5, 10);
  });

  it("ignora porcentajes fuera de 0-100 y, sin nada, es 0", () => {
    expect(pickCommissionRate({ period: t(0, 0, 0), recent: t(0, 0, 0), configuredPercentages: [150, -5, Number.NaN] })).toEqual({ rate: 0, source: "none" });
    expect(pickCommissionRate({ period: t(0, 0, 0), recent: t(0, 0, 0), configuredPercentages: [] })).toEqual({ rate: 0, source: "none" });
  });

  it("ventas con ingresos 0 no dividen por cero", () => {
    const r = pickCommissionRate({ period: t(0, 0, 10), recent: t(0, 0, 10), configuredPercentages: [20] });
    expect(r).toEqual({ rate: 0.2, source: "configured" });
  });
});

describe("ticket promedio", () => {
  it("del periodo; sin ventas, el reciente; sin ninguno, null", () => {
    expect(pickAvgTicket(t(10_000, 0, 4), t(99_999, 0, 9))).toBe(2_500);
    expect(pickAvgTicket(t(0, 0, 0), t(9_000, 0, 3))).toBe(3_000);
    expect(pickAvgTicket(t(0, 0, 0), t(0, 0, 0))).toBeNull();
  });
});

describe("punto de equilibrio", () => {
  it("las fórmulas: mensual = fijos ÷ margen; diaria = mensual ÷ días del mes; rango = diaria × días del rango", () => {
    const d = computeBreakEven({ ...base, from: "2026-11-02", to: "2026-11-08" });
    // 300 000 ÷ 0.6 = 500 000; ÷ 25 días operativos = 20 000 por día; semana lunes-domingo = 6 días abiertos.
    expect(d.state).toBe("ok");
    expect(d.contributionMargin).toBeCloseTo(0.6, 10);
    expect(d.monthlyBreakEvenCents).toBe(500_000);
    expect(d.operationalDaysInMonth).toBe(25);
    expect(d.dailyBreakEvenCents).toBe(20_000);
    expect(d.operationalDaysInRange).toBe(6);
    expect(d.rangeBreakEvenCents).toBe(120_000);
    expect(d.dailyVisitsNeeded).toBe(4); // 20 000 ÷ 5 000
  });

  it("redondea y las atenciones por día suben al entero", () => {
    const d = computeBreakEven({ ...base, fixedExpensesMonthCents: 100_000, avgTicketCents: 3_000 });
    expect(d.monthlyBreakEvenCents).toBe(166_667); // 100 000 ÷ 0.6
    expect(d.dailyBreakEvenCents).toBe(6_667); // ÷ 25
    expect(d.dailyVisitsNeeded).toBe(3); // ceil(6 667 ÷ 3 000)
  });

  it("el costo fijo es solo lo registrado como gasto fijo: la publicidad entra por Gastos, no se suma aparte", () => {
    const d = computeBreakEven({ ...base, fixedExpensesMonthCents: 300_000 });
    expect(d.fixedExpensesMonthCents).toBe(300_000);
    expect(d.monthlyBreakEvenCents).toBe(500_000);
    expect(Object.keys(d)).not.toContain("monthlyAdBudgetCents");
    expect(Object.keys(d)).not.toContain("totalFixedCostCents");
  });

  it("sin ticket promedio no hay atenciones estimadas", () => {
    expect(computeBreakEven({ ...base, avgTicketCents: null }).dailyVisitsNeeded).toBeNull();
    expect(computeBreakEven({ ...base, avgTicketCents: 0 }).dailyVisitsNeeded).toBeNull();
  });

  it("sin costos fijos no hay cuenta: estado orientador", () => {
    const d = computeBreakEven({ ...base, fixedExpensesMonthCents: 0 });
    expect(d.state).toBe("no_fixed_costs");
    expect(d.monthlyBreakEvenCents).toBeNull();
    expect(d.dailyBreakEvenCents).toBeNull();
    expect(d.progress).toBeNull();
  });

  it("margen 0 o negativo: estado inválido, sin números absurdos ni división por cero", () => {
    for (const commissionRate of [1, 1.2]) {
      const d = computeBreakEven({ ...base, commissionRate });
      expect(d.state).toBe("invalid_margin");
      expect(d.monthlyBreakEvenCents).toBeNull();
      expect(d.dailyBreakEvenCents).toBeNull();
      expect(d.rangeBreakEvenCents).toBeNull();
      expect(d.dailyVisitsNeeded).toBeNull();
    }
  });

  it("avisa si el rango no abarca el mes entero (los gastos fijos son del mes completo)", () => {
    expect(computeBreakEven({ ...base, from: "2026-11-01", to: "2026-11-30" }).coversWholeMonth).toBe(true);
    expect(computeBreakEven({ ...base, from: "2026-10-20", to: "2026-11-30" }).coversWholeMonth).toBe(true);
    expect(computeBreakEven({ ...base, from: "2026-11-01", to: "2026-11-22", today: "2026-11-22" }).coversWholeMonth).toBe(false);
    expect(computeBreakEven({ ...base, from: "2026-11-02", to: "2026-11-30" }).coversWholeMonth).toBe(false);
  });

  it("el mes que cuenta es el del último día del rango", () => {
    const d = computeBreakEven({ ...base, from: "2026-10-20", to: "2026-11-05", today: "2026-11-05" });
    expect(d.month).toBe("2026-11");
    expect(d.operationalDaysInMonth).toBe(25);
  });

  it("los meses de 28 y 31 días dan su propio número de días operativos", () => {
    expect(computeBreakEven({ ...base, from: "2026-02-01", to: "2026-02-28", today: "2026-02-28" }).operationalDaysInMonth).toBe(24); // 28 − 4 domingos
    expect(computeBreakEven({ ...base, from: "2026-12-01", to: "2026-12-31", today: "2026-12-31" }).operationalDaysInMonth).toBe(27); // 31 − 4 domingos
  });

  it("propaga el aviso de gastos fijos del mes pasado", () => {
    expect(computeBreakEven({ ...base, usingPreviousMonthFixedExpenses: true }).usingPreviousMonthFixedExpenses).toBe(true);
  });
});

describe("avance frente a la meta", () => {
  // Meta diaria 20 000 (ver arriba). Rango: 2 al 8 de noviembre (6 días abiertos) → meta 120 000.
  const week = { ...base, from: "2026-11-02", to: "2026-11-08" };

  it("alcanzado: cubre la meta del rango, esté en curso o no", () => {
    expect(computeBreakEven({ ...week, today: "2026-11-04", revenueCents: 120_000 }).progress).toBe("reached");
    expect(computeBreakEven({ ...week, today: "2026-11-30", revenueCents: 150_000 }).progress).toBe("reached");
  });

  it("en camino: el periodo sigue y va al ritmo (o más) de la meta", () => {
    // Al 4 de noviembre pasaron 3 días abiertos → se esperan 60 000.
    const d = computeBreakEven({ ...week, today: "2026-11-04", revenueCents: 60_000 });
    expect(d.elapsedOperationalDays).toBe(3);
    expect(d.progress).toBe("on_track");
    expect(d.currentDailyPaceCents).toBe(20_000);
  });

  it("por debajo: va atrás del ritmo, o el periodo terminó sin cubrir la meta", () => {
    expect(computeBreakEven({ ...week, today: "2026-11-04", revenueCents: 59_999 }).progress).toBe("below");
    expect(computeBreakEven({ ...week, today: "2026-11-30", revenueCents: 119_999 }).progress).toBe("below");
  });

  it("recién empezado el rango (aún no pasa un día abierto) no se marca «por debajo»", () => {
    const d = computeBreakEven({ ...week, today: "2026-11-02", revenueCents: 0 });
    // Hoy es lunes y cuenta como transcurrido: 1 día abierto, se esperan 20 000.
    expect(d.elapsedOperationalDays).toBe(1);
    const antes = computeBreakEven({ ...week, from: "2026-11-09", to: "2026-11-15", today: "2026-11-05", revenueCents: 0 });
    expect(antes.elapsedOperationalDays).toBe(0);
    expect(antes.progress).toBe("on_track");
    expect(antes.currentDailyPaceCents).toBeNull();
  });

  it("el porcentaje cubierto se calcula contra la meta del rango", () => {
    expect(computeBreakEven({ ...week, today: "2026-11-30", revenueCents: 30_000 }).coveredPercent).toBe(25);
    expect(computeBreakEven({ ...week, today: "2026-11-30", revenueCents: 240_000 }).coveredPercent).toBe(200);
  });

  it("un rango sin días operativos (solo domingos) no tiene meta ni avance", () => {
    const d = computeBreakEven({ ...base, from: "2026-11-01", to: "2026-11-01", today: "2026-11-01" });
    expect(d.operationalDaysInRange).toBe(0);
    expect(d.rangeBreakEvenCents).toBe(0);
    expect(d.coveredPercent).toBeNull();
    expect(d.progress).toBeNull();
  });
});

describe("hoy cerrado", () => {
  it("avisa cuando hoy cae en un día sin horario", () => {
    const d = computeBreakEven({ ...base, from: "2026-11-01", to: "2026-11-30", today: "2026-11-29" }); // domingo
    expect(d.today).toEqual({ date: "2026-11-29", closed: true });
    expect(d.rangeIncludesToday).toBe(true);
    expect(computeBreakEven({ ...base, today: "2026-11-30" }).today.closed).toBe(false); // lunes
  });

  it("si el rango no incluye hoy, no lo marca", () => {
    expect(computeBreakEven({ ...base, from: "2026-11-02", to: "2026-11-08", today: "2026-11-29" }).rangeIncludesToday).toBe(false);
  });
});
