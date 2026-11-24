"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Field } from "@/components/negocio/fields";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { stepCreateSchema, STEP_TYPES } from "@/lib/automation-schemas";
import {
  BRANCH_ACTION_LABELS,
  CONDITION_RULE_LABELS,
  DELAY_UNIT_LABELS,
  REPLY_BRANCHES,
  WAIT_LATE_LABELS,
  nextPositionY,
  offsetMinutesOf,
  offsetParts,
  stepLabel,
  type MediaOption,
  type StageOption,
  type StepDto,
  type TagOption,
  type TemplateOption,
} from "@/lib/automation-dto";
import {
  BRANCH_ACTIONS,
  CONDITION_RULE_TYPES,
  REPLY_TIMEOUT_DEFAULT_MINUTES,
  WAIT_LATE_ACTIONS,
} from "@/lib/automation";
import { Switch } from "@/components/ui/switch";
import { CodeJsFields, SetVarFields, SwitchFields, VarEqualsFields, casesFromConfig, casesToConfig, caseErrors, type CaseForm } from "@/components/automatizaciones/step-extras";
import { DEFAULT_CODE_JS } from "@/lib/automation-canvas";
import { tagColorClass } from "@/lib/tags";
import { avisoDeMedioEnPaso, etiquetaDeOpcion, seOfreceEnPaso } from "@/lib/medios-estado";
import { countVariables } from "@/lib/templates";

const NO_MEDIA: MediaOption[] = [];
const STEP_TYPE_OPTIONS: SearchSelectOption[] = STEP_TYPES.map((t) => ({ value: t, label: stepLabel(t) }));

const BRANCH_OPTIONS: SearchSelectOption[] = BRANCH_ACTIONS.map((a) => ({ value: a, label: BRANCH_ACTION_LABELS[a] }));

/** Unidades de las esperas ancladas (`wait_until`, tiempo límite de `wait_reply`): guardan MINUTOS, sin segundos. */
const UNIT_OPTIONS: SearchSelectOption[] = (["minutes", "hours", "days"] as const).map((u) => ({
  value: u,
  label: DELAY_UNIT_LABELS[u].other,
}));

/** Unidades del paso «Esperar»: las mismas más los segundos. */
const DELAY_UNIT_OPTIONS: SearchSelectOption[] = (
  Object.keys(DELAY_UNIT_LABELS) as (keyof typeof DELAY_UNIT_LABELS)[]
).map((u) => ({ value: u, label: DELAY_UNIT_LABELS[u].other }));

const DIRECTION_OPTIONS: SearchSelectOption[] = [
  { value: "before", label: "Antes de la cita" },
  { value: "after", label: "Después de la cita" },
];

const LATE_OPTIONS: SearchSelectOption[] = WAIT_LATE_ACTIONS.map((a) => ({ value: a, label: WAIT_LATE_LABELS[a] }));

