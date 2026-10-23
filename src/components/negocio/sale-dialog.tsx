"use client";

import { useEffect, useState } from "react";
import { UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";
import { apiFetch, describeError } from "@/components/negocio/api";
import { ContactMatchPanel, useContactMatches } from "@/components/negocio/contact-match";
import { Field, fieldErrors, PhoneInput } from "@/components/negocio/fields";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import {
  CustomCommissionField,
  PaymentMethodField,
  SaleAmountField,
  SaleItemsField,
  useSaleCart,
} from "@/components/negocio/sale-cart";
import { DatePicker } from "@/components/ui/date-picker";
import { MONTH_NAMES } from "@/lib/salon/format";
import { isPersonName, sanitizePersonName } from "@/lib/salon/staff-fields";
import { saleInputSchema, type PaymentMethod } from "@/lib/salon/schemas";
import { itemsAreRestricted, staffAfterItemsChange, staffForItems } from "@/lib/salon/staff-for-item";
import { formatPeruPhone } from "@/lib/salon/format";
import type { ContactMatchDto, RegisteredSaleDto, SaleOptionsDto } from "@/lib/salon/types";

/** Código de país fijo (Perú): quien cobra solo escribe los 9 dígitos del celular. */
const PHONE_DIGITS = 9;

const DAY_OPTIONS: SearchSelectOption[] = Array.from({ length: 31 }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1),
}));
const MONTH_OPTIONS: SearchSelectOption[] = MONTH_NAMES.map((m, i) => ({
  value: String(i + 1),
  label: m,
}));

export type SaleDialogInitial = {
  /** La cita que se cobra: al guardar queda como realizada. */
  bookingId?: string;
  contact?: { id: string; name: string } | null;
  staffId?: string | null;
};

/**
 * Módulo SALON — cobrar un servicio o una oferta.
 *
 * Sirve igual desde la caja (venta de mostrador) y desde la agenda (cobrar una
 * cita: el cliente y el profesional llegan ya puestos). Lo cobrado puede
 * diferir del precio de lista, pero a recepción no se le deja editarlo: el monto
 * se llena al elegir el servicio u oferta y queda bloqueado en ese precio.
 *
 * La comisión NO se calcula aquí: la decide el servidor con las reglas del
 * negocio (que quien cobra en el mostrador no tiene por qué ver). El dueño o
 * administrador puede, además, fijar un porcentaje distinto para esta venta.
 */
