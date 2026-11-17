"use client";

import { Building2, CircleDollarSign, Hourglass, PauseCircle, TriangleAlert, UserCheck } from "lucide-react";
import { formatMoneyCents } from "@/lib/money";
import type { Metrics } from "@/lib/saas";
import { cn } from "@/lib/utils";

/**
 * 045 — Las tarjetas del dashboard: organizaciones por estado y el MRR. Los números los calcula el servidor
 * (`computeMetrics`); aquí solo se pintan. La suma de los estados siempre da el total.
 */
export function MetricCards({ metrics }: { metrics: Metrics }) {
  const t = metrics.totals;
  const items = [
    { key: "organizations", label: "Organizaciones", value: t.organizations, icon: Building2, hint: t.withoutSubscription > 0 ? `${t.withoutSubscription} sin suscripción (anteriores)` : "registradas" },
    { key: "active", label: "Activas", value: t.active, icon: UserCheck, hint: "pagando" },
    { key: "trialing", label: "En prueba", value: t.trialing, icon: Hourglass, hint: "Demo vigente" },
    { key: "pastDue", label: "Vencidas", value: t.pastDue, icon: TriangleAlert, hint: "prueba o pago vencido" },
    { key: "canceled", label: "Canceladas", value: t.canceled, icon: PauseCircle, hint: t.paused > 0 ? `+ ${t.paused} suspendidas` : "bajas" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="metric-cards">
      {items.map((i) => (
        <div key={i.key} className="rounded-lg border bg-card p-4" data-testid={`metric-${i.key}`}>
          <div className="flex items-center justify-between text-text-3">
            <span className="kicker">{i.label}</span>
            <i.icon className="h-4 w-4" aria-hidden />
          </div>
          <p className="mt-2 text-2xl font-bold tabular-nums" data-testid="metric-value">
            {i.value}
          </p>
          <p className="mt-0.5 text-xs text-text-3">{i.hint}</p>
        </div>
      ))}
      <div className={cn("rounded-lg border bg-card p-4")} data-testid="metric-mrr">
        <div className="flex items-center justify-between text-text-3">
          <span className="kicker">MRR estimado</span>
          <CircleDollarSign className="h-4 w-4" aria-hidden />
        </div>
        <p className="mt-2 text-2xl font-bold tabular-nums" data-testid="metric-value">
          {formatMoneyCents(metrics.mrr.mrrCents, metrics.mrr.currency, "es-PE")}
        </p>
        <p className="mt-0.5 text-xs text-text-3">
          {metrics.mrr.activeCount} activas · ARR {formatMoneyCents(metrics.mrr.arrCents, metrics.mrr.currency, "es-PE")}
        </p>
        {metrics.mrr.churningMrrCents > 0 && (
          <p className="mt-0.5 text-xs text-warning-text">
            {formatMoneyCents(metrics.mrr.churningMrrCents, metrics.mrr.currency, "es-PE")} en salida
          </p>
        )}
        {metrics.mrr.atRiskCents > 0 && (
          <p className="mt-0.5 text-xs text-warning-text">
            {formatMoneyCents(metrics.mrr.atRiskCents, metrics.mrr.currency, "es-PE")} en riesgo
          </p>
        )}
        {metrics.mrr.mixedCurrency && <p className="mt-0.5 text-xs text-warning-text">Hay planes en otra moneda: no se suman.</p>}
      </div>
    </div>
  );
}
