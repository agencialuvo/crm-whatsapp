"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Field } from "@/components/negocio/fields";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { BIRTHDAY_DEFAULT_HOUR } from "@/lib/automation";
import {
  flowCreateSchema,
  flowPatchSchema,
  parseTriggerConfigFor,
  type FlowTriggerType,
} from "@/lib/automation-schemas";
import {
  CREATABLE_TRIGGERS,
  BIRTHDAY_OFFSETS,
  TRIGGER_HINTS,
  hourLabel,
  offsetOf,
  offsetOptionLabel,
  triggerLabel,
  type FlowDto,
  type StageOption,
} from "@/lib/automation-dto";

const HOUR_OPTIONS: SearchSelectOption[] = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: hourLabel(h),
}));

const TRIGGER_OPTIONS: SearchSelectOption[] = CREATABLE_TRIGGERS.map((t) => ({
  value: t,
  label: triggerLabel(t),
}));

/**
 * Automatizaciones — crear un flujo o editar su nombre y las reglas de su disparador.
 *
 * El tipo de disparador se elige al crear y ya no cambia (decide qué significan los ajustes): para otro
 * tipo se crea un flujo nuevo. Valida con los mismos esquemas que la API, así que lo que el formulario
 * deja pasar el servidor lo acepta, y lo que rechaza se dice aquí, bajo su campo.
 */
