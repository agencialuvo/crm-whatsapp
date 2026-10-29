"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BadgeCheck, Bot, CalendarOff, ChevronLeft, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DatePicker } from "@/components/ui/date-picker";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { NewBookingDialog } from "@/components/negocio/new-booking-dialog";
import { SaleDialog } from "@/components/negocio/sale-dialog";
import { StatCard } from "@/components/results/stat-card";
import { useEvents } from "@/components/use-events";
import { durationLabel, money } from "@/lib/salon/format";
import { loyaltyNotice } from "@/lib/loyalty";
import type { BoardBooking, BoardDto, BoardSlot, RegisteredSaleDto } from "@/lib/salon/types";
import { longDayLabel } from "@/lib/time/calendar";
import { addDaysISO, overlaps, timeInTz } from "@/lib/time/slots";
import { cn } from "@/lib/utils";
import { SearchSelect } from "@/components/ui/search-select";

/** La agenda se refresca sola cada minuto aunque no llegue ningún evento. */
const POLL_MS = 60_000;

/**
 * Módulo SALON — la agenda por sillas de un día.
 *
 * Filas = franjas del motor de disponibilidad; columnas = cada profesional
 * («silla») más las citas aún sin asignar. Cada celda dice si la silla está
 * libre, atendiendo a alguien o fuera de turno, y la última columna cuántos
 * cupos quedan en la franja.
 *
 * Se mantiene al día con el bus de eventos de la agenda (una cita nueva —
 * también la que agenda el agente— aparece sin recargar), con un respaldo cada
 * minuto y al volver a la pestaña.
 */
