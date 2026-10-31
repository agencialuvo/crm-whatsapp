import { describe, expect, it } from "vitest";
import {
  closeShiftInputSchema,
  computeShiftTotals,
  openShiftInputSchema,
  setTablePageSizeInputSchema,
} from "@/lib/salon/cash-shifts";

describe("cuadre de caja — totales del cierre", () => {
  it("ganancia neta = ventas − comisiones − gastos; esperado = inicial + efectivo", () => {
    expect(
      computeShiftTotals({
        initialCashCents: 5_000,
        salesCents: 40_000,
        commissionsCents: 16_000,
        expensesCents: 3_500,
        cashSalesCents: 25_000,
      })
    ).toEqual({
      totalSalesCents: 40_000,
      totalCommissionsCents: 16_000,
      totalExpensesCents: 3_500,
      netProfitCents: 20_500,
      expectedCashCents: 30_000,
    });
  });

  it("un turno sin movimiento espera solo el efectivo inicial", () => {
    const t = computeShiftTotals({ initialCashCents: 1_000, salesCents: 0, commissionsCents: 0, expensesCents: 0, cashSalesCents: 0 });
    expect(t.netProfitCents).toBe(0);
    expect(t.expectedCashCents).toBe(1_000);
  });

  it("la ganancia puede ser negativa si los gastos superan lo vendido", () => {
    expect(computeShiftTotals({ initialCashCents: 0, salesCents: 1_000, commissionsCents: 400, expensesCents: 2_000, cashSalesCents: 0 }).netProfitCents).toBe(-1_400);
  });
});

describe("cuadre de caja — validación de montos", () => {
  it("acepta céntimos enteros no negativos", () => {
    expect(openShiftInputSchema.safeParse({ initialCashCents: 0 }).success).toBe(true);
    expect(closeShiftInputSchema.safeParse({ finalCashCents: 12_345 }).success).toBe(true);
  });

  it("rechaza decimales, negativos, textos y montos absurdos", () => {
    for (const bad of [1.5, -1, "100", Number.NaN, 2_000_000_000, null, undefined]) {
      expect(openShiftInputSchema.safeParse({ initialCashCents: bad }).success).toBe(false);
      expect(closeShiftInputSchema.safeParse({ finalCashCents: bad }).success).toBe(false);
    }
  });
});

describe("preferencias de paginación", () => {
  it("acepta vistas y tamaños permitidos", () => {
    expect(setTablePageSizeInputSchema.safeParse({ view: "clients", pageSize: 25 }).success).toBe(true);
    expect(setTablePageSizeInputSchema.safeParse({ view: "ventas-dia_2", pageSize: 100 }).success).toBe(true);
  });

  it("rechaza tamaños fuera de lista y nombres de vista raros", () => {
    expect(setTablePageSizeInputSchema.safeParse({ view: "clients", pageSize: 7 }).success).toBe(false);
    for (const view of ["", "Clients", "a b", "../x", "x".repeat(41), "__proto__!"]) {
      expect(setTablePageSizeInputSchema.safeParse({ view, pageSize: 25 }).success).toBe(false);
    }
  });
});
