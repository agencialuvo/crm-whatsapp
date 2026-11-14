import {
  BIRTHDAY_DEFAULT_HOUR,
  type BranchAction,
  type ConditionRule,
  type ConditionRuleType,
  type SendWindow,
  type WaitLateAction,
} from "@/lib/automation";
import { FLOW_TRIGGER_TYPES, type FlowTriggerType } from "@/lib/automation-schemas";

/**
 * Automatizaciones — tipos y textos de las pantallas (compartidos y sin React, para probarlos).
 *
 * Los tipos describen lo que devuelve `/api/automations`; las funciones convierten esos datos en las
 * frases que lee la persona («Cada cumpleaños, a las 10:00») y deciden el orden de los pasos con el
 * mismo criterio que el servidor: arriba antes que abajo, izquierda antes que derecha.
 */

export type FlowListItem = {
  id: string;
  name: string;
  triggerType: string;
  active: boolean;
  createdAt: string;
  stepCount: number;
};

export type FlowDto = {
  id: string;
  name: string;
  triggerType: string;
  triggerConfig: Record<string, unknown> | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type StepDto = {
  id: string;
  flowId: string;
  stepType: string;
  config: Record<string, unknown>;
  positionX: number;
  positionY: number;
  order?: number;
};

export type StageOption = { id: string; name: string };
export type TagOption = { id: string; name: string; color: string };
export type TemplateOption = { id: string; name: string; language: string; body: string; status: string };

/* ─── Disparadores ─── */

export const TRIGGER_LABELS: Record<string, string> = {
  birthday: "Cumpleaños",
  stage_changed: "Cambio de etapa",
  lead_created: "Lead nuevo",
  manual: "Manual",
  booking_reminder: "Recordatorio de cita",
  tag_added: "Etiqueta agregada",
  booking_created: "Cita agendada",
  booking_confirmed: "Cita confirmada",
  booking_no_show: "Cliente no asistió",
};

/**
 * Los disparadores que la pantalla deja crear: los que hoy tienen quién los dispare. `manual` existe en
 * la API, pero todavía no hay un botón ni una ruta que encole a alguien, así que ofrecerlo sería crear
 * un flujo que nunca corre.
 */
export const CREATABLE_TRIGGERS = FLOW_TRIGGER_TYPES.filter((t) => t !== "manual") satisfies readonly FlowTriggerType[];

export const TRIGGER_HINTS: Record<(typeof CREATABLE_TRIGGERS)[number], string> = {
  birthday: "Saluda a cada cliente el día de su cumpleaños, a la hora que elijas.",
  stage_changed: "Se activa cuando un lead pasa a una etapa del pipeline.",
  lead_created: "Se activa cuando entra un lead nuevo.",
  booking_created:
    "Se activa al agendar una cita (y de nuevo si se reprograma). Ideal para recordatorios: usa «Esperar hasta la cita».",
  booking_confirmed: "Se activa cuando se confirma la asistencia a una cita.",
  booking_no_show: "Se activa cuando una cita se marca como «No asistió».",
};

export const triggerLabel = (type: string): string => TRIGGER_LABELS[type] ?? type;

export const hourLabel = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

/** `daysOffset` de un flujo de cumpleaños (0, -1, -2…); lo ausente o inválido cuenta como 0. */
export function offsetOf(config: Record<string, unknown> | null): number {
  const v = config?.daysOffset;
  return typeof v === "number" && Number.isInteger(v) && v < 0 ? v : 0;
}

/** «1 día antes», «2 días antes»; `null` si es el mismo día. */
export function offsetShort(offset: number): string | null {
  const n = Math.abs(offset);
  return n === 0 ? null : `${n} ${n === 1 ? "día" : "días"} antes`;
}

/** Opción del desplegable «Momento del envío»: «El mismo día del cumpleaños», «1 día antes del cumpleaños»… */
export function offsetOptionLabel(offset: number): string {
  const short = offsetShort(offset);
  return short ? `${short} del cumpleaños` : "El mismo día del cumpleaños";
}

/** Lo que ofrece la pantalla; un flujo creado por la API con otro valor lo conserva al editarse. */
export const BIRTHDAY_OFFSETS = [0, -1, -2] as const;

/** El disparador y sus reglas en una frase. `stages` resuelve el nombre de la etapa configurada. */
export function describeTrigger(
  type: string,
  config: Record<string, unknown> | null,
  stages: readonly StageOption[] = []
): string {
  switch (type) {
    case "birthday": {
      const hour = typeof config?.hour === "number" ? config.hour : BIRTHDAY_DEFAULT_HOUR;
      const before = offsetShort(offsetOf(config));
      return `Cada cumpleaños${before ? ` (${before})` : ""}, a las ${hourLabel(hour)}`;
    }
    case "stage_changed": {
      const id = config?.toStageId;
      if (typeof id !== "string") return "Cuando un lead cambia de etapa";
      const name = stages.find((s) => s.id === id)?.name;
      return name ? `Cuando un lead pasa a «${name}»` : "Cuando un lead pasa a una etapa que ya no existe";
    }
    case "lead_created":
      return "Cuando entra un lead nuevo";
    case "booking_created":
      return "Cuando se agenda (o se reprograma) una cita";
    case "booking_confirmed":
      return "Cuando se confirma la asistencia a una cita";
    case "booking_no_show":
      return "Cuando una cita se marca como «No asistió»";
    case "manual":
      return "Se inicia a mano";
    default:
      return triggerLabel(type);
  }
}

/* ─── Pasos ─── */

export const STEP_LABELS: Record<string, string> = {
  delay: "Esperar",
  send_whatsapp: "Enviar mensaje de WhatsApp",
  condition: "Condición (si / si no)",
  add_tag: "Agregar etiqueta",
  remove_tag: "Quitar etiqueta",
  set_stage: "Mover de etapa",
  wait_until: "Esperar hasta la cita",
};

export const stepLabel = (type: string): string => STEP_LABELS[type] ?? type;

export const DELAY_UNIT_LABELS = {
  minutes: { one: "minuto", other: "minutos" },
  hours: { one: "hora", other: "horas" },
  days: { one: "día", other: "días" },
} as const;

export function describeDelay(amount: number, unit: string): string {
  const label = DELAY_UNIT_LABELS[unit as keyof typeof DELAY_UNIT_LABELS];
  return `Esperar ${amount} ${label ? (amount === 1 ? label.one : label.other) : unit}`;
}

/* ─── Espera anclada a la cita y ventana horaria ─── */

export type OffsetParts = { direction: "before" | "after"; amount: number; unit: "minutes" | "hours" | "days" };

/** Un desplazamiento en minutos como la persona lo escribiría: −1440 → «1 día antes»; 90 → «90 minutos después». */
export function offsetParts(minutes: number): OffsetParts {
  const abs = Math.abs(minutes);
  const direction = minutes < 0 ? "before" : "after";
  if (abs > 0 && abs % 1440 === 0) return { direction, amount: abs / 1440, unit: "days" };
  if (abs > 0 && abs % 60 === 0) return { direction, amount: abs / 60, unit: "hours" };
  return { direction, amount: abs, unit: "minutes" };
}

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 } as const;

