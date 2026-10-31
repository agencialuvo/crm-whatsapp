"use client";

import { useState } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { Section } from "@/components/results/section";
import { money } from "@/lib/salon/format";
import type { PaymentMethod } from "@/lib/salon/schemas";
import type { SalesReportDto } from "@/lib/salon/types";
import { cn } from "@/lib/utils";

/**
 * Módulo SALON — las piezas gráficas del Panel. HTML y CSS, sin librería de
 * gráficos: pesan nada, se adaptan al ancho del teléfono y heredan el tema
 * claro/oscuro. Cada gráfico lleva su lectura en texto (los números van
 * escritos), así que no depende del color para entenderse.
 */

/** Cuánto cambió respecto a la referencia; `null` si no hay base. */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export type Trend = {
  /** Variación (% o puntos); `null` = sin base para comparar. */
  change: number | null;
  unit: "%" | "pp";
  /** «vs. mes anterior». */
  versus: string;
  /** El valor de la referencia, ya escrito («S/ 1,200.00»). */
  previous: string;
};

/** Tarjeta de indicador con su tendencia: flecha, signo y contra qué se compara. */
export function KpiCard({
  label,
  value,
  hint,
  trend,
  trendTone = "up-good",
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  trend?: Trend;
  /** Cómo se lee que suba: bien (ventas), mal (gastos) o sin juicio (comisiones). */
  trendTone?: "up-good" | "up-bad" | "neutral";
  loading?: boolean;
}) {
  const change = trend?.change ?? null;
  const Icon = change === null || change === 0 ? ArrowRight : change > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border border-border-strong bg-card p-4 shadow-sm transition-opacity",
        loading && "opacity-60"
      )}
    >
      <p className="text-xs font-medium text-text-2">{label}</p>
      <p className="mt-1 truncate text-2xl font-bold tabular-nums tracking-tight">{value}</p>
      {trend && (
        <p
          className={cn(
            "mt-1.5 flex flex-wrap items-center gap-x-1 text-xs",
            change === null || change === 0 || trendTone === "neutral"
              ? "text-text-3"
              : (change > 0) === (trendTone === "up-bad")
                ? "text-danger-text"
                : "text-success-text"
          )}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {change === null ? (
            <span>sin base para comparar</span>
          ) : (
            <span className="font-semibold">
              {change > 0 ? "+" : ""}
              {change}
              {trend.unit === "%" ? "%" : " pp"}
            </span>
          )}
          <span className="text-text-3">
            {trend.versus} ({trend.previous})
          </span>
        </p>
      )}
      {hint && <p className="mt-1 text-[11px] text-text-3">{hint}</p>}
    </div>
  );
}

/* ----------------------------- métodos de pago ----------------------------- */

const GROUPS: { key: string; label: string; methods: PaymentMethod[]; color: string }[] = [
  { key: "efectivo", label: "Efectivo", methods: ["efectivo"], color: "var(--success)" },
  { key: "digital", label: "Yape / Plin", methods: ["yape_plin"], color: "var(--accent)" },
  { key: "tarjeta", label: "Tarjeta", methods: ["tarjeta"], color: "var(--warning)" },
  { key: "otro", label: "Otro", methods: ["otro"], color: "var(--border-strong)" },
];

