"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Cake } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTablePagination, DataTableToolbar } from "@/components/ui/data-table-pagination";
import { useDataTable } from "@/components/ui/use-data-table";
import { apiFetch, describeError } from "@/components/negocio/api";
import { FunnelCards } from "@/components/negocio/dashboard-funnel";
import {
  KpiCard,
  PaymentMix,
  percentChange,
  TeamBars,
  TopItems,
  type Trend,
} from "@/components/negocio/dashboard-widgets";
import { RangePicker, type Range } from "@/components/results/range-picker";
import { Section } from "@/components/results/section";
import { TimeBars } from "@/components/results/time-bars";
import { itemFilterOptions } from "@/lib/salon/funnel";
import { MONTH_NAMES, money } from "@/lib/salon/format";
import { addDaysISO } from "@/lib/time/slots";
import type { SaleOptionsDto, SalonDashboardDto } from "@/lib/salon/types";
import { cn } from "@/lib/utils";
import { SearchSelect } from "@/components/ui/search-select";

/** Lista vacía estable mientras el Panel carga. */
const NONE: never[] = [];
const BIRTHDAY_NOUN = { one: "cumpleaños", other: "cumpleaños" };

/** Atajos del Panel: hoy, la semana (de lunes a hoy), el mes y el mes pasado. Las fechas sueltas están en el selector. */
function dashboardPresets(today: string): { label: string; range: Range }[] {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = domingo
  const monday = addDaysISO(today, -((weekday + 6) % 7));
  const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthEnd = addDaysISO(monthStart, -1);
  return [
    { label: "Hoy", range: { from: today, to: today } },
    { label: "Esta semana", range: { from: monday, to: today } },
    { label: "Este mes", range: { from: monthStart, to: today } },
    { label: "Mes pasado", range: { from: `${lastMonthEnd.slice(0, 8)}01`, to: lastMonthEnd } },
  ];
}

