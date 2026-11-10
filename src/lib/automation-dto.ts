import { BIRTHDAY_DEFAULT_HOUR } from "@/lib/automation";
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
export type TemplateOption = { id: string; name: string; language: string; body: string; status: string };

/* ─── Disparadores ─── */

export const TRIGGER_LABELS: Record<string, string> = {
  birthday: "Cumpleaños",
  stage_changed: "Cambio de etapa",
  lead_created: "Lead nuevo",
  manual: "Manual",
  booking_reminder: "Recordatorio de cita",
  tag_added: "Etiqueta agregada",
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
  condition: "Condición",
  add_tag: "Agregar etiqueta",
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

/** Texto con tope de largo para un resumen en una línea. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Título y detalle de un paso, para su tarjeta. `templates` resuelve el nombre de la plantilla. */
export function describeStep(
  step: Pick<StepDto, "stepType" | "config">,
  templates: readonly TemplateOption[] = []
): { title: string; detail: string | null } {
  const c = step.config;
  if (step.stepType === "delay") {
    const amount = typeof c.amount === "number" ? c.amount : 0;
    return { title: describeDelay(amount, String(c.unit ?? "")), detail: null };
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
