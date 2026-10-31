"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight, Eye } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Modal } from "@/components/negocio/modal";
import { PageSizeSelect } from "@/components/negocio/page-size-select";
import { presets } from "@/components/negocio/report-sections";
import { Difference, Row } from "@/components/negocio/shift-parts";
import { useTablePageSize } from "@/components/negocio/use-page-size";
import { RangePicker, type Range } from "@/components/results/range-picker";
import { Section } from "@/components/results/section";
import {
  MAX_HISTORY_ROWS,
  rowsPerPage,
  type CashShiftDetailDto,
  type CashShiftRowDto,
  type ShiftHistoryDto,
} from "@/lib/salon/cash-shifts";
import { dateTimeFullLabel, money } from "@/lib/salon/format";
import { PAYMENT_LABELS } from "@/lib/salon/schemas";
import { addDaysISO } from "@/lib/time/slots";
import { cn } from "@/lib/utils";

const DEFAULT_PAGE_SIZE = 25;

/** Los atajos de Caja, con «30 días» (el periodo con el que abre el historial). */
function historyPresets(today: string): { label: string; range: Range }[] {
  const base = presets(today);
  const at = base.findIndex((p) => p.label === "7 días");
  base.splice(at + 1, 0, { label: "30 días", range: { from: addDaysISO(today, -29), to: today } });
  return base;
}

/** Una diferencia de cuadre en la tabla: verde si sobra, rojo si falta, gris si cuadra. */
function DiffCell({ cents, currency }: { cents: number | null; currency: string }) {
  if (cents === null) return <span className="text-text-3">—</span>;
  return (
    <span
      className={cn(
        "font-medium",
        cents === 0 ? "text-text-2" : cents > 0 ? "text-success-text" : "text-danger-text"
      )}
    >
      {cents > 0 ? "+" : ""}
      {money(cents, currency)}
    </span>
  );
}

/** «Ana» si abrió y cerró la misma persona; «Ana → Luis» si no. */
function whoLabel(s: { openedByName: string | null; closedByName: string | null }): string {
  const opened = s.openedByName ?? "—";
  const closed = s.closedByName ?? "—";
  return opened === closed ? opened : `${opened} → ${closed}`;
}

/**
 * Módulo SALON — historial de turnos de caja cerrados (solo dueño/administrador).
 *
 * Cada fila es un cierre: cuánto empezó, cuánto se vendió, lo que se esperaba en la
 * gaveta contra lo que se contó, y la diferencia. Se filtra por fecha de cierre (días
 * del negocio) y un clic abre el desglose del turno.
 */
