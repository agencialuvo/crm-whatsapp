"use client";

import type { ReactNode } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { KpiCard, percentChange, type Trend } from "@/components/negocio/dashboard-widgets";
import type { FunnelTotalsDto } from "@/lib/salon/funnel";
import { money } from "@/lib/salon/format";
import { cn } from "@/lib/utils";

/**
 * Panel — el embudo financiero real: de lo que se cobra a lo que de verdad queda, de izquierda a derecha.
 *
 *   Ingresos − Comisiones = Saldo tras comisiones
 *   Saldo tras comisiones − Gastos = Ganancia neta
 *
 * Fila 1: Ingresos · Comisiones · Saldo tras comisiones · Ganancia neta.
 * Fila 2: Gastos operativos · y las tarjetas que pase el Panel (Ticket, Atenciones, Retención).
 *
 * Sin equipo (ni comisiones históricas) Comisiones y Saldo no aportan nada (cero e igual a los ingresos):
 * se ocultan y Gastos sube a la fila 1, en dos filas de 3.
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

export const COMMISSION_RULE_HINT = "según la regla de cada servicio o profesional";
export const NO_COMMISSION_RULE_HINT = "Sin regla de comisión configurada";
export const AFTER_COMMISSIONS_HINT = "Disponible tras comisiones (base para gastos)";
export const FILTER_NO_EXPENSES_NOTE = "con este filtro no se restan gastos";

/**
 * El subtítulo de «Comisiones del equipo». Las comisiones salen de la regla de cada venta (venta,
 * profesional × servicio, profesional o servicio): el porcentaje es el EFECTIVO del periodo, no uno fijo.
 * «Sin regla» solo cuando de verdad no hay reglas y el periodo no tuvo comisiones (una comisión puntual
 * o de una regla ya borrada sigue siendo dinero real).
 */
export function commissionHint(funnel: FunnelTotalsDto, rulesConfigured: boolean): string {
  if (!rulesConfigured && funnel.commissionsCents === 0) return NO_COMMISSION_RULE_HINT;
  if (funnel.revenueCents > 0) {
    return `${Math.round((funnel.commissionsCents / funnel.revenueCents) * 100)}% efectivo · ${COMMISSION_RULE_HINT}`;
  }
  return `${COMMISSION_RULE_HINT[0]!.toUpperCase()}${COMMISSION_RULE_HINT.slice(1)}`;
}

const ROW_4 = "grid grid-cols-1 gap-2.5 sm:grid-cols-2 sm:gap-3 lg:grid-cols-4";
const ROW_3 = "grid grid-cols-1 gap-2.5 sm:grid-cols-3 sm:gap-3";

export function FunnelCards({
  funnel,
  previous,
  versus,
  currency,
  loading,
  showCommissions = true,
  commissionRulesConfigured = true,
  children,
}: {
  funnel: FunnelTotalsDto | null;
  previous: FunnelTotalsDto | null;
  /** «vs. mes anterior» o «vs. periodo anterior». */
  versus: string;
  currency: string;
  loading: boolean;
  /** `false` en un negocio sin equipo (ni comisiones históricas): Comisiones y Saldo se ocultan. */
  showCommissions?: boolean;
  /** ¿Hay algún porcentaje de comisión configurado? Decide el subtítulo «Sin regla de comisión configurada». */
  commissionRulesConfigured?: boolean;
  /** Las demás tarjetas de la fila 2 (Ticket, Atenciones, Retención), detrás de Gastos. */
  children?: ReactNode;
}) {
  const f = funnel;
  // Sin gastos no hay «ganancia neta» completa: es lo que queda antes de pagar los gastos del negocio.
  const expensesApply = f ? f.expensesCents !== null : true;
  const busy = loading && !!f;

  const expenses = (
    <KpiCard
      label="Gastos operativos"
      value={f ? (f.expensesCents === null ? "No aplica" : money(f.expensesCents, currency)) : "…"}
      hint={
        f && f.expensesCents === null
          ? "Los gastos son del negocio: no se asignan a un profesional ni a un servicio."
          : showCommissions
            ? "Se descuentan del saldo tras comisiones"
            : "Se descuentan de los ingresos"
      }
      trend={
        f && previous && f.expensesCents !== null && previous.expensesCents !== null
          ? trendOf(f.expensesCents, previous.expensesCents, versus, currency)
          : undefined
      }
      trendTone="up-bad"
      loading={busy}
    />
  );

  return (
    <>
      <div className={showCommissions ? ROW_4 : ROW_3} data-testid="funnel-row-1">
        <KpiCard
          label="Ingresos totales"
          value={f ? money(f.revenueCents, currency) : "…"}
          hint={f ? `${f.count} venta${f.count === 1 ? "" : "s"} cobrada${f.count === 1 ? "" : "s"}` : undefined}
          trend={f && previous ? trendOf(f.revenueCents, previous.revenueCents, versus, currency) : undefined}
          loading={busy}
        />
        {showCommissions && (
          <>
            <KpiCard
              label="Comisiones del equipo"
              value={f ? money(f.commissionsCents, currency) : "…"}
              hint={f ? commissionHint(f, commissionRulesConfigured) : undefined}
              trend={f && previous ? trendOf(f.commissionsCents, previous.commissionsCents, versus, currency) : undefined}
              trendTone="neutral"
              loading={busy}
            />
            <KpiCard
              label="Saldo tras comisiones"
              value={f ? money(f.afterCommissionsCents, currency) : "…"}
              hint={expensesApply ? AFTER_COMMISSIONS_HINT : `${AFTER_COMMISSIONS_HINT} · ${FILTER_NO_EXPENSES_NOTE}`}
              trend={
                f && previous
                  ? trendOf(f.afterCommissionsCents, previous.afterCommissionsCents, versus, currency)
                  : undefined
              }
              loading={busy}
            />
          </>
        )}
        {!showCommissions && expenses}
        <NetProfitCard
          funnel={f}
          previous={previous}
          versus={versus}
          currency={currency}
          loading={busy}
          expensesApply={expensesApply}
        />
      </div>
      <div className={showCommissions ? ROW_4 : ROW_3} data-testid="funnel-row-2">
        {showCommissions && expenses}
        {children}
      </div>
    </>
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
        "min-w-0 rounded-lg border p-4 shadow-sm transition-opacity",
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
          "mt-1 truncate text-2xl font-bold tabular-nums tracking-tight",
          loss ? "text-danger-text" : "text-success-text"
        )}
      >
        {funnel ? money(funnel.netCents, currency) : "…"}
      </p>
      {t && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1 text-xs text-text-3">
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
      <p className="mt-1 text-[11px] text-text-3">
        {expensesApply
          ? "El dinero limpio que te queda."
          : "Ingresos − Comisiones. Con este filtro no se restan los gastos del negocio."}
      </p>
    </div>
  );
}