export function SaleDialog({
  currency,
  canAdjustCommission,
  initial,
  today,
  onClose,
  onSaved,
}: {
  currency: string;
  canAdjustCommission: boolean;
  initial?: SaleDialogInitial;
  /** Hoy en la zona del negocio (AAAA-MM-DD): el día con que arranca la atención. */
  today: string;
  onClose: () => void;
  onSaved: (result: RegisteredSaleDto) => void;
}) {
  const [options, setOptions] = useState<SaleOptionsDto | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  // Una cita que se cobra trae su cliente; en el mostrador se escriben nombre y celular.
  const contact = initial?.contact ?? null;
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [birthdayDay, setBirthdayDay] = useState("");
  const [birthdayMonth, setBirthdayMonth] = useState("");
  // Un contacto (cliente o solo WhatsApp) elegido de las sugerencias: se le cobra a ÉL, sin duplicar su ficha.
  const [picked, setPicked] = useState<ContactMatchDto | null>(null);
  const matches = useContactMatches({
    enabled: !contact && !picked,
    name: customerName,
    phone: customerPhone,
  });
  const [staffId, setStaffId] = useState(initial?.staffId ?? "");
  const [soldOn, setSoldOn] = useState(today);
  const cart = useSaleCart(options, currency, (vals) =>
    // Si quien estaba elegido no da todo lo del carrito, se cambia o se vacía.
    setStaffId((cur) => staffAfterItemsChange(options, vals, cur)),
  );
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [customPct, setCustomPct] = useState("");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch<SaleOptionsDto>("/api/negocio/opciones")
      .then((o) => {
        if (!alive) return;
        setOptions(o);
        // Con un solo profesional no hay nada que elegir.
        setStaffId((cur) => cur || (o.staff.length === 1 ? o.staff[0]!.id : ""));
      })
      .catch((err) => alive && setOptionsError(describeError(err)));
    return () => {
      alive = false;
    };
  }, []);

  function pickContact(m: ContactMatchDto) {
    setPicked(m);
    setErrors({});
    setBirthdayDay(m.birthdayDay != null ? String(m.birthdayDay) : "");
    setBirthdayMonth(m.birthdayMonth != null ? String(m.birthdayMonth) : "");
  }

  function unpick() {
    setPicked(null);
    setCustomerName("");
    setCustomerPhone("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!contact && !picked && customerPhone.length > 0 && customerPhone.length !== PHONE_DIGITS) {
      setErrors({ customerPhone: `El celular debe tener ${PHONE_DIGITS} dígitos` });
      return;
    }

    const parsed = saleInputSchema.safeParse({
      contactId: contact?.id ?? picked?.id ?? null,
      customerName: contact || picked ? null : customerName,
      customerPhone: contact || picked || !customerPhone ? null : `51${customerPhone}`,
      birthdayDay: birthdayDay ? Number(birthdayDay) : null,
      birthdayMonth: birthdayMonth ? Number(birthdayMonth) : null,
      staffId,
      // Hoy se guarda «ahora»; otro día (pasado o futuro) se guarda a ese día.
      soldOn: soldOn && soldOn !== today ? soldOn : null,
      items: cart.payload(),
      bookingId: initial?.bookingId ?? null,
      amountCents: cart.amountCents(),
      paymentMethod: method || undefined,
      customCommissionPercentage:
        canAdjustCommission && customPct.trim() !== "" ? Number(customPct) : null,
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});

    setBusy(true);
    try {
      const result = await apiFetch<RegisteredSaleDto>("/api/negocio/ventas", {
        method: "POST",
        json: parsed.data,
      });
      onSaved(result);
    } catch (err) {
      setFormError(describeError(err));
      setBusy(false);
    }
  }

  // Solo quienes dan lo que se vendió (todos si no se detalló).
  const staffChoices: SearchSelectOption[] = staffForItems(options, cart.values).map((m) => ({
    value: m.id,
    label: m.name,
  }));

  const loading = options === null && !optionsError;
  const noStaff = options !== null && options.staff.length === 0;

  return (
    <Modal
      title={initial?.bookingId ? "Cobrar cita" : "Registrar venta"}
      description="Se calcula la comisión de quien atendió y lo que le queda al negocio."
      onClose={onClose}
      busy={busy}
    >
      {optionsError ? (
        <p role="alert" className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text">
          {optionsError}
        </p>
      ) : loading ? (
        <div className="space-y-3" aria-busy aria-label="Cargando">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-md bg-subtle" />
          ))}
        </div>
      ) : noStaff ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-sm text-text-2">
          Primero da de alta al menos un profesional activo en «Equipo».
        </p>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          {contact || picked ? (
            <Field label="Cliente" htmlFor="sale-customer">
              <div className="flex items-center gap-2 rounded-md border bg-subtle px-3 py-1.5 text-sm">
                <UserRound className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
                <span className="truncate font-medium">{(contact ?? picked)!.name}</span>
                {picked && (
                  <>
                    <span className="shrink-0 text-xs tabular-nums text-text-2">
                      {formatPeruPhone(picked.phone)}
                    </span>
                    <span className="shrink-0 rounded-full border bg-background px-1.5 py-0.5 text-[11px] font-medium">
                      {picked.salonClient ? "Cliente" : "Contacto de WhatsApp"}
                    </span>
                    <button
                      type="button"
                      onClick={unpick}
                      disabled={busy}
                      aria-label="Quitar este cliente y escribir otro"
                      className="ml-auto rounded-sm p-1 text-text-3 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </>
                )}
              </div>
              {picked && !picked.salonClient && (
                <p className="mt-1.5 text-xs text-text-3">
                  Era solo un contacto de WhatsApp: al registrar la venta pasa a ser cliente, sin
                  duplicar su ficha.
                </p>
              )}
            </Field>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Nombre del cliente"
                htmlFor="sale-customer"
                error={errors.customerName}
                hint="Solo letras y espacios"
              >
                <Input
                  id="sale-customer"
                  value={customerName}
                  maxLength={80}
                  autoComplete="off"
                  placeholder="Ej. María Pérez"
                  // Números y signos no se pueden teclear ni pegar.
                  onChange={(e) => {
                    setCustomerName(sanitizePersonName(e.target.value));
                    setErrors((er) => {
                      const { customerName: _gone, ...rest } = er;
                      void _gone;
                      return rest;
                    });
                  }}
                  // El aviso llega al salir del campo con el nombre a medias, no al teclear.
                  onBlur={() => {
                    const t = customerName.trim();
                    if (t && (t.length < 2 || !isPersonName(t)))
                      setErrors((er) => ({
                        ...er,
                        customerName: "El nombre debe tener al menos 2 letras (solo letras y espacios).",
                      }));
                  }}
                  disabled={busy}
                  aria-invalid={!!errors.customerName}
                />
              </Field>
              <Field
                label="Número de celular"
                htmlFor="sale-phone"
                error={errors.customerPhone}
                hint="9 dígitos, solo números."
              >
                <PhoneInput
                  id="sale-phone"
                  digits={customerPhone}
                  onChange={(d) => {
                    setCustomerPhone(d);
                    setErrors((e) => {
                      const { customerPhone: _gone, ...rest } = e;
                      void _gone;
                      return rest;
                    });
                  }}
                  // El aviso llega al salir del campo con el celular a medias, no al teclear.
                  onBlur={() => {
                    if (customerPhone.length > 0 && customerPhone.length < PHONE_DIGITS)
                      setErrors((e) => ({
                        ...e,
                        customerPhone: `El celular debe tener ${PHONE_DIGITS} dígitos`,
                      }));
                  }}
                  disabled={busy}
                  invalid={!!errors.customerPhone}
                />
              </Field>
            </div>
          )}

          {!contact && !picked && (
            <ContactMatchPanel matches={matches} onPick={pickContact} />
          )}


          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">
              Cumpleaños <span className="font-normal text-text-3">(opcional)</span>
            </legend>
            <div className="grid grid-cols-2 gap-3">
              <SearchSelect
                value={birthdayDay}
                onChange={setBirthdayDay}
                options={DAY_OPTIONS}
                placeholder="Elige el día"
                searchPlaceholder="Buscar día…"
                emptyLabel="Sin definir"
                  emptyShowsPlaceholder
                disabled={busy}
              />
              <SearchSelect
                value={birthdayMonth}
                onChange={setBirthdayMonth}
                options={MONTH_OPTIONS}
                placeholder="Elige el mes"
                searchPlaceholder="Buscar mes…"
                emptyLabel="Sin definir"
                  emptyShowsPlaceholder
                disabled={busy}
              />
            </div>
            {(errors.birthdayDay || errors.birthdayMonth) && (
              <p role="alert" className="mt-1.5 text-xs text-danger-text">
                {errors.birthdayDay ?? errors.birthdayMonth}
              </p>
            )}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Atendió" required
              htmlFor="sale-staff"
              error={errors.staffId}
              hint={
                itemsAreRestricted(options, cart.values)
                  ? "Solo los profesionales que dan este servicio u oferta."
                  : undefined
              }
            >
              <SearchSelect
                id="sale-staff"
                value={staffId}
                onChange={setStaffId}
                options={staffChoices}
                placeholder="Elige quién atendió…"
                searchPlaceholder="Buscar profesional…"
                disabled={busy}
                invalid={!!errors.staffId}
              />
            </Field>
            {/* Poner la venta en otro día es del dueño o administrador (la API también lo exige). */}
            {canAdjustCommission && (
              <Field label="Fecha de atención" htmlFor="sale-sold-on" error={errors.soldOn}>
                <DatePicker
                  id="sale-sold-on"
                  value={soldOn}
                  onChange={setSoldOn}
                  disabled={busy}
                  invalid={!!errors.soldOn}
                  className="w-full"
                />
              </Field>
            )}
          </div>

          <SaleItemsField
            cart={cart}
            currency={currency}
            busy={busy}
            error={errors.items ?? errors.serviceId}
            idPrefix="sale"
          />

          <SaleAmountField
            cart={cart}
            currency={currency}
            busy={busy}
            error={errors.amountCents}
            idPrefix="sale"
          />

          <PaymentMethodField method={method} onChange={setMethod} busy={busy} error={errors.paymentMethod} />

          {canAdjustCommission && (
            <CustomCommissionField
              id="sale-pct"
              value={customPct}
              onChange={setCustomPct}
              busy={busy}
              error={errors.customCommissionPercentage}
            />
          )}

          <ModalFooter error={formError}>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Registrando…" : "Registrar venta"}
            </Button>
          </ModalFooter>
        </form>
      )}

      {(optionsError || loading || noStaff) && (
        <ModalFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </ModalFooter>
      )}
    </Modal>
  );
}
