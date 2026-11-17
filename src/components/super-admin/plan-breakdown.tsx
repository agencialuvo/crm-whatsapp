"use client";

import { formatMoneyCents } from "@/lib/money";
import type { Metrics } from "@/lib/saas";

/** 045 — Organizaciones por plan y estado (plan × estado). Los planes retirados salen juntos. */
export function PlanBreakdown({ metrics }: { metrics: Metrics }) {
  const rows = metrics.byPlan;
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <section className="rounded-lg border bg-card p-4" data-testid="plan-breakdown">
      <h3 className="mb-3 text-sm font-semibold">Por plan</h3>
      {rows.length === 0 ? (
        <p className="py-2 text-sm text-text-3">Todavía no hay organizaciones con plan.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.planId} data-testid={`plan-row-${r.planId}`}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0 truncate font-medium">
                  {r.name}
                  {!r.legacy && r.priceMonthlyCents > 0 && (
                    <span className="ml-1.5 text-xs font-normal text-text-3">{formatMoneyCents(r.priceMonthlyCents, metrics.mrr.currency, "es-PE")}/mes</span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums" data-testid="plan-total">
                  {r.total}
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-[4px] bg-subtle" aria-hidden>
                <div className="h-full rounded-[4px] bg-brand" style={{ width: `${(r.total / max) * 100}%` }} />
              </div>
              <p className="mt-1 text-xs text-text-3">
                {r.counts.active} activas · {r.counts.trialing} en prueba · {r.counts.pastDue} vencidas · {r.counts.canceled} canceladas
                {r.counts.paused > 0 ? ` · ${r.counts.paused} suspendidas` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
