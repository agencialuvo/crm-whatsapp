"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/negocio/fields";
import { CONDITION_RULE_LABELS } from "@/lib/automation-dto";
import { CODE_JS_MAX_CHARS, CONDITION_RULE_TYPES, SWITCH_MAX_CASES } from "@/lib/automation";
import { newCaseId } from "@/lib/automation-canvas";

/**
 * Automatizaciones — los formularios de los pasos del Paso 3: «Establecer variable», «Código JavaScript», «Switch» y la
 * regla «una variable vale…». Aparte de `step-dialog.tsx` (que ya es enorme); reciben su estado por props y no saben nada
 * de la API: el diálogo arma la configuración y el esquema compartido la valida.
 */

const toNumber = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text.trim()));

/* ─── Regla «una variable del flujo vale…» (la usan «Condición» y los casos del Switch) ─── */

export function VarEqualsFields({
  varKey,
  varValue,
  onKey,
  onValue,
  error,
  disabled,
  idPrefix,
}: {
  varKey: string;
  varValue: string;
  onKey: (v: string) => void;
  onValue: (v: string) => void;
  error?: string;
  disabled?: boolean;
  idPrefix: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Variable" required htmlFor={`${idPrefix}-key`} error={error} hint="La que dejó «Establecer variable» o «Código JavaScript».">
        <Input
          id={`${idPrefix}-key`}
          value={varKey}
          maxLength={32}
          placeholder="plan"
          autoComplete="off"
          aria-invalid={!!error}
          disabled={disabled}
          onChange={(e) => onKey(e.target.value.toLowerCase())}
        />
      </Field>
      <Field label="Vale" htmlFor={`${idPrefix}-value`} hint="Texto exacto (sin vacío = «sin definir»).">
        <Input id={`${idPrefix}-value`} value={varValue} maxLength={500} autoComplete="off" disabled={disabled} onChange={(e) => onValue(e.target.value)} />
      </Field>
    </div>
  );
}

/* ─── Establecer variable ─── */

export function SetVarFields({
  varKey,
  varValue,
  onKey,
  onValue,
  errors,
  disabled,
}: {
  varKey: string;
  varValue: string;
  onKey: (v: string) => void;
  onValue: (v: string) => void;
  errors: Record<string, string>;
  disabled?: boolean;
}) {
  return (
    <>
      <Field label="Nombre de la variable" required htmlFor="step-var-key" error={errors.key} hint="Minúsculas, números y _ (hasta 32). Ej.: plan, puntos_extra.">
        <Input
          id="step-var-key"
          value={varKey}
          maxLength={32}
          placeholder="plan"
          autoComplete="off"
          aria-invalid={!!errors.key}
          disabled={disabled}
          onChange={(e) => onKey(e.target.value.toLowerCase())}
        />
      </Field>
      <Field label="Valor" htmlFor="step-var-value" error={errors.value} hint="Admite {{name}}, {{fecha}}, {{hora}}, {{servicio}}, {{vars.otra}} y, en un flujo de premio de fidelidad, {{premio}}, {{descuento}} y {{sellos}}. Vacío = borrar el valor.">
        <Input
          id="step-var-value"
          value={varValue}
          maxLength={500}
          placeholder="Cliente {{name}}"
          autoComplete="off"
          aria-invalid={!!errors.value}
          disabled={disabled}
          onChange={(e) => onValue(e.target.value)}
        />
      </Field>
      <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-2">
        Los pasos que vienen después la leen escribiendo{" "}
        <code className="rounded bg-card px-1">{`{{vars.${varKey.trim() || "nombre"}}}`}</code> en un mensaje, o con la regla «Una
        variable del flujo vale…» en una Condición o un Switch. Si una variable no está definida se lee como vacío. Cada flujo
        guarda hasta 20 variables.
      </p>
    </>
  );
}

/* ─── Código JavaScript ─── */