/** Lo contrario de `offsetParts`: cantidad, unidad y «antes/después» → minutos con signo. */
export function offsetMinutesOf(direction: "before" | "after", amount: number, unit: keyof typeof UNIT_MINUTES): number {
  const total = amount * UNIT_MINUTES[unit];
  return direction === "before" ? -total : total;
}

/** «El día de la cita», «1 día antes de la cita», «2 horas antes de la cita», «30 minutos después de la cita». */
export function describeBookingOffset(minutes: number): string {
  if (minutes === 0) return "A la hora de la cita";
  const { direction, amount, unit } = offsetParts(minutes);
  const label = DELAY_UNIT_LABELS[unit];
  return `${amount} ${amount === 1 ? label.one : label.other} ${direction === "before" ? "antes" : "después"} de la cita`;
}

/** La ventana horaria en una frase corta, o null si no hay. */
export function describeWindow(window: SendWindow | Record<string, unknown> | null | undefined): string | null {
  if (!window || typeof window !== "object") return null;
  const w = window as Record<string, unknown>;
  if (w.mode === "at" && typeof w.hour === "number") {
    const minute = typeof w.minute === "number" ? w.minute : 0;
    return `a las ${String(w.hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  if (w.mode === "between" && typeof w.fromHour === "number" && typeof w.toHour === "number") {
    return `solo entre las ${hourLabel(w.fromHour)} y las ${hourLabel(w.toHour === 24 ? 0 : w.toHour)}${w.toHour === 24 ? " (medianoche)" : ""}`;
  }
  return null;
}

export const WAIT_LATE_LABELS: Record<WaitLateAction, string> = {
  skip_next: "Omitir el mensaje que sigue y continuar",
  continue: "Continuar de inmediato",
  stop: "Terminar el flujo",
};

/** Texto con tope de largo para un resumen en una línea. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/* ─── Condición ─── */

export const CONDITION_RULE_LABELS: Record<ConditionRuleType, string> = {
  tag_has: "El contacto tiene la etiqueta",
  tag_missing: "El contacto NO tiene la etiqueta",
  booking_confirmed: "La cita está confirmada",
  stage_is: "El lead está en la etapa",
};

export const BRANCH_ACTION_LABELS: Record<BranchAction, string> = {
  continue: "Continuar con el siguiente paso",
  skip_next: "Omitir el siguiente paso y continuar",
  stop: "Terminar el flujo",
};

/** Lo que resuelve nombres de etiquetas y etapas en las tarjetas (por id: el motor nunca compara nombres). */
export type StepRefs = { tags?: readonly TagOption[]; stages?: readonly StageOption[] };

/** La regla en una frase: «El contacto tiene la etiqueta «VIP»». */
export function describeRule(rule: ConditionRule | Record<string, unknown> | null | undefined, refs: StepRefs = {}): string {
  const r = (rule ?? {}) as { type?: string; tagId?: string; stageId?: string };
  const tag = (id?: string) => {
    const n = refs.tags?.find((t) => t.id === id)?.name;
    return n ? `«${n}»` : "una etiqueta que ya no existe";
  };
  const stage = (id?: string) => {
    const n = refs.stages?.find((st) => st.id === id)?.name;
    return n ? `«${n}»` : "una etapa que ya no existe";
  };
  switch (r.type) {
    case "tag_has":
      return `El contacto tiene la etiqueta ${tag(r.tagId)}`;
    case "tag_missing":
      return `El contacto no tiene la etiqueta ${tag(r.tagId)}`;
    case "booking_confirmed":
      return "La cita está confirmada";
    case "stage_is":
      return `El lead está en la etapa ${stage(r.stageId)}`;
    default:
      return "Condición sin configurar";
  }
}

/** Título y detalle de un paso, para su tarjeta. `templates` resuelve la plantilla; `refs`, etiquetas y etapas. */
export function describeStep(
  step: Pick<StepDto, "stepType" | "config">,
  templates: readonly TemplateOption[] = [],
  refs: StepRefs = {}
): { title: string; detail: string | null } {
  const c = step.config;
  if (step.stepType === "add_tag" || step.stepType === "remove_tag") {
    const n = refs.tags?.find((t) => t.id === c.tagId)?.name;
    const verb = step.stepType === "add_tag" ? "Agregar" : "Quitar";
    return { title: `${verb} etiqueta ${n ? `«${n}»` : "(ya no existe)"}`, detail: null };
  }
  if (step.stepType === "set_stage") {
    const n = refs.stages?.find((st) => st.id === c.stageId)?.name;
    return { title: `Mover a la etapa ${n ? `«${n}»` : "(ya no existe)"}`, detail: "No dispara otros flujos de cambio de etapa." };
  }
  if (step.stepType === "condition") {
    const t = (c.ifTrue as BranchAction) ?? "continue";
    const f = (c.ifFalse as BranchAction) ?? "stop";
    return {
      title: `Si: ${describeRule(c.rule as Record<string, unknown>, refs)}`,
      detail: `Sí → ${BRANCH_ACTION_LABELS[t].toLowerCase()} · No → ${BRANCH_ACTION_LABELS[f].toLowerCase()}`,
    };
  }
  if (step.stepType === "delay") {
    const amount = typeof c.amount === "number" ? c.amount : 0;
    const window = describeWindow(c.window as Record<string, unknown> | undefined);
    return { title: describeDelay(amount, String(c.unit ?? "")), detail: window ? `Envía ${window}` : null };
  }
  if (step.stepType === "wait_until") {
    const offset = typeof c.offsetMinutes === "number" ? c.offsetMinutes : 0;
    const window = describeWindow(c.window as Record<string, unknown> | undefined);
    const late = WAIT_LATE_LABELS[(c.lateAction as WaitLateAction) ?? "skip_next"] ?? WAIT_LATE_LABELS.skip_next;
    return {
      title: offset === 0 ? "Esperar hasta la hora de la cita" : `Esperar hasta ${describeBookingOffset(offset).toLowerCase()}`,
      detail: [window ? `Envía ${window}` : null, `Si ya pasó: ${late.toLowerCase()}`].filter(Boolean).join(" · "),
    };
  }
  if (step.stepType === "send_whatsapp") {
    const name = typeof c.name === "string" && c.name.trim() ? c.name.trim() : null;
    const content = typeof c.content === "string" && c.content.trim() ? c.content : null;
    const tpl = typeof c.templateId === "string" ? templates.find((t) => t.id === c.templateId) : undefined;
    const parts = [
      content ? `«${clip(content, 140)}»` : null,
      typeof c.templateId === "string" ? `Plantilla: ${tpl ? tpl.name : "ya no existe"}` : null,
    ].filter((p): p is string => p !== null);
    return { title: name ?? stepLabel(step.stepType), detail: parts.join(" · ") || null };
  }
  return { title: stepLabel(step.stepType), detail: "Este tipo de paso todavía no se puede ejecutar." };
}

/* ─── Orden ─── */

/** Separación entre pasos al reordenar: deja hueco para intercalar sin renumerar todo. */
export const STEP_GAP = 100;

/** El orden de ejecución, el mismo del servidor: `position_y`, `position_x` y el id para desempatar. */
export function sortSteps<T extends Pick<StepDto, "id" | "positionX" | "positionY">>(steps: readonly T[]): T[] {
  return [...steps].sort(
    (a, b) => a.positionY - b.positionY || a.positionX - b.positionX || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Dónde cae un paso nuevo: al final de la lista. */
export function nextPositionY(steps: readonly Pick<StepDto, "positionY">[]): number {
  return steps.length === 0 ? 0 : Math.max(...steps.map((s) => s.positionY)) + STEP_GAP;
}

/**
 * Mover el paso `from` a la posición `to`. Devuelve SOLO los pasos que cambian de lugar, con sus
 * posiciones ya normalizadas (una columna: `x = 0`, `y = índice × STEP_GAP`), listos para un PATCH cada uno.
 */
export function reorderPositions(
  steps: readonly Pick<StepDto, "id" | "positionX" | "positionY">[],
  from: number,
  to: number
): { id: string; positionX: number; positionY: number }[] {
  if (from === to || from < 0 || to < 0 || from >= steps.length || to >= steps.length) return [];
  const ordered = sortSteps(steps);
  const [moved] = ordered.splice(from, 1);
  if (!moved) return [];
  ordered.splice(to, 0, moved);
  const next = ordered.map((s, i) => ({ id: s.id, positionX: 0, positionY: i * STEP_GAP }));
  const before = new Map(steps.map((s) => [s.id, s]));
  return next.filter((n) => {
    const b = before.get(n.id);
    return !b || b.positionX !== n.positionX || b.positionY !== n.positionY;
  });
}

/* ─── Encender ─── */

/** Encender exige al menos un paso: la misma regla que el servidor, para avisar antes de pedirlo. */
export function activationBlock(stepCount: number, active: boolean): string | null {
  if (active) return null;
  return stepCount === 0 ? "Agrega al menos un paso para poder encenderlo." : null;
}
