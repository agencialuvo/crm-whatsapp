"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, describeError } from "@/components/negocio/api";
import { MediaImageField, type ImagenElegida } from "@/components/medios/media-picker";
import { DurationInput, Field, fieldErrors, MoneyInput, toInt } from "@/components/negocio/fields";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { StaffSelect, staffIdsToSend, type StaffOption } from "@/components/negocio/staff-select";
import { parseMoneyToCents } from "@/lib/money";
import { centsToInput } from "@/lib/salon/format";
import { comboInputSchema, normalizeKeyword } from "@/lib/salon/schemas";
import type { ComboDto } from "@/lib/salon/types";

/**
 * Módulo SALON — alta y edición de una oferta de publicidad pagada.
 *
 * La palabra clave se muestra NORMALIZADA mientras se escribe (MAYÚSCULAS, sin
 * acentos, espacios como «_»): lo que se ve es exactamente lo que se guarda, y
 * dos ofertas no pueden compartirla (la base lo impide; el 409 se muestra aquí).
 */
export function ComboDialog({
  item,
  currency,
  staff,
  onClose,
  onSaved,
}: {
  item: ComboDto | null;
  currency: string;
  /** Todo el equipo, para elegir quién lo da. */
  staff: StaffOption[];
  onClose: () => void;
  onSaved: (combo: ComboDto) => void;
}) {
  const [image, setImage] = useState<ImagenElegida | null>(
    item?.imageMediaId && item.imageUrl ? { id: item.imageMediaId, url: item.imageUrl } : null
  );
  const [name, setName] = useState(item?.name ?? "");
  // Sin detallar (lo normal) lo dan todos; con la casilla se eligen uno por uno.
  const [staffEnabled, setStaffEnabled] = useState((item?.staffIds.length ?? 0) > 0);
  const [staffSelected, setStaffSelected] = useState<string[]>(item?.staffIds ?? []);
  const [description, setDescription] = useState(item?.description ?? "");
  const [price, setPrice] = useState(item ? centsToInput(item.priceCents) : "");
  const [duration, setDuration] = useState(String(item?.durationMinutes ?? 60));
  const [keyword, setKeyword] = useState(item?.keywordTrigger ?? "");
  const [active, setActive] = useState(item?.active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const staffToSend = staffIdsToSend(staffEnabled, staffSelected);

    const parsed = comboInputSchema.safeParse({
      name,
      description,
      priceCents: parseMoneyToCents(price) ?? Number.NaN,
      durationMinutes: toInt(duration),
      keywordTrigger: keyword,
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
      const url = item ? `/api/negocio/ofertas/${item.id}` : "/api/negocio/ofertas";
      const { combo } = await apiFetch<{ combo: ComboDto }>(url, {
        method: item ? "PATCH" : "POST",
        json: parsed.data,
      });
      onSaved(combo);
    } catch (err) {
      setFormError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={item ? "Editar oferta" : "Nueva oferta"}
      description="Una oferta de publicidad pagada: varios servicios por un precio."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <MediaImageField
          id="cmb-image"
          value={image}
          onChange={setImage}
          disabled={busy}
          error={errors.imageMediaId}
        />

        <Field label="Nombre" required htmlFor="cmb-name" error={errors.name}>
          <Input
            id="cmb-name"
            value={name}
            maxLength={80}
            placeholder="Oferta Fresh"
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

        <Field label="Qué incluye" required htmlFor="cmb-desc" error={errors.description}>
          <Textarea
            id="cmb-desc"
            rows={3}
            value={description}
            maxLength={500}
            placeholder="Corte, mascarilla negra y masaje de cuello"
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Precio de la oferta" required htmlFor="cmb-price" error={errors.priceCents}>
            <MoneyInput
              id="cmb-price"
              value={price}
              onChange={setPrice}
              currency={currency}
              disabled={busy}
              invalid={!!errors.priceCents}
            />
          </Field>
          <Field
            label="Duración" required
            htmlFor="cmb-duration"
            error={errors.durationMinutes}
            hint="Horas y minutos: 01:00 es una hora."
          >
            <DurationInput
              id="cmb-duration"
              minutes={duration}
              onChange={setDuration}
              disabled={busy}
              invalid={!!errors.durationMinutes}
            />
          </Field>
        </div>

        <Field
          label="Palabra clave del anuncio (opcional)"
          htmlFor="cmb-keyword"
          error={errors.keywordTrigger}
          hint={
            keyword.trim()
              ? `Se guardará como: ${normalizeKeyword(keyword) || "—"}`
              : "El texto que trae el mensaje desde Meta o TikTok, p. ej. OFERTA_FRESH. Única por oferta."
          }
        >
          <Input
            id="cmb-keyword"
            value={keyword}
            maxLength={60}
            placeholder="COMBO_FRESH"
            autoCapitalize="characters"
            className="font-mono"
            onChange={(e) => setKeyword(e.target.value)}
            disabled={busy}
          />
        </Field>

        <div className="flex items-center justify-between rounded-md border bg-subtle px-3 py-2.5">
          <div>
            <p className="text-sm font-medium">Oferta vigente</p>
            <p className="text-xs text-text-3">Una oferta desactivada no aparece en la caja.</p>
          </div>
          <Switch checked={active} onCheckedChange={setActive} label="Oferta activa" disabled={busy} />
        </div>

        <ModalFooter error={formError}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Guardando…" : item ? "Guardar cambios" : "Crear oferta"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
