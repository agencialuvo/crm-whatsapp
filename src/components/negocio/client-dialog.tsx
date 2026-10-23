"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil, UserCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  SearchSelect,
  type SearchSelectOption,
} from "@/components/ui/search-select";
import { DatePicker } from "@/components/ui/date-picker";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, describeError } from "@/components/negocio/api";
import { ContactMatchPanel, useContactMatches } from "@/components/negocio/contact-match";
import {
  Field,
  fieldErrors,
  PhoneInput,
} from "@/components/negocio/fields";
import { ConfirmDialog, Modal, ModalFooter } from "@/components/negocio/modal";
import {
  CustomCommissionField,
  PaymentMethodField,
  SaleAmountField,
  SaleItemsField,
  useSaleCart,
} from "@/components/negocio/sale-cart";
import { dayIsoInTz } from "@/lib/time/slots";
import {
  birthdayLabel,
  dateNumeric,
  formatPeruPhone,
  MONTH_NAMES,
  money,
} from "@/lib/salon/format";
import { isPersonName, sanitizePersonName } from "@/lib/salon/staff-fields";
import {
  clientCreateSchema,
  clientInputSchema,
  PAYMENT_LABELS,
  type PaymentMethod,
} from "@/lib/salon/schemas";
import {
  itemsAreRestricted,
  staffAfterItemsChange,
  staffForItems,
} from "@/lib/salon/staff-for-item";
import type {
  SalonClientDetailDto,
  ContactMatchDto,
  SaleOptionsDto,
} from "@/lib/salon/types";

/** Celular de Perú: +51 fijo y exactamente 9 dígitos. */
const LOCAL = /^51\d{9}$/;

const DAY_OPTIONS: SearchSelectOption[] = Array.from(
  { length: 31 },
  (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
  }),
);
const MONTH_OPTIONS: SearchSelectOption[] = MONTH_NAMES.map((m, i) => ({
  value: String(i + 1),
  label: m,
}));
/**
 * Módulo SALON — la ficha de un cliente: alta (`clientId` nulo), edición y
 * baja, con el historial de lo que ha consumido.
 *
 * Campos estrictos: el nombre solo lleva letras y espacios y el celular son
 * exactamente 9 dígitos con +51 fijo; el cumpleaños es solo día y mes. Las
 * fechas se ven como DD/MM/AAAA y no hay horas en pantalla. Al crear un
 * cliente la ventana se cierra sola y la lista se refresca. Eliminar solo lo
 * quita de Clientes: el contacto y sus ventas se conservan.
 *
 * Alta: al escribir el celular o el nombre se buscan clientes ya registrados. Si
 * aparece uno, al elegirlo se completan su nombre y cumpleaños y el foco pasa a
 * la atención; al guardar, la atención se suma a su historial en vez de crear un
 * cliente duplicado.
 */
