"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Eye, History, Pencil, Plus, Receipt, Trash2, X } from "lucide-react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { DataTablePagination, DataTableToolbar } from "@/components/ui/data-table-pagination";
import { useDataTable } from "@/components/ui/use-data-table";
import { apiFetch, describeError } from "@/components/negocio/api";
import { ClientHistoryDialog } from "@/components/negocio/client-history-dialog";
import { ConfirmDialog } from "@/components/negocio/modal";
import { presets } from "@/components/negocio/report-sections";
import { SaleDialog } from "@/components/negocio/sale-dialog";
import { SaleDetailDialog } from "@/components/negocio/sale-detail-dialog";
import { SaleEditDialog } from "@/components/negocio/sale-edit-dialog";
import { ShiftPanel } from "@/components/negocio/shift-panel";
import { Section } from "@/components/results/section";
import { RangePicker, type Range } from "@/components/results/range-picker";
import { StatCard } from "@/components/results/stat-card";
import { csvCell, dateTimeLabel, money } from "@/lib/salon/format";
import { PAYMENT_LABELS } from "@/lib/salon/schemas";
import { loyaltyNotice } from "@/lib/loyalty";
import type { CashReportDto, RegisteredSaleDto, SaleRowDto } from "@/lib/salon/types";
import { cn } from "@/lib/utils";

/** Ventas por página por defecto; cada persona puede elegir otro número. */
const PAGE = 50;
const SALE_NOUN = { one: "venta", other: "ventas" };