const WINDOW_OPTIONS: SearchSelectOption[] = [
  { value: "none", label: "Cuando toque (sin restricción)" },
  { value: "at", label: "A una hora fija" },
  { value: "between", label: "Solo dentro de un horario" },
];

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
  steps = [],
  templates,
  tags,
  stages,
  media = NO_MEDIA,
  triggerType,
  onTagCreated,
  onClose,
  onSaved,
  inline = false,
  onApply,
}: {
  /** Solo el modo diálogo guarda por la API de pasos; en `inline` no se usa. */
  flowId?: string;
  /** `null` agrega un paso nuevo. */
  step: StepDto | null;
  /** Los pasos actuales: de ahí sale dónde cae el nuevo. */
  steps?: StepDto[];
  templates: TemplateOption[];
  /** Etiquetas y etapas del negocio: lo que ofrecen `add_tag`, `set_stage` y `condition`. */
  tags: TagOption[];
  stages: StageOption[];
  /** Los archivos de la biblioteca de Medios: lo que ofrece «Enviar imagen o video». */
  media?: MediaOption[];
  /** El disparador del flujo: decide qué pasos y reglas tienen sentido (los de cita, solo en flujos de cita). */
  triggerType: string;
  /** Una etiqueta creada «al vuelo» desde el diálogo, para que el detalle del flujo la conozca. */
  onTagCreated: (tag: TagOption) => void;
  onClose?: () => void;
  onSaved?: (step: StepDto) => void;
  /**
   * Presentación en el panel del lienzo (spec 036, D14): sin `Modal`, sin guardar por la API de pasos; la
   * configuración válida se entrega en vivo con `onApply`. Las reglas del formulario son las mismas del diálogo.
   */
  inline?: boolean;
  onApply?: (config: Record<string, unknown>) => void;
}) {
  const editing = step !== null;
  const c = step?.config ?? {};
  const [stepType, setStepType] = useState<string>(step?.stepType ?? "send_whatsapp");
  const [name, setName] = useState(typeof c.name === "string" ? c.name : "");
  const [amount, setAmount] = useState(typeof c.amount === "number" ? String(c.amount) : "1");
  const [unit, setUnit] = useState(typeof c.unit === "string" ? c.unit : "days");
  // Esperar hasta la cita: «1 día antes», «2 horas antes»… (se guarda en minutos con signo).
  const offset = offsetParts(typeof c.offsetMinutes === "number" ? c.offsetMinutes : -1440);
  const [offsetAmount, setOffsetAmount] = useState(String(offset.amount));
  const [offsetUnit, setOffsetUnit] = useState<string>(offset.unit);
  const [offsetDir, setOffsetDir] = useState<string>(offset.direction);
  const [lateAction, setLateAction] = useState<string>(typeof c.lateAction === "string" ? c.lateAction : "skip_next");
  // Ventana horaria de envío (en «Esperar» y en «Esperar hasta la cita»).
  const win = (c.window ?? null) as Record<string, unknown> | null;
  const [windowMode, setWindowMode] = useState<string>(win && typeof win.mode === "string" ? win.mode : "none");
  const [winHour, setWinHour] = useState(typeof win?.hour === "number" ? String(win.hour) : "10");
  const [winMinute, setWinMinute] = useState(typeof win?.minute === "number" ? String(win.minute) : "0");
  const [winFrom, setWinFrom] = useState(typeof win?.fromHour === "number" ? String(win.fromHour) : "9");
  const [winTo, setWinTo] = useState(typeof win?.toHour === "number" ? String(win.toHour) : "21");
  // Acciones de CRM y condición. Todo por id: ni el motor ni el formulario comparan nombres.
  const rule = (c.rule ?? null) as Record<string, unknown> | null;
  const isBookingFlow = triggerType.startsWith("booking_");
  const [tagId, setTagId] = useState(typeof c.tagId === "string" ? c.tagId : "");
  const [stageId, setStageId] = useState(typeof c.stageId === "string" ? c.stageId : "");
  // Enviar imagen o video: el archivo (por id de la biblioteca) y su leyenda.
  const [mediaId, setMediaId] = useState(typeof c.mediaId === "string" ? c.mediaId : "");
  const [caption, setCaption] = useState(typeof c.caption === "string" ? c.caption : "");
  const [ruleType, setRuleType] = useState<string>(typeof rule?.type === "string" ? rule.type : "tag_has");
  const [ruleTagId, setRuleTagId] = useState(typeof rule?.tagId === "string" ? rule.tagId : "");
  const [ruleStageId, setRuleStageId] = useState(typeof rule?.stageId === "string" ? rule.stageId : "");
  // Reglas con número: «vino en los últimos N días» y «tiene al menos N sellos».
  const [ruleDays, setRuleDays] = useState(typeof rule?.days === "number" ? String(rule.days) : "30");
  const [ruleStamps, setRuleStamps] = useState(typeof rule?.stamps === "number" ? String(rule.stamps) : "5");
  // Paso 3: variables, código y Switch.
  const [ruleVarKey, setRuleVarKey] = useState(typeof rule?.key === "string" ? rule.key : "");
  const [ruleVarValue, setRuleVarValue] = useState(typeof rule?.value === "string" ? rule.value : "");
  const [varKey, setVarKey] = useState(typeof c.key === "string" ? c.key : "");
  const [varValue, setVarValue] = useState(typeof c.value === "string" ? c.value : "");
  const [code, setCode] = useState(typeof c.code === "string" ? c.code : DEFAULT_CODE_JS);
  const [cases, setCases] = useState<CaseForm[]>(() => casesFromConfig(c.cases));
  const [ifTrue, setIfTrue] = useState<string>(typeof c.ifTrue === "string" ? c.ifTrue : "continue");
  const [ifFalse, setIfFalse] = useState<string>(typeof c.ifFalse === "string" ? c.ifFalse : "stop");
  // Esperar respuesta: tiempo límite (cantidad + unidad), qué hacer en cada caso y si confirma la cita.
  const replyTimeout = offsetParts(typeof c.timeoutMinutes === "number" ? c.timeoutMinutes : REPLY_TIMEOUT_DEFAULT_MINUTES);
  const [replyAmount, setReplyAmount] = useState(String(replyTimeout.amount));
  const [replyUnit, setReplyUnit] = useState<string>(replyTimeout.unit);
  const [replyBranches, setReplyBranches] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      REPLY_BRANCHES.map((b) => [b.key, typeof c[b.key] === "string" ? (c[b.key] as string) : b.key === "onConfirmed" ? "continue" : "stop"])
    )
  );
  const [confirmBookingOn, setConfirmBookingOn] = useState(typeof c.confirmBooking === "boolean" ? c.confirmBooking : true);
  const [newTagName, setNewTagName] = useState("");
  const [creatingTag, setCreatingTag] = useState(false);
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

  /** La ventana horaria elegida, o nada si el envío es «cuando toque». */
  function buildWindow(): Record<string, unknown> | undefined {
    if (windowMode === "at") return { mode: "at", hour: toNumber(winHour), minute: toNumber(winMinute) };
    if (windowMode === "between") return { mode: "between", fromHour: toNumber(winFrom), toHour: toNumber(winTo) };
    return undefined;
  }

  // Los pasos de cita (esperar hasta la cita) solo se ofrecen en flujos de cita; el que ya existe se conserva.
  // El Switch (varias salidas) y el código viven en el Modo Visual: la lista no los ofrece al crear (uno que ya existe se conserva).
  const stepTypeOptions = useMemo<SearchSelectOption[]>(
    () => STEP_TYPE_OPTIONS.filter((o) => (isBookingFlow || o.value !== "wait_until") && o.value !== "switch" && o.value !== "code_js"),
    [isBookingFlow]
  );
  const mediaOptions = useMemo<SearchSelectOption[]>(
    // 048: lo que WhatsApp no manda (AVIF, un video antiguo de más de 16 MB) no se ofrece: fallaría al enviarse.
    () =>
      media
        .filter((m) => seOfreceEnPaso(m, mediaId))
        .map((m) => ({ value: m.id, label: etiquetaDeOpcion(m) })),
    [media, mediaId]
  );
  const chosenMedia = media.find((m) => m.id === mediaId);
  const avisoMedio = avisoDeMedioEnPaso(chosenMedia);
  const tagOptions = useMemo<SearchSelectOption[]>(() => tags.map((t) => ({ value: t.id, label: t.name })), [tags]);
  const stageOptions = useMemo<SearchSelectOption[]>(() => stages.map((s) => ({ value: s.id, label: s.name })), [stages]);
  const ruleOptions = useMemo<SearchSelectOption[]>(
    () =>
      CONDITION_RULE_TYPES.filter((r) => isBookingFlow || r !== "booking_confirmed" || ruleType === r).map((r) => ({
        value: r,
        label: CONDITION_RULE_LABELS[r],
      })),
    [isBookingFlow, ruleType]
  );

  /** Crea una etiqueta nueva sin salir del diálogo y la deja elegida en el campo `onPick`. */
  async function createTagInline(onPick: (id: string) => void, errorKey: string) {
    const label = newTagName.trim();
    if (!label) return;
    setCreatingTag(true);
    try {
      const { tag } = await apiFetch<{ tag: TagOption }>("/api/tags", { method: "POST", json: { name: label } });
      onTagCreated(tag);
      onPick(tag.id);
      clear(errorKey);
      setNewTagName("");
    } catch (err) {
      setErrors((prev) => ({ ...prev, [errorKey]: describeError(err) }));
    } finally {
      setCreatingTag(false);
    }
  }

  function buildConfig(): Record<string, unknown> {
    const window = buildWindow();
    if (stepType === "wait_reply") {
      return {
        ...(name.trim() && { name: name.trim() }),
        timeoutMinutes:
          replyAmount.trim() === ""
            ? Number.NaN
            : offsetMinutesOf("after", Number(replyAmount), replyUnit as "minutes" | "hours" | "days"),
        ...replyBranches,
        ...(isBookingFlow && { confirmBooking: confirmBookingOn }),
      };
    }
    if (stepType === "add_tag" || stepType === "remove_tag") {
      return { ...(name.trim() && { name: name.trim() }), tagId };
    }
    if (stepType === "set_stage") {
      return { ...(name.trim() && { name: name.trim() }), stageId };
    }
    if (stepType === "send_media") {
      return { ...(name.trim() && { name: name.trim() }), mediaId, ...(caption.trim() && { caption: caption.trim() }) };
    }
    if (stepType === "set_var") {
      return { ...(name.trim() && { name: name.trim() }), key: varKey.trim(), value: varValue };
    }
    if (stepType === "code_js") {
      return { ...(name.trim() && { name: name.trim() }), code };
    }
    if (stepType === "switch") {
      return { ...(name.trim() && { name: name.trim() }), cases: casesToConfig(cases) };
    }
    if (stepType === "condition") {
      return {
        ...(name.trim() && { name: name.trim() }),
        rule:
          ruleType === "var_equals"
            ? { type: ruleType, key: ruleVarKey.trim(), value: ruleVarValue }
            : ruleType === "booking_confirmed" || ruleType === "has_upcoming_booking" || ruleType === "birthday_today"
            ? { type: ruleType }
            : ruleType === "stage_is"
              ? { type: ruleType, stageId: ruleStageId }
              : ruleType === "visited_within_days"
                ? { type: ruleType, days: toNumber(ruleDays) }
                : ruleType === "stamps_gte"
                  ? { type: ruleType, stamps: toNumber(ruleStamps) }
                  : { type: ruleType, tagId: ruleTagId },
        ifTrue,
        ifFalse,
      };
    }
    if (stepType === "delay") {
      return { ...(name.trim() && { name: name.trim() }), amount: toNumber(amount), unit, ...(window && { window }) };
    }
    if (stepType === "wait_until") {
      return {
        ...(name.trim() && { name: name.trim() }),
        anchor: "booking.scheduledAt",
        offsetMinutes: offsetAmount.trim() === "" ? Number.NaN : offsetMinutesOf(offsetDir as "before" | "after", Number(offsetAmount), offsetUnit as "minutes" | "hours" | "days"),
        lateAction,
        ...(window && { window }),
      };
    }
    return {
      ...(name.trim() && { name: name.trim() }),
      ...(content.trim() && { content: content.trim() }),
      ...(templateId && { templateId }),
      ...(templateId && variableCount > 0 && { variables: variables.slice(0, variableCount).map((v) => v.trim()) }),
    };
  }

  /** Las reglas del formulario (las mismas del diálogo y del panel): los errores por campo y el resultado del esquema. */
  function validate() {
    const config = buildConfig();
    const found: Record<string, string> = {};
    if (stepType === "wait_until" && offsetAmount.trim() === "") found.offsetMinutes = "Escribe la cantidad";
    if (stepType === "wait_reply" && replyAmount.trim() === "") found.timeoutMinutes = "Escribe cuánto esperar";
    // El esquema pide un id no vacío, pero «Elige una etiqueta» se entiende mejor que «String must contain 1 character».
    if ((stepType === "add_tag" || stepType === "remove_tag") && !tagId) found.tagId = "Elige una etiqueta";
    if (stepType === "set_stage" && !stageId) found.stageId = "Elige una etapa";
    if (stepType === "send_media" && !mediaId) found.mediaId = "Elige un archivo de la biblioteca";
    if (stepType === "condition" && (ruleType === "tag_has" || ruleType === "tag_missing") && !ruleTagId) found.tagId = "Elige una etiqueta";
    if (stepType === "condition" && ruleType === "stage_is" && !ruleStageId) found.stageId = "Elige una etapa";
    if (stepType === "condition" && ruleType === "var_equals" && !ruleVarKey.trim()) found.varKey = "Escribe el nombre de la variable";
    if (stepType === "set_var" && !varKey.trim()) found.key = "Escribe el nombre de la variable";
    if (stepType === "switch") Object.assign(found, caseErrors(cases));

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
        // Un error de un caso del Switch se pinta bajo ese caso (`case.<n>[.campo]`); los del conjunto, bajo la lista.
        const caseAt = issue.path[1] === "cases" && typeof issue.path[2] === "number" ? issue.path[2] : null;
        const key =
          caseAt !== null
            ? `case.${caseAt}${typeof issue.path[3] === "string" && issue.path[3] !== "rule" ? `.${issue.path[3]}` : issue.path[4] ? `.${String(issue.path[4])}` : ""}`
            : issue.path.length <= 1 || last === "config"
              ? "content"
              : String(last);
        if (!(key in found)) found[key] = issue.message;
      }
    }
    // El servidor no cuenta las variables al guardar y WhatsApp rechaza el envío si falta alguna: se pide aquí.
    if (stepType === "send_whatsapp" && templateId && variableCount > 0 && variables.slice(0, variableCount).some((v) => !v.trim())) {
      found.variables = `Escribe el valor de ${variableCount === 1 ? "{{1}}" : `las ${variableCount} variables`} de la plantilla.`;
    }
    return { found, parsed };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const { found, parsed } = validate();
    setErrors(found);
    if (Object.keys(found).length > 0 || !parsed.success) return;

    setBusy(true);
    try {
      const { step: saved } = await apiFetch<{ step: StepDto }>(
        editing ? `/api/automations/${flowId}/steps/${step.id}` : `/api/automations/${flowId}/steps`,
        // Editar manda solo la configuración: el tipo no cambia y el orden se mueve con las flechas.
        { method: editing ? "PATCH" : "POST", json: editing ? { config: parsed.data.config } : parsed.data }
      );
      onSaved?.(saved);
    } catch (err) {
      setFormError(describeError(err));
      setBusy(false);
    }
  }

  // Panel del lienzo: cada vez que la configuración cambia se valida y, si es válida, se entrega. Una inválida se
  // muestra bajo su campo y no se aplica (el bloque conserva la última configuración buena).
  const liveKey = inline ? JSON.stringify(buildConfig()) : "";
  useEffect(() => {
    if (!inline || !onApply) return;
    const { found, parsed } = validate();
    setErrors(found);
    if (Object.keys(found).length === 0 && parsed.success) onApply(parsed.data.config as Record<string, unknown>);
    // `validate` y `onApply` cambian en cada render; lo que dispara el efecto es la configuración.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);

  const form = (
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
              options={stepTypeOptions}
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
            placeholder={
              stepType === "delay" ? "Esperar un día" : stepType === "wait_until" ? "Un día antes de la cita" : "Saludo de cumpleaños"
            }
            autoComplete="off"
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        {stepType === "wait_reply" ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Esperar hasta" required htmlFor="step-reply-amount" error={errors.timeoutMinutes} hint="Si no responde en ese tiempo, sale por «No responde a tiempo».">
                <Input
                  id="step-reply-amount"
                  inputMode="numeric"
                  value={replyAmount}
                  maxLength={4}
                  aria-invalid={!!errors.timeoutMinutes}
                  disabled={busy}
                  onChange={(e) => {
                    setReplyAmount(e.target.value.replace(/\D/g, ""));
                    clear("timeoutMinutes");
                  }}
                />
              </Field>
              <Field label="Unidad" required htmlFor="step-reply-unit">
                <SearchSelect
                  id="step-reply-unit"
                  value={replyUnit}
                  onChange={setReplyUnit}
                  options={UNIT_OPTIONS}
                  searchPlaceholder="Buscar unidad…"
                  ariaLabel="Unidad de tiempo"
                  disabled={busy}
                />
              </Field>
            </div>
            {!inline && (
            <div className="grid gap-4 sm:grid-cols-2">
              {REPLY_BRANCHES.map((b) => (
                <Field key={b.key} label={b.label} htmlFor={`step-${b.key}`}>
                  <SearchSelect
                    id={`step-${b.key}`}
                    value={replyBranches[b.key] ?? "stop"}
                    onChange={(v) => setReplyBranches((prev) => ({ ...prev, [b.key]: v }))}
                    options={BRANCH_OPTIONS}
                    searchPlaceholder="Buscar…"
                    ariaLabel={b.label}
                    disabled={busy}
                  />
                </Field>
              ))}
            </div>
            )}
            {isBookingFlow && (
              <label className="flex items-center justify-between gap-3 rounded-md border bg-subtle px-3 py-2.5">
                <span className="text-sm">
                  <span className="font-medium">Confirmar la cita si confirma</span>
                  <span className="block text-xs text-text-3">Igual que el botón «Confirmar asistencia» de la agenda.</span>
                </span>
                <Switch size="sm" checked={confirmBookingOn} label="Confirmar la cita si confirma" onCheckedChange={setConfirmBookingOn} />
              </label>
            )}
            <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-2">
              Entiende respuestas como «sí», «no puedo» o «quiero reagendar»; si no está seguro, cuenta como «responde
              otra cosa». Un sticker o una imagen sin texto no cuenta como respuesta.{" "}
              {inline
                ? "Conecta cada salida del bloque (Confirma, No, Reagendar, Otra cosa, Sin respuesta) a lo que debe pasar; una salida sin conectar termina el flujo."
                : "Con «Terminar el flujo» el flujo se detiene; con «Continuar» sigue con el paso que viene."}
            </p>
          </>
        ) : stepType === "add_tag" || stepType === "remove_tag" ? (
          <TagField
            label={stepType === "add_tag" ? "Etiqueta que se agrega" : "Etiqueta que se quita"}
            value={tagId}
            onChange={(v) => {
              setTagId(v);
              clear("tagId");
            }}
            options={tagOptions}
            tags={tags}
            error={errors.tagId}
            busy={busy || creatingTag}
            newName={newTagName}
            onNewName={setNewTagName}
            onCreate={() => void createTagInline(setTagId, "tagId")}
            hint={
              stepType === "add_tag"
                ? "Si el contacto ya la tiene, no pasa nada."
                : "Si el contacto no la tiene, no pasa nada."
            }
            allowCreate={stepType === "add_tag"}
          />
        ) : stepType === "set_stage" ? (
          <>
            <Field label="Mover a la etapa" required htmlFor="step-stage" error={errors.stageId}>
              <SearchSelect
                id="step-stage"
                value={stageId}
                onChange={(v) => {
                  setStageId(v);
                  clear("stageId");
                }}
                options={stageOptions}
                placeholder="Elige una etapa"
                searchPlaceholder="Buscar etapa…"
                ariaLabel="Etapa de destino"
                invalid={!!errors.stageId}
                disabled={busy}
              />
            </Field>
            <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-2">
              Mueve al lead del contacto a esa etapa y lo deja en el historial del embudo. Para evitar bucles, este
              movimiento <strong>no</strong> activa otros flujos de «Cambio de etapa». Si el contacto no tiene lead, el
              paso falla y se ve en el historial.
            </p>
          </>
        ) : stepType === "condition" ? (
          <>
            <Field label="Si se cumple que…" required htmlFor="step-rule">
              <SearchSelect
                id="step-rule"
                value={ruleType}
                onChange={(v) => {
                  setRuleType(v);
                  clear("tagId", "stageId", "days", "stamps");
                }}
                options={ruleOptions}
                searchPlaceholder="Buscar regla…"
                ariaLabel="Regla de la condición"
                disabled={busy}
              />
            </Field>
            {(ruleType === "tag_has" || ruleType === "tag_missing") && (
              <TagField
                label="Etiqueta"
                value={ruleTagId}
                onChange={(v) => {
                  setRuleTagId(v);
                  clear("tagId");
                }}
                options={tagOptions}
                tags={tags}
                error={errors.tagId}
                busy={busy || creatingTag}
                newName={newTagName}
                onNewName={setNewTagName}
                onCreate={() => void createTagInline(setRuleTagId, "tagId")}
                allowCreate={false}
              />
            )}
            {ruleType === "stage_is" && (
              <Field label="Etapa" required htmlFor="step-rule-stage" error={errors.stageId}>
                <SearchSelect
                  id="step-rule-stage"
                  value={ruleStageId}
                  onChange={(v) => {
                    setRuleStageId(v);
                    clear("stageId");
                  }}
                  options={stageOptions}
                  placeholder="Elige una etapa"
                  searchPlaceholder="Buscar etapa…"
                  ariaLabel="Etapa de la condición"
                  invalid={!!errors.stageId}
                  disabled={busy}
                />
              </Field>
            )}
            {ruleType === "var_equals" && (
              <VarEqualsFields
                idPrefix="step-rule-var"
                varKey={ruleVarKey}
                varValue={ruleVarValue}
                onKey={(v) => {
                  setRuleVarKey(v);
                  clear("varKey");
                }}
                onValue={setRuleVarValue}
                error={errors.varKey}
                disabled={busy}
              />
            )}
            {ruleType === "booking_confirmed" && (
              <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-2">
                Se mira al llegar a este paso: si el cliente confirmó mientras el flujo esperaba, cuenta como confirmada.
              </p>
            )}
            {ruleType === "has_upcoming_booking" && (
              <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-2">
                Cuenta una cita agendada que aún no llega (no cuenta las canceladas ni las pasadas). Con la rama «No» sirve para
                «no tiene cita».
              </p>
            )}
            {ruleType === "visited_within_days" && (
              <Field
                label="En los últimos (días)"
                required
                htmlFor="step-rule-days"
                error={errors.days}
                hint="Cuenta citas marcadas como realizadas. Con la rama «No»: no vino en ese tiempo, o nunca vino."
              >
                <Input
                  id="step-rule-days"
                  inputMode="numeric"
                  value={ruleDays}
                  maxLength={4}
                  aria-invalid={!!errors.days}
                  disabled={busy}
                  onChange={(e) => {
                    setRuleDays(e.target.value.replace(/\D/g, ""));
                    clear("days");
                  }}
                />
              </Field>
            )}
            {ruleType === "stamps_gte" && (
              <Field
                label="Sellos mínimos"
                required
                htmlFor="step-rule-stamps"
                error={errors.stamps}
                hint="Los sellos que tiene hoy en su tarjeta de fidelidad."
              >
                <Input
                  id="step-rule-stamps"
                  inputMode="numeric"
                  value={ruleStamps}
                  maxLength={4}
                  aria-invalid={!!errors.stamps}
                  disabled={busy}
                  onChange={(e) => {
                    setRuleStamps(e.target.value.replace(/\D/g, ""));
                    clear("stamps");
                  }}
                />
              </Field>
            )}
            {ruleType === "birthday_today" && (
              <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-2">
                Mira el día y el mes de cumpleaños del contacto, en la zona horaria de tu negocio.
              </p>
            )}
            {!inline && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Si es verdadero" htmlFor="step-if-true">
                <SearchSelect
                  id="step-if-true"
                  value={ifTrue}
                  onChange={setIfTrue}
                  options={BRANCH_OPTIONS}
                  searchPlaceholder="Buscar…"
                  ariaLabel="Acción si es verdadero"
                  disabled={busy}
                />
              </Field>
              <Field label="Si es falso" htmlFor="step-if-false">
                <SearchSelect
                  id="step-if-false"
                  value={ifFalse}
                  onChange={setIfFalse}
                  options={BRANCH_OPTIONS}
                  searchPlaceholder="Buscar…"
                  ariaLabel="Acción si es falso"
                  disabled={busy}
                />
              </Field>
            </div>
            )}
            <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-2">
              {inline
                ? "Conecta la salida «Sí» y la salida «No» a lo que debe pasar en cada caso; una salida sin conectar termina el flujo."
                : "Hoy los pasos se ejecutan en fila: la condición decide si el flujo sigue, se salta el siguiente paso o termina. Más adelante cada resultado podrá llevar a un camino distinto."}
            </p>
          </>
        ) : stepType === "set_var" ? (
          <SetVarFields
            varKey={varKey}
            varValue={varValue}
            onKey={(v) => {
              setVarKey(v);
              clear("key");
            }}
            onValue={(v) => {
              setVarValue(v);
              clear("value");
            }}
            errors={errors}
            disabled={busy}
          />
        ) : stepType === "code_js" ? (
          <CodeJsFields
            code={code}
            onCode={(v) => {
              setCode(v);
              clear("code");
            }}
            error={errors.code}
            disabled={busy}
          />
        ) : stepType === "switch" ? (
          <SwitchFields
            cases={cases}
            onChange={(next) => {
              setCases(next);
              setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith("case.") && k !== "cases")));
            }}
            tagOptions={tagOptions}
            stageOptions={stageOptions}
            isBookingFlow={isBookingFlow}
            errors={errors}
            disabled={busy}
          />
        ) : stepType === "wait_until" ? (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Cantidad" required htmlFor="step-offset" error={errors.offsetMinutes}>
                <Input
                  id="step-offset"
                  inputMode="numeric"
                  value={offsetAmount}
                  maxLength={4}
                  aria-invalid={!!errors.offsetMinutes}
                  disabled={busy}
                  onChange={(e) => {
                    setOffsetAmount(e.target.value.replace(/\D/g, ""));
                    clear("offsetMinutes");
                  }}
                />
              </Field>
              <Field label="Unidad" required htmlFor="step-offset-unit">
                <SearchSelect
                  id="step-offset-unit"
                  value={offsetUnit}
                  onChange={setOffsetUnit}
                  options={UNIT_OPTIONS}
                  searchPlaceholder="Buscar unidad…"
                  ariaLabel="Unidad de tiempo"
                  disabled={busy}
                />
              </Field>
              <Field label="Respecto a la cita" required htmlFor="step-offset-dir">
                <SearchSelect
                  id="step-offset-dir"
                  value={offsetDir}
                  onChange={setOffsetDir}
                  options={DIRECTION_OPTIONS}
                  searchPlaceholder="Buscar…"
                  ariaLabel="Antes o después de la cita"
                  disabled={busy}
                />
              </Field>
            </div>
            {!inline && (
            <Field
              label="Si esa hora ya pasó"
              htmlFor="step-late"
              hint="Pasa cuando la cita se agenda con menos anticipación (p. ej. un recordatorio de «1 día antes» para una cita de hoy)."
            >
              <SearchSelect
                id="step-late"
                value={lateAction}
                onChange={setLateAction}
                options={LATE_OPTIONS}
                searchPlaceholder="Buscar…"
                ariaLabel="Qué hacer si la hora ya pasó"
                disabled={busy}
              />
            </Field>
            )}
            <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-2">
              Solo para flujos de citas. Los pasos que siguen se ejecutan a esa hora, y se cancelan solos si la cita se
              cancela o se reprograma.
              {inline && " Conecta la salida «Si ya pasó» a lo que debe hacerse cuando esa hora ya pasó."}
            </p>
          </>
        ) : stepType === "send_media" ? (
          <>
            <Field label="Archivo" required htmlFor="step-media" error={errors.mediaId} hint="Imágenes, videos (hasta 16 MB) y PDF de tu biblioteca de Medios.">
              <SearchSelect
                id="step-media"
                value={mediaId}
                onChange={setMediaId}
                options={mediaOptions}
                emptyLabel="Sin elegir"
                searchPlaceholder="Buscar archivo…"
                ariaLabel="Archivo a enviar"
                disabled={busy}
              />
              {media.length === 0 && (
                <p className="text-xs text-text-3">
                  Aún no tienes archivos.{" "}
                  <Link href="/medios" className="font-semibold underline">
                    Sube uno en Medios
                  </Link>
                  .
                </p>
              )}
              {mediaId && !chosenMedia && <p className="text-xs text-danger-text">Ese archivo ya no está en la biblioteca: elige otro.</p>}
            </Field>
            {avisoMedio && (
              <p
                role={avisoMedio.tono === "error" ? "alert" : "status"}
                className={
                  avisoMedio.tono === "error"
                    ? "rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-xs text-danger-text"
                    : "rounded-md border bg-subtle px-3 py-2 text-xs text-text-2"
                }
              >
                {avisoMedio.texto}
              </p>
            )}
            {chosenMedia && (
              <div className="overflow-hidden rounded-md border bg-subtle">
                {chosenMedia.tipo === "document" ? (
                  <a href={chosenMedia.ruta} target="_blank" rel="noreferrer" className="block px-3 py-4 text-sm font-semibold underline">
                    PDF · {chosenMedia.nombre}
                  </a>
                ) : chosenMedia.tipo === "video" ? (
                  <video src={chosenMedia.urlVariante ?? chosenMedia.ruta} controls preload="metadata" className="max-h-56 w-full bg-black" aria-label={`Vista previa de ${chosenMedia.nombre}`} />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={chosenMedia.ruta} alt={`Vista previa de ${chosenMedia.nombre}`} className="max-h-56 w-full object-contain" />
                )}
              </div>
            )}
            <Field label="Leyenda (opcional)" htmlFor="step-caption" error={errors.caption} hint="Puedes usar {{name}}, {{fecha}}, {{hora}} y {{servicio}}.">
              <Textarea
                id="step-caption"
                rows={3}
                maxLength={1024}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                disabled={busy}
              />
            </Field>
            <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-2">
              Un archivo no tiene plantilla: solo se envía mientras la ventana de 24 h del cliente está abierta (si no, el
              paso falla y queda en el historial). Si el cliente pidió la baja, no se envía.
            </p>
          </>
        ) : stepType === "delay" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cantidad" required htmlFor="step-amount" error={errors.amount}>
              <Input
                id="step-amount"
                inputMode="numeric"
                value={amount}
                maxLength={4}
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
                options={DELAY_UNIT_OPTIONS}
                searchPlaceholder="Buscar unidad…"
                ariaLabel="Unidad de tiempo"
                disabled={busy}
              />
            </Field>
            <p className="text-xs text-text-3 sm:col-span-2">
              El motor revisa las esperas cada ~10 segundos: una espera en segundos puede tardar hasta ~10 s más. Máximo 3600
              segundos; en minutos, horas y días, 366.
            </p>
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

        {(stepType === "delay" || stepType === "wait_until") && (
          <fieldset className="space-y-3 rounded-md border bg-subtle px-3 py-3" disabled={busy}>
            <Field
              label="Hora de envío"
              htmlFor="step-window-mode"
              hint="En la hora del negocio (Ajustes → Marca). Si cae fuera, el envío se retrasa a la próxima hora permitida: nunca se adelanta."
            >
              <SearchSelect
                id="step-window-mode"
                value={windowMode}
                onChange={setWindowMode}
                options={WINDOW_OPTIONS}
                searchPlaceholder="Buscar…"
                ariaLabel="Hora de envío"
              />
            </Field>
            {windowMode === "at" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Hora (0–23)" required htmlFor="step-win-hour" error={errors.hour}>
                  <Input
                    id="step-win-hour"
                    inputMode="numeric"
                    maxLength={2}
                    value={winHour}
                    aria-invalid={!!errors.hour}
                    onChange={(e) => {
                      setWinHour(e.target.value.replace(/\D/g, ""));
                      clear("hour");
                    }}
                  />
                </Field>
                <Field label="Minutos (0–59)" htmlFor="step-win-minute" error={errors.minute}>
                  <Input
                    id="step-win-minute"
                    inputMode="numeric"
                    maxLength={2}
                    value={winMinute}
                    aria-invalid={!!errors.minute}
                    onChange={(e) => {
                      setWinMinute(e.target.value.replace(/\D/g, ""));
                      clear("minute");
                    }}
                  />
                </Field>
              </div>
            )}
            {windowMode === "between" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Desde (hora 0–23)" required htmlFor="step-win-from" error={errors.fromHour}>
                  <Input
                    id="step-win-from"
                    inputMode="numeric"
                    maxLength={2}
                    value={winFrom}
                    aria-invalid={!!errors.fromHour}
                    onChange={(e) => {
                      setWinFrom(e.target.value.replace(/\D/g, ""));
                      clear("fromHour", "toHour");
                    }}
                  />
                </Field>
                <Field label="Hasta (hora 1–24)" required htmlFor="step-win-to" error={errors.toHour}>
                  <Input
                    id="step-win-to"
                    inputMode="numeric"
                    maxLength={2}
                    value={winTo}
                    aria-invalid={!!errors.toHour}
                    onChange={(e) => {
                      setWinTo(e.target.value.replace(/\D/g, ""));
                      clear("toHour");
                    }}
                  />
                </Field>
              </div>
            )}
          </fieldset>
        )}

        {!inline && (
          <ModalFooter error={formError}>
            <Button type="submit" disabled={busy}>
              {busy ? "Guardando…" : editing ? "Guardar cambios" : "Agregar paso"}
            </Button>
          </ModalFooter>
        )}
      </form>
  );

  if (inline) return form;
  return (
    <Modal
      title={editing ? "Editar paso" : "Agregar paso"}
      description="Cada paso se ejecuta en orden, uno después del otro."
      onClose={onClose ?? (() => undefined)}
      busy={busy}
      size="lg"
    >
      {form}
    </Modal>
  );
}

