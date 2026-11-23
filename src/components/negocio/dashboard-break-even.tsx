"use client";

import Link from "next/link";
import { Section } from "@/components/results/section";
import { MONTH_NAMES, money } from "@/lib/salon/format";
import type { BreakEvenDto, BreakEvenProgress } from "@/lib/salon/break-even";
import { cn } from "@/lib/utils";

/**
 * Panel — Punto de Equilibrio: lo mínimo que hay que vender en el mes para cubrir los gastos fijos, la meta
 * diaria que sale de ahí y a qué ritmo se vende hoy. Las cuentas son de `src/lib/salon/break-even.ts`; aquí
 * solo se pintan. Es del negocio entero: no cambia con los filtros de profesional o servicio.
 *
 * La referencia es UNA: el equilibrio del mes. La meta diaria sale de él y el ritmo actual se compara con la
 * meta diaria; el avance del periodo se dice solo en porcentaje, para no poner dos «equilibrios» a la vista.
 */

const PROGRESS: Record<BreakEvenProgress, { label: string; badge: string; bar: string }> = {
  reached: { label: "Alcanzado", badge: "border-success-soft bg-success-tint text-success-text", bar: "bg-success-text" },
  on_track: { label: "En camino", badge: "border-warning-soft bg-warning-tint text-warning-text", bar: "bg-warning-text" },
  below: { label: "Por debajo", badge: "border-danger-soft bg-danger-tint text-danger-text", bar: "bg-danger-text" },
};

/** La barra de avance llena es el 100 % de la meta (no es un campo de porcentaje editable). */
const FULL_BAR = 100;

const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

function monthLabel(month: string): string {
  const name = MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month;
  return `${name} ${month.slice(0, 4)}`;
}

function Stat({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className="min-w-0 rounded-md border bg-subtle px-3 py-2.5">
      <p className="text-xs font-medium text-text-2">{label}</p>
      <p className={cn("mt-0.5 truncate tabular-nums", strong ? "text-2xl font-bold" : "text-xl font-semibold")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-3">{hint}</p>}
    </div>
  );
}

export function BreakEvenCard({
  data,
  currency,
  loading,
  filtersActive,
}: {
  data: BreakEvenDto | null;
  currency: string;
  loading: boolean;
  /** Hay un filtro de profesional o de servicio: este bloque lo ignora y conviene decirlo. */
  filtersActive: boolean;
}) {
  const d = data;
  const p = d?.progress ? PROGRESS[d.progress] : null;

  return (
    <Section
      title="Punto de equilibrio"
      hint="Lo mínimo que debes vender en el mes para cubrir tus gastos fijos."
      loading={loading}
      hasData={d !== null}
    >
      {d && (
        <div className="space-y-4">
          {filtersActive && (
            <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-2">
              El punto de equilibrio es de todo el negocio: no cambia con el filtro de profesional ni de servicio.
            </p>
          )}

          {d.state === "no_fixed_costs" && (
            <p className="text-sm text-text-2">
              Todavía no hay gastos fijos para calcularlo. Registra los que tengas (alquiler, luz, sueldos, publicidad…) en{" "}
              <Link href="/gastos" className="font-semibold text-primary underline-offset-2 hover:underline">
                Gastos
              </Link>{" "}
              marcándolos como fijos.
            </p>
          )}

          {d.state === "invalid_margin" && (
            <div role="alert" className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2.5 text-sm text-danger-text">
              Las comisiones ({Math.round(d.commissionRate * 100)} % de los ingresos) se llevan todo lo que entra, así que no hay
              margen para cubrir los gastos fijos y el punto de equilibrio no se puede calcular. Revisa los porcentajes de
              comisión del equipo.
            </div>
          )}

          {d.state === "ok" && d.monthlyBreakEvenCents !== null && d.dailyBreakEvenCents !== null && (
            <>
              {p && d.coveredPercent !== null && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-bold", p.badge)}>{p.label}</span>
                    <p className="text-sm text-text-2">
                      Llevas el <span className="font-semibold tabular-nums text-foreground">{d.coveredPercent} %</span> de la meta del periodo
                    </p>
                  </div>
                  <div
                    className="h-2 overflow-hidden rounded-full bg-border"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={FULL_BAR}
                    aria-valuenow={Math.min(FULL_BAR, d.coveredPercent)}
                    aria-label="Avance del periodo frente a la meta"
                  >
                    <div className={cn("h-full rounded-full", p.bar)} style={{ width: `${Math.min(FULL_BAR, Math.max(0, d.coveredPercent))}%` }} />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                <Stat
                  strong
                  label={`Punto de equilibrio de ${monthLabel(d.month)}`}
                  value={money(d.monthlyBreakEvenCents, currency)}
                  hint={`gastos fijos del mes completo ${money(d.fixedExpensesMonthCents, currency)} ÷ margen de contribución ${Math.round(d.contributionMargin * 100)} %`}
                />
                <Stat
                  label="Meta diaria mínima"
                  value={money(d.dailyBreakEvenCents, currency)}
                  hint={
                    d.dailyVisitsNeeded !== null
                      ? `≈ ${plural(d.dailyVisitsNeeded, "atención", "atenciones")} al día · ${plural(d.operationalDaysInMonth, "día operativo", "días operativos")} en el mes`
                      : `${plural(d.operationalDaysInMonth, "día operativo", "días operativos")} en el mes`
                  }
                />
                <Stat
                  label="Ritmo actual por día"
                  value={d.currentDailyPaceCents === null ? "—" : money(d.currentDailyPaceCents, currency)}
                  hint={
                    d.currentDailyPaceCents === null
                      ? "aún no pasa ningún día operativo del periodo"
                      : d.currentDailyPaceCents >= d.dailyBreakEvenCents
                        ? "al día o por encima de la meta"
                        : `${money(d.dailyBreakEvenCents - d.currentDailyPaceCents, currency)} por debajo de la meta`
                  }
                />
              </div>
            </>
          )}

          {(d.state === "ok" || d.state === "invalid_margin") && d.rangeIncludesToday && d.today.closed && (
            <p className="rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
              Hoy es un día cerrado según tu horario: no cuenta para la meta diaria.
            </p>
          )}

          {d.state === "ok" && !d.coversWholeMonth && (
            <p className="text-xs text-text-3">
              Usa los gastos fijos de todo {monthLabel(d.month)}, también los fechados después del rango elegido: por eso puede diferir
              de «Gastos operativos», que solo suma las fechas del rango.
            </p>
          )}
          {d.usingPreviousMonthFixedExpenses && (
            <p className="text-xs text-text-3">Calculado con gastos fijos del mes pasado: aún no cargas los de este mes.</p>
          )}
          {d.state === "ok" && d.operationalDaysSource !== "schedule" && (
            <p className="text-xs text-text-3">
              {d.operationalDaysSource === "sales"
                ? "Días operativos deducidos de tus ventas de los últimos 60 días: configura tu horario en Ajustes → Agenda para afinarlo."
                : "Días operativos supuestos de lunes a sábado: configura tu horario en Ajustes → Agenda para afinarlo."}
            </p>
          )}
          {d.state === "ok" && d.commissionRateSource !== "period" && d.commissionRateSource !== "recent" && d.commissionRate === 0 && (
            <p className="text-xs text-text-3">Sin comisiones registradas todavía: el margen se calcula sin ellas.</p>
          )}
        </div>
      )}
    </Section>
  );
}
