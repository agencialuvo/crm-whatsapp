import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeShiftTotals } from "@/lib/salon/cash-shifts";
import { buildExpenseSummary } from "@/lib/salon/expenses";
import { computeFunnel } from "@/lib/salon/funnel";

/**
 * «Ganancia neta» significa UNA cosa en todo el sistema: ingresos − comisiones − gastos operativos.
 * El subtotal ingresos − comisiones (antes de descontar gastos) se llama «Ganancia antes de gastos».
 */

const NONE = { fixed: { count: 0, totalCents: 0 }, variable: { count: 0, totalCents: 0 } };

describe("ganancia neta: todas las cuentas dan lo mismo", () => {
  const cases = [
    { revenue: 100_000, commissions: 40_000, expenses: 12_000 },
    { revenue: 0, commissions: 0, expenses: 0 },
    { revenue: 50_000, commissions: 0, expenses: 80_000 }, // pérdida
    { revenue: 123_457, commissions: 61_729, expenses: 1 },
  ];

  it.each(cases)("Panel, Caja, Gastos y cierre de turno coinciden: %o", ({ revenue, commissions, expenses }) => {
    const esperado = revenue - commissions - expenses;
    const panel = computeFunnel({ count: 1, revenueCents: revenue, commissionsCents: commissions, expensesCents: expenses });
    const gastos = buildExpenseSummary({ revenueCents: revenue, commissionsCents: commissions, expensesCents: expenses, byKind: NONE });
    const turno = computeShiftTotals({ initialCashCents: 0, salesCents: revenue, commissionsCents: commissions, expensesCents: expenses, cashSalesCents: 0 });
    expect(panel.netCents).toBe(esperado);
    expect(gastos.realNetCents).toBe(esperado);
    expect(turno.netProfitCents).toBe(esperado);
  });

  it("el subtotal antes de gastos es ingresos − comisiones, y no es la ganancia neta cuando hay gastos", () => {
    const g = buildExpenseSummary({ revenueCents: 100_000, commissionsCents: 40_000, expensesCents: 12_000, byKind: NONE });
    expect(g.netBeforeExpensesCents).toBe(60_000);
    expect(g.realNetCents).toBe(48_000);
    expect(g.netBeforeExpensesCents).not.toBe(g.realNetCents);
  });

  it("con filtro de profesional o servicio los gastos no aplican (null): lo que queda es «antes de gastos»", () => {
    const f = computeFunnel({ count: 1, revenueCents: 100_000, commissionsCents: 40_000, expensesCents: null });
    expect(f.expensesCents).toBeNull();
    expect(f.netCents).toBe(60_000);
  });
});

describe("ganancia neta: las etiquetas de la pantalla", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  function tsx(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? tsx(p) : p.endsWith(".tsx") ? [p] : [];
    });
  }

  it("ningún valor de ingresos − comisiones (por venta) lleva la etiqueta «Ganancia neta»", () => {
    const offenders = tsx("src/components").flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => /Ganancia neta/.test(l) && /businessNetCents/.test(l))
        .map((l) => `${f}: ${l.trim()}`)
    );
    expect(offenders).toEqual([]);
  });

  it("el detalle de una venta y la tabla de Caja dicen «Ganancia antes de gastos» (monto − comisión)", () => {
    expect(read("src/components/negocio/sale-detail-dialog.tsx")).toContain('"Ganancia antes de gastos"');
    const caja = read("src/components/negocio/cash-client.tsx");
    expect(caja).not.toMatch(/\bNeto\b/);
    expect(caja).toContain("Ganancia antes de gastos");
  });

  it("la gráfica del Panel cambia de nombre cuando un filtro deja los gastos fuera", () => {
    const panel = read("src/components/negocio/dashboard-client.tsx");
    expect(panel).toContain('filtersActive ? "ganancia antes de gastos" : "ganancia neta"');
    expect(panel).not.toContain('"Ver ganancia neta"');
  });

  it("Panel y Caja rotulan «Ganancia neta» solo cuando los gastos sí entran", () => {
    expect(read("src/components/negocio/dashboard-funnel.tsx")).toContain('expensesApply ? "Ganancia neta" : "Ganancia antes de gastos"');
    expect(read("src/components/negocio/cash-client.tsx")).toContain('report?.expensesCents === null ? "Ganancia antes de gastos" : "Ganancia neta"');
  });

  it("Gastos: «Ganancia antes de gastos» y «Ganancia neta» (nunca «neta real»)", () => {
    const g = read("src/components/negocio/expenses-client.tsx");
    expect(g).toContain('label="Ganancia antes de gastos"');
    expect(g).toContain('label="Ganancia neta"');
    expect(g).not.toMatch(/neta real/i);
  });
});
