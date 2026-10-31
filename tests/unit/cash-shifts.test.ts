import { describe, expect, it } from "vitest";
import { dateTimeFullLabel } from "@/lib/salon/format";
import {
  DEFAULT_HISTORY_ROWS,
  MAX_HISTORY_ROWS,
  PAGE_SIZE_ALL,
  closeShiftInputSchema,
  computeShiftTotals,
  historyQuerySchema,
  openShiftInputSchema,
  pageSizeLabel,
  rowsPerPage,
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

  it("«Todos» se guarda como 0 y equivale a sin tope", () => {
    expect(setTablePageSizeInputSchema.safeParse({ view: "clientes", pageSize: PAGE_SIZE_ALL }).success).toBe(true);
    expect(pageSizeLabel(PAGE_SIZE_ALL)).toBe("Todos");
    expect(pageSizeLabel(25)).toBe("25 por página");
    expect(rowsPerPage(PAGE_SIZE_ALL)).toBe(Number.MAX_SAFE_INTEGER);
    expect(rowsPerPage(50)).toBe(50);
    // Con «Todos» el recorte de filas no se rompe (0 × tope no puede dar NaN).
    expect(Array.from({ length: 7 }, (_, i) => i).slice(0 * rowsPerPage(PAGE_SIZE_ALL), 1 * rowsPerPage(PAGE_SIZE_ALL))).toHaveLength(7);
  });

  it("rechaza tamaños fuera de lista y nombres de vista raros", () => {
    expect(setTablePageSizeInputSchema.safeParse({ view: "clients", pageSize: 7 }).success).toBe(false);
    for (const view of ["", "Clients", "a b", "../x", "x".repeat(41), "__proto__!"]) {
      expect(setTablePageSizeInputSchema.safeParse({ view, pageSize: 25 }).success).toBe(false);
    }
  });
});

describe("historial de turnos — consulta", () => {
  it("sin parámetros usa la primera página por defecto", () => {
    expect(historyQuerySchema.parse({})).toEqual({ limit: DEFAULT_HISTORY_ROWS, offset: 0 });
  });

  it("acepta números en texto (vienen de la URL) dentro de los topes", () => {
    expect(historyQuerySchema.parse({ limit: "50", offset: "100" })).toEqual({ limit: 50, offset: 100 });
    expect(historyQuerySchema.safeParse({ limit: String(MAX_HISTORY_ROWS) }).success).toBe(true);
  });

  it("rechaza topes excedidos, cero, negativos y texto", () => {
    for (const bad of [{ limit: "0" }, { limit: String(MAX_HISTORY_ROWS + 1) }, { limit: "abc" }, { offset: "-1" }, { limit: "1.5" }]) {
      expect(historyQuerySchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("historial de turnos — fecha con año", () => {
  it("se escribe en la zona del negocio", () => {
    // 2026-10-31 03:04 UTC = 30 oct 22:04 en Lima (UTC−5)
    expect(dateTimeFullLabel("2026-10-31T03:04:00Z", "America/Lima")).toBe("30 oct 2026, 22:04");
  });

  it("una fecha inválida no rompe la tabla", () => {
    expect(dateTimeFullLabel("no-es-fecha", "America/Lima")).toBe("—");
  });
});