/** Cómo se reparte lo cobrado entre efectivo, billeteras digitales y tarjeta. */
export function PaymentMix({
  report,
  currency,
  loading,
}: {
  report: SalesReportDto | null;
  currency: string;
  loading: boolean;
}) {
  const groups = GROUPS.map((g) => ({
    ...g,
    amount: (report?.byPayment ?? [])
      .filter((p) => g.methods.includes(p.method))
      .reduce((a, p) => a + p.amountCents, 0),
  })).filter((g) => g.amount > 0);
  const total = groups.reduce((a, g) => a + g.amount, 0);

  let acc = 0;
  const stops = groups
    .map((g) => {
      const from = (acc / total) * 100;
      acc += g.amount;
      return `${g.color} ${from}% ${(acc / total) * 100}%`;
    })
    .join(", ");

  return (
    <Section
      title="Métodos de pago"
      hint="Cómo pagaron los clientes en el periodo."
      loading={loading}
      hasData={report !== null}
      empty={total === 0}
      emptyText="Sin cobros en este periodo."
    >
      <div className="flex flex-col items-center gap-4 sm:flex-row lg:flex-col">
        <div
          role="img"
          aria-label={groups
            .map((g) => `${g.label} ${Math.round((g.amount / total) * 100)}%`)
            .join(", ")}
          className="relative h-32 w-32 shrink-0 rounded-full"
          style={{ background: `conic-gradient(${stops})` }}
        >
          <div className="absolute inset-4 flex flex-col items-center justify-center rounded-full bg-card text-center">
            <span className="text-[10px] text-text-3">Total</span>
            <span className="text-xs font-bold tabular-nums">{money(total, currency)}</span>
          </div>
        </div>
        <ul className="w-full min-w-0 space-y-2">
          {groups.map((g) => (
            <li key={g.key} className="flex items-start gap-2 text-sm">
              <span
                aria-hidden
                className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border"
                style={{ background: g.color }}
              />
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{g.label}</span>
                  <span className="shrink-0 font-semibold tabular-nums">
                    {Math.round((g.amount / total) * 100)}%
                  </span>
                </p>
                <p className="text-xs tabular-nums text-text-3">{money(g.amount, currency)}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

/* ------------------------- servicios y ofertas top ------------------------- */

/** Los servicios y ofertas que más se piden y los que más dejan, en barras. */
export function TopItems({
  report,
  currency,
  loading,
}: {
  report: SalesReportDto | null;
  currency: string;
  loading: boolean;
}) {
  const [by, setBy] = useState<"revenue" | "count">("revenue");
  const items = [...(report?.byItem ?? [])]
    .sort((a, b) =>
      by === "revenue" ? b.revenueCents - a.revenueCents : b.count - a.count || b.revenueCents - a.revenueCents
    )
    .slice(0, 6);
  const max = Math.max(1, ...items.map((i) => (by === "revenue" ? i.revenueCents : i.count)));

  return (
    <Section
      title="Servicios y ofertas top"
      hint="Lo más vendido y lo más rentable del periodo."
      loading={loading}
      hasData={report !== null}
      empty={items.length === 0}
      emptyText="Sin ventas en este periodo."
      right={
        <div className="flex gap-1" role="group" aria-label="Ordenar por">
          {(
            [
              ["revenue", "Ingresos"],
              ["count", "Veces vendido"],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              aria-pressed={by === value}
              onClick={() => setBy(value)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                by === value
                  ? "border-brand bg-brand-tint text-brand-text"
                  : "text-text-2 hover:bg-accent hover:text-foreground"
              )}
            >
              {text}
            </button>
          ))}
        </div>
      }
    >
      <ul className="space-y-3">
        {items.map((it, i) => {
          const value = by === "revenue" ? it.revenueCents : it.count;
          return (
            <li key={`${it.kind}:${it.itemId}`}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">
                  <span className="mr-2 text-xs tabular-nums text-text-3">{i + 1}</span>
                  {it.name}
                  {it.kind === "combo" && (
                    <span className="ml-1.5 text-[11px] text-text-3">oferta</span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums">
                  <strong className="font-semibold">
                    {by === "revenue" ? money(it.revenueCents, currency) : `${it.count}×`}
                  </strong>
                  <span className="ml-1.5 text-xs text-text-3">
                    {by === "revenue"
                      ? `${it.count} venta${it.count === 1 ? "" : "s"}`
                      : money(it.revenueCents, currency)}
                  </span>
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-[4px] bg-subtle" aria-hidden>
                <div
                  className="h-full rounded-r-[4px] bg-brand"
                  style={{ width: `${Math.max(2, (value / max) * 100)}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/* --------------------------- rendimiento del equipo --------------------------- */

/** Lo que vendió cada profesional, partido entre su comisión y lo que le deja al negocio. */
export function TeamBars({
  report,
  currency,
  loading,
}: {
  report: SalesReportDto | null;
  currency: string;
  loading: boolean;
}) {
  const team = report?.byStaff ?? [];
  const max = Math.max(1, ...team.map((m) => m.revenueCents));

  return (
    <Section
      title="Rendimiento del equipo"
      hint="Ventas y comisiones acumuladas de cada profesional en el periodo."
      loading={loading}
      hasData={report !== null}
      empty={team.length === 0}
      emptyText="Sin ventas en este periodo."
      right={
        <p className="flex items-center gap-3 text-xs text-text-2" aria-hidden>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-brand" />
            Para el negocio
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--warning)" }} />
            Comisión
          </span>
        </p>
      }
    >
      <ul className="space-y-4">
        {team.map((m) => {
          const width = Math.max(3, (m.revenueCents / max) * 100);
          const commissionPct = m.revenueCents > 0 ? (m.commissionCents / m.revenueCents) * 100 : 0;
          return (
            <li key={m.staffId}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
                <span className="min-w-0 truncate font-medium">{m.staffName}</span>
                <span className="text-xs text-text-3">
                  {m.count} servicio{m.count === 1 ? "" : "s"} ·{" "}
                  {m.count > 0 ? money(Math.round(m.revenueCents / m.count), currency) : "—"} prom.
                </span>
              </div>
              <div
                className="mt-1.5 h-2.5 overflow-hidden rounded-[4px] bg-subtle"
                aria-hidden
              >
                <div className="flex h-full overflow-hidden rounded-r-[4px]" style={{ width: `${width}%` }}>
                  <div className="h-full bg-brand" style={{ width: `${100 - commissionPct}%` }} />
                  <div className="h-full" style={{ width: `${commissionPct}%`, background: "var(--warning)" }} />
                </div>
              </div>
              <p className="mt-1 text-xs tabular-nums text-text-2">
                <strong className="font-semibold text-foreground">
                  {money(m.revenueCents, currency)}
                </strong>{" "}
                vendido · comisión {money(m.commissionCents, currency)} · negocio{" "}
                {money(m.netCents, currency)}
              </p>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
