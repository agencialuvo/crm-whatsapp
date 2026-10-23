"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { MediaImageField, type ImagenElegida } from "@/components/medios/media-picker";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Field, fieldErrors, PhoneInput } from "@/components/negocio/fields";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { DEFAULT_COMMISSION_PERCENTAGE } from "@/lib/salon/commission";
import { staffInputSchema } from "@/lib/salon/schemas";
import { phoneToDigits, sanitizePersonName, STAFF_PHONE_DIGITS } from "@/lib/salon/staff-fields";
import type { StaffDto } from "@/lib/salon/types";

/**
 * Módulo SALON — alta y edición de un profesional (barbero, esteticista,
 * manicurista). La comisión nace en 50 % y se puede vaciar: sin porcentaje
 * propio manda el del servicio. Su horario y las comisiones por servicio se
 * configuran después, en el otro diálogo.
 *
 * Campos estrictos, igual que en la API: el nombre solo lleva letras y espacios
 * (lo demás no se puede teclear) y el celular son exactamente 9 dígitos, con el
 * +51 de Perú fijo. Qué servicios da cada uno se elige desde el servicio, no aquí.
 */
export function StaffDialog({
  item,
  onClose,
  onSaved,
}: {
  item: StaffDto | null;
  onClose: () => void;
  onSaved: (staff: StaffDto) => void;
}) {
  const [image, setImage] = useState<ImagenElegida | null>(
    item?.imageMediaId && item.imageUrl ? { id: item.imageMediaId, url: item.imageUrl } : null
  );
  const [name, setName] = useState(item?.name ?? "");
  // Lo guardado antes en otro formato (con espacios, +51…) se lleva a sus 9 dígitos.
  const [phone, setPhone] = useState(() => {
    const digits = phoneToDigits(item?.phone);
    return digits.length > STAFF_PHONE_DIGITS ? digits.slice(-STAFF_PHONE_DIGITS) : digits;
  });
  const [commission, setCommission] = useState(
    item ? (item.globalCommissionPercentage?.toString() ?? "") : String(DEFAULT_COMMISSION_PERCENTAGE)
  );
  const [active, setActive] = useState(item?.active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = staffInputSchema.safeParse({
      name,
      phone,
      active,
      globalCommissionPercentage: commission.trim() === "" ? null : Number(commission),
      imageMediaId: image?.id ?? null,
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});

    setBusy(true);
    try {
      const url = item ? `/api/negocio/equipo/${item.id}` : "/api/negocio/equipo";
      const { staff } = await apiFetch<{ staff: StaffDto }>(url, {
        method: item ? "PATCH" : "POST",
        json: parsed.data,
      });
      onSaved(staff);
    } catch (err) {
      setFormError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={item ? "Editar profesional" : "Nuevo profesional"}
      description="Quien atiende a los clientes y recibe una comisión por cada servicio."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <MediaImageField
          id="stf-image"
          label="Foto (opcional)"
          value={image}
          onChange={setImage}
          disabled={busy}
          error={errors.imageMediaId}
        />

        <Field
          label="Nombre" required
          htmlFor="stf-name"
          error={errors.name}
          hint="Solo letras y espacios."
        >
          <Input
            id="stf-name"
            value={name}
            maxLength={80}
            placeholder="Carlos Mendoza"
            autoComplete="off"
            // Números y signos no se pueden teclear ni pegar.
            onChange={(e) => setName(sanitizePersonName(e.target.value))}
            disabled={busy}
            aria-invalid={!!errors.name || undefined}
          />
        </Field>

        <Field
          label="Celular"
          htmlFor="stf-phone"
          error={errors.phone}
          hint="Opcional. Si lo pones, son 9 dígitos, solo números."
        >
          <PhoneInput
            id="stf-phone"
            digits={phone}
            onChange={setPhone}
            disabled={busy}
            invalid={!!errors.phone}
          />
        </Field>

        <Field
          label="Comisión (%)"
          htmlFor="stf-commission"
          error={errors.globalCommissionPercentage}
          hint="Lo que se queda por cada servicio. Vacío: manda el porcentaje del servicio."
        >
          <Input
            id="stf-commission"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            value={commission}
            onChange={(e) => setCommission(e.target.value)}
            disabled={busy}
          />
        </Field>

        <div className="flex items-center justify-between rounded-md border bg-subtle px-3 py-2.5">
          <div>
            <p className="text-sm font-medium">Atiende clientes</p>
            <p className="text-xs text-text-3">
              Inactivo: no aparece en la agenda ni en la caja, y se conserva su historial.
            </p>
          </div>
          <Switch checked={active} onCheckedChange={setActive} label="Profesional activo" disabled={busy} />
        </div>

        <ModalFooter error={formError}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Guardando…" : item ? "Guardar cambios" : "Dar de alta"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
