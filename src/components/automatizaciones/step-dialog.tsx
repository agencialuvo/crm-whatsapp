"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Field } from "@/components/negocio/fields";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { stepCreateSchema, STEP_TYPES } from "@/lib/automation-schemas";
import {
  DELAY_UNIT_LABELS,
  nextPositionY,
  stepLabel,
  type StepDto,
  type TemplateOption,
} from "@/lib/automation-dto";
import { countVariables } from "@/lib/templates";

const STEP_TYPE_OPTIONS: SearchSelectOption[] = STEP_TYPES.map((t) => ({ value: t, label: stepLabel(t) }));

const UNIT_OPTIONS: SearchSelectOption[] = (
  Object.keys(DELAY_UNIT_LABELS) as (keyof typeof DELAY_UNIT_LABELS)[]
).map((u) => ({ value: u, label: DELAY_UNIT_LABELS[u].other }));

/** Un número entero de un campo de texto: vacío o basura da `NaN` y el esquema lo rechaza con su mensaje. */
const toNumber = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text.trim()));

/**
 * Automatizaciones — agregar o editar un paso del flujo: esperar un tiempo o enviar un mensaje de WhatsApp.
 *
 * La configuración se valida con el mismo esquema que la API. Un paso nuevo cae al final de la lista;
 * el tipo de un paso ya creado no cambia (se borra y se crea otro).
 *
 * Sobre la ventana de 24 h de WhatsApp: un mensaje de texto solo sale si el cliente escribió en las
 * últimas 24 horas; fuera de ella solo sale una plantilla aprobada. Por eso el formulario lo avisa
 * cuando el paso no tiene plantilla.
 */
