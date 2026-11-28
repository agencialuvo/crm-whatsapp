import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AFTER_COMMISSIONS_HINT,
  commissionHint,
  FILTER_NO_EXPENSES_NOTE,
  FunnelCards,
  NO_COMMISSION_RULE_HINT,
} from "@/components/negocio/dashboard-funnel";
import { KpiCard } from "@/components/negocio/dashboard-widgets";
import { computeFunnel, type FunnelTotalsDto } from "@/lib/salon/funnel";
import { money } from "@/lib/salon/format";

/**
 * Panel — tarjetas del embudo en dos filas: el dinero se lee de izquierda a derecha.
 * Fila 1: Ingresos · Comisiones · Saldo tras comisiones · Ganancia neta.
 * Fila 2: Gastos operativos · Ticket · Atenciones · Retención.
 */

const CUR = "PEN";
const NOW = computeFunnel({ count: 3, revenueCents: 778_000, commissionsCents: 150_000, expensesCents: 200_000 });
const PREV = computeFunnel({ count: 2, revenueCents: 600_000, commissionsCents: 100_000, expensesCents: 0 });

function render(over: Partial<Parameters<typeof FunnelCards>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(
      FunnelCards,
      {
        funnel: NOW,
        previous: PREV,
        versus: "vs. mes anterior",
        currency: CUR,
        loading: false,
        showCommissions: true,
        commissionRulesConfigured: true,
        ...over,
      },
      createElement(KpiCard, { key: "t", label: "Ticket promedio", value: "x" }),
      createElement(KpiCard, { key: "a", label: "Atenciones", value: "x" }),
      createElement(KpiCard, { key: "r", label: "Tasa de retención", value: "x" })
    )
  );
}

/** Las etiquetas de las tarjetas de una fila, en orden. */
function labels(html: string, row: 1 | 2): string[] {
  const start = html.indexOf(`data-testid="funnel-row-${row}"`);
  expect(start).toBeGreaterThan(-1);
  const end = row === 1 ? html.indexOf('data-testid="funnel-row-2"') : html.length;
  const chunk = html.slice(start, end);
  return [...chunk.matchAll(/<p class="text-xs font-medium text-text-2">([^<]+)<\/p>/g)].map((m) => m[1]!);
}

function rowClass(html: string, row: 1 | 2): string {
  const m = new RegExp(`<div class="([^"]+)" data-testid="funnel-row-${row}"`).exec(html);
  return m?.[1] ?? "";
}

describe("Panel — orden de las tarjetas", () => {
  it("dos filas de 4: el recorrido del dinero arriba, el resto abajo", () => {
    const html = render();
    expect(labels(html, 1)).toEqual(["Ingresos totales", "Comisiones del equipo", "Saldo tras comisiones", "Ganancia neta"]);
    expect(labels(html, 2)).toEqual(["Gastos operativos", "Ticket promedio", "Atenciones", "Tasa de retención"]);
    for (const row of [1, 2] as const) {
      const cls = rowClass(html, row);
      expect(cls).toContain("grid-cols-1");
      expect(cls).toContain("sm:grid-cols-2");
      expect(cls).toContain("lg:grid-cols-4");
    }
  });

  it("Saldo tras comisiones: monto, subtítulo y comparación con el periodo anterior", () => {
    const html = render();
    expect(html).toContain(money(628_000, CUR));
    expect(html).toContain(AFTER_COMMISSIONS_HINT);
    // 628.000 vs 500.000 → +26 %, con el monto anterior entre paréntesis.
    expect(html).toContain(`(${money(500_000, CUR)})`);
    expect(html).not.toContain(FILTER_NO_EXPENSES_NOTE);
  });

  it("Ganancia neta sigue en verde con el mismo tamaño que las demás; roja con pérdida", () => {
    const html = render();
    expect(html).toMatch(/class="min-w-0 rounded-lg border p-4 shadow-sm[^"]*bg-success-tint[^"]*" data-testid="net-profit-card"/);
    expect(html).not.toContain("sm:col-span-2");
    const loss = render({ funnel: computeFunnel({ count: 1, revenueCents: 1_000, commissionsCents: 0, expensesCents: 5_000 }) });
    expect(loss).toContain("bg-danger-tint");
  });

  it("Gastos operativos: se descuentan del saldo y, sin gastos antes, no inventa un porcentaje", () => {
    const html = render();
    expect(html).toContain("Se descuentan del saldo tras comisiones");
    const row2 = html.slice(html.indexOf('data-testid="funnel-row-2"'));
    const gastos = row2.slice(0, row2.indexOf("Ticket promedio"));
    expect(gastos).toContain("sin base para comparar");
    expect(gastos).not.toMatch(/\d+%/);
  });
});

