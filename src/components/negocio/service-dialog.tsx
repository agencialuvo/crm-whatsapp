"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { clampPercent } from "@/lib/percent";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { apiFetch, describeError } from "@/components/negocio/api";
import { MediaImageField, type ImagenElegida } from "@/components/medios/media-picker";
import { DurationInput, Field, fieldErrors, MoneyInput, toInt } from "@/components/negocio/fields";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { StaffSelect, staffIdsToSend, type StaffOption } from "@/components/negocio/staff-select";
import { parseMoneyToCents } from "@/lib/money";
import { centsToInput } from "@/lib/salon/format";
import { serviceInputSchema, type PriceMode } from "@/lib/salon/schemas";
import type { ServiceDto } from "@/lib/salon/types";

/**
 * Módulo SALON — alta y edición de un servicio. Valida con el MISMO esquema
 * Zod que la API: lo que este formulario deja pasar es lo que el servidor
 * acepta; si el servidor rechaza algo (p. ej. un nombre repetido a futuro), el
 * mensaje aparece en el diálogo sin perder lo escrito.
 */
export function ServiceDialog({
  item,
  currency,
  staff,
  onClose,
  onSaved,
}: {
  item: ServiceDto | null;
  currency: string;
  /** Todo el equipo, para elegir quién lo da. */
  staff: StaffOption[];
  onClose: () => void;
  onSaved: (service: ServiceDto) => void;
}) {
  const [image, setImage] = useState<ImagenElegida | null>(
    item?.imageMediaId && item.imageUrl ? { id: item.imageMediaId, url: item.imageUrl } : null
  );
  const [name, setName] = useState(item?.name ?? "");
  // Sin detallar (lo normal) lo dan todos; con la casilla se eligen uno por uno.
  const [staffEnabled, setStaffEnabled] = useState((item?.staffIds.length ?? 0) > 0);
  const [staffSelected, setStaffSelected] = useState<string[]>(item?.staffIds ?? []);
  const [description, setDescription] = useState(item?.description ?? "");
  const [priceMode, setPriceMode] = useState<PriceMode>(item?.priceMode ?? "fixed");
  // Con precio variable el precio es solo una referencia; en 0 (sin referencia) el campo queda vacío.
  const [price, setPrice] = useState(item && !(item.priceMode === "variable" && item.priceCents === 0) ? centsToInput(item.priceCents) : "");
  const [duration, setDuration] = useState(item?.durationMinutes != null ? String(item.durationMinutes) : "");
  const [commission, setCommission] = useState(item?.defaultCommissionPercentage?.toString() ?? "");
  const [active, setActive] = useState(item?.active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const staffToSend = staffIdsToSend(staffEnabled, staffSelected);

    const cents = parseMoneyToCents(price);
    const variable = priceMode === "variable";
    const parsed = serviceInputSchema.safeParse({
      name,
      description,
      // Variable: el precio es opcional (referencia); vacío = 0.
      priceCents: variable && price.trim() === "" ? 0 : (cents ?? Number.NaN),
      priceMode,
      durationMinutes: duration.trim() === "" ? null : toInt(duration),
      defaultCommissionPercentage: commission.trim() === "" ? null : toInt(commission),
      active,
      imageMediaId: image?.id ?? null,
      staffIds: staffToSend.staffIds,
    });
    if (!parsed.success || staffToSend.error) {
      setErrors({
        ...(parsed.success ? {} : fieldErrors(parsed.error.issues)),
        ...(staffToSend.error ? { staffIds: staffToSend.error } : {}),
      });
      return;
    }
    setErrors({});

    setBusy(true);
    try {
      const url = item ? `/api/negocio/servicios/${item.id}` : "/api/negocio/servicios";
      const { service } = await apiFetch<{ service: ServiceDto }>(url, {
        method: item ? "PATCH" : "POST",
        json: parsed.data,
      });
      onSaved(service);
    } catch (err) {
      setFormError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={item ? "Editar servicio" : "Nuevo servicio"}
      description="Lo que ofreces en el mostrador, con su precio y cuánto tarda."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <MediaImageField
          id="srv-image"
          value={image}
          onChange={setImage}
          disabled={busy}
          error={errors.imageMediaId}
        />

        <Field label="Nombre" required htmlFor="srv-name" error={errors.name}>
          <Input
            id="srv-name"
            value={name}
            maxLength={80}
            placeholder="Corte clásico"
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </Field>

        <StaffSelect
          staff={staff}
          enabled={staffEnabled}
          onEnabledChange={setStaffEnabled}
          selected={staffSelected}
          onChange={setStaffSelected}
          disabled={busy}
          error={errors.staffIds}
        />

        <Field label="Descripción (opcional)" htmlFor="srv-desc" error={errors.description}>
          <Textarea
            id="srv-desc"
            rows={2}
            value={description}
            maxLength={500}
            placeholder="Incluye lavado y peinado"
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
          />
        </Field>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Tipo de precio</legend>
          <div role="radiogroup" aria-label="Tipo de precio" className="grid grid-cols-2 gap-2">
            {(
              [
                ["fixed", "Precio fijo"],
                ["variable", "Precio variable"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={priceMode === mode}
                disabled={busy}
                onClick={() => setPriceMode(mode)}
                className={cn(
                  "rounded-md border px-2 py-2 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  priceMode === mode
                    ? "border-brand bg-brand-tint text-brand-text"
                    : "text-text-2 hover:bg-accent hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-text-3">
            {priceMode === "variable"
              ? "El monto se escribe al cobrar, y el agente responde «Precio a consultar» en vez de un precio."
              : "Siempre se cobra este precio."}
          </p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={priceMode === "variable" ? "Precio de referencia (opcional)" : "Precio"}
            required={priceMode !== "variable"}
            htmlFor="srv-price"
            error={errors.priceCents}
          >
            <MoneyInput
              id="srv-price"
              value={price}
              onChange={setPrice}
              currency={currency}
              disabled={busy}
              invalid={!!errors.priceCents}
            />
          </Field>
          <Field
            label="Duración (opcional)"
            htmlFor="srv-duration"
            error={errors.durationMinutes}
            hint="Horas y minutos: 00:30 es media hora."
          >
            <DurationInput
              id="srv-duration"
              minutes={duration}
              onChange={setDuration}
              disabled={busy}
              invalid={!!errors.durationMinutes}
            />
          </Field>
        </div>

        <Field
          label="Comisión por defecto (% opcional)"
          htmlFor="srv-commission"
          error={errors.defaultCommissionPercentage}
          hint="Opcional. Lo que se queda quien atiende, si no tiene un porcentaje propio. Vacío: sin comisión."
        >
          <Input
            id="srv-commission"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            value={commission}
            onChange={(e) => setCommission(clampPercent(e.target.value))}
            disabled={busy}
          />
        </Field>

        <div className="flex items-center justify-between rounded-md border bg-subtle px-3 py-2.5">
          <div>
            <p className="text-sm font-medium">Disponible para cobrar</p>
            <p className="text-xs text-text-3">Un servicio desactivado no aparece en la caja.</p>
          </div>
          <Switch checked={active} onCheckedChange={setActive} label="Servicio activo" disabled={busy} />
        </div>

        <ModalFooter error={formError}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Guardando…" : item ? "Guardar cambios" : "Crear servicio"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