export function StepDialog({
  flowId,
  step,
  steps,
  templates,
  onClose,
  onSaved,
}: {
  flowId: string;
  /** `null` agrega un paso nuevo. */
  step: StepDto | null;
  /** Los pasos actuales: de ahí sale dónde cae el nuevo. */
  steps: StepDto[];
  templates: TemplateOption[];
  onClose: () => void;
  onSaved: (step: StepDto) => void;
}) {
  const editing = step !== null;
  const c = step?.config ?? {};
  const [stepType, setStepType] = useState<string>(step?.stepType ?? "send_whatsapp");
  const [name, setName] = useState(typeof c.name === "string" ? c.name : "");
  const [amount, setAmount] = useState(typeof c.amount === "number" ? String(c.amount) : "1");
  const [unit, setUnit] = useState(typeof c.unit === "string" ? c.unit : "days");
  const [content, setContent] = useState(typeof c.content === "string" ? c.content : "");
  const [templateId, setTemplateId] = useState(typeof c.templateId === "string" ? c.templateId : "");
  const [variables, setVariables] = useState<string[]>(
    Array.isArray(c.variables) ? c.variables.filter((v): v is string => typeof v === "string") : []
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Un error se va en cuanto la persona toca el campo que lo causó (no se queda en rojo ya corregido). */
  const clear = (...keys: string[]) =>
    setErrors((prev) => (keys.some((k) => k in prev) ? Object.fromEntries(Object.entries(prev).filter(([k]) => !keys.includes(k))) : prev));

  // Solo se ofrecen las aprobadas (son las únicas que WhatsApp deja enviar); la que ya tiene el paso
  // se conserva aunque ya no esté aprobada, para que no desaparezca sin avisar.
  const templateOptions = useMemo<SearchSelectOption[]>(
    () =>
      templates
        .filter((t) => t.status === "approved" || t.id === templateId)
        .map((t) => ({
          value: t.id,
          label: t.name,
          hint: t.status === "approved" ? t.language : `${t.language} · no aprobada`,
        })),
    [templates, templateId]
  );
  const chosen = templates.find((t) => t.id === templateId) ?? null;
  const variableCount = chosen ? countVariables(chosen.body) : 0;
  const hasApproved = templates.some((t) => t.status === "approved");

  function pickTemplate(id: string) {
    setTemplateId(id);
    // Elegir plantilla también resuelve «falta mensaje o plantilla».
    clear("content", "templateId", "variables");
    const t = templates.find((x) => x.id === id);
    const n = t ? countVariables(t.body) : 0;
    // Conserva lo ya escrito y ajusta la cantidad de valores a las variables de la plantilla elegida.
    setVariables((prev) => Array.from({ length: n }, (_, i) => prev[i] ?? ""));
  }

  function buildConfig(): Record<string, unknown> {
    if (stepType === "delay") {
      return { ...(name.trim() && { name: name.trim() }), amount: toNumber(amount), unit };
    }
    return {
      ...(name.trim() && { name: name.trim() }),
      ...(content.trim() && { content: content.trim() }),
      ...(templateId && { templateId }),
      ...(templateId && variableCount > 0 && { variables: variables.slice(0, variableCount).map((v) => v.trim()) }),
    };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const config = buildConfig();
    const found: Record<string, string> = {};

    const parsed = stepCreateSchema.safeParse({
      stepType,
      config,
      positionX: step?.positionX ?? 0,
      positionY: step?.positionY ?? nextPositionY(steps),
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        // `config.amount` se pinta bajo «amount»; un error del conjunto («falta mensaje o plantilla»)
        // se pinta bajo el mensaje.
        const last = issue.path[issue.path.length - 1];
        const key = issue.path.length <= 1 || last === "config" ? "content" : String(last);
        if (!(key in found)) found[key] = issue.message;
      }
    }
    // El servidor no cuenta las variables al guardar y WhatsApp rechaza el envío si falta alguna: se pide aquí.
    if (stepType === "send_whatsapp" && templateId && variableCount > 0 && variables.slice(0, variableCount).some((v) => !v.trim())) {
      found.variables = `Escribe el valor de ${variableCount === 1 ? "{{1}}" : `las ${variableCount} variables`} de la plantilla.`;
    }
    setErrors(found);
    if (Object.keys(found).length > 0 || !parsed.success) return;

    setBusy(true);
    try {
      const { step: saved } = await apiFetch<{ step: StepDto }>(
        editing ? `/api/automations/${flowId}/steps/${step.id}` : `/api/automations/${flowId}/steps`,
        // Editar manda solo la configuración: el tipo no cambia y el orden se mueve con las flechas.
        { method: editing ? "PATCH" : "POST", json: editing ? { config: parsed.data.config } : parsed.data }
      );
      onSaved(saved);
    } catch (err) {
      setFormError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={editing ? "Editar paso" : "Agregar paso"}
      description="Cada paso se ejecuta en orden, uno después del otro."
      onClose={onClose}
      busy={busy}
      size="lg"
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Tipo de paso" required htmlFor="step-type" hint={editing ? "El tipo no se puede cambiar: elimina el paso y crea otro." : undefined}>
          {editing ? (
            <p id="step-type" className="rounded-md border bg-subtle px-3 py-2 text-sm">
              {stepLabel(stepType)}
            </p>
          ) : (
            <SearchSelect
              id="step-type"
              value={stepType}
              onChange={setStepType}
              options={STEP_TYPE_OPTIONS}
              searchPlaceholder="Buscar tipo de paso…"
              ariaLabel="Tipo de paso"
              disabled={busy}
            />
          )}
        </Field>

        <Field label="Nombre (opcional)" htmlFor="step-name" hint="Para reconocerlo en la lista y en el historial.">
          <Input
            id="step-name"
            value={name}
            maxLength={120}
            placeholder={stepType === "delay" ? "Esperar un día" : "Saludo de cumpleaños"}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        {stepType === "delay" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cantidad" required htmlFor="step-amount" error={errors.amount}>
              <Input
                id="step-amount"
                inputMode="numeric"
                value={amount}
                maxLength={3}
                aria-invalid={!!errors.amount}
                disabled={busy}
                // Solo dígitos: lo demás no se puede teclear ni pegar.
                onChange={(e) => {
                  setAmount(e.target.value.replace(/\D/g, ""));
                  clear("amount");
                }}
              />
            </Field>
            <Field label="Unidad" required htmlFor="step-unit" error={errors.unit}>
              <SearchSelect
                id="step-unit"
                value={unit}
                onChange={(v) => {
                  setUnit(v);
                  clear("unit");
                }}
                options={UNIT_OPTIONS}
                searchPlaceholder="Buscar unidad…"
                ariaLabel="Unidad de tiempo"
                disabled={busy}
              />
            </Field>
          </div>
        ) : (
          <>
            <Field
              label="Mensaje"
              htmlFor="step-content"
              error={errors.content}
              hint="Escribe {{name}} para poner el nombre del cliente."
            >
              <Textarea
                id="step-content"
                value={content}
                rows={4}
                maxLength={4096}
                placeholder="¡Hola {{name}}! Hoy es tu día…"
                aria-invalid={!!errors.content}
                disabled={busy}
                onChange={(e) => {
                  setContent(e.target.value);
                  clear("content");
                }}
              />
            </Field>

            <Field
              label="Plantilla de WhatsApp (opcional)"
              htmlFor="step-template"
              error={errors.templateId}
              hint={
                hasApproved
                  ? "Solo las plantillas aprobadas por WhatsApp pueden enviarse."
                  : undefined
              }
            >
              <SearchSelect
                id="step-template"
                value={templateId}
                onChange={pickTemplate}
                options={templateOptions}
                emptyLabel="Sin plantilla"
                searchPlaceholder="Buscar plantilla…"
                ariaLabel="Plantilla de WhatsApp"
                disabled={busy}
              />
              {!hasApproved && (
                <p className="text-xs text-text-3">
                  Aún no tienes plantillas aprobadas.{" "}
                  <Link href="/ajustes/plantillas" className="font-semibold underline">
                    Crea una en Ajustes
                  </Link>
                  .
                </p>
              )}
            </Field>

            {chosen && (
              <div className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-2">
                <p className="mb-1 font-semibold">Texto de la plantilla</p>
                <p className="whitespace-pre-wrap">{chosen.body}</p>
              </div>
            )}

            {chosen && variableCount > 0 && (
              <fieldset className="space-y-3" disabled={busy}>
                <legend className="text-sm font-medium">Valores de las variables</legend>
                {Array.from({ length: variableCount }, (_, i) => (
                  <Field key={i} label={`Variable {{${i + 1}}}`} htmlFor={`step-var-${i}`}>
                    <Input
                      id={`step-var-${i}`}
                      value={variables[i] ?? ""}
                      maxLength={1024}
                      placeholder={i === 0 ? "{{name}}" : ""}
                      autoComplete="off"
                      onChange={(e) => {
                        clear("variables");
                        const value = e.target.value;
                        setVariables((prev) => {
                          const next = Array.from({ length: variableCount }, (_, j) => prev[j] ?? "");
                          next[i] = value;
                          return next;
                        });
                      }}
                    />
                  </Field>
                ))}
                {errors.variables ? (
                  <p role="alert" className="text-xs text-danger-text">
                    {errors.variables}
                  </p>
                ) : (
                  <p className="text-xs text-text-3">Puedes usar {"{{name}}"} para el nombre del cliente.</p>
                )}
              </fieldset>
            )}

            {!templateId && (
              <p className="rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
                Sin plantilla, este mensaje solo sale si el cliente te escribió en las últimas 24 horas (regla de
                WhatsApp). Fuera de ese plazo el paso falla. Agrega una plantilla aprobada para que salga siempre.
              </p>
            )}
          </>
        )}

        <ModalFooter error={formError}>
          <Button type="submit" disabled={busy}>
            {busy ? "Guardando…" : editing ? "Guardar cambios" : "Agregar paso"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
