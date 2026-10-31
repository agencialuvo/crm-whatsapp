"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Field, MoneyInput } from "@/components/negocio/fields";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { Difference, Row } from "@/components/negocio/shift-parts";
import { StatCard } from "@/components/results/stat-card";
import { dateTimeLabel, money } from "@/lib/salon/format";
import { parseMoneyToCents } from "@/lib/money";
import type { CashShiftDto } from "@/lib/salon/cash-shifts";

/** El panel se actualiza solo cada tanto: las ventas entran desde otras pantallas. */
const POLL_MS = 30_000;

/**
 * Cuadre de caja — estado del turno. Sin turno: invita a abrirlo. Con turno: panel en
 * vivo (inicial, ventas, comisiones, gastos y efectivo esperado) y el cierre con cuadre.
 * `refreshKey` cambia cuando la pantalla registró o anuló una venta.
 */
export function ShiftPanel({
  currency,
  timezone,
  refreshKey,
}: {
  currency: string;
  timezone: string;
  refreshKey: number;
}) {
  const [shift, setShift] = useState<CashShiftDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [result, setResult] = useState<CashShiftDto | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ shift: CashShiftDto | null }>("/api/negocio/caja/turnos/activo");
      if (!alive.current) return;
      setShift(data.shift);
      setError(null);
    } catch (err) {
      if (alive.current) setError(describeError(err));
    } finally {
      if (alive.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!loaded) {
    return <div className="h-[92px] animate-pulse rounded-lg border bg-subtle" aria-hidden />;
  }

  return (
    <>
      {error && !shift ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger-soft bg-danger-tint px-4 py-3">
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Reintentar
          </Button>
        </div>
      ) : shift ? (
        <section aria-label="Turno de caja abierto" className="rounded-lg border bg-card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <LockOpen className="h-4 w-4 text-success-text" aria-hidden />
                Turno de caja abierto
              </h2>
              <p className="text-xs text-text-3">Desde {dateTimeLabel(shift.openedAt, timezone)}</p>
            </div>
            <Button onClick={() => setClosing(true)}>
              <Lock className="h-4 w-4" aria-hidden />
              Cerrar Turno / Cuadre
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatCard label="Monto inicial" value={money(shift.initialCashCents, currency)} />
            <StatCard label="Ventas acumuladas" value={money(shift.totalSalesCents, currency)} />
            <StatCard label="Comisiones" value={money(shift.totalCommissionsCents, currency)} />
            <StatCard label="Gastos" value={money(shift.totalExpensesCents, currency)} />
            <StatCard
              label="Efectivo esperado"
              value={money(shift.expectedCashCents, currency)}
              hint="Inicial + ventas en efectivo"
            />
          </div>
          {error && (
            <p role="alert" className="mt-2 text-xs text-danger-text">
              No se pudo actualizar: {error}
            </p>
          )}
        </section>
      ) : (
        <section
          aria-label="Sin turno de caja"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3"
        >
          <div>
            <h2 className="text-sm font-semibold">No hay un turno de caja abierto</h2>
            <p className="text-xs text-text-3">Ábrelo con el efectivo con el que empieza la caja y ciérralo para cuadrar.</p>
          </div>
          <Button onClick={() => setOpening(true)}>
            <LockOpen className="h-4 w-4" aria-hidden />
            Abrir Turno de Caja
          </Button>
        </section>
      )}

      {opening && (
        <OpenShiftDialog
          currency={currency}
          onClose={() => setOpening(false)}
          onOpened={(s) => {
            setOpening(false);
            setShift(s);
            void load();
          }}
        />
      )}
      {closing && shift && (
        <CloseShiftDialog
          shift={shift}
          currency={currency}
          onClose={() => setClosing(false)}
          onClosed={(s) => {
            setClosing(false);
            setShift(null);
            setResult(s);
            void load();
          }}
        />
      )}
      {result && <ShiftResultDialog shift={result} currency={currency} timezone={timezone} onClose={() => setResult(null)} />}
    </>
  );
}

/* ------------------------------- abrir turno ------------------------------- */

