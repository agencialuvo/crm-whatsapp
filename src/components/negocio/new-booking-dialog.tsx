"use client";

import { useEffect, useMemo, useState } from "react";
import { UserPlus, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Field, PhoneInput } from "@/components/negocio/fields";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { durationLabel, formatPeruPhone, money } from "@/lib/salon/format";
import { newBoardBookingSchema } from "@/lib/salon/schemas";
import { staffForItem } from "@/lib/salon/staff-for-item";
import { isPersonName, sanitizePersonName } from "@/lib/salon/staff-fields";
import type { BoardDto, BoardSlot, ContactMatchDto, SaleOptionsDto } from "@/lib/salon/types";
import { longDayLabel } from "@/lib/time/calendar";
import { overlaps } from "@/lib/time/slots";

const PHONE_DIGITS = 9;

/**
 * Módulo SALON — «Agendar cita» desde la agenda por sillas: cliente, hora,
 * servicio u oferta y profesional, contra el mismo tablero que se está viendo.
 *
 * La cita dura lo que dura el servicio u oferta, así que solo se ofrecen las horas
 * en que cabe entera (todas sus franjas libres y sin bloqueo) y, para esa hora,
 * los profesionales que dan ese servicio, están de turno todo el tramo y no tienen
 * otra cita encima. El servidor vuelve a validar todo (dos personas pueden agendar
 * el mismo hueco a la vez) y su mensaje se muestra tal cual.
 *
 * El cliente se busca por nombre o celular; si no está, «Crear cliente rápido»
 * pide solo nombre y celular.
 */