const COMMISSION_SOURCE_LABEL: Record<RegisteredSaleDto["commissionSource"], string> = {
  custom: "porcentaje de esta venta",
  staff_service: "pacto con el profesional para este servicio",
  staff: "porcentaje del profesional",
  service: "porcentaje del servicio",
  default: "porcentaje por defecto",
};

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}% de los ingresos` : "sin ingresos";
}

/**
 * Módulo SALON — caja y cierres (solo dueño/administrador).
 *
 * Responde a «¿cuánto entró, cuánto les toca a los profesionales y cuánto me
 * queda?» para un día o un mes. Los totales los agrega la base sobre TODO el
 * periodo; la tabla muestra las ventas más recientes. Los días se cuentan en
 * la zona del negocio, no en la del navegador.
 */
export function CashClient({
  currency,
  timezone,
  today,
  initialDay,
  openSaleId,
}: {
  currency: string;
  timezone: string;
  today: string;
  /** Llega desde una notificación: el día de la venta. */
  initialDay?: string;
  /** Llega desde una notificación: abre el detalle de esa venta al cargar. */
  openSaleId?: string;
}) {
  const [range, setRange] = useState<Range>({ from: initialDay ?? today, to: initialDay ?? today });
  const pendingSale = useRef<string | null>(openSaleId ?? null);
  const [report, setReport] = useState<CashReportDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Cambia cada vez que la lista de ventas se recarga: el panel del turno se actualiza con ella.
  const [shiftTick, setShiftTick] = useState(0);
  const [saleOpen, setSaleOpen] = useState(false);
  const [voiding, setVoiding] = useState<SaleRowDto | null>(null);
  const [editing, setEditing] = useState<SaleRowDto | null>(null);
  const [viewing, setViewing] = useState<SaleRowDto | null>(null);
  // La ficha del cliente de una venta (si el contacto sigue existiendo).
  const [fichaId, setFichaId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const load = useCallback(async (r: Range) => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<CashReportDto>(
        `/api/negocio/ventas?from=${r.from}&to=${r.to}`,
        { signal: ctrl.signal }
      );
      if (ctrl.signal.aborted) return;
      setReport(data);
      setShiftTick((n) => n + 1);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(describeError(err));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
    return () => ctrlRef.current?.abort();
  }, [range, load]);

  // La venta de una notificación se abre una sola vez, cuando ya está en la lista.
  useEffect(() => {
    const id = pendingSale.current;
    const row = id ? report?.rows.find((r) => r.id === id) : undefined;
    if (row) {
      pendingSale.current = null;
      setViewing(row);
    }
  }, [report]);

  function onSaved(result: RegisteredSaleDto) {
    setSaleOpen(false);
    const { sale } = result;
    setNotice(
      `Venta registrada: ${sale.itemName} · ${money(sale.amountCents, currency)}. ` +
        `Comisión de ${sale.staffName}: ${money(sale.staffCommissionCents, currency)} ` +
        `(${result.commissionPercentage}%, ${COMMISSION_SOURCE_LABEL[result.commissionSource]}).` +
        loyaltyNotice(result)
    );
    void load(range);
  }

  async function voidSale(sale: SaleRowDto) {
    await apiFetch(`/api/negocio/ventas/${sale.id}`, { method: "DELETE" });
    setNotice("Venta anulada.");
    await load(range);
  }

  function exportCsv() {
    if (!report) return;
    const header = ["Fecha", "Cliente", "Servicio u oferta", "Profesional", "Pago", "Monto", "Comisión", "Neto"];
    const lines = rows.map((r) =>
      [
        dateTimeLabel(r.createdAt, timezone),
        r.customerName,
        r.itemName,
        r.staffName,
        PAYMENT_LABELS[r.paymentMethod],
        (r.amountCents / 100).toFixed(2),
        (r.staffCommissionCents / 100).toFixed(2),
        (r.businessNetCents / 100).toFixed(2),
      ]
        .map(csvCell)
        .join(",")
    );
    // BOM: Excel abre UTF-8 con acentos solo si lo ve.
    const blob = new Blob(["﻿" + [header.join(","), ...lines].join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `caja-${report.period.from}_${report.period.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const t = report?.totals;
  const rows = useMemo(() => report?.rows ?? [], [report]);
  // Cambia el periodo: la tabla vuelve a la primera página.
  const table = useDataTable(rows, {
    view: "caja-ventas",
    defaultPageSize: PAGE,
    resetKey: `${range.from}|${range.to}`,
  });
  const gastosHref = report ? `/gastos?from=${report.period.from}&to=${report.period.to}` : "/gastos";
  const oneDay = range.from === range.to;
  const periodTitle = oneDay
    ? range.from === today
      ? "Cierre de hoy"
      : `Cierre del ${range.from}`
    : `Cierre del ${range.from} al ${range.to}`;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <RangePicker
          value={range}
          onChange={setRange}
          today={today}
          presets={presets(today)}
        />
        <div className="flex flex-wrap gap-2">
          <Link href="/caja/historial" className={buttonVariants({ variant: "outline" })}>
            <History className="h-4 w-4" aria-hidden />
            Historial de turnos
          </Link>
          <Button variant="outline" onClick={exportCsv} disabled={!report || rows.length === 0}>
            <Download className="h-4 w-4" aria-hidden />
            Exportar CSV
          </Button>
          <Button onClick={() => setSaleOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Registrar venta
          </Button>
        </div>
      </div>

      <ShiftPanel currency={currency} timezone={timezone} refreshKey={shiftTick} />

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

      <section aria-labelledby="cierre-titulo" aria-busy={loading}>
        <h3 id="cierre-titulo" className="mb-2 text-[15px] font-bold tracking-tight">
          {periodTitle}
        </h3>
        {error ? (
          <div className="rounded-lg border border-danger-soft bg-danger-tint p-4 text-sm text-danger-text">
            <p>{error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void load(range)}>
              Reintentar
            </Button>
          </div>
        ) : (
          <div className={cn("grid grid-cols-2 gap-2.5 transition-opacity sm:gap-3 lg:grid-cols-5", loading && report && "opacity-60")}>
            <StatCard
              label="Ingresos"
              value={t ? money(t.revenueCents, currency) : "…"}
              hint={t ? `${t.count} venta${t.count === 1 ? "" : "s"}` : undefined}
            />
            <StatCard
              label="Comisiones del equipo"
              value={t ? money(t.commissionsCents, currency) : "…"}
              hint={t ? percent(t.commissionsCents, t.revenueCents) : undefined}
            />
            <div className="min-w-0 rounded-md border bg-subtle px-3 py-2.5">
              <p className="text-xs font-medium text-text-2">Gastos operativos</p>
              <p className="mt-0.5 truncate text-xl font-semibold">
                {report ? (report.expensesCents === null ? "—" : money(report.expensesCents, currency)) : "…"}
              </p>
              {report?.expensesCents === null ? (
                <p className="mt-1 text-[11px] text-text-3">No se asignan a un profesional</p>
              ) : (
                report && (
                <Link
                  href={gastosHref}
                  className="mt-1 inline-flex items-center gap-1 rounded-sm text-[11px] font-medium text-brand-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Receipt className="h-3 w-3" aria-hidden />
                  Ver gastos del periodo
                </Link>
                )
              )}
            </div>
            <div
              className={cn(
                "min-w-0 rounded-md border px-3 py-2.5",
                report && report.netAfterExpensesCents < 0
                  ? "border-danger-soft bg-danger-tint"
                  : "border-success-soft bg-success-tint"
              )}
            >
              <p className="text-xs font-medium text-text-2">
                {report?.expensesCents === null ? "Ganancia antes de gastos" : "Ganancia neta"}
              </p>
              <p
                className={cn(
                  "mt-0.5 truncate text-xl font-semibold tabular-nums",
                  report && report.netAfterExpensesCents < 0 ? "text-danger-text" : "text-success-text"
                )}
              >
                {report ? money(report.netAfterExpensesCents, currency) : "…"}
              </p>
              {report && (
                <p className="mt-1 text-[11px] text-text-3">
                  {report.expensesCents === null ? "ingresos − comisiones" : "ingresos − comisiones − gastos"}
                </p>
              )}
            </div>
            <StatCard
              label="Ticket promedio"
              value={t ? (t.count > 0 ? money(Math.round(t.revenueCents / t.count), currency) : "—") : "…"}
              hint="por venta"
            />
          </div>
        )}
      </section>

      {/* Si la carga falla y no hay nada que enseñar, basta el aviso de arriba. */}
      {(report || !error) && (
        <>
          <Section
            title="Ventas"
            hint="De la más reciente a la más antigua."
            loading={loading}
            hasData={report !== null}
            empty={report?.rows.length === 0}
            emptyText="Todavía no hay ventas en este periodo. Usa «Registrar venta» para cobrar una."
            right={
              report && (
                <span className="text-[13px] font-semibold text-text-2">
                  {report.totals.count} venta{report.totals.count === 1 ? "" : "s"} en el periodo
                </span>
              )
            }
          >
            {report && (
              <>
                {report.truncated && (
                  <p className="mb-3 rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
                    Se muestran las {report.rows.length} ventas más recientes. Los totales de arriba
                    incluyen todas; acota el rango para ver el detalle completo.
                  </p>
                )}
                <DataTableToolbar {...table.pagination} noun={SALE_NOUN} />
                {/* `relative`: el `sr-only` de la cabecera es absoluto; sin esto escapa del recorte
                del scroll y ensancha la página en el teléfono. */}
            <div className="relative -mx-4 overflow-x-auto sm:-mx-5">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead>
                      <tr className="border-y bg-subtle text-left text-xs font-semibold text-text-2">
                        <th scope="col" className="px-4 py-2 sm:pl-5">
                          Fecha
                        </th>
                        <th scope="col" className="px-2 py-2">
                          Cliente
                        </th>
                        <th scope="col" className="px-2 py-2">
                          Servicio / oferta
                        </th>
                        <th scope="col" className="px-2 py-2">
                          Profesional
                        </th>
                        <th scope="col" className="px-2 py-2">
                          Pago
                        </th>
                        <th scope="col" className="px-2 py-2 text-right">
                          Monto
                        </th>
                        <th scope="col" className="px-2 py-2 text-right">
                          Comisión
                        </th>
                        <th scope="col" className="px-2 py-2 text-right">
                          Neto
                        </th>
                        <th scope="col" className="px-2 py-2 sm:pr-5">
                          <span className="sr-only">Acciones</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.rows.map((r) => (
                        <tr key={r.id} className="border-b last:border-0 hover:bg-row-hover">
                          <td className="whitespace-nowrap px-4 py-2 text-text-2 sm:pl-5">
                            {dateTimeLabel(r.createdAt, timezone)}
                          </td>
                          <td className="max-w-[10rem] truncate px-2 py-2">
                            <button
                              type="button"
                              onClick={() => (r.contactId ? setFichaId(r.contactId) : setViewing(r))}
                              title={r.contactId ? "Ver la ficha del cliente" : "Ver el detalle de la venta"}
                              className="max-w-full truncate rounded-sm text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {r.customerName}
                            </button>
                          </td>
                          <td className="max-w-[12rem] truncate px-2 py-2">
                            <button
                              type="button"
                              onClick={() => setViewing(r)}
                              title="Ver el detalle de la venta"
                              className="max-w-full truncate rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {r.itemName}
                            </button>
                            {r.itemKind === "combo" && (
                              <span className="ml-1.5 text-[11px] text-text-3">oferta</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2">{r.staffName}</td>
                          <td className="whitespace-nowrap px-2 py-2 text-text-2">
                            {PAYMENT_LABELS[r.paymentMethod]}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 text-right font-medium tabular-nums">
                            {money(r.amountCents, currency)}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-text-2">
                            {money(r.staffCommissionCents, currency)}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 text-right font-semibold tabular-nums">
                            {money(r.businessNetCents, currency)}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1 text-right sm:pr-5">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Ver el detalle de la venta de ${r.customerName}`}
                              title="Ver detalle"
                              onClick={() => setViewing(r)}
                            >
                              <Eye className="h-4 w-4" aria-hidden />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Editar la venta de ${r.customerName}`}
                              title="Editar venta"
                              onClick={() => setEditing(r)}
                            >
                              <Pencil className="h-4 w-4" aria-hidden />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Anular la venta de ${r.customerName}`}
                              onClick={() => setVoiding(r)}
                            >
                              <Trash2 className="h-4 w-4 text-danger-text" aria-hidden />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <DataTablePagination {...table.pagination} noun={SALE_NOUN} label="Paginación de ventas" />
              </>
            )}
          </Section>

          <div className="grid w-full gap-5 md:w-1/2">
            <Section
              title="Cuadre de caja por método de pago"
              hint="Lo cobrado, para contrastar con el efectivo y las billeteras."
              loading={loading}
              hasData={report !== null}
              empty={report?.byPayment.length === 0}
              emptyText="Sin ventas en este periodo."
            >
              {report && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-text-3">
                      <th scope="col" className="py-1.5 pr-2 font-medium">
                        Método
                      </th>
                      <th scope="col" className="py-1.5 text-right font-medium">
                        Ventas
                      </th>
                      <th scope="col" className="py-1.5 pl-2 text-right font-medium">
                        Monto
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byPayment.map((p) => (
                      <tr key={p.method} className="border-b last:border-0">
                        <td className="py-1.5 pr-2">{PAYMENT_LABELS[p.method]}</td>
                        <td className="py-1.5 text-right tabular-nums text-text-2">{p.count}</td>
                        <td className="py-1.5 pl-2 text-right font-semibold tabular-nums">
                          {money(p.amountCents, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          </div>
        </>
      )}

      {saleOpen && (
        <SaleDialog
          currency={currency}
          canAdjustCommission
          today={today}
          onClose={() => setSaleOpen(false)}
          onSaved={onSaved}
        />
      )}

      {fichaId && (
        <ClientHistoryDialog
          clientId={fichaId}
          currency={currency}
          timezone={timezone}
          onClose={() => setFichaId(null)}
        />
      )}

      {viewing && (
        <SaleDetailDialog
          sale={viewing}
          currency={currency}
          timezone={timezone}
          onClose={() => setViewing(null)}
          onEdit={() => {
            setEditing(viewing);
            setViewing(null);
          }}
        />
      )}

      {editing && (
        <SaleEditDialog
          sale={editing}
          currency={currency}
          timezone={timezone}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice("Venta actualizada. El cambio quedó registrado.");
            void load(range);
          }}
        />
      )}

      {voiding && (
        <ConfirmDialog
          title="Anular venta"
          message={
            <>
              ¿Anular la venta de <strong>{voiding.customerName}</strong> por{" "}
              <strong>{money(voiding.amountCents, currency)}</strong>? Desaparece de la caja y de la
              comisión de {voiding.staffName}. No se puede deshacer.
            </>
          }
          confirmLabel="Anular venta"
          onClose={() => setVoiding(null)}
          onConfirm={() => voidSale(voiding)}
        />
      )}
    </div>
  );
}