export function BoardClient({
  currency,
  timezone,
  today,
  initialDate,
  openNewOnLoad = false,
  openBookingId,
  canManage,
}: {
  currency: string;
  timezone: string;
  today: string;
  /** El día con el que abre (si no, hoy). */
  initialDate?: string;
  /** Llega desde «Agendar cita» del calendario: abre el formulario al cargar. */
  openNewOnLoad?: boolean;
  /** Llega desde una notificación: abre esa cita en cuanto la agenda carga. */
  openBookingId?: string;
  canManage: boolean;
}) {
  const [date, setDate] = useState(initialDate ?? today);
  const [board, setBoard] = useState<BoardDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pendingOpen = useRef<string | null>(openBookingId ?? null);
  const [chargeFor, setChargeFor] = useState<BoardBooking | null>(null);
  // «Agendar cita»: abierto desde el botón (vacío) o desde una celda libre (hora y silla puestas).
  const [newBooking, setNewBooking] = useState<{ startUtc?: string; staffId?: string } | null>(
    openNewOnLoad ? {} : null
  );
  const [notice, setNotice] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const dateRef = useRef(date);
  dateRef.current = date;

  const load = useCallback(
    async (day: string, silent: boolean) => {
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      if (!silent) setLoading(true);
      try {
        const data = await apiFetch<BoardDto>(`/api/negocio/agenda?date=${day}`, {
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) return;
        setBoard(data);
        setError(null);
        setUpdatedAt(
          new Intl.DateTimeFormat("es-MX", {
            timeZone: timezone,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(new Date())
        );
      } catch (err) {
        if (ctrl.signal.aborted) return;
        // Un refresco silencioso que falla no borra lo que ya se ve.
        if (!silent || !board) setError(describeError(err));
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    },
    // `board` solo se lee para decidir si mostrar el error de un refresco silencioso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timezone]
  );

  useEffect(() => {
    void load(date, false);
    return () => ctrlRef.current?.abort();
  }, [date, load]);

  const refresh = useCallback(() => void load(dateRef.current, true), [load]);

  useEvents({ onBookingUpdated: refresh, onReconnect: refresh });

  useEffect(() => {
    const id = setInterval(refresh, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const sessions = useMemo(() => board?.bookings.filter((b) => b.kind === "session") ?? [], [board]);
  const unassigned = useMemo(() => sessions.filter((b) => !b.staffId), [sessions]);
  const showUnassigned = !!board && (unassigned.length > 0 || board.chairs.length === 0);

  const blocks = useMemo(() => board?.bookings.filter((b) => b.kind === "block") ?? [], [board]);

  // Qué pinta cada columna en cada franja (las citas largas abarcan varias).
  const plans = useMemo(() => {
    const byChair = new Map<string, ReturnType<typeof planColumn>>();
    if (!board) return { byChair, unassigned: planColumn([], []) };
    for (const c of board.chairs) {
      byChair.set(c.id, planColumn(board.slots, sessions.filter((b) => b.staffId === c.id)));
    }
    return { byChair, unassigned: planColumn(board.slots, unassigned) };
  }, [board, sessions, unassigned]);

  const stats = useMemo(() => {
    if (!board) return null;
    const upcoming = board.slots.filter((s) => !s.past);
    const free = upcoming.reduce((n, s) => n + s.free, 0);
    const capacity = upcoming.reduce((n, s) => n + s.capacity, 0);
    const nowMs = Date.now();
    const current =
      board.nowTime === null
        ? null
        : (board.slots.find(
            (s) => Date.parse(s.startUtc) <= nowMs && nowMs < Date.parse(s.endUtc)
          ) ?? null);
    return { free, capacity, current };
  }, [board]);

  // La cita de una notificación se abre una sola vez, cuando ya está en el tablero.
  useEffect(() => {
    const id = pendingOpen.current;
    if (id && board?.bookings.some((b) => b.id === id)) {
      pendingOpen.current = null;
      setSelectedId(id);
    }
  }, [board]);

  const selected = board?.bookings.find((b) => b.id === selectedId) ?? null;
  // Si la cita seleccionada desapareció (se canceló en otra pantalla), se cierra sola.
  useEffect(() => {
    if (selectedId && board && !selected) setSelectedId(null);
  }, [selectedId, board, selected]);

  function onCharged(result: RegisteredSaleDto) {
    setChargeFor(null);
    setSelectedId(null);
    setNotice(
      `Cobrado: ${result.sale.customerName} · ${money(result.sale.amountCents, currency)} (${result.sale.itemName}).${loyaltyNotice(result)}`
    );
    refresh();
  }

  const isToday = date === today;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              aria-label="Día anterior"
              onClick={() => setDate((d) => addDaysISO(d, -1))}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </Button>
            <Button variant="outline" size="sm" disabled={isToday} onClick={() => setDate(today)}>
              Hoy
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Día siguiente"
              onClick={() => setDate((d) => addDaysISO(d, 1))}
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <DatePicker ariaLabel="Elegir el día" value={date} onChange={setDate} className="w-40" />
          {/* Solo la primera letra: `capitalize` también pondría «De» en mayúscula. */}
          <h3 className="text-[15px] font-bold tracking-tight first-letter:uppercase">
            {longDayLabel(date)}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {updatedAt && (
            <span className="hidden text-xs text-text-3 sm:inline">Actualizado {updatedAt}</span>
          )}
          <Button
            variant="outline"
            size="icon"
            aria-label="Actualizar"
            disabled={loading}
            onClick={() => void load(date, false)}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} aria-hidden />
          </Button>
          <Button onClick={() => setNewBooking({})} disabled={!board || !board.open}>
            <Plus className="h-4 w-4" aria-hidden />
            Agendar cita
          </Button>
        </div>
      </div>

      {notice && (
        <p
          role="status"
          className="rounded-md border border-success-soft bg-success-tint px-3 py-2.5 text-sm text-success-text"
        >
          {notice}
        </p>
      )}

      {error ? (
        <div className="rounded-lg border border-danger-soft bg-danger-tint p-4 text-sm text-danger-text">
          <p>{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void load(date, false)}>
            Reintentar
          </Button>
        </div>
      ) : !board ? (
        <div className="space-y-2" aria-busy aria-label="Cargando la agenda">
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-md border bg-subtle" />
            ))}
          </div>
          <div className="h-72 animate-pulse rounded-lg border bg-subtle" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
            <StatCard label="Sillas activas" value={String(board.chairs.length)} hint="profesionales con agenda" />
            <StatCard
              label="Citas del día"
              value={String(sessions.length)}
              hint={unassigned.length > 0 ? `${unassigned.length} sin asignar` : "todas asignadas"}
            />
            <StatCard
              label="Cupos libres"
              value={stats ? String(stats.free) : "—"}
              hint={stats ? `de ${stats.capacity} en lo que resta del día` : undefined}
            />
            <StatCard
              label="Ahora"
              value={
                stats?.current
                  ? `${stats.current.free} de ${stats.current.capacity}`
                  : "—"
              }
              hint={
                stats?.current ? "sillas libres en esta franja" : isToday ? "fuera de horario" : "solo para hoy"
              }
            />
          </div>

          {board.chairs.length === 0 && (
            <p className="rounded-md border border-warning-soft bg-warning-tint px-3 py-2.5 text-sm text-warning-text">
              Aún no hay profesionales dados de alta, así que la agenda tiene una sola silla.
              {canManage && (
                <>
                  {" "}
                  <Link href="/equipo" className="font-semibold underline">
                    Agrégalos en Equipo
                  </Link>{" "}
                  para repartir las citas.
                </>
              )}
            </p>
          )}

          {!board.open || board.slots.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-strong bg-card py-8">
              <EmptyState
                icon={CalendarOff}
                title="El negocio no abre este día"
                description="No hay franjas en el horario del negocio. Cambia el día o ajusta el horario en Ajustes → Agenda."
              />
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border-strong bg-card shadow-sm">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="border-b bg-subtle text-left text-xs font-semibold text-text-2">
                    <th scope="col" className="sticky left-0 z-10 w-16 bg-subtle px-3 py-2.5">
                      Hora
                    </th>
                    {board.chairs.map((c) => (
                      <th key={c.id} scope="col" className="min-w-36 border-l px-3 py-2.5">
                        {c.name}
                      </th>
                    ))}
                    {showUnassigned && (
                      <th scope="col" className="min-w-36 border-l px-3 py-2.5 text-text-3">
                        Sin asignar
                      </th>
                    )}
                    <th scope="col" className="w-24 border-l px-3 py-2.5 text-right">
                      Cupos
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {board.slots.map((slot, rowIndex) => (
                    <SlotRow
                      key={slot.startUtc}
                      slot={slot}
                      rowIndex={rowIndex}
                      chairs={board.chairs}
                      plans={plans.byChair}
                      unassignedPlan={plans.unassigned}
                      blocks={blocks}
                      showUnassigned={showUnassigned}
                      isNow={stats?.current?.startUtc === slot.startUtc}
                      timezone={board.timezone}
                      onOpen={setSelectedId}
                      onBook={(startUtc, staffId) => setNewBooking({ startUtc, staffId })}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Legend />
        </>
      )}

      {selected && selected.kind === "session" && board && (
        <BookingPanel
          booking={selected}
          chairs={board.chairs}
          onClose={() => setSelectedId(null)}
          onChanged={() => {
            setSelectedId(null);
            refresh();
          }}
          onCharge={() => setChargeFor(selected)}
        />
      )}

      {newBooking && board && (
        <NewBookingDialog
          board={board}
          currency={currency}
          initialStartUtc={newBooking.startUtc}
          initialStaffId={newBooking.staffId}
          onClose={() => setNewBooking(null)}
          onSaved={(message) => {
            setNewBooking(null);
            setNotice(message);
            refresh();
          }}
        />
      )}

      {chargeFor && (
        <SaleDialog
          currency={currency}
          canAdjustCommission={canManage}
          today={today}
          initial={{
            bookingId: chargeFor.id,
            contact: chargeFor.contact,
            staffId: chargeFor.staffId,
          }}
          onClose={() => setChargeFor(null)}
          onSaved={onCharged}
        />
      )}
    </div>
  );
}

/* ------------------------------ una franja ------------------------------ */

/** Una cita dentro de una columna: cuántas franjas abarca y si solo continúa la de arriba. */
type CellEntry = { booking: BoardBooking; span: number; continues: boolean };

/** Lo que una columna (un profesional o «sin asignar») pinta por franja. */
type ColumnPlan = {
  /** Franja → las citas que EMPIEZAN a pintarse ahí. */
  starts: Map<number, CellEntry[]>;
  /** Franjas que ya cubre la tarjeta de una cita larga (la celda no se pinta). */
  covered: Set<number>;
};

/**
 * Reparte las citas de una columna entre las franjas. Una cita que dura más que
 * una franja se pinta UNA vez, con la altura de todas las que abarca (`rowSpan`),
 * así un servicio de 60 o 90 min se ve tan largo como dura. Si en la misma columna
 * hay otra cita encima en el tiempo (datos viejos o sin asignar), no se funden:
 * cada franja muestra su cita, la continuación en pequeño.
 */
function planColumn(slots: BoardSlot[], bookings: BoardBooking[]): ColumnPlan {
  const starts = new Map<number, CellEntry[]>();
  const covered = new Set<number>();
  const push = (row: number, entry: CellEntry) => {
    const list = starts.get(row);
    if (list) list.push(entry);
    else starts.set(row, [entry]);
  };
  for (const b of bookings) {
    const rows: number[] = [];
    slots.forEach((s, i) => {
      if (overlaps(s.startUtc, s.endUtc, b.startUtc, b.endUtc)) rows.push(i);
    });
    if (rows.length === 0) continue;
    const alone = !bookings.some(
      (o) => o.id !== b.id && overlaps(b.startUtc, b.endUtc, o.startUtc, o.endUtc)
    );
    if (alone) {
      push(rows[0]!, { booking: b, span: rows.length, continues: false });
      rows.slice(1).forEach((r) => covered.add(r));
    } else {
      rows.forEach((r, k) => push(r, { booking: b, span: 1, continues: k > 0 }));
    }
  }
  return { starts, covered };
}

function SlotRow({
  slot,
  rowIndex,
  chairs,
  plans,
  unassignedPlan,
  blocks,
  showUnassigned,
  isNow,
  timezone,
  onOpen,
  onBook,
}: {
  slot: BoardSlot;
  rowIndex: number;
  chairs: BoardDto["chairs"];
  plans: Map<string, ColumnPlan>;
  unassignedPlan: ColumnPlan;
  blocks: BoardBooking[];
  showUnassigned: boolean;
  isNow: boolean;
  timezone: string;
  onOpen: (id: string) => void;
  onBook: (startUtc: string, staffId: string) => void;
}) {
  const blockHere = blocks.find((b) => overlaps(slot.startUtc, slot.endUtc, b.startUtc, b.endUtc));
  const rowSpanOf = (entries: CellEntry[]) => (entries.length === 1 ? entries[0]!.span : 1);

  return (
    <tr
      className={cn("border-b last:border-0", slot.past && "opacity-60", isNow && "bg-brand-tint")}
      aria-current={isNow ? "time" : undefined}
    >
      <th
        scope="row"
        className={cn(
          "sticky left-0 z-10 px-3 py-2 text-left align-top font-mono text-xs font-medium tabular-nums",
          isNow ? "bg-brand-tint text-brand-text" : "bg-card text-text-2"
        )}
      >
        {slot.time}
      </th>

      {chairs.map((chair) => {
        const plan = plans.get(chair.id);
        if (plan?.covered.has(rowIndex)) return null;
        const entries = plan?.starts.get(rowIndex) ?? [];
        const offShift = !slot.workingStaffIds.includes(chair.id);
        const span = rowSpanOf(entries);
        return (
          <td
            key={chair.id}
            rowSpan={span}
            className={cn(
              "border-l px-2 py-1.5 align-top",
              span > 1 && "h-px",
              entries.length === 0 && (slot.blocked || offShift) && "booking-hatch"
            )}
          >
            {entries.length > 0 ? (
              <div className={cn("space-y-1", span > 1 && "h-full")}>
                {entries.map((e) => (
                  <Chip
                    key={`${e.booking.id}-${e.continues}`}
                    booking={e.booking}
                    span={e.span}
                    continues={e.continues}
                    timezone={timezone}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            ) : slot.blocked ? (
              <span className="text-xs text-text-3">Bloqueado</span>
            ) : offShift ? (
              <span className="text-xs text-text-3">Fuera de turno</span>
            ) : (
              <FreeCell
                past={slot.past}
                canBook={slot.free > 0}
                label={`Agendar a las ${slot.time} con ${chair.name}`}
                onBook={() => onBook(slot.startUtc, chair.id)}
              />
            )}
          </td>
        );
      })}

      {showUnassigned &&
        (unassignedPlan.covered.has(rowIndex) ? null : (
          <td
            rowSpan={rowSpanOf(unassignedPlan.starts.get(rowIndex) ?? [])}
            className={cn(
              "border-l px-2 py-1.5 align-top",
              rowSpanOf(unassignedPlan.starts.get(rowIndex) ?? []) > 1 && "h-px"
            )}
          >
            <div
              className={cn(
                "space-y-1",
                rowSpanOf(unassignedPlan.starts.get(rowIndex) ?? []) > 1 && "h-full"
              )}
            >
              {(unassignedPlan.starts.get(rowIndex) ?? []).map((e) => (
                <Chip
                  key={`${e.booking.id}-${e.continues}`}
                  booking={e.booking}
                  span={e.span}
                  continues={e.continues}
                  timezone={timezone}
                  onOpen={onOpen}
                />
              ))}
              {blockHere && (
                <p className="booking-hatch rounded-sm px-2 py-1 text-xs text-text-2">
                  Bloqueo{blockHere.notes ? `: ${blockHere.notes}` : ""}
                </p>
              )}
            </div>
          </td>
        ))}

      <td className="border-l px-3 py-2 text-right align-top">
        {slot.blocked ? (
          <Badge variant="secondary">Bloqueado</Badge>
        ) : slot.capacity === 0 ? (
          <Badge variant="secondary">Sin equipo</Badge>
        ) : (
          <Badge variant={slot.free > 0 ? "success" : "destructive"}>
            {slot.free}/{slot.capacity}
          </Badge>
        )}
      </td>
    </tr>
  );
}

/** Silla libre. Si aún se puede agendar, la celda entera es el atajo a «Agendar cita» con la hora y la silla puestas. */
function FreeCell({
  past,
  canBook,
  label,
  onBook,
}: {
  past: boolean;
  canBook: boolean;
  label: string;
  onBook: () => void;
}) {
  const content = (
    <>
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", past ? "bg-text-4" : "bg-success")} />
      Libre
    </>
  );
  if (past || !canBook) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-xs", past ? "text-text-4" : "text-success-text")}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onBook}
      aria-label={label}
      title={label}
      className="inline-flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs text-success-text transition-colors hover:bg-success-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {content}
    </button>
  );
}

/**
 * Una cita dentro de una columna. Si abarca varias franjas (`span > 1`) la tarjeta
 * ocupa toda esa altura y dice de qué hora a qué hora va; la continuación de una
 * cita encimada se pinta compacta.
 */
function Chip({
  booking,
  span,
  continues,
  timezone,
  onOpen,
}: {
  booking: BoardBooking;
  span: number;
  continues: boolean;
  timezone: string;
  onOpen: (id: string) => void;
}) {
  const name = booking.contact?.name ?? "Sin nombre";
  const endTime = timeInTz(booking.endUtc, timezone);

  return (
    <button
      type="button"
      onClick={() => onOpen(booking.id)}
      aria-label={`${name}, ${booking.time} a ${endTime}, ${durationLabel(booking.durationMinutes)}${booking.itemName ? `, ${booking.itemName}` : ""}${booking.sold ? ", cobrada" : ""}`}
      className={cn(
        "flex w-full items-start gap-1.5 rounded-sm border px-2 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        booking.sold || booking.status === "realizada"
          ? "border-success-soft bg-success-tint text-success-text"
          : "border-brand-soft bg-brand-tint text-brand-text hover:border-brand",
        span > 1 && "h-full",
        continues ? "py-0.5 text-[11px] opacity-80" : "py-1.5 text-xs"
      )}
    >
      {continues ? (
        <span className="truncate">↳ {name}</span>
      ) : (
        <>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{name}</span>
            {booking.itemName && <span className="block truncate text-[11px]">{booking.itemName}</span>}
            <span className="block text-[11px] opacity-80">
              {booking.time}–{endTime} · {durationLabel(booking.durationMinutes)}
            </span>
          </span>
          {booking.source === "ai" && <Bot className="h-3.5 w-3.5 shrink-0" aria-label="Agendada por el agente" />}
          {booking.sold && <BadgeCheck className="h-3.5 w-3.5 shrink-0" aria-label="Cobrada" />}
        </>
      )}
    </button>
  );
}

function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-text-3" aria-label="Leyenda">
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="h-2 w-2 rounded-full bg-success" />
        Silla libre
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="h-3 w-5 rounded-sm border border-brand-soft bg-brand-tint" />
        Cita agendada
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="h-3 w-5 rounded-sm border border-success-soft bg-success-tint" />
        Realizada o cobrada
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="booking-hatch h-3 w-5 rounded-sm border" />
        Fuera de turno o bloqueado
      </li>
    </ul>
  );
}

/* --------------------------- detalle de una cita --------------------------- */

function BookingPanel({
  booking,
  chairs,
  onClose,
  onChanged,
  onCharge,
}: {
  booking: BoardBooking;
  chairs: BoardDto["chairs"];
  onClose: () => void;
  onChanged: () => void;
  onCharge: () => void;
}) {
  const [staffId, setStaffId] = useState(booking.staffId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = staffId !== (booking.staffId ?? "");

  async function assign() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/negocio/agenda/citas/${booking.id}/profesional`, {
        method: "PUT",
        json: { staffId: staffId || null },
      });
      onChanged();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  const canCharge = !booking.sold && ["agendada", "realizada"].includes(booking.status);

  return (
    <Modal
      title={booking.contact?.name ?? "Cita sin nombre"}
      description={`${booking.time} · ${durationLabel(booking.durationMinutes)}`}
      onClose={onClose}
      busy={busy}
      size="sm"
    >
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-text-3">Estado</dt>
          <dd>
            <Badge variant={booking.status === "realizada" ? "success" : "default"}>
              {booking.status === "realizada" ? "Realizada" : "Agendada"}
            </Badge>
            {booking.sold && (
              <Badge variant="success" className="ml-1.5">
                Cobrada
              </Badge>
            )}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-3">Origen</dt>
          <dd>{booking.source === "ai" ? "Agente de IA" : "Manual"}</dd>
        </div>
        {booking.notes && (
          <div className="flex justify-between gap-3">
            <dt className="text-text-3">Notas</dt>
            <dd className="max-w-[16rem] text-right">{booking.notes}</dd>
          </div>
        )}
      </dl>

      <div className="mt-4 space-y-1.5">
        <label htmlFor="bk-staff" className="text-sm font-medium">
          Atiende
        </label>
        <SearchSelect
          id="bk-staff"
          value={staffId}
          onChange={setStaffId}
          options={chairs.map((c) => ({ value: c.id, label: c.name }))}
          emptyLabel="Sin asignar"
          searchPlaceholder="Buscar profesional…"
          disabled={busy}
        />
        <p className="text-xs text-text-3">
          Un profesional no puede tener dos citas a la misma hora.
        </p>
      </div>

      <ModalFooter error={error}>
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cerrar
        </Button>
        {canCharge && (
          <Button type="button" variant="outline" onClick={onCharge} disabled={busy || dirty}>
            Cobrar
          </Button>
        )}
        <Button type="button" onClick={() => void assign()} disabled={busy || !dirty}>
          {busy ? "Guardando…" : "Guardar profesional"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
