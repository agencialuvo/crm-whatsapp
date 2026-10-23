"use client";

import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";
import { apiFetch, describeError } from "@/components/negocio/api";
import { ContactMatchPanel, useContactMatches } from "@/components/negocio/contact-match";
import { Field, fieldErrors } from "@/components/negocio/fields";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import {
  CustomCommissionField,
  SaleAmountField,
  SaleItemsField,
  useSaleCart,
} from "@/components/negocio/sale-cart";
import { centsToInput, formatPeruPhone, wallClockInTz } from "@/lib/salon/format";
import { saleEditSchema } from "@/lib/salon/schemas";
import { staffForItems } from "@/lib/salon/staff-for-item";
import type { ContactMatchDto, SaleOptionsDto, SaleRowDto } from "@/lib/salon/types";

/**
 * Módulo SALON — «Editar venta» (solo dueño/administrador): corrige los ítems
 * vendidos, quién atendió, el monto cobrado, el cliente y la fecha y hora. El
 * método de pago no cambia. El servidor guarda la venta antes y después (quién y
 * cuándo) y la ficha del cliente y el Panel se actualizan solos.
 */
export function SaleEditDialog({
  sale,
  currency,
  timezone,
  onClose,
  onSaved,
}: {
  sale: SaleRowDto;
  currency: string;
  /** Zona del negocio: la fecha y la hora se leen y se escriben en ella. */
  timezone: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [options, setOptions] = useState<SaleOptionsDto | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [staffId, setStaffId] = useState(sale.staffId);
  const [customPct, setCustomPct] = useState("");
  const initialAt = wallClockInTz(sale.createdAt, timezone);
  const [soldOn, setSoldOn] = useState(initialAt.date);
  const [soldTime, setSoldTime] = useState(initialAt.time);
  // Otro cliente: se busca por nombre o celular entre los contactos.
  const [pickedClient, setPickedClient] = useState<ContactMatchDto | null>(null);
  const [changingClient, setChangingClient] = useState(false);
  const [clientQuery, setClientQuery] = useState("");
  const matches = useContactMatches({
    enabled: changingClient && !pickedClient,
    name: /^\d/.test(clientQuery.trim()) ? "" : clientQuery,
    phone: /^\d/.test(clientQuery.trim()) ? clientQuery.replace(/\D/g, "").replace(/^51(?=\d{9})/, "") : "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // La venta tal como está: sus ítems (con su detalle si son «Otro») y su monto cobrado.
  const cart = useSaleCart(options, currency, undefined, {
    lines: sale.items.map((i) => ({
      value: i.other ? "other" : i.comboId ? `combo:${i.comboId}` : `service:${i.serviceId}`,
      price: i.other ? centsToInput(i.amountCents) : "",
      note: i.note ?? "",
    })),
    amount: centsToInput(sale.amountCents),
    extra: sale.items
      .filter((i) => !i.other)
      .map((i) => ({
        value: i.comboId ? `combo:${i.comboId}` : `service:${i.serviceId}`,
        label: i.name,
        group: i.comboId ? "Ofertas" : "Servicios",
        priceCents: i.amountCents,
      })),
  });

  useEffect(() => {
    let alive = true;
    apiFetch<SaleOptionsDto>("/api/negocio/opciones")
      .then((o) => alive && setOptions(o))
      .catch((err) => alive && setOptionsError(describeError(err)));
    return () => {
      alive = false;
    };
  }, []);

  // El profesional actual siempre se puede dejar, aunque hoy esté inactivo o ya no dé algo del carrito.
  const staffChoices: SearchSelectOption[] = [
    ...staffForItems(options, cart.values),
    ...(options && !options.staff.some((m) => m.id === sale.staffId)
      ? [{ id: sale.staffId, name: sale.staffName }]
      : []),
  ]
    .filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i)
    .map((m) => ({ value: m.id, label: m.name }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = saleEditSchema.safeParse({
      items: cart.payload(),
      staffId,
      amountCents: cart.amountCents(),
      customCommissionPercentage: customPct.trim() !== "" ? Number(customPct) : null,
      contactId: pickedClient?.id ?? null,
      soldOn: soldOn || null,
      soldTime: soldTime || null,
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await apiFetch(`/api/negocio/ventas/${sale.id}`, { method: "PUT", json: parsed.data });
      onSaved();
    } catch (err) {
      setFormError(describeError(err));
      setBusy(false);
    }
  }

  const loading = options === null && !optionsError;

  return (
    <Modal
      title="Editar venta"
      description={`Venta de ${pickedClient?.name ?? sale.customerName}. Cada cambio queda registrado: la venta anterior, la nueva, quién y cuándo.`}
      onClose={onClose}
      busy={busy}
    >
      {optionsError ? (
        <p
          role="alert"
          className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text"
        >
          {optionsError}
        </p>
      ) : loading ? (
        <div className="space-y-3" aria-busy aria-label="Cargando">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-md bg-subtle" />
          ))}
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          <Field label="Cliente" htmlFor="sale-edit-client" error={errors.contactId}>
            <div className="space-y-2">
              <div className="flex items-center gap-2 rounded-md border bg-subtle px-3 py-1.5 text-sm">
                <UserRound className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
                <span className="truncate font-medium">{pickedClient?.name ?? sale.customerName}</span>
                {pickedClient && (
                  <span className="shrink-0 text-xs tabular-nums text-text-2">
                    {formatPeruPhone(pickedClient.phone)}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7"
                  disabled={busy}
                  onClick={() => {
                    setChangingClient((v) => !v);
                    setClientQuery("");
                  }}
                >
                  {changingClient ? "Cancelar cambio" : "Cambiar cliente"}
                </Button>
              </div>
              {changingClient && (
                <>
                  <Input
                    id="sale-edit-client"
                    value={clientQuery}
                    maxLength={80}
                    autoComplete="off"
                    placeholder="Busca por nombre o celular…"
                    onChange={(e) => {
                      setClientQuery(e.target.value);
                      setPickedClient(null);
                    }}
                    disabled={busy}
                  />
                  <ContactMatchPanel
                    matches={matches}
                    onPick={(m) => {
                      setPickedClient(m);
                      setChangingClient(false);
                      setClientQuery("");
                    }}
                  />
                </>
              )}
              {!changingClient && pickedClient && pickedClient.id !== sale.contactId && (
                <p className="text-xs text-text-3">
                  La venta pasará a este cliente{pickedClient.salonClient ? "" : " (hasta ahora solo un contacto de WhatsApp: pasa a ser cliente)"}.
                </p>
              )}
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Fecha de atención" required htmlFor="sale-edit-sold-on" error={errors.soldOn}>
              <DatePicker
                id="sale-edit-sold-on"
                value={soldOn}
                onChange={setSoldOn}
                disabled={busy}
                invalid={!!errors.soldOn}
                className="w-full"
              />
            </Field>
            <Field label="Hora" required htmlFor="sale-edit-sold-time" error={errors.soldTime}>
              <Input
                id="sale-edit-sold-time"
                type="time"
                value={soldTime}
                onChange={(e) => setSoldTime(e.target.value)}
                disabled={busy}
                aria-invalid={!!errors.soldTime}
              />
            </Field>
          </div>

          <Field label="Atendió" required htmlFor="sale-edit-staff" error={errors.staffId}>
            <SearchSelect
              id="sale-edit-staff"
              value={staffId}
              onChange={setStaffId}
              options={staffChoices}
              placeholder="Elige quién atendió…"
              searchPlaceholder="Buscar profesional…"
              disabled={busy}
              invalid={!!errors.staffId}
            />
          </Field>

          <SaleItemsField
            cart={cart}
            currency={currency}
            busy={busy}
            error={errors.items ?? errors.serviceId}
            idPrefix="sale-edit"
          />

          <SaleAmountField
            cart={cart}
            currency={currency}
            busy={busy}
            error={errors.amountCents}
            idPrefix="sale-edit"
          />

          <CustomCommissionField
            id="sale-edit-pct"
            value={customPct}
            onChange={setCustomPct}
            busy={busy}
            error={errors.customCommissionPercentage}
          />

          <ModalFooter error={formError}>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Guardando…" : "Guardar cambios"}
            </Button>
          </ModalFooter>
        </form>
      )}

      {(optionsError || loading) && (
        <ModalFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </ModalFooter>
      )}
    </Modal>
  );
}