export function FlowDialog({
  flow,
  stages,
  onClose,
  onSaved,
}: {
  /** `null` crea un flujo nuevo. */
  flow: FlowDto | null;
  stages: StageOption[];
  onClose: () => void;
  onSaved: (flow: FlowDto) => void;
}) {
  const editing = flow !== null;
  const [name, setName] = useState(flow?.name ?? "");
  const [triggerType, setTriggerType] = useState<string>(flow?.triggerType ?? "");
  const [hour, setHour] = useState(
    typeof flow?.triggerConfig?.hour === "number" ? String(flow.triggerConfig.hour) : String(BIRTHDAY_DEFAULT_HOUR)
  );
  const [daysOffset, setDaysOffset] = useState(String(offsetOf(flow?.triggerConfig ?? null)));
  const [stageId, setStageId] = useState(
    typeof flow?.triggerConfig?.toStageId === "string" ? flow.triggerConfig.toStageId : ""
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Un error se va en cuanto la persona toca el campo que lo causó (no se queda en rojo ya corregido). */
  const clear = (...keys: string[]) =>
    setErrors((prev) => (keys.some((k) => k in prev) ? Object.fromEntries(Object.entries(prev).filter(([k]) => !keys.includes(k))) : prev));

  // Los tres momentos de la pantalla y, si el flujo trae otro desde la API, ese también (no se pierde al editar).
  const offsetOptions = useMemo<SearchSelectOption[]>(() => {
    const values: number[] = [...BIRTHDAY_OFFSETS];
    const current = Number(daysOffset);
    if (!values.includes(current)) values.push(current);
    return values.map((v) => ({ value: String(v), label: offsetOptionLabel(v) }));
  }, [daysOffset]);

  const stageOptions = useMemo<SearchSelectOption[]>(
    () => stages.map((s) => ({ value: s.id, label: s.name })),
    [stages]
  );

  /** Los ajustes del disparador tal como los espera la API (`null` si no hay ninguno). */
  function buildConfig(): Record<string, unknown> | null {
    if (triggerType === "birthday") return { hour: Number(hour), daysOffset: Number(daysOffset) };
    if (triggerType === "stage_changed" && stageId) return { toStageId: stageId };
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const triggerConfig = buildConfig();
    const found: Record<string, string> = {};

    if (!editing && !triggerType) found.triggerType = "Elige cuándo se activa el flujo";
    const schema = editing
      ? flowPatchSchema.safeParse({ name, triggerConfig })
      : flowCreateSchema.safeParse({ name, triggerType, triggerConfig });
    if (!schema.success) {
      for (const issue of schema.error.issues) {
        const key = String(issue.path[0] ?? "_");
        if (!(key in found)) found[key] = issue.message;
      }
    }
    if (triggerType && (CREATABLE_TRIGGERS as readonly string[]).includes(triggerType)) {
      const cfg = parseTriggerConfigFor(triggerType as FlowTriggerType, triggerConfig);
      if (!cfg.ok) found.triggerConfig = cfg.message;
    }
    setErrors(found);
    if (Object.keys(found).length > 0 || !schema.success) return;

    setBusy(true);
    try {
      const { flow: saved } = await apiFetch<{ flow: FlowDto }>(
        editing ? `/api/automations/${flow.id}` : "/api/automations",
        { method: editing ? "PATCH" : "POST", json: schema.data }
      );
      onSaved(saved);
    } catch (err) {
      setFormError(describeError(err));
      setBusy(false);
    }
  }

  const hint = (CREATABLE_TRIGGERS as readonly string[]).includes(triggerType)
    ? TRIGGER_HINTS[triggerType as keyof typeof TRIGGER_HINTS]
    : null;

  return (
    <Modal
      title={editing ? "Editar flujo" : "Nuevo flujo"}
      description={
        editing
          ? "Cambia el nombre o las reglas de cuándo se activa."
          : "Un flujo es una secuencia de pasos que se ejecuta sola cuando pasa algo con un cliente."
      }
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Nombre" required htmlFor="flow-name" error={errors.name}>
          <Input
            id="flow-name"
            value={name}
            maxLength={120}
            placeholder="Saludo de cumpleaños"
            autoComplete="off"
            aria-invalid={!!errors.name}
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value);
              clear("name");
            }}
          />
        </Field>

        <Field
          label="Se activa cuando"
          required
          htmlFor="flow-trigger"
          error={errors.triggerType}
          hint={editing ? "El tipo de disparador no se puede cambiar: crea otro flujo si lo necesitas." : (hint ?? undefined)}
        >
          {editing ? (
            <p id="flow-trigger" className="rounded-md border bg-subtle px-3 py-2 text-sm">
              {triggerLabel(triggerType)}
            </p>
          ) : (
            <SearchSelect
              id="flow-trigger"
              value={triggerType}
              onChange={(v) => {
                setTriggerType(v);
                clear("triggerType", "triggerConfig");
              }}
              options={TRIGGER_OPTIONS}
              placeholder="Elige un disparador"
              searchPlaceholder="Buscar disparador…"
              ariaLabel="Disparador del flujo"
              invalid={!!errors.triggerType}
              disabled={busy}
            />
          )}
        </Field>

        {triggerType === "birthday" && (
          <Field
            label="Momento del envío"
            htmlFor="flow-offset"
            error={errors.triggerConfig}
            hint="Para avisos previos (un descuento, un recordatorio), elige cuántos días antes sale el mensaje."
          >
            <SearchSelect
              id="flow-offset"
              value={daysOffset}
              onChange={(v) => {
                setDaysOffset(v);
                clear("triggerConfig");
              }}
              options={offsetOptions}
              searchPlaceholder="Buscar momento…"
              ariaLabel="Momento del envío"
              disabled={busy}
            />
          </Field>
        )}

        {triggerType === "birthday" && (
          <Field
            label="Hora del saludo"
            htmlFor="flow-hour"
            error={errors.triggerConfig}
            hint="Hora local de tu negocio, el día en que sale el mensaje."
          >
            <SearchSelect
              id="flow-hour"
              value={hour}
              onChange={(v) => {
                setHour(v);
                clear("triggerConfig");
              }}
              options={HOUR_OPTIONS}
              searchPlaceholder="Buscar hora…"
              ariaLabel="Hora del saludo"
              disabled={busy}
            />
          </Field>
        )}

        {triggerType === "stage_changed" && (
          <Field
            label="Etapa"
            htmlFor="flow-stage"
            error={errors.triggerConfig}
            hint={
              stages.length === 0
                ? "No se pudieron cargar las etapas: el flujo se activará con cualquier cambio."
                : "Elige una etapa, o déjalo en «Cualquier etapa» para que se active con cada cambio."
            }
          >
            <SearchSelect
              id="flow-stage"
              value={stageId}
              onChange={(v) => {
                setStageId(v);
                clear("triggerConfig");
              }}
              options={stageOptions}
              emptyLabel="Cualquier etapa"
              searchPlaceholder="Buscar etapa…"
              ariaLabel="Etapa que activa el flujo"
              disabled={busy}
            />
          </Field>
        )}

        <ModalFooter error={formError}>
          <Button type="submit" disabled={busy}>
            {busy ? "Guardando…" : editing ? "Guardar cambios" : "Crear flujo"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
