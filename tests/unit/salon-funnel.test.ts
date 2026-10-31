import { describe, expect, it } from "vitest";
import {
  computeFunnel,
  formatItemFilter,
  itemFilterOptions,
  itemFilterSchema,
  parseItemFilter,
} from "@/lib/salon/funnel";
import { escalaLimpia } from "@/components/results/time-bars";
import { funnelTotals, expensesApply, type FunnelDay } from "@/server/business/financial-funnel";
import { percentChange } from "@/components/negocio/dashboard-widgets";

describe("embudo financiero — de bruto a neto", () => {
  it("ganancia neta = ingresos − comisiones − gastos", () => {
    expect(computeFunnel({ count: 4, revenueCents: 46_000, commissionsCents: 17_400, expensesCents: 45_000 })).toEqual({
      count: 4,
      revenueCents: 46_000,
      commissionsCents: 17_400,
      expensesCents: 45_000,
      netCents: -16_400,
    });
  });

  it("sin gastos aplicables (filtro de profesional o servicio) la ganancia es ingresos − comisiones", () => {
    const f = computeFunnel({ count: 1, revenueCents: 6_000, commissionsCents: 2_400, expensesCents: null });
    expect(f.expensesCents).toBeNull();
    expect(f.netCents).toBe(3_600);
  });

  it("los gastos solo entran sin filtros", () => {
    expect(expensesApply({})).toBe(true);
    expect(expensesApply({ staffId: null, item: null })).toBe(true);
    expect(expensesApply({ staffId: "stf_1" })).toBe(false);
    expect(expensesApply({ item: { kind: "service", id: null } })).toBe(false);
  });

  it("los totales son la suma de los días (tarjetas y gráfica no se contradicen)", () => {
    const days: FunnelDay[] = [
      { day: "2026-09-03", revenueCents: 10_000, commissionsCents: 4_000, expensesCents: 3_000, count: 1 },
      { day: "2026-09-06", revenueCents: 0, commissionsCents: 0, expensesCents: 40_000, count: 0 },
    ];
    expect(funnelTotals(days, {})).toEqual({
      count: 1,
      revenueCents: 10_000,
      commissionsCents: 4_000,
      expensesCents: 43_000,
      netCents: -37_000,
    });
    expect(funnelTotals(days, { staffId: "x" }).expensesCents).toBeNull();
    expect(funnelTotals([], {})).toMatchObject({ count: 0, revenueCents: 0, netCents: 0 });
  });
});

describe("filtro de servicio o combo", () => {
  it("entiende tipo y tipo:id", () => {
    expect(parseItemFilter("service")).toEqual({ kind: "service", id: null });
    expect(parseItemFilter("combo")).toEqual({ kind: "combo", id: null });
    expect(parseItemFilter("service:srv_abc123")).toEqual({ kind: "service", id: "srv_abc123" });
    expect(parseItemFilter("combo:cmb_x-1")).toEqual({ kind: "combo", id: "cmb_x-1" });
  });

  it("vacío es «sin filtro»; lo raro se rechaza", () => {
    expect(parseItemFilter("")).toBeNull();
    expect(parseItemFilter(null)).toBeNull();
    for (const bad of ["hola", "service:", "service:a b", "service:x'; drop table", "staff:1", "service:" + "a".repeat(65), "SERVICE"]) {
      expect(parseItemFilter(bad)).toBeNull();
      expect(itemFilterSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("ida y vuelta", () => {
    for (const raw of ["service", "combo", "service:srv_1", "combo:cmb_2"]) {
      expect(formatItemFilter(parseItemFilter(raw))).toBe(raw);
    }
    expect(formatItemFilter(null)).toBe("");
  });

  it("las opciones van agrupadas: por tipo, servicios y combos", () => {
    const o = itemFilterOptions([{ id: "s1", name: "Corte" }], [{ id: "c1", name: "Fresh" }]);
    expect(o.map((x) => [x.value, x.group])).toEqual([
      ["service", "Por tipo"],
      ["combo", "Por tipo"],
      ["service:s1", "Servicios"],
      ["combo:c1", "Combos"],
    ]);
  });
});

describe("gráfica y variaciones", () => {
  it("la escala limpia cubre el máximo", () => {
    expect(escalaLimpia(26_000)).toBe(50_000);
    expect(escalaLimpia(40_000)).toBe(40_000 * 1.25);
    expect(escalaLimpia(0)).toBe(1);
  });

  it("la variación porcentual necesita base", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(10, 0)).toBeNull();
  });
});
