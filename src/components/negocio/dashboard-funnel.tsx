"use client";

import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { KpiCard, percentChange, type Trend } from "@/components/negocio/dashboard-widgets";
import type { FunnelTotalsDto } from "@/lib/salon/funnel";
import { money } from "@/lib/salon/format";
import { cn } from "@/lib/utils";

/**
 * Panel — el embudo financiero real: de lo que se cobra a lo que de verdad queda.
 *
 *   Ingresos − Comisiones − Gastos = Ganancia neta
 *
 * La ganancia neta se distingue por su tinte verde (rojo si el periodo cierra en pérdida),
 * el mismo estilo de la pantalla Gastos, para que el dueño no confunda lo que cobró con lo que le queda.
 */

/** La variación contra el periodo de comparación; sin base (cero o negativa) no hay porcentaje. */
function trendOf(current: number, previous: number, versus: string, currency: string): Trend {
  return {
    change: previous > 0 ? percentChange(current, previous) : null,
    unit: "%",
    versus,
    previous: money(previous, currency),
  };
}

export function FunnelCards({
  funnel,
  previous,
  versus,
  currency,
  loading,
}: {
  funnel: FunnelTotalsDto | null;
  previous: FunnelTotalsDto | null;
  /** «vs. mes anterior» o «vs. periodo anterior». */
  versus: string;
  currency: string;
  loading: boolean;
}) {
  const f = funnel;
  // Sin gastos no hay «ganancia neta» completa: es lo que queda antes de pagar los gastos del negocio.
  const expensesApply = f ? f.expensesCents !== null : true;

  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 sm:gap-3 lg:grid-cols-4">
      <KpiCard
        label="Ingresos totales"
        value={f ? money(f.revenueCents, currency) : "…"}
        hint={f ? `${f.count} venta${f.count === 1 ? "" : "s"} cobrada${f.count === 1 ? "" : "s"}` : undefined}
        trend={f && previous ? trendOf(f.revenueCents, previous.revenueCents, versus, currency) : undefined}
        loading={loading && !!f}
      />
      <KpiCard
        label="Comisiones del equipo"
        value={f ? money(f.commissionsCents, currency) : "…"}
        hint={
          f && f.revenueCents > 0
            ? `${Math.round((f.commissionsCents / f.revenueCents) * 100)}% de los ingresos`
            : "lo que se lleva el personal"
        }
        trend={f && previous ? trendOf(f.commissionsCents, previous.commissionsCents, versus, currency) : undefined}
        trendTone="neutral"
        loading={loading && !!f}
      />
      <KpiCard
        label="Gastos operativos"
        value={f ? (f.expensesCents === null ? "No aplica" : money(f.expensesCents, currency)) : "…"}
        hint={
          f && f.expensesCents === null
            ? "Los gastos son del negocio: no se asignan a un profesional ni a un servicio."
            : "insumos, alquiler y servicios (módulo Gastos)"
        }
        trend={
          f && previous && f.expensesCents !== null && previous.expensesCents !== null
            ? trendOf(f.expensesCents, previous.expensesCents, versus, currency)
            : undefined
        }
        trendTone="up-bad"
        loading={loading && !!f}
      />
      <NetProfitCard
        funnel={f}
        previous={previous}
        versus={versus}
        currency={currency}
        loading={loading && !!f}
        expensesApply={expensesApply}
      />
    </div>
  );
}

function NetProfitCard({
  funnel,
  previous,
  versus,
  currency,
  loading,
  expensesApply,
}: {
  funnel: FunnelTotalsDto | null;
  previous: FunnelTotalsDto | null;
  versus: string;
  currency: string;
  loading: boolean;
  expensesApply: boolean;
}) {
  const loss = funnel !== null && funnel.netCents < 0;
  const t = funnel && previous ? trendOf(funnel.netCents, previous.netCents, versus, currency) : null;
  const change = t?.change ?? null;
  const Icon = change === null || change === 0 ? ArrowRight : change > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <div
      className={cn(
        "min-w-0 rounded-md border px-3 py-2.5 transition-opacity sm:col-span-2 lg:col-span-1",
        loss ? "border-danger-soft bg-danger-tint" : "border-success-soft bg-success-tint",
        loading && "opacity-60"
      )}
      data-testid="net-profit-card"
    >
      <p className="text-xs font-medium text-text-2">
        {expensesApply ? "Ganancia neta" : "Ganancia antes de gastos"}
      </p>
      <p
        className={cn(
          "mt-0.5 truncate text-xl font-semibold tabular-nums",
          loss ? "text-danger-text" : "text-success-text"
        )}
      >
        {funnel ? money(funnel.netCents, currency) : "…"}
      </p>
      {t && (
        <p className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-text-3">
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {change === null ? (
            <span>sin base para comparar</span>
          ) : (
            <span className="font-semibold">
              {change > 0 ? "+" : ""}
              {change}%
            </span>
          )}
          <span>
            {t.versus} ({t.previous})
          </span>
        </p>
      )}
      <p className="mt-1 text-xs text-text-3">
        {expensesApply
          ? "El dinero limpio que te queda."
          : "Ingresos − Comisiones. Con este filtro no se restan los gastos del negocio."}
      </p>
    </div>
  );
}