export function NewBookingDialog({
  board,
  currency,
  initialStartUtc,
  initialStaffId,
  onClose,
  onSaved,
}: {
  board: BoardDto;
  currency: string;
  /** Al tocar una celda libre llegan la hora y la silla ya elegidas. */
  initialStartUtc?: string;
  initialStaffId?: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [options, setOptions] = useState<SaleOptionsDto | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const [customerText, setCustomerText] = useState("");
  const [contact, setContact] = useState<{ id: string; name: string } | null>(null);
  const [hits, setHits] = useState<ContactMatchDto[]>([]);
  const [searched, setSearched] = useState(false);
  // «Crear cliente rápido»: nombre y celular.
  const [quick, setQuick] = useState<{ name: string; phone: string } | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);

  const [startUtc, setStartUtc] = useState(initialStartUtc ?? "");
  const [itemValue, setItemValue] = useState("");
  const [staffId, setStaffId] = useState(initialStaffId ?? "");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch<SaleOptionsDto>("/api/negocio/opciones")
      .then((o) => alive && setOptions(o))
      .catch((err) => alive && setOptionsError(describeError(err)));
    return () => {
      alive = false;
    };
  }, []);

  // El servicio u oferta elegido, con su duración.
  const item = useMemo(() => {
    const [kind, id] = itemValue.split(":");
    const list = kind === "service" ? options?.services : kind === "combo" ? options?.combos : undefined;
    return list?.find((x) => x.id === id) ?? null;
  }, [itemValue, options]);
  const duration = item?.durationMinutes ?? 0;

  /** Las franjas que cubriría una cita que empieza en `slot` y dura `minutes`. */
  const spanOf = useMemo(
    () =>
      (slot: BoardSlot, minutes: number): BoardSlot[] | null => {
        const start = Date.parse(slot.startUtc);
        const end = start + Math.max(minutes, 1) * 60_000;
        const span = board.slots.filter(
          (s) => Date.parse(s.startUtc) < end && Date.parse(s.endUtc) > start
        );
        if (span.length === 0 || Date.parse(span[span.length - 1]!.endUtc) < end) return null;
        return span;
      },
    [board.slots]
  );

  // Horas en que la cita cabe entera (sin servicio elegido, las de una franja libre).
  const bookable = useMemo(
    () =>
      board.slots.filter((s) => {
        if (s.past) return false;
        const span = spanOf(s, duration || 1);
        return !!span && span.every((x) => !x.blocked && x.free > 0);
      }),
    [board.slots, spanOf, duration]
  );

  // Si cambiar el servicio deja la hora elegida sin lugar, se pasa a la primera que cabe.
  useEffect(() => {
    if (!bookable.some((s) => s.startUtc === startUtc)) setStartUtc(bookable[0]?.startUtc ?? "");
  }, [bookable, startUtc]);

  const slot = bookable.find((s) => s.startUtc === startUtc) ?? null;

  // Los profesionales que sí pueden atender: dan el servicio, de turno todo el tramo y sin otra cita encima.
  const availableChairs = useMemo(() => {
    if (!slot) return [];
    const span = spanOf(slot, duration || 1) ?? [slot];
    const endIso = new Date(Date.parse(slot.startUtc) + Math.max(duration, 1) * 60_000).toISOString();
    const canGive = itemValue ? new Set(staffForItem(options, itemValue).map((m) => m.id)) : null;
    return board.chairs.filter(
      (c) =>
        (!canGive || canGive.has(c.id)) &&
        span.every((s) => s.workingStaffIds.includes(c.id)) &&
        !board.bookings.some(
          (b) =>
            b.kind === "session" &&
            b.staffId === c.id &&
            overlaps(slot.startUtc, endIso, b.startUtc, b.endUtc)
        )
    );
  }, [board.chairs, board.bookings, slot, spanOf, duration, itemValue, options]);

  // Si cambiar la hora o el servicio deja sin cupo al profesional elegido, se suelta.
  useEffect(() => {
    if (staffId && !availableChairs.some((c) => c.id === staffId)) setStaffId("");
  }, [availableChairs, staffId]);

  // Búsqueda de contactos mientras se escribe (si no hay uno elegido).
  useEffect(() => {
    const q = customerText.trim();
    if (contact || quick || q.length < 2) {
      setHits([]);
      setSearched(false);
      return;
    }
    setSearched(false);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      apiFetch<{ matches: ContactMatchDto[] }>(
        `/api/negocio/contactos/buscar?limit=6&q=${encodeURIComponent(q)}`,
        { signal: ctrl.signal }
      )
        .then((r) => {
          if (ctrl.signal.aborted) return;
          setHits(r.matches);
          setSearched(true);
        })
        .catch(() => {
          // Sin sugerencias no se rompe nada: se puede crear al cliente.
          if (!ctrl.signal.aborted) setSearched(true);
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [customerText, contact, quick]);

  function startQuick() {
    const q = customerText.trim();
    const digits = q.replace(/\D/g, "");
    const looksLikePhone = /^\d/.test(q);
    setQuick({
      name: looksLikePhone ? "" : sanitizePersonName(q),
      phone: looksLikePhone ? digits.replace(/^51(?=\d{9}$)/, "").slice(0, PHONE_DIGITS) : "",
    });
    setErrors({});
  }

  async function createQuick() {
    if (!quick) return;
    const name = quick.name.trim();
    const next: Record<string, string> = {};
    if (name.length < 2 || !isPersonName(name)) {
      next.quickName = "El nombre debe tener al menos 2 letras (solo letras y espacios).";
    }
    if (quick.phone.length !== PHONE_DIGITS) {
      next.quickPhone = `El celular debe tener ${PHONE_DIGITS} dígitos`;
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    setQuickBusy(true);
    try {
      const r = await apiFetch<{ contact: { id: string; name: string } }>("/api/negocio/contactos", {
        method: "POST",
        json: { name, phone: `51${quick.phone}` },
      });
      setContact({ id: r.contact.id, name: r.contact.name });
      setQuick(null);
      setCustomerText("");
    } catch (err) {
      setErrors({ quickPhone: describeError(err) });
    } finally {
      setQuickBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const [kind, id] = itemValue.split(":");
    const parsed = newBoardBookingSchema.safeParse({
      contactId: contact?.id ?? "",
      serviceId: kind === "service" ? id : null,
      comboId: kind === "combo" ? id : null,
      startUtc,
      staffId: staffId || null,
      notes,
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        if (!next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await apiFetch("/api/negocio/agenda/citas", { method: "POST", json: parsed.data });
      const chair = board.chairs.find((c) => c.id === staffId);
      onSaved(
        `Cita agendada: ${contact?.name ?? "cliente"} · ${item?.name ?? ""} · ${slot?.time ?? ""}${chair ? ` con ${chair.name}` : ""}.`
      );
    } catch (err) {
      setFormError(describeError(err));
      setBusy(false);
    }
  }

  const itemOptions: SearchSelectOption[] = [
    ...(options?.services ?? []).map((s) => ({
      value: `service:${s.id}`,
      label: s.name,
      group: "Servicios",
      hint: `${money(s.priceCents, currency)} · ${durationLabel(s.durationMinutes)}`,
    })),
    ...(options?.combos ?? []).map((c) => ({
      value: `combo:${c.id}`,
      label: c.name,
      group: "Ofertas",
      hint: `${money(c.priceCents, currency)} · ${durationLabel(c.durationMinutes)}`,
    })),
  ];

  const loading = options === null && !optionsError;
  const showDropdown = !contact && !quick && customerText.trim().length >= 2 && searched;

  return (
    <Modal
      title="Agendar cita"
      description={longDayLabel(board.date)}
      onClose={onClose}
      busy={busy}
    >
      {optionsError ? (
        <>
          <p
            role="alert"
            className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text"
          >
            {optionsError}
          </p>
          <ModalFooter>
            <Button type="button" onClick={onClose}>
              Cerrar
            </Button>
          </ModalFooter>
        </>
      ) : loading ? (
        <div className="space-y-3" aria-busy aria-label="Cargando">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-md bg-subtle" />
          ))}
        </div>
      ) : itemOptions.length === 0 ? (
        <>
          <p className="rounded-md border border-warning-soft bg-warning-tint px-3 py-2.5 text-sm text-warning-text">
            Primero crea al menos un servicio u oferta activo en «Servicios».
          </p>
          <ModalFooter>
            <Button type="button" onClick={onClose}>
              Cerrar
            </Button>
          </ModalFooter>
        </>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field
            label="Nombre del cliente" required
            htmlFor="nb-customer"
            error={errors.contactId}
            hint={contact || quick ? undefined : "Busca por nombre o celular."}
          >
            {contact ? (
              <div className="flex items-center justify-between gap-2 rounded-md border bg-subtle px-3 py-1.5">
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <UserRound className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
                  <span className="truncate font-medium">{contact.name}</span>
                </span>
                <button
                  type="button"
                  aria-label="Quitar el cliente"
                  onClick={() => {
                    setContact(null);
                    setCustomerText("");
                  }}
                  disabled={busy}
                  className="rounded-sm p-1 text-text-3 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ) : quick ? (
              <div className="space-y-3 rounded-md border border-brand-soft bg-brand-tint p-3">
                <p className="flex items-center justify-between gap-2 text-xs font-semibold text-brand-text">
                  <span className="flex items-center gap-1.5">
                    <UserPlus className="h-3.5 w-3.5" aria-hidden />
                    Crear cliente rápido
                  </span>
                  <button
                    type="button"
                    onClick={() => setQuick(null)}
                    disabled={quickBusy}
                    className="rounded-sm px-1 font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Volver a buscar
                  </button>
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Nombre" required htmlFor="nb-quick-name" error={errors.quickName}>
                    <Input
                      id="nb-quick-name"
                      value={quick.name}
                      maxLength={80}
                      autoComplete="off"
                      placeholder="Ej. María Pérez"
                      onChange={(e) => setQuick({ ...quick, name: sanitizePersonName(e.target.value) })}
                      disabled={quickBusy}
                      aria-invalid={!!errors.quickName}
                    />
                  </Field>
                  <Field label="Celular" required htmlFor="nb-quick-phone" error={errors.quickPhone}>
                    <PhoneInput
                      id="nb-quick-phone"
                      digits={quick.phone}
                      onChange={(d) => setQuick({ ...quick, phone: d })}
                      disabled={quickBusy}
                      invalid={!!errors.quickPhone}
                    />
                  </Field>
                </div>
                <div className="flex justify-end">
                  <Button type="button" size="sm" onClick={() => void createQuick()} disabled={quickBusy}>
                    {quickBusy ? "Creando…" : "Crear y usar"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="relative">
                <Input
                  id="nb-customer"
                  value={customerText}
                  maxLength={80}
                  autoComplete="off"
                  placeholder="Nombre o celular"
                  onChange={(e) => setCustomerText(e.target.value)}
                  disabled={busy}
                />
                {showDropdown && (
                  <ul
                    role="listbox"
                    aria-label="Clientes encontrados"
                    className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-pop"
                  >
                    {hits.map((h) => (
                      <li key={h.id} role="option" aria-selected={false}>
                        <button
                          type="button"
                          onClick={() => {
                            setContact({ id: h.id, name: h.name });
                            setHits([]);
                          }}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                        >
                          <span className="truncate">{h.name}</span>
                          {h.phone && (
                            <span className="shrink-0 text-xs tabular-nums text-text-3">
                              {formatPeruPhone(h.phone)}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                    <li role="option" aria-selected={false} className={hits.length > 0 ? "border-t" : undefined}>
                      <button
                        type="button"
                        onClick={startQuick}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-brand-text hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                      >
                        <UserPlus className="h-4 w-4 shrink-0" aria-hidden />
                        {hits.length === 0 ? "No se encontró: crear cliente rápido" : "Crear cliente rápido"}
                      </button>
                    </li>
                  </ul>
                )}
              </div>
            )}
          </Field>

          <Field label="Hora" required htmlFor="nb-time" error={errors.startUtc}>
            {bookable.length === 0 ? (
              <p className="rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-sm text-warning-text">
                {item
                  ? `No hay una hora este día donde quepan ${durationLabel(duration)} seguidos. Elige otro día o otro servicio.`
                  : "No quedan horas libres este día. Elige otro día para agendar."}
              </p>
            ) : (
              <SearchSelect
                id="nb-time"
                value={startUtc}
                onChange={setStartUtc}
                options={bookable.map((s) => ({
                  value: s.startUtc,
                  label: `${s.time} · ${s.free} ${s.free === 1 ? "cupo" : "cupos"}`,
                }))}
                searchPlaceholder="Buscar hora…"
                disabled={busy}
              />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Servicio / oferta" required
              htmlFor="nb-item"
              error={errors.serviceId ?? errors.comboId}
              hint={item ? `Dura ${durationLabel(item.durationMinutes)}.` : undefined}
            >
              <SearchSelect
                id="nb-item"
                value={itemValue}
                onChange={setItemValue}
                options={itemOptions}
                placeholder="Elige el servicio u oferta…"
                searchPlaceholder="Buscar servicio u oferta…"
                disabled={busy}
                invalid={!!(errors.serviceId ?? errors.comboId)}
              />
            </Field>

            {board.chairs.length > 0 && (
              <Field
                label="Profesional"
                htmlFor="nb-staff"
                error={errors.staffId}
                hint={
                  availableChairs.length === 0
                    ? "Nadie está libre en ese tramo: queda sin asignar."
                    : undefined
                }
              >
                <SearchSelect
                  id="nb-staff"
                  value={staffId}
                  onChange={setStaffId}
                  options={availableChairs.map((c) => ({ value: c.id, label: c.name }))}
                  emptyLabel="Sin asignar (elegir después)"
                  searchPlaceholder="Buscar profesional…"
                  disabled={busy}
                />
              </Field>
            )}
          </div>

          <Field label="Notas" htmlFor="nb-notes" error={errors.notes} hint="Opcional. Ej.: corte y barba.">
            <Input
              id="nb-notes"
              value={notes}
              maxLength={500}
              onChange={(e) => setNotes(e.target.value)}
              disabled={busy}
            />
          </Field>

          <ModalFooter error={formError}>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || bookable.length === 0}>
              {busy ? "Agendando…" : "Agendar cita"}
            </Button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}
