"use client";

import { useEffect, useState } from "react";
import { Cake, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { birthdayAllowsItems, restrictedServices, stampsAllowItems, type LoyaltyCardViewDto } from "@/lib/loyalty";
import { isBirthdayMonth } from "@/lib/salon/insights";
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
  contact?: { id: string; name: string; birthdayDay?: number | null; birthdayMonth?: number | null } | null;
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
  const [birthdayDiscount, setBirthdayDiscount] = useState(false);
  // El descuento se ofrece durante TODO el mes de cumpleaños del cliente (el de la fecha de atención).
  // Si escribió el celular completo de un cliente ya registrado sin tocar la sugerencia, el
  // cobro se le hace a ÉL (el servidor lo reconoce por el celular): se usa su cumpleaños.
  const sameNumber =
    !contact && !picked && customerPhone.length === PHONE_DIGITS
      ? matches.find((m) => m.phone.replace(/\D/g, "").endsWith(customerPhone))
      : undefined;
  const campaign = options?.birthday;
  // A quién se le cobra (para consultar lo suyo: uso del beneficio y premios).
  const resolvedContactId = contact?.id ?? picked?.id ?? sameNumber?.id ?? null;
  const soldYear = Number(soldOn.slice(0, 4)) || new Date().getFullYear();
  // Los ítems del carrito: un servicio o una oferta tienen id; «Otro», no.
  const cartItems = cart.values.map((v) => ({
    serviceId: v.startsWith("service:") ? v.slice(8) : null,
    comboId: v.startsWith("combo:") ? v.slice(6) : null,
  }));
  // El interruptor se ofrece con la campaña encendida, en el mes de cumpleaños del cliente y si NO lo usó ya
  // este año (es de una vez por año). Qué servicios admite se avisa al activarlo, no se esconde (Ajustes →
  // Marketing → Campaña de cumpleaños).
  const monthOk =
    !!campaign?.enabled &&
    isBirthdayMonth(
      contact ? contact.birthdayMonth : sameNumber ? sameNumber.birthdayMonth : Number(birthdayMonth) || null,
      soldOn
    );
  const usageKey = resolvedContactId ? `${resolvedContactId}:${soldYear}` : "";
  const [usage, setUsage] = useState<{ key: string; used: boolean } | null>(null);
  useEffect(() => {
    if (!monthOk || !resolvedContactId) return;
    let alive = true;
    apiFetch<{ used: boolean }>(
      `/api/negocio/cumpleanos/uso?contactId=${encodeURIComponent(resolvedContactId)}&year=${soldYear}`
    )
      .then((r) => alive && setUsage({ key: usageKey, used: r.used }))
      // Sin poder consultarlo no se ofrece: el servidor igual lo decide al cobrar.
      .catch(() => alive && setUsage({ key: usageKey, used: true }));
    return () => {
      alive = false;
    };
  }, [monthOk, resolvedContactId, soldYear, usageKey]);
  // Un cliente de mostrador sin ficha todavía no pudo usarlo; con ficha, se espera a saberlo.
  const alreadyUsed = resolvedContactId ? usage?.key !== usageKey || usage.used : false;
  const isBirthday = monthOk && !alreadyUsed;
  const birthdayList = campaign?.serviceIds ?? [];
  const birthdayViolates = cartItems.length > 0 && !birthdayAllowsItems(birthdayList, cartItems);

  const namesOf = (ids: string[]) =>
    [...(options?.services ?? []), ...(options?.combos ?? [])].filter((x) => ids.includes(x.id)).map((x) => x.name);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const birthdayAlert = () =>
    `El descuento de cumpleaños solo aplica para los siguientes servicios: ${namesOf(birthdayList).join(", ") || "los que configuró el negocio"}.`;

  // Premios de la tarjeta que se pueden canjear en esta venta.
  const [cardInfo, setCardInfo] = useState<{ contactId: string; view: LoyaltyCardViewDto } | null>(null);
  useEffect(() => {
    if (!resolvedContactId) return;
    let alive = true;
    apiFetch<LoyaltyCardViewDto>(`/api/loyalty/card?contactId=${encodeURIComponent(resolvedContactId)}`)
      .then((v) => alive && setCardInfo({ contactId: resolvedContactId, view: v }))
      .catch(() => alive && setCardInfo(null));
    return () => {
      alive = false;
    };
  }, [resolvedContactId]);
  const rewards =
    resolvedContactId && cardInfo?.contactId === resolvedContactId && cardInfo.view.settings.enabled
      ? cardInfo.view.availableMilestones
      : [];
  const [redeemStamps, setRedeemStamps] = useState("");
  const redeeming = rewards.find((m) => String(m.stamps) === redeemStamps) ?? null;
  const rewardAlert = (m: { serviceIds?: string[]; serviceIdRestriction?: string }) =>
    `Este premio solo se puede canjear en: ${namesOf(restrictedServices(m)).join(", ") || "los servicios que configuró el negocio"}.`;
  const rewardViolates = (m: { serviceIds?: string[]; serviceIdRestriction?: string } | null) =>
    !!m && restrictedServices(m).length > 0 && cartItems.length > 0 && !stampsAllowItems(restrictedServices(m), cartItems);

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
    // El cumpleaños era de quien se soltó: no se arrastra al siguiente cliente.
    setBirthdayDay("");
    setBirthdayMonth("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!contact && !picked && customerPhone.length > 0 && customerPhone.length !== PHONE_DIGITS) {
      setErrors({ customerPhone: `El celular debe tener ${PHONE_DIGITS} dígitos` });
      return;
    }

    if (birthdayDiscount && isBirthday && birthdayViolates) {
      setAlertMsg(birthdayAlert());
      return;
    }
    if (redeeming && rewardViolates(redeeming)) {
      setAlertMsg(rewardAlert(redeeming));
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
      ...(birthdayDiscount && isBirthday && { birthdayDiscount: true }),
      ...(redeeming && !birthdayDiscount && { redeemMilestoneStamps: redeeming.stamps }),
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
    <>
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
            // Con el descuento de cumpleaños activo solo se ofrece lo que él admite.
            allow={
              birthdayDiscount && isBirthday && birthdayList.length > 0
                ? (v) => birthdayAllowsItems(birthdayList, [{
                    serviceId: v.startsWith("service:") ? v.slice(8) : null,
                    comboId: v.startsWith("combo:") ? v.slice(6) : null,
                  }])
                : undefined
            }
          />

          <SaleAmountField
            cart={cart}
            currency={currency}
            busy={busy}
            error={errors.amountCents}
            idPrefix="sale"
          />

          <PaymentMethodField method={method} onChange={setMethod} busy={busy} error={errors.paymentMethod} />

          {isBirthday && (
          <div
            className={
              "rounded-md border px-3 py-2.5 transition-colors " +
              (birthdayDiscount ? "border-warning-soft bg-warning-tint" : "bg-subtle/50")
            }
          >
            <div className="flex items-start gap-3">
              <Cake className="mt-0.5 h-4 w-4 shrink-0 text-text-3" aria-hidden />
              <div className="min-w-0 flex-1 text-sm">
                <span className="font-medium">Aplicar {campaign?.percentage ?? 20}% de descuento de cumpleaños</span>
                <span className="block text-xs text-text-3">No suma sello</span>
              </div>
              <Switch
                size="sm"
                checked={birthdayDiscount}
                onCheckedChange={(on) => {
                  // Activarlo con algo no permitido en la venta avisa, sin quitar nada: el cajero corrige.
                  if (on && birthdayViolates) {
                    setAlertMsg(birthdayAlert());
                    return;
                  }
                  setBirthdayDiscount(on);
                  if (on) setRedeemStamps("");
                }}
                disabled={busy}
                label={`Aplicar ${campaign?.percentage ?? 20}% de descuento de cumpleaños (no suma sello)`}
              />
            </div>
            {birthdayDiscount && (
              <p className="mt-2 text-xs text-warning-text" role="status">
                Esta venta protege el margen del negocio: queda anotada en la tarjeta de fidelidad como
                «Cumpleaños» y no acumula sello.
              </p>
            )}
          </div>
          )}

          {rewards.length > 0 && (
            <div className="rounded-md border bg-subtle/50 px-3 py-2.5">
              <Label htmlFor="sale-redeem">Canjear un premio de fidelidad (opcional)</Label>
              <SearchSelect
                id="sale-redeem"
                value={redeemStamps}
                onChange={(v) => {
                  const m = rewards.find((r) => String(r.stamps) === v) ?? null;
                  // Un premio restringido solo se canjea sobre lo permitido: se avisa y no se elige.
                  if (m && rewardViolates(m)) {
                    setAlertMsg(rewardAlert(m));
                    return;
                  }
                  setRedeemStamps(v);
                  if (v) setBirthdayDiscount(false);
                }}
                options={rewards.map((m) => ({ value: String(m.stamps), label: `${m.title} (${m.stamps} sellos)` }))}
                emptyLabel="Sin canje"
                emptyShowsPlaceholder
                placeholder="Sin canje"
                searchPlaceholder="Buscar premio…"
                disabled={busy}
                triggerClassName="mt-1.5 bg-card px-2"
              />
              {redeeming && (
                <p className="mt-2 text-xs text-text-2" role="status">
                  Se descuentan {redeeming.stamps} sellos de la tarjeta. Ajusta el monto cobrado a mano según el premio;
                  esta venta no suma sello.
                </p>
              )}
            </div>
          )}

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
    {alertMsg && (
      <Modal title="No aplica para esta venta" size="sm" onClose={() => setAlertMsg(null)}>
        <p role="alert" className="text-sm text-text-2">
          {alertMsg}
        </p>
        <ModalFooter>
          <Button type="button" onClick={() => setAlertMsg(null)}>
            Entendido
          </Button>
        </ModalFooter>
      </Modal>
    )}
    </>
  );
}