/** Enlace de WhatsApp para saludar; solo con un celular de dígitos. */
function whatsappLink(phone: string | null, name: string): string | null {
  if (!phone || !/^\d{7,15}$/.test(phone)) return null;
  const text = `¡Hola ${name.split(" ")[0] ?? ""}! 🎉 Feliz cumpleaños de parte de todo el equipo.`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

/**
 * Módulo SALON — panel ejecutivo (solo dueño/administrador).
 *
 * Un solo selector de fechas (Hoy, Esta semana, Este mes o fechas a mano)
 * recalcula las tarjetas con su tendencia, los gráficos de ingresos, servicios y
 * métodos de pago, y el equipo; los cumpleaños son siempre los del mes en curso del negocio
 * (retención: a quién saludar), no dependen del rango.
 */
export function DashboardClient({
  currency,
  today,
}: {
  currency: string;
  today: string;
}) {
  const [range, setRange] = useState<Range>({ from: `${today.slice(0, 8)}01`, to: today });
  // Auditoría rápida: acota las tarjetas, el equipo y el ranking a un profesional.
  const [staffId, setStaffId] = useState("");
  const [staffOptions, setStaffOptions] = useState<SaleOptionsDto["staff"]>([]);
  // Filtro por servicio u oferta (`service`, `combo`, `service:<id>`, `combo:<id>`): acota tarjetas y gráfica.
  const [item, setItem] = useState("");
  const [itemOptions, setItemOptions] = useState<ReturnType<typeof itemFilterOptions>>([]);
  // Qué muestra la gráfica de tendencia.
  const [view, setView] = useState<"revenue" | "net">("revenue");
  const [data, setData] = useState<SalonDashboardDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const load = useCallback(async (r: Range, staff: string, itemFilter: string) => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<SalonDashboardDto>(
        `/api/negocio/panel?from=${r.from}&to=${r.to}${staff ? `&staffId=${encodeURIComponent(staff)}` : ""}${itemFilter ? `&item=${encodeURIComponent(itemFilter)}` : ""}`,
        { signal: ctrl.signal }
      );
      if (ctrl.signal.aborted) return;
      setData(res);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(describeError(err));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range, staffId, item);
    return () => ctrlRef.current?.abort();
  }, [range, staffId, item, load]);

  // Los selectores de profesional y servicio se llenan una vez (no dependen de los filtros).
  useEffect(() => {
    let alive = true;
    apiFetch<SaleOptionsDto>("/api/negocio/opciones")
      .then((o) => {
        if (!alive) return;
        setStaffOptions(o.staff);
        setItemOptions(itemFilterOptions(o.services, o.combos));
      })
      .catch(() => {
        // Sin la lista no hay filtros por profesional ni servicio; el resto funciona igual.
      });
    return () => {
      alive = false;
    };
  }, []);

  const report = data?.report ?? null;
  const f = data?.funnel;
  const birthdays = data?.birthdays;
  // Los cumpleaños del mes pueden ser muchos: van paginados como cualquier lista.
  const birthdayTable = useDataTable(birthdays?.clients ?? NONE, { view: "panel-cumpleanos", defaultPageSize: 10 });
  const monthName = birthdays ? MONTH_NAMES[birthdays.month - 1] : null;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <RangePicker
          value={range}
          onChange={setRange}
          today={today}
          presets={dashboardPresets(today)}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {staffOptions.length > 1 && (
            <div className="flex items-center gap-2">
              <label htmlFor="panel-staff" className="text-sm font-medium text-text-2">
                Profesional:
              </label>
              <SearchSelect
                id="panel-staff"
                value={staffId}
                onChange={setStaffId}
                options={staffOptions.map((m) => ({ value: m.id, label: m.name }))}
                emptyLabel="Todo el equipo"
                placeholder="Todo el equipo"
                searchPlaceholder="Buscar profesional…"
                className="w-48"
              />
            </div>
          )}
          {itemOptions.length > 2 && (
            <div className="flex items-center gap-2">
              <label htmlFor="panel-item" className="text-sm font-medium text-text-2">
                Servicio:
              </label>
              <SearchSelect
                id="panel-item"
                value={item}
                onChange={setItem}
                options={itemOptions}
                emptyLabel="Todos los servicios y ofertas"
                placeholder="Todos los servicios y ofertas"
                searchPlaceholder="Buscar servicio u oferta…"
                className="w-64"
              />
            </div>
          )}
        </div>
      </div>

      {item && (
        <p className="-mt-2 text-xs text-text-3">
          El filtro de servicio acota las tarjetas y la gráfica; métodos de pago, ranking y equipo muestran todo el
          periodo.
        </p>
      )}

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-soft bg-danger-tint p-4 text-sm text-danger-text"
        >
          <p>{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void load(range, staffId, item)}>
            Reintentar
          </Button>
        </div>
      ) : (
        <section aria-label="Indicadores del periodo" aria-busy={loading} className="space-y-2.5 sm:space-y-3">
          <FunnelCards
            funnel={data?.funnel ?? null}
            previous={data?.comparison.funnel ?? null}
            versus={data?.comparison.kind === "month" ? "vs. mes anterior" : "vs. periodo anterior"}
            currency={currency}
            loading={loading}
          />
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3 sm:gap-3">
            <KpiCard
              label="Ticket promedio"
              value={f ? (f.count > 0 ? money(Math.round(f.revenueCents / f.count), currency) : "—") : "…"}
              hint="ingresos ÷ atenciones"
              trend={trend(data, "ticket", currency)}
              loading={loading && !!report}
            />
            <KpiCard
              label="Atenciones"
              value={f ? String(f.count) : "…"}
              hint={
                data?.appointments != null
                  ? `${data.appointments} cita${data.appointments === 1 ? "" : "s"} en la agenda`
                  : "servicios cobrados en Caja"
              }
              trend={trend(data, "count", currency)}
              loading={loading && !!report}
            />
            <KpiCard
              label="Tasa de retención"
              value={data ? (data.retention.rate === null ? "—" : `${data.retention.rate}%`) : "…"}
              hint={
                data
                  ? data.retention.clients > 0
                    ? `${data.retention.returning} de ${data.retention.clients} clientes atendidos con 2 o más visitas`
                    : "sin clientes identificados en el periodo"
                  : undefined
              }
              trend={trend(data, "retention", currency)}
              loading={loading && !!report}
            />
          </div>
        </section>
      )}

      {(data || !error) && (
        <>
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Section
                title={`${view === "net" ? "Ganancia neta" : "Ingresos"} por ${
                  data?.series.granularity === "month" ? "mes" : data?.series.granularity === "week" ? "semana" : "día"
                }`}
                hint={
                  view === "net"
                    ? item || staffId
                      ? "Ingresos − comisiones por tramo; con este filtro no se restan gastos. Rojo = pérdida."
                      : "Ingresos − comisiones − gastos por tramo: lo que de verdad dejó. Rojo = pérdida."
                    : "La tendencia de ventas en el periodo; pasa el cursor por una barra para ver el detalle."
                }
                loading={loading}
                hasData={data !== null}
                right={
                  <div className="flex gap-1" role="group" aria-label="Qué mostrar en la gráfica">
                    {(
                      [
                        ["revenue", "Ver Ingresos"],
                        ["net", "Ver Ganancia Neta"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={view === key}
                        onClick={() => setView(key)}
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          view === key
                            ? "border-brand bg-brand-tint text-brand-text"
                            : "text-text-2 hover:bg-accent hover:text-foreground"
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                }
              >
                {data && (
                  <TimeBars
                    title={
                      data.series.granularity === "month"
                        ? "Por mes"
                        : data.series.granularity === "week"
                          ? "Por semana (inicio)"
                          : "Por día"
                    }
                    unit={view === "net" ? "ganancia neta" : "ingresos"}
                    format={(v) => money(v, currency)}
                    points={data.series.points.map((p) => ({
                      bucket: p.bucket,
                      value: view === "net" ? p.netCents : p.revenueCents,
                      detail:
                        view === "net"
                          ? `${money(p.revenueCents, currency)} ingresos`
                          : `${p.count} atención${p.count === 1 ? "" : "es"}`,
                    }))}
                    emptyText={view === "net" ? "Sin ganancia en el periodo." : undefined}
                  />
                )}
              </Section>
            </div>
            <PaymentMix report={report} currency={currency} loading={loading} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <TopItems report={report} currency={currency} loading={loading} />
            <TeamBars report={report} currency={currency} loading={loading} />
          </div>

          <div>
            <Section
              title={monthName ? `Cumpleaños de ${monthName}` : "Cumpleaños del mes"}
              hint="Clientes que cumplen años este mes: un saludo ayuda a que vuelvan."
              loading={loading && !data}
              hasData={data !== null}
              empty={birthdays?.clients.length === 0}
              emptyText="Ningún cliente cumple años este mes. Registra el cumpleaños al cobrar o desde Clientes."
            >
              {birthdays && (
                <>
                <DataTableToolbar {...birthdayTable.pagination} noun={BIRTHDAY_NOUN} />
                <ul className="divide-y">
                  {birthdayTable.rows.map((c) => {
                    const link = whatsappLink(c.phone, c.name);
                    const isToday = c.day === birthdays.today;
                    const passed = c.day < birthdays.today;
                    return (
                      <li key={c.id} className="flex items-center gap-3 py-2">
                        <span
                          className={cn(
                            "flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-md border text-sm font-bold tabular-nums",
                            isToday
                              ? "border-brand bg-brand-tint text-brand-text"
                              : passed
                                ? "text-text-3"
                                : "bg-subtle"
                          )}
                        >
                          {c.day}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {c.name}
                            {isToday && (
                              <span className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-text">
                                <Cake className="h-3.5 w-3.5" aria-hidden />
                                ¡Hoy!
                              </span>
                            )}
                          </p>
                          <p className="truncate text-xs text-text-3">
                            {c.visits} visita{c.visits === 1 ? "" : "s"} ·{" "}
                            {money(c.totalCents, currency)} invertidos
                          </p>
                        </div>
                        {link && (
                          <a
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 rounded-md border px-2.5 py-1.5 text-xs font-semibold text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`Saludar a ${c.name} por WhatsApp`}
                          >
                            Saludar
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <DataTablePagination
                  {...birthdayTable.pagination}
                  noun={BIRTHDAY_NOUN}
                  label="Paginación de cumpleaños"
                />
                </>
              )}
            </Section>
          </div>
        </>
      )}
    </div>
  );
}

/** La tendencia de una tarjeta contra el periodo de comparación (mes anterior o tramo anterior). */
function trend(
  data: SalonDashboardDto | null,
  kind: "ticket" | "count" | "retention",
  currency: string
): Trend | undefined {
  if (!data) return undefined;
  const c = data.comparison;
  const t = data.funnel;
  const versus = c.kind === "month" ? "vs. mes anterior" : "vs. periodo anterior";
  if (kind === "count") {
    return { change: percentChange(t.count, c.count), unit: "%", versus, previous: String(c.count) };
  }
  if (kind === "ticket") {
    const now = t.count > 0 ? t.revenueCents / t.count : 0;
    const before = c.count > 0 ? c.revenueCents / c.count : 0;
    return {
      change: percentChange(now, before),
      unit: "%",
      versus,
      previous: before > 0 ? money(Math.round(before), currency) : "—",
    };
  }
  const rate = data.retention.rate;
  return {
    change: rate === null || c.retentionRate === null ? null : rate - c.retentionRate,
    unit: "pp",
    versus,
    previous: c.retentionRate === null ? "—" : `${c.retentionRate}%`,
  };
}