export function CodeJsFields({
  code,
  onCode,
  error,
  disabled,
}: {
  code: string;
  onCode: (v: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <>
      <Field label="Código" required htmlFor="step-code" error={error} hint={`El cuerpo de una función que recibe «input» y devuelve { vars: { clave: valor } }. Hasta ${CODE_JS_MAX_CHARS} caracteres.`}>
        <Textarea
          id="step-code"
          value={code}
          rows={10}
          spellCheck={false}
          autoComplete="off"
          maxLength={CODE_JS_MAX_CHARS}
          aria-invalid={!!error}
          disabled={disabled}
          className="font-mono text-xs"
          onChange={(e) => onCode(e.target.value)}
        />
      </Field>
      <div className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-2">
        <p className="font-medium text-foreground">Cómo corre</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>
            En un intérprete aislado: <strong>sin red, sin base de datos, sin archivos y sin claves</strong> del sistema.
          </li>
          <li>
            Recibe <code>input</code> = {"{ now, contact: { name, tagIds, stageId }, context, vars }"}.
          </li>
          <li>Devuelve solo <code>vars</code> (texto, número, sí/no o null para borrar). Los pasos siguientes la leen con {"{{vars.clave}}"}.</li>
          <li>Tope de 0,5 s y 8 MB. <code>Date</code> y <code>Math.random</code> no están disponibles, para que repetir el paso dé lo mismo.</li>
          <li>Si el código falla, el paso falla a la vista en el historial y no se reintenta.</li>
        </ul>
      </div>
    </>
  );
}

/* ─── Switch ─── */

/** Un caso tal como se edita: todo texto (los números se validan al armar la configuración). */
export type CaseForm = {
  id: string;
  label: string;
  type: string;
  tagId: string;
  stageId: string;
  days: string;
  stamps: string;
  /** `stamps_between`: el rango (ambos incluidos). */
  min: string;
  max: string;
  varKey: string;
  varValue: string;
};

const emptyCase = (existing: readonly string[], n: number): CaseForm => ({
  id: newCaseId(existing),
  label: `Caso ${n}`,
  type: "tag_has",
  tagId: "",
  stageId: "",
  days: "30",
  stamps: "5",
  min: "1",
  max: "4",
  varKey: "",
  varValue: "",
});

/** Los casos guardados en la configuración → el formulario. */
export function casesFromConfig(raw: unknown): CaseForm[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  return raw.map((k, i) => {
    const o = (k ?? {}) as { id?: unknown; label?: unknown; rule?: Record<string, unknown> | null };
    const rule = o.rule ?? {};
    const id = typeof o.id === "string" && o.id && !ids.includes(o.id) ? o.id : newCaseId(ids);
    ids.push(id);
    return {
      id,
      label: typeof o.label === "string" ? o.label : `Caso ${i + 1}`,
      type: typeof rule.type === "string" ? rule.type : "tag_has",
      tagId: typeof rule.tagId === "string" ? rule.tagId : "",
      stageId: typeof rule.stageId === "string" ? rule.stageId : "",
      days: typeof rule.days === "number" ? String(rule.days) : "30",
      stamps: typeof rule.stamps === "number" ? String(rule.stamps) : "5",
      min: typeof rule.min === "number" ? String(rule.min) : "1",
      max: typeof rule.max === "number" ? String(rule.max) : "4",
      varKey: typeof rule.key === "string" ? rule.key : "",
      varValue: typeof rule.value === "string" ? rule.value : "",
    };
  });
}

/** La regla de un caso como la espera el esquema. */
export function ruleFromCase(k: CaseForm): Record<string, unknown> {
  switch (k.type) {
    case "booking_confirmed":
    case "has_upcoming_booking":
    case "birthday_today":
      return { type: k.type };
    case "stage_is":
      return { type: k.type, stageId: k.stageId };
    case "visited_within_days":
      return { type: k.type, days: toNumber(k.days) };
    case "stamps_gte":
    case "stamps_remaining_lte":
    case "loyalty_milestone_is":
      return { type: k.type, stamps: toNumber(k.stamps) };
    case "stamps_between":
      return { type: k.type, min: toNumber(k.min), max: toNumber(k.max) };
    case "var_equals":
      return { type: k.type, key: k.varKey.trim(), value: k.varValue };
    default:
      return { type: k.type, tagId: k.tagId };
  }
}

export const casesToConfig = (cases: readonly CaseForm[]): Record<string, unknown>[] =>
  cases.map((k) => ({ id: k.id, label: k.label.trim(), rule: ruleFromCase(k) }));

/** Los errores que el formulario puede comprobar antes del esquema (mensajes más claros que los de Zod). */
export function caseErrors(cases: readonly CaseForm[]): Record<string, string> {
  const found: Record<string, string> = {};
  cases.forEach((k, i) => {
    if ((k.type === "tag_has" || k.type === "tag_missing") && !k.tagId) found[`case.${i}`] = "Elige una etiqueta";
    else if (k.type === "stage_is" && !k.stageId) found[`case.${i}`] = "Elige una etapa";
    else if (k.type === "var_equals" && !k.varKey.trim()) found[`case.${i}`] = "Escribe el nombre de la variable";
    else if (k.type === "stamps_between" && toNumber(k.min) > toNumber(k.max)) found[`case.${i}.max`] = "El máximo debe ser igual o mayor que el mínimo";
  });
  return found;
}

export function SwitchFields({
  cases,
  onChange,
  tagOptions,
  stageOptions,
  isBookingFlow,
  errors,
  disabled,
}: {
  cases: CaseForm[];
  onChange: (next: CaseForm[]) => void;
  tagOptions: SearchSelectOption[];
  stageOptions: SearchSelectOption[];
  isBookingFlow: boolean;
  errors: Record<string, string>;
  disabled?: boolean;
}) {
  const patch = (i: number, p: Partial<CaseForm>) => onChange(cases.map((k, j) => (j === i ? { ...k, ...p } : k)));
  const rules: SearchSelectOption[] = CONDITION_RULE_TYPES.filter((r) => isBookingFlow || r !== "booking_confirmed").map((r) => ({
    value: r,
    label: CONDITION_RULE_LABELS[r],
  }));

  return (
    <>
      <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-2">
        Se evalúan los casos <strong>en orden</strong> y el flujo sigue por la salida del primero que se cumpla. Si ninguno se
        cumple, sigue por <strong>«Otro»</strong>. Conecta cada salida del bloque a lo que debe pasar; una salida sin conectar
        termina el flujo.
      </p>
      {errors.cases && (
        <p role="alert" className="text-xs text-danger-text">
          {errors.cases}
        </p>
      )}
      <ol className="space-y-3">
        {cases.map((k, i) => (
          <li key={k.id} className="space-y-3 rounded-lg border bg-background p-3">
            <div className="flex items-end gap-2">
              <Field label={`Caso ${i + 1}`} required htmlFor={`case-${k.id}-label`} className="flex-1" error={errors[`case.${i}.label`]}>
                <Input
                  id={`case-${k.id}-label`}
                  value={k.label}
                  maxLength={40}
                  autoComplete="off"
                  disabled={disabled}
                  aria-invalid={!!errors[`case.${i}.label`]}
                  onChange={(e) => patch(i, { label: e.target.value })}
                />
              </Field>
              <Button type="button" variant="outline" size="sm" disabled={disabled} aria-label={`Quitar el caso ${i + 1}`} onClick={() => onChange(cases.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4 text-danger-text" aria-hidden />
              </Button>
            </div>
            <Field label="Si se cumple que…" htmlFor={`case-${k.id}-rule`}>
              <SearchSelect
                id={`case-${k.id}-rule`}
                value={k.type}
                onChange={(v) => patch(i, { type: v })}
                options={rules}
                searchPlaceholder="Buscar regla…"
                ariaLabel={`Regla del caso ${i + 1}`}
                disabled={disabled}
              />
            </Field>
            {(k.type === "tag_has" || k.type === "tag_missing") && (
              <Field label="Etiqueta" required htmlFor={`case-${k.id}-tag`} error={errors[`case.${i}`]}>
                <SearchSelect
                  id={`case-${k.id}-tag`}
                  value={k.tagId}
                  onChange={(v) => patch(i, { tagId: v })}
                  options={tagOptions}
                  placeholder="Elige una etiqueta"
                  searchPlaceholder="Buscar etiqueta…"
                  ariaLabel={`Etiqueta del caso ${i + 1}`}
                  invalid={!!errors[`case.${i}`]}
                  disabled={disabled}
                />
              </Field>
            )}
            {k.type === "stage_is" && (
              <Field label="Etapa" required htmlFor={`case-${k.id}-stage`} error={errors[`case.${i}`]}>
                <SearchSelect
                  id={`case-${k.id}-stage`}
                  value={k.stageId}
                  onChange={(v) => patch(i, { stageId: v })}
                  options={stageOptions}
                  placeholder="Elige una etapa"
                  searchPlaceholder="Buscar etapa…"
                  ariaLabel={`Etapa del caso ${i + 1}`}
                  invalid={!!errors[`case.${i}`]}
                  disabled={disabled}
                />
              </Field>
            )}
            {k.type === "visited_within_days" && (
              <Field label="En los últimos (días)" required htmlFor={`case-${k.id}-days`} error={errors[`case.${i}.days`]}>
                <Input id={`case-${k.id}-days`} inputMode="numeric" value={k.days} maxLength={4} disabled={disabled} onChange={(e) => patch(i, { days: e.target.value.replace(/\D/g, "") })} />
              </Field>
            )}
            {k.type === "stamps_gte" && (
              <Field label="Sellos mínimos" required htmlFor={`case-${k.id}-stamps`} error={errors[`case.${i}.stamps`]}>
                <Input id={`case-${k.id}-stamps`} inputMode="numeric" value={k.stamps} maxLength={4} disabled={disabled} onChange={(e) => patch(i, { stamps: e.target.value.replace(/\D/g, "") })} />
              </Field>
            )}
            {k.type === "stamps_remaining_lte" && (
              <Field label="Le faltan como máximo (sellos)" required htmlFor={`case-${k.id}-stamps`} error={errors[`case.${i}.stamps`]}>
                <Input id={`case-${k.id}-stamps`} inputMode="numeric" value={k.stamps} maxLength={4} disabled={disabled} onChange={(e) => patch(i, { stamps: e.target.value.replace(/\D/g, "") })} />
              </Field>
            )}
            {k.type === "loyalty_milestone_is" && (
              <Field label="Sellos del premio del disparo" required htmlFor={`case-${k.id}-stamps`} error={errors[`case.${i}.stamps`]}>
                <Input id={`case-${k.id}-stamps`} inputMode="numeric" value={k.stamps} maxLength={4} disabled={disabled} onChange={(e) => patch(i, { stamps: e.target.value.replace(/\D/g, "") })} />
              </Field>
            )}
            {k.type === "stamps_between" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Desde (sellos)" required htmlFor={`case-${k.id}-min`} error={errors[`case.${i}.min`]}>
                  <Input id={`case-${k.id}-min`} inputMode="numeric" value={k.min} maxLength={4} disabled={disabled} onChange={(e) => patch(i, { min: e.target.value.replace(/\D/g, "") })} />
                </Field>
                <Field label="Hasta (sellos)" required htmlFor={`case-${k.id}-max`} error={errors[`case.${i}.max`]}>
                  <Input id={`case-${k.id}-max`} inputMode="numeric" value={k.max} maxLength={4} disabled={disabled} onChange={(e) => patch(i, { max: e.target.value.replace(/\D/g, "") })} />
                </Field>
              </div>
            )}
            {k.type === "var_equals" && (
              <VarEqualsFields
                idPrefix={`case-${k.id}`}
                varKey={k.varKey}
                varValue={k.varValue}
                onKey={(v) => patch(i, { varKey: v })}
                onValue={(v) => patch(i, { varValue: v })}
                error={errors[`case.${i}`]}
                disabled={disabled}
              />
            )}
          </li>
        ))}
      </ol>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || cases.length >= SWITCH_MAX_CASES}
        onClick={() => onChange([...cases, emptyCase(cases.map((k) => k.id), cases.length + 1)])}
      >
        <Plus className="h-4 w-4" aria-hidden />
        Agregar caso{cases.length >= SWITCH_MAX_CASES ? ` (máximo ${SWITCH_MAX_CASES})` : ""}
      </Button>
    </>
  );
}
