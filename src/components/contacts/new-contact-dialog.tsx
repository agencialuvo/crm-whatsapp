"use client";

import { useEffect, useState } from "react";
import type { SourceValue, StageDto } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DialogCloseButton } from "@/components/ui/dialog-close";
import { SearchSelect } from "@/components/ui/search-select";
import { PhoneInput } from "@/components/negocio/fields";
import { isPersonName, sanitizePersonName, STAFF_PHONE_DIGITS } from "@/lib/salon/staff-fields";

const SOURCES: { value: SourceValue; label: string }[] = [
  { value: "referido", label: "Referido" },
  { value: "organico", label: "Contenido orgánico" },
  { value: "conocido", label: "Conocido" },
  { value: "anuncio", label: "Anuncio" },
  { value: "otro", label: "Otro" },
];

/**
 * Alta manual de un prospecto que no llegó por WhatsApp.
 * El celular es obligatorio porque ES la identidad en WhatsApp: sin él, el
 * contacto no podría recibir ni mandar nada, y sería una ficha muerta.
 *
 * Validación en vivo: el nombre solo admite letras y espacios (lo demás no se
 * puede teclear ni pegar) y el celular son exactamente 9 dígitos con el +51 de
 * Perú fijo, que se escribe «921 926 452» y se envía como `51921926452`.
 */
export function NewContactDialog({
  onClose,
  onCreated,
  onOpenExisting,
}: {
  onClose: () => void;
  onCreated: () => void;
  /** Duplicado: en vez de un error seco, se ofrece ir a quien ya existe. */
  onOpenExisting: (contactId: string) => void;
}) {
  const [name, setName] = useState("");
  // Solo los 9 dígitos; el +51 va fijo en pantalla.
  const [phone, setPhone] = useState("");
  const [touched, setTouched] = useState({ name: false, phone: false });
  const [source, setSource] = useState<SourceValue>("referido");
  const [notes, setNotes] = useState("");
  const [stages, setStages] = useState<StageDto[]>([]);
  const [stageId, setStageId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicado, setDuplicado] = useState<{ id: string; name: string } | null>(
    null
  );

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/pipeline/stages").catch(() => null);
      if (!res?.ok) return;
      const data = (await res.json()) as { stages: StageDto[] };
      const abiertas = data.stages.filter((s) => s.kind === "open");
      setStages(abiertas);
      setStageId(abiertas[0]?.id ?? "");
    })();
  }, []);

  async function guardar() {
    // Con algo mal, el botón no está apagado: al pulsarlo se muestran los avisos.
    if (!listo) {
      setTouched({ name: true, phone: true });
      return;
    }
    setSaving(true);
    setError(null);
    setDuplicado(null);
    const res = await fetch("/api/contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        phone: `51${phone}`,
        source,
        notes: notes.trim() || undefined,
        stageId: stageId || undefined,
      }),
    }).catch(() => null);
    setSaving(false);

    if (!res) {
      setError("No se pudo guardar. Revisa tu conexión.");
      return;
    }
    const data = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      contact?: { id: string; name: string };
    } | null;

    if (res.status === 409 && data?.contact) {
      setDuplicado({ id: data.contact.id, name: data.contact.name });
      return;
    }
    if (!res.ok) {
      setError(data?.error?.message ?? "No se pudo guardar el contacto");
      return;
    }
    onCreated();
  }

  const nameError =
    name.trim().length < 2 || !isPersonName(name.trim())
      ? "Escribe el nombre (mínimo 2 letras, solo letras y espacios)."
      : null;
  const phoneError =
    phone.length !== STAFF_PHONE_DIGITS
      ? `El celular debe tener exactamente ${STAFF_PHONE_DIGITS} dígitos.`
      : null;
  const listo = !nameError && !phoneError;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Nuevo contacto"
        className="relative w-full max-w-md rounded-lg border bg-popover p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <DialogCloseButton onClick={onClose} />
        <h3 className="mb-1 pr-8 font-semibold">Nuevo contacto</h3>
        <p className="mb-4 text-xs text-text-3">
          Para prospectos que no llegaron por WhatsApp: referidos, gente que te
          escribió por otra red, conocidos.
        </p>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="nc-name" required>Nombre</Label>
            <Input
              id="nc-name"
              value={name}
              maxLength={80}
              autoComplete="off"
              // Números y signos no se pueden teclear ni pegar.
              onChange={(e) => {
                setName(sanitizePersonName(e.target.value));
                setTouched((t) => ({ ...t, name: false }));
              }}
              onBlur={() => setTouched((t) => ({ ...t, name: name.trim().length > 0 }))}
              aria-invalid={(touched.name && !!nameError) || undefined}
              placeholder="Ej. Carlos Mendoza"
            />
            {touched.name && nameError ? (
              <p role="alert" className="text-[11px] text-danger-text">
                {nameError}
              </p>
            ) : (
              <p className="text-[11px] text-text-3">Solo letras y espacios.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="nc-phone" required>Celular</Label>
            <PhoneInput
              id="nc-phone"
              digits={phone}
              onChange={(d) => {
                setPhone(d);
                setTouched((t) => ({ ...t, phone: false }));
              }}
              // El error llega al salir del campo con el celular a medias, no al teclear.
              onBlur={() => setTouched((t) => ({ ...t, phone: phone.length > 0 }))}
              invalid={touched.phone && !!phoneError}
            />
            {touched.phone && phoneError ? (
              <p role="alert" className="text-[11px] text-danger-text">
                {phoneError}
              </p>
            ) : (
              <p className="text-[11px] text-text-3">9 dígitos, solo números.</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="nc-source">
                ¿De dónde salió?
              </label>
              <SearchSelect
                id="nc-source"
                value={source}
                onChange={(v) => setSource(v as SourceValue)}
                options={SOURCES.map((s) => ({ value: s.value, label: s.label }))}
                searchPlaceholder="Buscar origen…"
                triggerClassName="bg-card px-2"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="nc-stage">
                Etapa inicial
              </label>
              <SearchSelect
                id="nc-stage"
                value={stageId}
                onChange={setStageId}
                options={stages.map((s) => ({ value: s.id, label: s.name }))}
                searchPlaceholder="Buscar etapa…"
                triggerClassName="bg-card px-2"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="nc-notes">
              Notas (opcional)
            </label>
            <Textarea
              id="nc-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Prefiere corte degradado bajo, viene cada 15 días"
            />
          </div>
        </div>

        {duplicado && (
          <div className="mt-3 rounded-md border border-warning-soft bg-warning-tint px-3 py-2.5">
            <p className="text-[13px] text-warning-text">
              Ese teléfono ya es de <strong>{duplicado.name}</strong>. No se creó
              un duplicado.
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => onOpenExisting(duplicado.id)}
            >
              Abrir su conversación
            </Button>
          </div>
        )}
        {error && <p className="mt-3 text-xs text-danger-text">{error}</p>}
        {stages.length === 0 && (
          <p className="mt-3 text-xs text-warning-text">
            Tu embudo no tiene etapas abiertas. Crea una en el Pipeline antes de
            capturar contactos.
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={saving || stages.length === 0}
            onClick={() => void guardar()}
          >
            {saving ? "Guardando…" : "Crear contacto"}
          </Button>
        </div>
      </div>
    </div>
  );
}