export function ShiftHistoryClient({
  currency,
  timezone,
  today,
}: {
  currency: string;
  timezone: string;
  today: string;
}) {
  const [range, setRange] = useState<Range>({ from: addDaysISO(today, -29), to: today });
  const [pageSize, setPageSize] = useTablePageSize("caja-turnos", DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<ShiftHistoryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  // «Todos» pide el máximo que el servidor entrega por consulta; con más, se pagina de a tanto.
  const limit = Math.min(rowsPerPage(pageSize), MAX_HISTORY_ROWS);

  const load = useCallback(
    async (r: Range, offset: number, rows: number) => {
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch<ShiftHistoryDto>(
          `/api/negocio/caja/turnos?from=${r.from}&to=${r.to}&limit=${rows}&offset=${offset}`,
          { signal: ctrl.signal }
        );
        if (!ctrl.signal.aborted) setData(res);
      } catch (err) {
        if (!ctrl.signal.aborted) setError(describeError(err));
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void load(range, page * limit, limit);
    return () => ctrlRef.current?.abort();
  }, [range, page, limit, load]);

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const first = total === 0 ? 0 : page * limit + 1;
  const last = Math.min(total, (page + 1) * limit);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <RangePicker
          value={range}
          onChange={(r) => {
            setRange(r);
            setPage(0);
          }}
          today={today}
          presets={historyPresets(today)}
        />
        <Link href="/caja" className={buttonVariants({ variant: "outline" })}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Volver a Caja
        </Link>
      </div>

      <Section
        title="Turnos cerrados"
        hint="Del cierre más reciente al más antiguo. Toca uno para ver su desglose."
        loading={loading}
        error={error && !data ? error : null}
        hasData={data !== null}
        empty={data?.shifts.length === 0}
        emptyText="No hay turnos cerrados en este periodo."
        right={
          <PageSizeSelect
            value={pageSize}
            onChange={(n) => {
              setPageSize(n);
              setPage(0);
            }}
          />
        }
      >
        {data && (
          <>
            <div className="relative -mx-4 overflow-x-auto sm:-mx-5">
              <table className="w-full min-w-[1040px] text-sm">
                <thead>
                  <tr className="border-y bg-subtle text-left text-xs font-semibold text-text-2">
                    <th scope="col" className="px-4 py-2 sm:pl-5">
                      Apertura / cierre
                    </th>
                    <th scope="col" className="px-2 py-2">
                      Responsable
                    </th>
                    <th scope="col" className="px-2 py-2 text-right">
                      Inicial
                    </th>
                    <th scope="col" className="px-2 py-2 text-right">
                      Ventas
                    </th>
                    <th scope="col" className="px-2 py-2 text-right">
                      Gastos
                    </th>
                    <th scope="col" className="px-2 py-2 text-right">
                      Ganancia neta
                    </th>
                    <th scope="col" className="px-2 py-2 text-right">
                      Esperado
                    </th>
                    <th scope="col" className="px-2 py-2 text-right">
                      Contado
                    </th>
                    <th scope="col" className="px-2 py-2 text-right">
                      Diferencia
                    </th>
                    <th scope="col" className="px-2 py-2 pr-4 sm:pr-5">
                      <span className="sr-only">Ver detalle</span>
                    </th>
                  </tr>
                </thead>
                <tbody className={cn("transition-opacity", loading && "opacity-60")}>
                  {data.shifts.map((s) => (
                    <ShiftRow
                      key={s.id}
                      shift={s}
                      currency={currency}
                      timezone={timezone}
                      onOpen={() => setDetailId(s.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <nav
              aria-label="Paginación de turnos"
              className="mt-3 flex flex-wrap items-center justify-between gap-2"
            >
              <p className="text-xs text-text-3">
                Mostrando {first}–{last} de {total} turno{total === 1 ? "" : "s"}
              </p>
              {pages > 1 && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((n) => n - 1)}
                    disabled={page <= 0 || loading}
                    aria-label="Página anterior"
                  >
                    <ChevronLeft className="h-4 w-4" aria-hidden />
                    Anterior
                  </Button>
                  <span className="px-2 text-xs tabular-nums text-text-3">
                    {page + 1} / {pages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((n) => n + 1)}
                    disabled={page + 1 >= pages || loading}
                    aria-label="Página siguiente"
                  >
                    Siguiente
                    <ChevronRight className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              )}
            </nav>
          </>
        )}
      </Section>

      {detailId && (
        <ShiftDetailDialog id={detailId} currency={currency} timezone={timezone} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}

function ShiftRow({
  shift: s,
  currency,
  timezone,
  onOpen,
}: {
  shift: CashShiftRowDto;
  currency: string;
  timezone: string;
  onOpen: () => void;
}) {
  return (
    <tr
      onClick={onOpen}
      className="cursor-pointer border-b transition-colors last:border-0 hover:bg-subtle"
    >
      <td className="px-4 py-2.5 sm:pl-5">
        <p className="font-medium">{s.closedAt ? dateTimeFullLabel(s.closedAt, timezone) : "—"}</p>
        <p className="text-xs text-text-3">Abrió {dateTimeFullLabel(s.openedAt, timezone)}</p>
      </td>
      <td className="px-2 py-2.5 text-text-2">{whoLabel(s)}</td>
      <td className="px-2 py-2.5 text-right tabular-nums">{money(s.initialCashCents, currency)}</td>
      <td className="px-2 py-2.5 text-right tabular-nums">{money(s.totalSalesCents, currency)}</td>
      <td className="px-2 py-2.5 text-right tabular-nums">{money(s.totalExpensesCents, currency)}</td>
      <td className="px-2 py-2.5 text-right font-medium tabular-nums">{money(s.netProfitCents, currency)}</td>
      <td className="px-2 py-2.5 text-right tabular-nums">{money(s.expectedCashCents, currency)}</td>
      <td className="px-2 py-2.5 text-right tabular-nums">{money(s.finalCashCents, currency)}</td>
      <td className="px-2 py-2.5 text-right tabular-nums">
        <DiffCell cents={s.differenceCents} currency={currency} />
      </td>
      <td className="px-2 py-2.5 pr-4 text-right sm:pr-5">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Ver el detalle del turno cerrado ${s.closedAt ? dateTimeFullLabel(s.closedAt, timezone) : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          <Eye className="h-4 w-4" aria-hidden />
        </Button>
      </td>
    </tr>
  );
}

/* ------------------------------ detalle del turno ----------------------------- */

function ShiftDetailDialog({
  id,
  currency,
  timezone,
  onClose,
}: {
  id: string;
  currency: string;
  timezone: string;
  onClose: () => void;
}) {
  const [shift, setShift] = useState<CashShiftDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    apiFetch<{ shift: CashShiftDetailDto }>(`/api/negocio/caja/turnos/${encodeURIComponent(id)}`, {
      signal: ctrl.signal,
    })
      .then((r) => setShift(r.shift))
      .catch((err) => {
        if (!ctrl.signal.aborted) setError(describeError(err));
      });
    return () => ctrl.abort();
  }, [id]);

  // Lo congelado al cerrar (esperado − inicial), para que esa tarjeta cuadre siempre con el contado.
  const cashSales = shift ? (shift.expectedCashCents ?? 0) - shift.initialCashCents : 0;
  // Lo vendido hoy ya no coincide con lo que se congeló al cerrar: se avisa, no se esconde.
  const changed = shift !== null && shift.currentSalesCents !== shift.totalSalesCents;

  return (
    <Modal
      title="Detalle del turno"
      description={
        shift
          ? `${dateTimeFullLabel(shift.openedAt, timezone)} → ${shift.closedAt ? dateTimeFullLabel(shift.closedAt, timezone) : "abierto"}`
          : undefined
      }
      onClose={onClose}
    >
      {error ? (
        <p role="alert" className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text">
          {error}
        </p>
      ) : !shift ? (
        <div className="h-48 animate-pulse rounded-md bg-subtle" aria-hidden />
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5 rounded-md border bg-subtle p-3">
            <Row label="Abrió" value={shift.openedByName ?? "—"} />
            <Row label="Cerró" value={shift.closedByName ?? "—"} />
          </div>

          <div className="space-y-1.5 rounded-md border p-3">
            <Row label="Efectivo inicial" value={money(shift.initialCashCents, currency)} />
            <Row label="Ventas en efectivo" value={money(cashSales, currency)} />
            <Row label="Efectivo esperado" value={money(shift.expectedCashCents, currency)} strong />
            <Row label="Efectivo contado" value={money(shift.finalCashCents, currency)} strong />
          </div>
          {shift.differenceCents !== null && <Difference cents={shift.differenceCents} currency={currency} />}

          <div className="space-y-1.5 rounded-md border p-3">
            <p className="text-xs font-semibold text-text-2">Ventas por método de pago</p>
            {shift.byPayment.length === 0 ? (
              <p className="text-sm text-text-3">Sin ventas en este turno.</p>
            ) : (
              shift.byPayment.map((p) => (
                <Row
                  key={p.method}
                  label={`${PAYMENT_LABELS[p.method]} (${p.count})`}
                  value={money(p.amountCents, currency)}
                />
              ))
            )}
            <div className="border-t pt-1.5">
              <Row label={`Ventas del turno (${shift.salesCount})`} value={money(shift.totalSalesCents, currency)} strong />
            </div>
            {changed && (
              <p className="text-[11px] text-warning-text">
                Hoy esas ventas suman {money(shift.currentSalesCents, currency)}: alguna se anuló o se editó después del
                cierre. Lo de arriba es lo que se guardó al cerrar.
              </p>
            )}
          </div>

          <div className="space-y-1.5 rounded-md border p-3">
            <Row label="Comisiones" value={`− ${money(shift.totalCommissionsCents, currency)}`} />
            <Row
              label={`Gastos (${shift.expensesCount})`}
              value={`− ${money(shift.totalExpensesCents, currency)}`}
            />
            <div className="border-t pt-1.5">
              <Row label="Ganancia neta" value={money(shift.netProfitCents, currency)} strong />
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-semibold text-text-2">Notas del cierre</p>
            <p className="whitespace-pre-wrap rounded-md border bg-subtle px-3 py-2 text-sm text-text-2">
              {shift.notes?.trim() || "Sin notas."}
            </p>
          </div>
        </div>
      )}
    </Modal>
  );
}