export function ClientDialog({
  clientId,
  view = false,
  currency,
  timezone,
  today,
  onClose,
  onChanged,
}: {
  clientId: string | null;
  /** Hoy en la zona del negocio (AAAA-MM-DD): la fecha con que arranca una atención nueva. */
  today: string;
  /** Abre la ficha en solo lectura (el ojo); «Editar» pasa al formulario. */
  view?: boolean;
  currency: string;
  timezone: string;
  onClose: () => void;
  /** Avisa a la lista que algo cambió (para que se refresque). */
  onChanged: () => void;
}) {
  const currentId = clientId;
  const [detail, setDetail] = useState<SalonClientDetailDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [day, setDay] = useState("");
  const [month, setMonth] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Corregir la fecha de una venta del historial: cuál se edita y qué día se escribió.
  const [editingSale, setEditingSale] = useState<{
    id: string;
    day: string;
  } | null>(null);
  const [saleDateBusy, setSaleDateBusy] = useState(false);
  const [saleDateError, setSaleDateError] = useState<string | null>(null);
  const [viewing, setViewing] = useState(view && clientId !== null);
  // Alta: un cliente siempre recibió un servicio, así que el alta registra esa atención.
  const [options, setOptions] = useState<SaleOptionsDto | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [soldOn, setSoldOn] = useState(today);
  const [staffId, setStaffId] = useState("");
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [customPct, setCustomPct] = useState("");
  // El mismo carrito que «Registrar venta» (Caja).
  const cart = useSaleCart(options, currency, (vals) =>
    // Si quien estaba elegido no da todo lo del carrito, se cambia o se vacía.
    setStaffId((cur) => staffAfterItemsChange(options, vals, cur)),
  );
  // Alta: el contacto (cliente o solo WhatsApp) que se eligió de las sugerencias.
  const [linked, setLinked] = useState<ContactMatchDto | null>(null);
  const matches = useContactMatches({ enabled: clientId === null && !linked, name, phone }).filter(
    // Solo celulares de Perú de 9 dígitos: el formulario no admite otros.
    (m) => LOCAL.test(m.phone)
  );
  const itemRef = useRef<HTMLDivElement>(null);

  function adopt(d: SalonClientDetailDto) {
    const c = d.client;
    setDetail(d);
    setName(c.name);
    // Un número que no es de Perú (datos viejos) no cabe aquí: se pide uno de 9 dígitos.
    const full = c.phone ?? "";
    setPhone(LOCAL.test(full) ? full.slice(2) : "");
    setDay(c.birthdayDay != null ? String(c.birthdayDay) : "");
    setMonth(c.birthdayMonth != null ? String(c.birthdayMonth) : "");
    setNotes(c.notes ?? "");
  }

  useEffect(() => {
    if (!currentId) return;
    let alive = true;
    apiFetch<SalonClientDetailDto>(`/api/negocio/clientes/${currentId}`)
      .then((d) => alive && adopt(d))
      .catch((err) => alive && setLoadError(describeError(err)));
    return () => {
      alive = false;
    };
  }, [currentId]);

  useEffect(() => {
    if (clientId !== null) return;
    let alive = true;
    apiFetch<SaleOptionsDto>("/api/negocio/opciones")
      .then((o) => {
        if (!alive) return;
        setOptions(o);
        // Con un solo profesional no hay nada que elegir.
        setStaffId(
          (cur) => cur || (o.staff.length === 1 ? o.staff[0]!.id : ""),
        );
      })
      .catch((err) => alive && setOptionsError(describeError(err)));
    return () => {
      alive = false;
    };
  }, [clientId]);

  function clearError(field: string) {
    setErrors((e) => {
      if (!(field in e)) return e;
      const { [field]: _gone, ...rest } = e;
      void _gone;
      return rest;
    });
  }

  function pickExisting(c: ContactMatchDto) {
    setLinked(c);
    setName(c.name);
    setPhone((c.phone ?? "").slice(2));
    // Lo que ya estaba mal (o a medias) deja de estarlo al elegir a la persona.
    setErrors({});
    setDay(c.birthdayDay != null ? String(c.birthdayDay) : "");
    setMonth(c.birthdayMonth != null ? String(c.birthdayMonth) : "");
    // El foco pasa a la atención, que es lo que falta llenar.
    setTimeout(() => {
      itemRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      itemRef.current
        ?.querySelector<HTMLElement>("button")
        ?.focus({ preventScroll: true });
    }, 0);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSaved(false);

    const fields = {
      name,
      phone: phone ? `51${phone}` : "",
      birthdayDay: day ? Number(day) : null,
      birthdayMonth: month ? Number(month) : null,
      notes,
    };
    const parsed =
      currentId === null
        ? clientCreateSchema.safeParse({
            ...fields,
            items: cart.payload(),
            amountCents: cart.amountCents(),
            soldOn,
            staffId,
            paymentMethod: method || undefined,
            customCommissionPercentage:
              customPct.trim() !== "" ? Number(customPct) : null,
          })
        : clientInputSchema.safeParse(fields);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const result = await apiFetch<SalonClientDetailDto>(
        currentId
          ? `/api/negocio/clientes/${currentId}`
          : "/api/negocio/clientes",
        { method: currentId ? "PATCH" : "POST", json: parsed.data },
      );
      onChanged();
      if (currentId === null) {
        // Alta lista: se cierra la ventana y la lista ya se está refrescando.
        onClose();
        return;
      }
      adopt(result);
      setSaved(true);
    } catch (err) {
      setFormError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveSaleDate() {
    if (!editingSale || !currentId) return;
    setSaleDateBusy(true);
    setSaleDateError(null);
    try {
      await apiFetch(`/api/negocio/ventas/${editingSale.id}`, {
        method: "PATCH",
        json: { soldOn: editingSale.day },
      });
      const fresh = await apiFetch<SalonClientDetailDto>(
        `/api/negocio/clientes/${currentId}`,
      );
      setDetail(fresh);
      setEditingSale(null);
      onChanged();
    } catch (err) {
      setSaleDateError(describeError(err));
    } finally {
      setSaleDateBusy(false);
    }
  }

  async function remove() {
    await apiFetch(`/api/negocio/clientes/${currentId}`, { method: "DELETE" });
    onChanged();
    onClose();
  }

  if (confirming && detail) {
    return (
      <ConfirmDialog
        title="Eliminar cliente"
        message={
          <p>
            <strong>{detail.client.name}</strong> dejará de aparecer en
            Clientes. Su contacto y sus ventas se conservan; si vuelve a comprar
            en Caja, será cliente otra vez.
          </p>
        }
        confirmLabel="Eliminar cliente"
        onConfirm={remove}
        onClose={() => setConfirming(false)}
      />
    );
  }

  const client = detail?.client;
  const creating = currentId === null;
  const noStaff = options !== null && options.staff.length === 0;
  // Solo quienes dan todo lo que se adquirió (todos si no se detalló).
  const staffOptions: SearchSelectOption[] = staffForItems(
    options,
    cart.values,
  ).map((m) => ({
    value: m.id,
    label: m.name,
  }));
  const loading = !creating && !detail && !loadError;

  const historySection = detail && (
    <section aria-labelledby="client-history">
      <h3 id="client-history" className="mb-2 text-sm font-semibold">
        Historial de atenciones
      </h3>
      {detail.history.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-sm text-text-2">
          Todavía no tiene atenciones registradas.
        </p>
      ) : (
        <div className="relative max-h-64 overflow-auto rounded-md border">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b bg-subtle text-left text-xs font-semibold text-text-2">
                <th scope="col" className="px-3 py-2">
                  Fecha de atención
                </th>
                <th scope="col" className="px-2 py-2">
                  Servicio / oferta
                </th>
                <th scope="col" className="px-2 py-2">
                  Atendió
                </th>
                <th scope="col" className="px-2 py-2">
                  Método de pago
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Monto
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.history.map((h) => (
                <tr key={h.id} className="border-b last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-text-2">
                    {editingSale?.id === h.id ? (
                      <span className="flex items-center gap-1.5">
                        <DatePicker
                          ariaLabel="Fecha de la atención"
                          value={editingSale.day}
                          onChange={(day) => setEditingSale({ id: h.id, day })}
                          disabled={saleDateBusy}
                          className="w-36"
                        />
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void saveSaleDate()}
                          disabled={saleDateBusy || !editingSale.day}
                        >
                          {saleDateBusy ? "…" : "Guardar"}
                        </Button>
                        <button
                          type="button"
                          aria-label="Descartar el cambio de fecha"
                          onClick={() => {
                            setEditingSale(null);
                            setSaleDateError(null);
                          }}
                          disabled={saleDateBusy}
                          className="rounded-sm p-1 text-text-3 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1">
                        {dateNumeric(h.createdAt, timezone)}
                        {!viewing && (
                          <button
                            type="button"
                            aria-label={`Cambiar la fecha del ${dateNumeric(h.createdAt, timezone)}`}
                            title="Cambiar la fecha"
                            onClick={() => {
                              setSaleDateError(null);
                              setEditingSale({
                                id: h.id,
                                day: dayIsoInTz(
                                  new Date(h.createdAt),
                                  timezone,
                                ),
                              });
                            }}
                            className="rounded-sm p-1 text-text-3 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {h.itemName}
                    {h.itemKind === "combo" && (
                      <span className="ml-1.5 text-[11px] text-text-3">
                        oferta
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2">{h.staffName}</td>
                  <td className="whitespace-nowrap px-2 py-2">
                    {PAYMENT_LABELS[h.paymentMethod]}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                    {money(h.amountCents, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {saleDateError && (
        <p role="alert" className="mt-2 text-xs text-danger-text">
          {saleDateError}
        </p>
      )}
    </section>
  );

  return (
    <Modal
      title={creating ? "Nuevo cliente" : (client?.name ?? "Cliente")}
      description={
        client
          ? `Registrado el: ${dateNumeric(client.registeredAt, timezone)} · ${client.visits} visita${client.visits === 1 ? "" : "s"} · ${money(client.totalCents, currency)} invertidos`
          : creating
            ? "Un cliente siempre recibió un servicio: se registra esa atención en Caja."
            : undefined
      }
      onClose={onClose}
      busy={busy}
      size="lg"
    >
      {loadError ? (
        <p
          role="alert"
          className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text"
        >
          {loadError}
        </p>
      ) : loading ? (
        <div className="space-y-3" aria-busy aria-label="Cargando">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-md bg-subtle" />
          ))}
        </div>
      ) : viewing && client ? (
        <div className="space-y-5">
          <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold text-text-2">Nombre</dt>
              <dd className="mt-0.5 break-words">{client.name}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-text-2">Celular</dt>
              <dd className="mt-0.5">{formatPeruPhone(client.phone)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-text-2">Cumpleaños</dt>
              <dd className="mt-0.5">
                {birthdayLabel(client.birthdayDay, client.birthdayMonth)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-text-2">
                Última visita
              </dt>
              <dd className="mt-0.5">
                {client.lastVisitAt
                  ? dateNumeric(client.lastVisitAt, timezone)
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-text-2">Visitas</dt>
              <dd className="mt-0.5 tabular-nums">{client.visits}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-text-2">
                Total invertido
              </dt>
              <dd className="mt-0.5 font-semibold tabular-nums">
                {money(client.totalCents, currency)}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold text-text-2">Notas</dt>
              <dd className="mt-0.5 whitespace-pre-wrap break-words">
                {client.notes ?? "—"}
              </dd>
            </div>
          </dl>

          {historySection}

          <ModalFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cerrar
            </Button>
            <Button type="button" onClick={() => setViewing(false)}>
              Editar
            </Button>
          </ModalFooter>
        </div>
      ) : (
        <div className="space-y-5">
          <form onSubmit={save} noValidate className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Nombre del cliente" required={!creating}
                htmlFor="client-name"
                error={errors.name}
                hint="Solo letras y espacios"
              >
                <Input
                  id="client-name"
                  value={name}
                  maxLength={80}
                  autoComplete="off"
                  placeholder="Ej. María Pérez"
                  // Números y signos no se pueden teclear ni pegar.
                  onChange={(e) => {
                    setName(sanitizePersonName(e.target.value));
                    clearError("name");
                  }}
                  // El aviso llega al salir del campo con el nombre a medias, no al teclear.
                  onBlur={() => {
                    const t = name.trim();
                    if (t && (t.length < 2 || !isPersonName(t)))
                      setErrors((e) => ({
                        ...e,
                        name: "El nombre debe tener al menos 2 letras (solo letras y espacios).",
                      }));
                  }}
                  disabled={busy}
                />
              </Field>
              <Field
                label="Número de celular"
                htmlFor="client-phone"
                error={errors.phone}
                hint="9 dígitos, solo números."
              >
                <PhoneInput
                  id="client-phone"
                  digits={phone}
                  onChange={(d) => {
                    setPhone(d);
                    clearError("phone");
                  }}
                  onBlur={() => {
                    if (phone.length > 0 && phone.length < 9)
                      setErrors((e) => ({
                        ...e,
                        phone: "El celular debe tener exactamente 9 dígitos.",
                      }));
                  }}
                  disabled={busy || !!linked}
                  invalid={!!errors.phone}
                />
              </Field>
            </div>

            {creating && !linked && (
              <ContactMatchPanel matches={matches} onPick={pickExisting} />
            )}

            {creating && linked && (
              <div
                role="status"
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-brand-soft bg-brand-tint px-3 py-2 text-sm"
              >
                <p className="flex items-center gap-1.5">
                  <UserCheck
                    className="h-4 w-4 shrink-0 text-brand-text"
                    aria-hidden
                  />
                  <span>
                    {linked.salonClient ? (
                      <>
                        <strong>{linked.name}</strong> ya está registrado (
                        {linked.visits} visita{linked.visits === 1 ? "" : "s"}).
                        Esta atención se sumará a su historial.
                      </>
                    ) : (
                      <>
                        <strong>{linked.name}</strong> es un contacto de WhatsApp.
                        Al registrar la atención pasará a ser cliente, sin
                        duplicar su ficha.
                      </>
                    )}
                  </span>
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setLinked(null)}
                  disabled={busy}
                >
                  No es esta persona
                </Button>
              </div>
            )}

            <Field
              label="Cumpleaños"
              htmlFor="client-bday-day"
              error={errors.birthdayDay ?? errors.birthdayMonth}
              hint="Opcional. Solo día y mes."
            >
              <div className="grid grid-cols-2 gap-3">
                <SearchSelect
                  id="client-bday-day"
                  value={day}
                  onChange={setDay}
                  options={DAY_OPTIONS}
                  placeholder="Elige el día"
                  searchPlaceholder="Buscar día…"
                  emptyLabel="Sin definir"
                  emptyShowsPlaceholder
                  disabled={busy}
                />
                <SearchSelect
                  value={month}
                  onChange={setMonth}
                  options={MONTH_OPTIONS}
                  placeholder="Elige el mes"
                  searchPlaceholder="Buscar mes…"
                  emptyLabel="Sin definir"
                  emptyShowsPlaceholder
                  disabled={busy}
                />
              </div>
            </Field>

            {creating &&
              (optionsError ? (
                <p role="alert" className="text-sm text-danger-text">
                  {optionsError}
                </p>
              ) : !options ? (
                <div
                  className="h-9 animate-pulse rounded-md bg-subtle"
                  aria-busy
                />
              ) : noStaff ? (
                <p className="text-sm text-text-2">
                  Primero da de alta al menos un profesional activo en
                  «Equipo».
                </p>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label="Atendió" required
                      htmlFor="client-staff"
                      error={errors.staffId}
                      hint={
                        itemsAreRestricted(options, cart.values)
                          ? "Solo los profesionales que dan este servicio u oferta."
                          : undefined
                      }
                    >
                      <SearchSelect
                        id="client-staff"
                        value={staffId}
                        onChange={setStaffId}
                        options={staffOptions}
                        placeholder="Elige quién atendió…"
                        searchPlaceholder="Buscar profesional…"
                        disabled={busy}
                        invalid={!!errors.staffId}
                      />
                    </Field>
                    <Field
                      label="Fecha de atención"
                      htmlFor="client-sold-on"
                      error={errors.soldOn}
                    >
                      <DatePicker
                        id="client-sold-on"
                        value={soldOn}
                        onChange={setSoldOn}
                        disabled={busy}
                        invalid={!!errors.soldOn}
                        className="w-full"
                      />
                    </Field>
                  </div>

                  <div ref={itemRef}>
                    <SaleItemsField
                      cart={cart}
                      currency={currency}
                      busy={busy}
                      error={errors.items ?? errors.serviceId}
                      idPrefix="client"
                    />
                  </div>

                  <SaleAmountField
                    cart={cart}
                    currency={currency}
                    busy={busy}
                    error={errors.amountCents}
                    idPrefix="client"
                  />

                  <PaymentMethodField
                    method={method}
                    onChange={setMethod}
                    busy={busy}
                    error={errors.paymentMethod}
                  />

                  <CustomCommissionField
                    id="client-pct"
                    value={customPct}
                    onChange={setCustomPct}
                    busy={busy}
                    error={errors.customCommissionPercentage}
                  />
                </>
              ))}

            {/* Las notas son del perfil: se editan en «Editar cliente». */}
            {!creating && (
            <Field
              label="Notas"
              htmlFor="client-notes"
              error={errors.notes}
              hint="Opcional."
            >
              <Textarea
                id="client-notes"
                value={notes}
                maxLength={500}
                rows={2}
                onChange={(e) => setNotes(e.target.value)}
                disabled={busy}
              />
            </Field>
            )}

            <ModalFooter error={formError}>
              {!creating && (
                <Button
                  type="button"
                  variant="outline"
                  className="mr-auto text-danger-text"
                  onClick={() => setConfirming(true)}
                  disabled={busy}
                >
                  Eliminar
                </Button>
              )}
              {saved && (
                <span role="status" className="self-center text-xs text-text-2">
                  Guardado.
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={busy}
              >
                Cerrar
              </Button>
              <Button
                type="submit"
                disabled={busy || (creating && (!options || noStaff))}
              >
                {busy
                  ? "Guardando…"
                  : creating
                    ? linked
                      ? "Registrar atención"
                      : "Crear cliente"
                    : "Guardar cambios"}
              </Button>
            </ModalFooter>
          </form>

          {historySection}
        </div>
      )}
    </Modal>
  );
}