function OpenShiftDialog({
  currency,
  onClose,
  onOpened,
}: {
  currency: string;
  onClose: () => void;
  onOpened: (shift: CashShiftDto) => void;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = parseMoneyToCents(amount);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (cents === null) {
      setError("Escribe el efectivo inicial (puede ser 0).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { shift } = await apiFetch<{ shift: CashShiftDto }>("/api/negocio/caja/turnos/abrir", {
        method: "POST",
        json: { initialCashCents: cents },
      });
      onOpened(shift);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Abrir turno de caja" description="Cuenta el efectivo que hay en la gaveta al empezar." onClose={onClose} busy={busy} size="sm">
      <form onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Efectivo inicial" htmlFor="shift-initial" required>
          <MoneyInput id="shift-initial" value={amount} onChange={(v) => { setAmount(v); setError(null); }} currency={currency} disabled={busy} />
        </Field>
        <ModalFooter error={error}>
          <Button type="submit" disabled={busy}>
            {busy ? "Abriendo…" : "Abrir turno"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/* ------------------------------ cerrar y cuadrar ----------------------------- */

function CloseShiftDialog({
  shift,
  currency,
  onClose,
  onClosed,
}: {
  shift: CashShiftDto;
  currency: string;
  onClose: () => void;
  onClosed: (shift: CashShiftDto) => void;
}) {
  const [counted, setCounted] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = parseMoneyToCents(counted);
  const expected = shift.expectedCashCents ?? 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (cents === null) {
      setError("Escribe el efectivo que contaste en la gaveta (puede ser 0).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { shift: closed } = await apiFetch<{ shift: CashShiftDto }>("/api/negocio/caja/turnos/cerrar", {
        method: "POST",
        json: { shiftId: shift.id, finalCashCents: cents, ...(notes.trim() && { notes: notes.trim() }) },
      });
      onClosed(closed);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Cerrar turno y cuadrar caja"
      description="Cuenta el efectivo de la gaveta. El sistema compara con lo que debería haber."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
        <div className="space-y-1.5 rounded-md border bg-subtle p-3">
          <Row label="Efectivo inicial" value={money(shift.initialCashCents, currency)} />
          <Row label="Ventas en efectivo" value={money(expected - shift.initialCashCents, currency)} />
          <div className="border-t pt-1.5">
            <Row label="Efectivo esperado en caja" value={money(expected, currency)} strong />
          </div>
        </div>

        <Field label="Efectivo contado en gaveta" htmlFor="shift-counted" required>
          <MoneyInput id="shift-counted" value={counted} onChange={(v) => { setCounted(v); setError(null); }} currency={currency} disabled={busy} />
        </Field>

        {cents !== null && <Difference cents={cents - expected} currency={currency} />}

        <div className="space-y-1.5 rounded-md border p-3">
          <Row label="Ventas del turno" value={money(shift.totalSalesCents, currency)} />
          <Row label="Comisiones" value={`− ${money(shift.totalCommissionsCents, currency)}`} />
          <Row label="Gastos" value={`− ${money(shift.totalExpensesCents, currency)}`} />
          <div className="border-t pt-1.5">
            <Row label="Ganancia neta del turno" value={money(shift.netProfitCents, currency)} strong />
          </div>
          <p className="text-[11px] text-text-3">Se recalcula al confirmar el cierre, con lo ocurrido hasta ese momento.</p>
        </div>

        <Field label="Notas (opcional)" htmlFor="shift-notes">
          <textarea
            id="shift-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={500}
            rows={2}
            disabled={busy}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </Field>

        <ModalFooter error={error}>
          <Button type="submit" disabled={busy}>
            {busy ? "Cerrando…" : "Cerrar turno"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** El resultado definitivo del cierre, con los montos que se guardaron. */
function ShiftResultDialog({
  shift,
  currency,
  timezone,
  onClose,
}: {
  shift: CashShiftDto;
  currency: string;
  timezone: string;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Turno cerrado"
      description={`${dateTimeLabel(shift.openedAt, timezone)} → ${shift.closedAt ? dateTimeLabel(shift.closedAt, timezone) : ""}`}
      onClose={onClose}
      size="sm"
    >
      <div className="space-y-4">
        <div className="space-y-1.5 rounded-md border bg-subtle p-3">
          <Row label="Efectivo esperado" value={money(shift.expectedCashCents, currency)} />
          <Row label="Efectivo contado" value={money(shift.finalCashCents, currency)} />
        </div>
        {shift.differenceCents !== null && <Difference cents={shift.differenceCents} currency={currency} />}
        <div className="space-y-1.5 rounded-md border p-3">
          <Row label="Ventas" value={money(shift.totalSalesCents, currency)} />
          <Row label="Comisiones" value={`− ${money(shift.totalCommissionsCents, currency)}`} />
          <Row label="Gastos" value={`− ${money(shift.totalExpensesCents, currency)}`} />
          <div className="border-t pt-1.5">
            <Row label="Ganancia neta" value={money(shift.netProfitCents, currency)} strong />
          </div>
        </div>
        <ModalFooter>
          <Button type="button" onClick={onClose}>
            Listo
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