/** Elegir una etiqueta del negocio y, si se permite, crear una nueva sin salir del diálogo. */
function TagField({
  label,
  value,
  onChange,
  options,
  tags,
  error,
  busy,
  newName,
  onNewName,
  onCreate,
  hint,
  allowCreate,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  options: SearchSelectOption[];
  tags: TagOption[];
  error?: string;
  busy: boolean;
  newName: string;
  onNewName: (v: string) => void;
  onCreate: () => void;
  hint?: string;
  allowCreate: boolean;
}) {
  const chosen = tags.find((t) => t.id === value) ?? null;
  return (
    <div className="space-y-3">
      <Field label={label} required htmlFor="step-tag" error={error} hint={hint}>
        <SearchSelect
          id="step-tag"
          value={value}
          onChange={onChange}
          options={options}
          placeholder={options.length ? "Elige una etiqueta" : "Aún no hay etiquetas"}
          searchPlaceholder="Buscar etiqueta…"
          ariaLabel="Etiqueta"
          invalid={!!error}
          disabled={busy}
        />
        {chosen && (
          <span className={`mt-1 inline-flex w-fit rounded-full border px-2 py-0.5 text-xs font-medium ${tagColorClass(chosen.color)}`}>
            {chosen.name}
          </span>
        )}
      </Field>
      {allowCreate && (
        <div className="flex items-end gap-2">
          <Field label="¿No está? Crea una nueva" htmlFor="step-tag-new" className="flex-1">
            <Input
              id="step-tag-new"
              value={newName}
              maxLength={40}
              placeholder="Cita pendiente"
              autoComplete="off"
              disabled={busy}
              onChange={(e) => onNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onCreate();
                }
              }}
            />
          </Field>
          <Button type="button" variant="outline" disabled={busy || !newName.trim()} onClick={onCreate}>
            Crear
          </Button>
        </div>
      )}
    </div>
  );
}
