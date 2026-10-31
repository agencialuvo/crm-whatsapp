"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/search-select";
import { apiFetch, describeError } from "@/components/negocio/api";
import { ExpenseDialog } from "@/components/negocio/expense-dialogs";
import { ConfirmDialog } from "@/components/negocio/modal";
import { presets } from "@/components/negocio/report-sections";
import { RangePicker, type Range } from "@/components/results/range-picker";
import { Section } from "@/components/results/section";
import {
  expenseTotalUnits,
  type ExpenseItemDto,
  type ExpensesReportDto,
} from "@/lib/salon/expenses";
import { money } from "@/lib/salon/format";
import { cn } from "@/lib/utils";

/** Cuántos gastos se pintan de entrada; «Mostrar más» agrega otro tanto. */
const PAGE = 50;

function percentOf(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** dd/mm/aaaa a partir de un día AAAA-MM-DD (sin pasar por Date: no hay zona que lo mueva). */
function dayLabel(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Módulo SALON — egresos y gastos operativos (solo dueño/administrador).
 *
 * Responde a «¿cuánto me queda de verdad?»: lo que entró, lo que se llevó el
 * equipo en comisiones, lo que se gastó en operar y, al final, la ganancia neta
 * real. Los gastos son fijos (alquiler, luz) o variables (insumos), . Los días se cuentan en la zona del negocio, no en la del navegador.
 */
export function ExpensesClient({
  currency,
  today,
  initialRange,
}: {
  currency: string;
  today: string;
  /** Llega desde Caja: el periodo que se estaba revisando. */
  initialRange?: Range;
}) {
  const [range, setRange] = useState<Range>(() => initialRange ?? { from: `${today.slice(0, 8)}01`, to: today });
  const [kindFilter, setKindFilter] = useState("");
  const [report, setReport] = useState<ExpensesReportDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ExpenseItemDto | "new" | null>(null);
  const [deleting, setDeleting] = useState<ExpenseItemDto | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const load = useCallback(async (r: Range, kind: string) => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ from: r.from, to: r.to });
      if (kind) qs.set("kind", kind);
      const data = await apiFetch<ExpensesReportDto>(`/api/negocio/gastos?${qs}`, {
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) return;
      setReport(data);
      setShown(PAGE);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(describeError(err));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range, kindFilter);
    return () => ctrlRef.current?.abort();
  }, [range, kindFilter, load]);

  const reload = useCallback(() => {
    void load(range, kindFilter);
  }, [load, range, kindFilter]);

  async function removeExpense(item: ExpenseItemDto) {
    await apiFetch(`/api/negocio/gastos/${item.id}`, { method: "DELETE" });
    setNotice("Gasto borrado.");
    reload();
  }

  const s = report?.summary;
  const revenue = s?.revenueCents ?? 0;
  const negative = (s?.realNetCents ?? 0) < 0;
  // La barra reparte los ingresos: comisiones, gastos y lo que de verdad queda.
  const commissionsPct = percentOf(s?.commissionsCents ?? 0, revenue);
  const expensesPct = percentOf(s?.expensesCents ?? 0, revenue);
  const realPct = Math.max(0, 100 - commissionsPct - expensesPct);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <RangePicker value={range} onChange={setRange} today={today} presets={presets(today)} />
        <div className="flex gap-2">
          <Button onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" aria-hidden />
            Registrar gasto
          </Button>
        </div>
      </div>

      {notice && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-md border border-success-soft bg-success-tint px-3 py-2.5 text-sm text-success-text"
        >
          <p>{notice}</p>
          <button
            type="button"
            aria-label="Cerrar el aviso"
            onClick={() => setNotice(null)}
            className="shrink-0 rounded-sm p-0.5 hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      {error && !report ? (
        <div className="rounded-lg border border-danger-soft bg-danger-tint p-4 text-sm text-danger-text">
          <p>{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={reload}>
            Reintentar
          </Button>
        </div>
      ) : (
        <>
          <section aria-label="Ingresos contra gastos" aria-busy={loading}>
            <div
              className={cn(
                "grid grid-cols-2 gap-2.5 transition-opacity sm:gap-3 lg:grid-cols-5",
                loading && report && "opacity-60"
              )}
            >
              <Tile label="Ingresos" value={s ? money(s.revenueCents, currency) : "…"} />
              <Tile
                label="Comisiones del equipo"
                value={s ? money(s.commissionsCents, currency) : "…"}
                hint={s ? `${commissionsPct}% de los ingresos` : undefined}
              />
              <Tile
                label="Ganancia neta"
                value={s ? money(s.netBeforeExpensesCents, currency) : "…"}
                hint="antes de gastos"
              />
              <Tile
                label="Gastos operativos"
                value={s ? money(s.expensesCents, currency) : "…"}
                hint={s ? `${expensesPct}% de los ingresos` : undefined}
              />
              <Tile
                strong
                negative={negative}
                label="Ganancia neta real"
                value={s ? money(s.realNetCents, currency) : "…"}
                hint="ingresos − comisiones − gastos"
              />
            </div>

            {s && revenue > 0 && (
              <div className="mt-3 rounded-md border bg-subtle px-3 py-3">
                <p className="mb-2 text-xs font-medium text-text-2">
                  A dónde va lo que entra
                </p>
                <div
                  className="flex h-3 w-full overflow-hidden rounded-full bg-border"
                  role="img"
                  aria-label={`Comisiones ${commissionsPct}%, gastos ${expensesPct}%, ganancia real ${negative ? 0 : realPct}%`}
                >
                  <span className="bg-brand-soft" style={{ width: `${Math.min(commissionsPct, 100)}%` }} />
                  <span
                    className="bg-warning"
                    style={{ width: `${Math.min(expensesPct, 100 - Math.min(commissionsPct, 100))}%` }}
                  />
                  <span className="bg-success" style={{ width: `${negative ? 0 : realPct}%` }} />
                </div>
                <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-2">
                  <li className="flex items-center gap-1.5">
                    <span aria-hidden className="h-2 w-2 rounded-full bg-brand-soft" />
                    Comisiones {commissionsPct}%
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span aria-hidden className="h-2 w-2 rounded-full bg-warning" />
                    Gastos {expensesPct}%
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span aria-hidden className="h-2 w-2 rounded-full bg-success" />
                    Ganancia real {negative ? "negativa" : `${realPct}%`}
                  </li>
                </ul>
                {negative && (
                  <p className="mt-2 text-xs text-danger-text">
                    En este periodo se gastó más de lo que quedó después de las comisiones.
                  </p>
                )}
              </div>
            )}
          </section>

          <div>
            <Section
              title="Fijos y variables"
              hint="Cuánto del gasto del periodo es fijo y cuánto son insumos."
              loading={loading}
              hasData={report !== null}
              empty={report?.summary.expensesCents === 0}
              emptyText="Sin gastos en este periodo."
            >
              <ul className="space-y-3">
                {report &&
                  (
                    [
                      ["Gastos fijos", report.summary.byKind.fixed],
                      ["Insumos / variables", report.summary.byKind.variable],
                    ] as const
                  ).map(([label, k]) => {
                    const pct = percentOf(k.totalCents, report.summary.expensesCents);
                    return (
                      <li key={label}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="truncate font-medium">{label}</span>
                          <span className="shrink-0 tabular-nums">
                            {money(k.totalCents, currency)}{" "}
                            <span className="text-xs text-text-3">· {pct}%</span>
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-border">
                          <span className="block h-full bg-warning" style={{ width: `${pct}%` }} />
                        </div>
                        <p className="mt-0.5 text-xs text-text-3">
                          {k.count} gasto{k.count === 1 ? "" : "s"}
                        </p>
                      </li>
                    );
                  })}
              </ul>
            </Section>

          </div>

          <Section
            title="Gastos"
            hint="Del más reciente al más antiguo."
            loading={loading}
            hasData={report !== null}
            error={error}
            empty={report?.items.length === 0}
            emptyText={
              kindFilter
                ? "No hay gastos con ese filtro en este periodo."
                : "Todavía no hay gastos en este periodo. Usa «Registrar gasto» para anotar uno."
            }
            right={
              <div className="flex flex-wrap gap-2">
                <SearchSelect
                  value={kindFilter}
                  onChange={setKindFilter}
                  ariaLabel="Filtrar por tipo"
                  options={[
                    { value: "fixed", label: "Gastos fijos" },
                    { value: "variable", label: "Insumos / variables" },
                  ]}
                  emptyLabel="Todos los tipos"
                  emptyShowsPlaceholder
                  placeholder="Todos los tipos"
                  searchPlaceholder="Buscar tipo…"
                  className="w-48"
                />
              </div>
            }
          >
            {report && (
              <>
                {report.truncated && (
                  <p className="mb-3 rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
                    Se muestran los {report.items.length} gastos más recientes. Los totales de arriba
                    incluyen todos; acota el rango para ver el detalle completo.
                  </p>
                )}
                <div className="relative -mx-4 overflow-x-auto sm:-mx-5">
                  <table className="w-full min-w-[620px] text-sm">
                    <thead>
                      <tr className="border-y bg-subtle text-left text-xs font-semibold text-text-2">
                        <th scope="col" className="px-4 py-2 sm:pl-5">Fecha</th>
                        <th scope="col" className="px-2 py-2">Gasto</th>
                                                <th scope="col" className="px-2 py-2 text-right">Cantidad</th>
                        <th scope="col" className="px-2 py-2 text-right">Precio</th>
                        <th scope="col" className="px-2 py-2 sm:pr-5">
                          <span className="sr-only">Acciones</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.items.slice(0, shown).map((g) => (
                        <tr key={g.id} className="border-b last:border-0 hover:bg-row-hover">
                          <td className="whitespace-nowrap px-4 py-2 tabular-nums text-text-2 sm:pl-5">
                            {dayLabel(g.expenseDate)}
                          </td>
                          <td className="max-w-[16rem] px-2 py-2">
                            <span className="block truncate font-medium">
                              {g.name}
                              <span className="ml-2 rounded-full border px-1.5 py-0.5 align-middle text-[10px] font-semibold text-text-2">
                                {g.isFixed ? "Fijo" : "Variable"}
                              </span>
                            </span>
                            {g.notes && <span className="block truncate text-xs text-text-3">{g.notes}</span>}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                            {g.isFixed || g.quantity === null ? (
                              "—"
                            ) : g.unitsPerPackage ? (
                              <>
                                {g.presentation === "dozen"
                                  ? `${g.quantity} ${g.quantity === 1 ? "docena" : "docenas"}`
                                  : `${g.quantity} × ${g.unitsPerPackage}`}
                                <span className="block text-xs text-text-3">
                                  = {expenseTotalUnits(g)} unidades
                                </span>
                              </>
                            ) : (
                              g.quantity
                            )}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 text-right font-semibold tabular-nums">
                            {money(g.totalPriceCents, currency)}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1 text-right sm:pr-5">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Editar el gasto ${g.name}`}
                              title="Editar gasto"
                              onClick={() => setEditing(g)}
                            >
                              <Pencil className="h-4 w-4" aria-hidden />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Borrar el gasto ${g.name}`}
                              title="Borrar gasto"
                              onClick={() => setDeleting(g)}
                            >
                              <Trash2 className="h-4 w-4 text-danger-text" aria-hidden />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {shown < report.items.length && (
                  <div className="mt-3 flex justify-center">
                    <Button variant="outline" size="sm" onClick={() => setShown((n) => n + PAGE)}>
                      Mostrar más ({report.items.length - shown} restantes)
                    </Button>
                  </div>
                )}
              </>
            )}
          </Section>
        </>
      )}

      {editing && (
        <ExpenseDialog
          item={editing === "new" ? null : editing}
          currency={currency}
          today={today}
          onClose={() => setEditing(null)}
          onSaved={() => {
            const wasNew = editing === "new";
            setEditing(null);
            setNotice(wasNew ? "Gasto registrado." : "Gasto actualizado.");
            reload();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Borrar gasto"
          message={
            <>
              ¿Borrar el gasto <strong>{deleting.name}</strong> por{" "}
              <strong>{money(deleting.totalPriceCents, currency)}</strong>? La ganancia neta real del
              periodo se recalcula.
              {" "}
              No se puede deshacer.
            </>
          }
          confirmLabel="Borrar gasto"
          onClose={() => setDeleting(null)}
          onConfirm={() => removeExpense(deleting)}
        />
      )}
    </div>
  );
}

/** Tarjeta de cifra; la «real» va destacada y en rojo si es negativa. */
function Tile({
  label,
  value,
  hint,
  strong,
  negative,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
  negative?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-md border px-3 py-2.5",
        strong ? (negative ? "border-danger-soft bg-danger-tint" : "border-success-soft bg-success-tint") : "bg-subtle"
      )}
    >
      <p className="text-xs font-medium text-text-2">{label}</p>
      <p
        className={cn(
          "mt-0.5 truncate text-xl font-semibold tabular-nums",
          strong && (negative ? "text-danger-text" : "text-success-text")
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-text-3">{hint}</p>}
    </div>
  );
}