describe("Panel — subtítulo de Comisiones del equipo", () => {
  const f = (revenueCents: number, commissionsCents: number): FunnelTotalsDto =>
    computeFunnel({ count: 1, revenueCents, commissionsCents, expensesCents: 0 });

  it("con comisiones: el porcentaje efectivo del periodo, según las reglas", () => {
    expect(commissionHint(f(778_000, 150_000), true)).toBe("19% efectivo · según la regla de cada servicio o profesional");
    // Una comisión puntual (o de una regla ya borrada) es dinero real aunque hoy no haya reglas.
    expect(commissionHint(f(10_000, 4_000), false)).toBe("40% efectivo · según la regla de cada servicio o profesional");
  });

  it("«Sin regla» solo sin reglas y con comisiones en 0", () => {
    expect(commissionHint(f(10_000, 0), false)).toBe(NO_COMMISSION_RULE_HINT);
    expect(commissionHint(f(0, 0), false)).toBe(NO_COMMISSION_RULE_HINT);
    expect(commissionHint(f(10_000, 0), true)).toBe("0% efectivo · según la regla de cada servicio o profesional");
    expect(commissionHint(f(0, 0), true)).toBe("Según la regla de cada servicio o profesional");
  });

  it("en la tarjeta: el monto es el real (nunca forzado a 0)", () => {
    const sinReglas = render({ commissionRulesConfigured: false, funnel: computeFunnel({ count: 1, revenueCents: 10_000, commissionsCents: 0, expensesCents: 0 }) });
    expect(sinReglas).toContain(NO_COMMISSION_RULE_HINT);
    const conPuntual = render({ commissionRulesConfigured: false });
    expect(conPuntual).not.toContain(NO_COMMISSION_RULE_HINT);
    expect(conPuntual).toContain(money(150_000, CUR));
  });
});

describe("Panel — casos especiales", () => {
  it("A: sin equipo se ocultan Comisiones y Saldo; dos filas de 3 sin huecos", () => {
    const html = render({ showCommissions: false });
    expect(labels(html, 1)).toEqual(["Ingresos totales", "Gastos operativos", "Ganancia neta"]);
    expect(labels(html, 2)).toEqual(["Ticket promedio", "Atenciones", "Tasa de retención"]);
    expect(html).not.toContain("Comisiones del equipo");
    expect(html).not.toContain("Saldo tras comisiones");
    for (const row of [1, 2] as const) {
      const cls = rowClass(html, row);
      expect(cls).toContain("sm:grid-cols-3");
      expect(cls).not.toContain("lg:grid-cols-4");
    }
  });

  it("B: con filtro de profesional o servicio, las 8 tarjetas; Gastos «No aplica» y el saldo lo avisa", () => {
    const filtered = computeFunnel({ count: 2, revenueCents: 20_000, commissionsCents: 8_000, expensesCents: null });
    const prev = computeFunnel({ count: 1, revenueCents: 10_000, commissionsCents: 4_000, expensesCents: null });
    const html = render({ funnel: filtered, previous: prev });
    expect(labels(html, 1)).toEqual(["Ingresos totales", "Comisiones del equipo", "Saldo tras comisiones", "Ganancia antes de gastos"]);
    expect(labels(html, 2)).toEqual(["Gastos operativos", "Ticket promedio", "Atenciones", "Tasa de retención"]);
    expect(html).toContain("No aplica");
    expect(html).toContain(`${AFTER_COMMISSIONS_HINT} · ${FILTER_NO_EXPENSES_NOTE}`);
    expect(html).toContain(money(12_000, CUR));
  });
});
