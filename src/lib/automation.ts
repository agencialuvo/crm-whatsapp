import { z } from "zod";
import { addDaysISO, dayIsoInTz, zonedWallClockToUtc } from "@/lib/time/slots";

/**
 * Motor de automatizaciones — reglas puras (sin base de datos ni red).
 *
 * Todo lo que decide el motor y se puede decidir con datos en la mano vive aquí, para probarlo
 * con tablas de casos: el backoff, la regla de la ventana de 24 h de Meta, los contratos de la
 * configuración de cada paso y el relleno de variables.
 */

/* ─── Reintentos ─── */

export const MAX_ATTEMPTS_DEFAULT = 5;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 60 * 60_000;

/**
 * Espera antes del próximo intento, con backoff exponencial: 30 s, 1 min, 2 min, 4 min… con tope
 * de 1 h. `attemptsMade` es la cantidad de intentos ya iniciados (el primero fallido → 1).
 */
export function backoffMs(attemptsMade: number): number {
  const n = Number.isFinite(attemptsMade) ? Math.max(1, Math.floor(attemptsMade)) : 1;
  // Tope del exponente: evita desbordar con un contador absurdo; el resultado igual se acota.
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20));
}

/* ─── Configuración de los pasos (el JSON `automation_step.config`) ─── */

/** Texto con variables como `{{name}}`. Lo escribe el dueño del negocio. */
const messageText = z.string().trim().min(1).max(4096);

export const sendWhatsappConfigSchema = z
  .object({
    /** Nombre opcional del nodo, para reconocerlo en el historial. */
    name: z.string().trim().max(120).optional(),
    /** Mensaje de texto libre: solo dentro de la ventana de 24 h. */
    content: messageText.optional(),
    /** Plantilla aprobada (`template.id`): la única vía fuera de la ventana. */
    templateId: z.string().trim().min(1).optional(),
    /** Valores de {{1}}, {{2}}… de la plantilla; admiten `{{name}}`. */
    variables: z.array(z.string().max(1024)).max(20).optional(),
  })
  .refine((c) => !!(c.content || c.templateId), {
    message: "El paso necesita un mensaje o una plantilla",
  });
export type SendWhatsappConfig = z.infer<typeof sendWhatsappConfigSchema>;

/**
 * `send_media`: una imagen o video de la biblioteca de Medios. La leyenda admite `{{name}}`, `{{fecha}}`, `{{hora}}` y
 * `{{servicio}}`; 1024 es el tope de Meta. Solo sale dentro de la ventana de 24 h (un adjunto no tiene plantilla).
 */
export const sendMediaConfigSchema = z.object({
  name: z.string().trim().max(120).optional(),
  mediaId: z.string().trim().min(1, "Elige un archivo de la biblioteca").max(64),
  caption: z.string().trim().max(1024).optional(),
});
export type SendMediaConfig = z.infer<typeof sendMediaConfigSchema>;

/** Con la ventana de 24 h cerrada un adjunto no puede salir: no hay plantilla de imagen o video. */
export const OUT_OF_WINDOW_MEDIA_ERROR = "out_of_window_media_requires_open_window";

export const DELAY_UNITS = ["seconds", "minutes", "hours", "days"] as const;
const UNIT_MS = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

/** Tope de la cantidad por unidad: hasta una hora en segundos; 366 en el resto (como siempre). */
export const DELAY_MAX_BY_UNIT = { seconds: 3600, minutes: 366, hours: 366, days: 366 } as const;

/* ─── Ventana horaria de envío ─── */

/**
 * Cuándo se permite enviar, en la hora local del negocio:
 * - `at`: a una hora fija («a las 10:00»). Si el momento calculado cae a otra hora, pasa a la próxima 10:00.
 * - `between`: solo dentro de un horario («de 09 a 21»). Si cae fuera, pasa al próximo inicio de horario.
 *
 * Siempre mueve hacia ADELANTE: la ventana retrasa, nunca adelanta (ver `applySendWindow`).
 */
export const sendWindowSchema = z
  .discriminatedUnion("mode", [
    z.object({
      mode: z.literal("at"),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59).default(0),
    }),
    z.object({
      mode: z.literal("between"),
      fromHour: z.number().int().min(0).max(23),
      /** 24 = hasta el final del día. */
      toHour: z.number().int().min(1).max(24),
    }),
  ])
  .superRefine((w, ctx) => {
    if (w.mode === "between" && w.fromHour >= w.toHour) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["toHour"], message: "La hora final debe ser posterior a la inicial" });
    }
  });
export type SendWindow = z.infer<typeof sendWindowSchema>;

const hh = (h: number, m = 0) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/**
 * Ajusta un instante a la ventana de envío del negocio. Pura, y apoyada en `zonedWallClockToUtc`, que ya
 * resuelve los cambios de horario de verano. Nunca devuelve un instante anterior a `at`; si la hora local
 * pedida no existe (el salto del horario de verano) deja `at` como está en vez de bloquear el envío.
 */
export function applySendWindow(at: Date, window: SendWindow, timezone: string): Date {
  const day = dayIsoInTz(at, timezone);
  const tomorrow = addDaysISO(day, 1);

  if (window.mode === "at") {
    const time = hh(window.hour, window.minute);
    const same = zonedWallClockToUtc(day, time, timezone);
    if (!same) return at;
    if (same.getTime() >= at.getTime()) return same;
    return zonedWallClockToUtc(tomorrow, time, timezone) ?? at;
  }

  const from = zonedWallClockToUtc(day, hh(window.fromHour), timezone);
  const to =
    window.toHour === 24
      ? zonedWallClockToUtc(tomorrow, "00:00", timezone)
      : zonedWallClockToUtc(day, hh(window.toHour), timezone);
  if (!from || !to) return at;
  if (at.getTime() < from.getTime()) return from;
  if (at.getTime() < to.getTime()) return at;
  return zonedWallClockToUtc(tomorrow, hh(window.fromHour), timezone) ?? at;
}

export const delayConfigSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
    amount: z.number().int().positive().max(DELAY_MAX_BY_UNIT.seconds),
    unit: z.enum(DELAY_UNITS),
    /** Opcional: tras esperar, no salir de madrugada o forzar una hora fija. */
    window: sendWindowSchema.optional(),
  })
  .superRefine((c, ctx) => {
    const max = DELAY_MAX_BY_UNIT[c.unit];
    if (c.amount > max) {
      ctx.addIssue({ code: z.ZodIssueCode.too_big, type: "number", maximum: max, inclusive: true, path: ["amount"], message: `Como máximo ${max}` });
    }
  });
export type DelayConfig = z.infer<typeof delayConfigSchema>;

export function delayToMs(cfg: Pick<DelayConfig, "amount" | "unit">): number {
  return cfg.amount * UNIT_MS[cfg.unit];
}

/* ─── Espera anclada a una cita ─── */

/** Qué hacer cuando la hora de la espera ya pasó (p. ej. la cita se creó con menos anticipación). */
export const WAIT_LATE_ACTIONS = ["skip_next", "continue", "stop"] as const;
export type WaitLateAction = (typeof WAIT_LATE_ACTIONS)[number];

/** Una espera se puede anclar hasta 30 días antes o después de la hora de la cita. */
export const WAIT_OFFSET_MAX_MINUTES = 30 * 24 * 60;

/**
 * `wait_until`: espera hasta una hora relativa a la cita. `offsetMinutes` negativo = antes (−1440 = un día
 * antes), positivo = después. `lateAction`: `skip_next` omite el paso que sigue (el mensaje ligado a esta
 * espera) y sigue con el resto; `continue` no espera y sigue; `stop` termina el flujo.
 */
export const waitUntilConfigSchema = z.object({
  name: z.string().trim().max(120).optional(),
  anchor: z.literal("booking.scheduledAt"),
  offsetMinutes: z.number().int().min(-WAIT_OFFSET_MAX_MINUTES).max(WAIT_OFFSET_MAX_MINUTES),
  lateAction: z.enum(WAIT_LATE_ACTIONS).default("skip_next"),
  window: sendWindowSchema.optional(),
});
export type WaitUntilConfig = z.infer<typeof waitUntilConfigSchema>;

export type WaitDecision = { kind: "wait"; at: Date } | { kind: "late"; action: WaitLateAction };

/**
 * ¿Hasta cuándo espera un `wait_until`, o ya es tarde?
 *
 * Es tarde si la hora pedida ya pasó, o si la ventana horaria la empujaría hasta la hora de la cita o
 * después (un recordatorio jamás sale después de la cita).
 */
export function decideWaitUntil(input: {
  now: Date;
  scheduledAt: Date;
  config: Pick<WaitUntilConfig, "offsetMinutes" | "lateAction" | "window">;
  timezone: string;
}): WaitDecision {
  const { now, scheduledAt, config, timezone } = input;
  const raw = new Date(scheduledAt.getTime() + config.offsetMinutes * 60_000);
  if (raw.getTime() <= now.getTime()) return { kind: "late", action: config.lateAction };
  const at = config.window ? applySendWindow(raw, config.window, timezone) : raw;
  if (config.offsetMinutes < 0 && at.getTime() >= scheduledAt.getTime()) {
    return { kind: "late", action: config.lateAction };
  }
  return { kind: "wait", at };
}

/**
 * ¿Sigue vigente la cita de una tarea? `null` = sí; si no, el motivo con el que se cancela la tarea.
 * `booking_created` y `booking_confirmed` exigen una cita agendada (una cancelada, realizada o ya marcada
 * como no-show no recibe el recordatorio); `booking_no_show` exige que siga marcada como no-show.
 */
export function bookingGuard(triggerType: string, booking: { status: string } | null): string | null {
  if (!booking) return "booking_not_found";
  if (triggerType === "booking_no_show") {
    return booking.status === "no_show" ? null : "booking_no_longer_no_show";
  }
  // «Cita realizada»: la cita acaba de cerrarse como realizada. Si se reabrió o se canceló después, ya no aplica.
  if (triggerType === "booking_completed") {
    return booking.status === "realizada" ? null : "booking_no_longer_completed";
  }
  return booking.status === "agendada" ? null : "booking_not_active";
}

/* ─── Acciones de CRM: etiquetas y etapa ─── */

const entityId = z.string().trim().min(1).max(64);

/** `add_tag` / `remove_tag`: la etiqueta se referencia por id (el nombre puede cambiar). */
export const addTagConfigSchema = z.object({
  name: z.string().trim().max(120).optional(),
  tagId: entityId,
});
export type AddTagConfig = z.infer<typeof addTagConfigSchema>;
export const removeTagConfigSchema = addTagConfigSchema;

/** `set_stage`: la etapa se referencia ESTRICTAMENTE por id (el motor jamás compara nombres). */
export const setStageConfigSchema = z.object({
  name: z.string().trim().max(120).optional(),
  stageId: entityId,
});
export type SetStageConfig = z.infer<typeof setStageConfigSchema>;

/* ─── Condición (If/Else) ─── */

export const CONDITION_RULE_TYPES = [
  "tag_has",
  "tag_missing",
  "booking_confirmed",
  "stage_is",
  // Paso 2: cumpleaños, asistencia y fidelización.
  "has_upcoming_booking",
  "visited_within_days",
  // Citas, más completas: confirmada y futura (en cualquier flujo), días hasta la próxima, tiempo sin venir y visitas.
  "has_confirmed_upcoming_booking",
  "upcoming_booking_days_lte",
  "inactive_for_days_gte",
  "visits_gte",
  "stamps_gte",
  // Fidelización multi-hito: cuánto falta para el próximo premio y un rango de sellos.
  "stamps_remaining_lte",
  "stamps_between",
  // Flujos de premio: el hito (en sellos) que activó la ejecución es N (`context.loyalty.milestoneStamps`).
  "loyalty_milestone_is",
  "birthday_today",
  "var_equals",
] as const;
export type ConditionRuleType = (typeof CONDITION_RULE_TYPES)[number];

/* ─── Memoria entre nodos (Paso 3): `automation_run.context.vars` ─── */

/**
 * Las variables de una ejecución viven en `context.vars`, APARTE de las claves del disparo (`bookingId`, `source`,
 * `loyalty`…): un nodo nunca puede pisar lo que otras partes leen por nombre. Solo escalares, con topes: el contexto es
 * un `jsonb` que se relee en cada paso y se escribe bajo el candado de la fila del `run`.
 */
export const VAR_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const VARS_MAX_KEYS = 20;
export const VAR_VALUE_MAX_CHARS = 500;
/** Tope del JSON de todas las variables de una ejecución. */
export const VARS_MAX_BYTES = 4096;

export type VarValue = string | number | boolean;
export type RunVars = Record<string, VarValue>;

function varKeySchema() {
  return z
    .string()
    .trim()
    .toLowerCase()
    .regex(VAR_KEY_PATTERN, "Usa minúsculas, números y _ (empieza con una letra, hasta 32)");
}

/** Normaliza un valor a escalar seguro: sin saltos ni caracteres de control, con tope. `undefined` = no válido. */
export function sanitizeVarValue(raw: unknown): VarValue | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "string") {
    return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, VAR_VALUE_MAX_CHARS);
  }
  return undefined;
}

/** Las variables guardadas en un contexto (descarta lo que no sea un escalar válido: un contexto corrupto no rompe nada). */
export function readVars(context: unknown): RunVars {
  const raw = (context as { vars?: unknown } | null | undefined)?.vars;
  const out: RunVars = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const value = sanitizeVarValue(v);
    if (VAR_KEY_PATTERN.test(k) && value !== undefined) out[k] = value;
  }
  return out;
}

export type MergeVarsResult =
  | { ok: true; vars: RunVars }
  | { ok: false; code: "vars_invalid" | "vars_limit"; message: string };

/**
 * Aplica `updates` sobre las variables actuales. `null` borra la clave. Falla (sin cambiar nada) con una clave o valor
 * no válido o si se pasan los topes (claves y bytes). Pura y determinista: es la MISMA función en el motor (para fallar a
 * la vista antes de avanzar) y en la transacción que persiste.
 */
export function mergeVars(current: RunVars, updates: Record<string, unknown>): MergeVarsResult {
  const next: RunVars = { ...current };
  for (const [key, raw] of Object.entries(updates)) {
    if (!VAR_KEY_PATTERN.test(key)) return { ok: false, code: "vars_invalid", message: `Nombre de variable no válido: «${key.slice(0, 40)}»` };
    if (raw === null) {
      delete next[key];
      continue;
    }
    const value = sanitizeVarValue(raw);
    if (value === undefined) return { ok: false, code: "vars_invalid", message: `El valor de «${key}» debe ser texto, número o sí/no` };
    next[key] = value;
  }
  if (Object.keys(next).length > VARS_MAX_KEYS) {
    return { ok: false, code: "vars_limit", message: `Una ejecución admite hasta ${VARS_MAX_KEYS} variables` };
  }
  if (JSON.stringify(next).length > VARS_MAX_BYTES) {
    return { ok: false, code: "vars_limit", message: `Las variables superan ${VARS_MAX_BYTES} caracteres en total` };
  }
  return { ok: true, vars: next };
}

/**
 * `set_var`: fija o actualiza UNA variable. `value` admite `{{name}}`, `{{fecha}}`… y `{{vars.otra}}`; se renderiza al
 * ejecutar. Una variable sin definir se lee como vacío, nunca falla.
 */
export const setVarConfigSchema = z.object({
  name: z.string().trim().max(120).optional(),
  key: varKeySchema(),
  value: z.string().trim().max(VAR_VALUE_MAX_CHARS),
});
export type SetVarConfig = z.infer<typeof setVarConfigSchema>;


/** Topes de las reglas con número: 10 años de historia; 1000 sellos (más de lo que cualquier tarjeta pide). */
export const CONDITION_MAX_DAYS = 3650;
export const CONDITION_MAX_STAMPS = 1000;
/** Tope de visitas acumuladas que una regla puede pedir. */
export const CONDITION_MAX_VISITS = 10_000;

export const conditionRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tag_has"), tagId: entityId }),
  z.object({ type: z.literal("tag_missing"), tagId: entityId }),
  z.object({ type: z.literal("booking_confirmed") }),
  z.object({ type: z.literal("stage_is"), stageId: entityId }),
  /** El contacto tiene una cita agendada que aún no llega (con el «No» sirve para «no tiene cita»). */
  z.object({ type: z.literal("has_upcoming_booking") }),
  /** Tuvo una cita REALIZADA en los últimos `days` días (con el «No»: no vino o hace mucho que no viene). */
  z.object({ type: z.literal("visited_within_days"), days: z.number().int().min(1).max(CONDITION_MAX_DAYS) }),
  /** Tiene una cita agendada, futura y CONFIRMADA (a diferencia de `booking_confirmed`, vale en cualquier flujo). */
  z.object({ type: z.literal("has_confirmed_upcoming_booking") }),
  /** Su próxima cita agendada es dentro de `days` días o menos (0 = hoy; días de calendario del negocio). Sin próxima cita, no se cumple. */
  z.object({ type: z.literal("upcoming_booking_days_lte"), days: z.number().int().min(0).max(CONDITION_MAX_DAYS) }),
  /** Su última cita REALIZADA fue hace `days` días o más. Quien nunca vino NO cumple (con `visited_within_days` + «No» se cubre). */
  z.object({ type: z.literal("inactive_for_days_gte"), days: z.number().int().min(1).max(CONDITION_MAX_DAYS) }),
  /** Tiene al menos `visits` citas realizadas acumuladas. */
  z.object({ type: z.literal("visits_gte"), visits: z.number().int().min(1).max(CONDITION_MAX_VISITS) }),
  /** Su tarjeta de fidelidad tiene al menos `stamps` sellos hoy. */
  z.object({ type: z.literal("stamps_gte"), stamps: z.number().int().min(1).max(CONDITION_MAX_STAMPS) }),
  /** Le faltan como máximo `stamps` sellos para su próximo premio (sin próximo premio, no se cumple). */
  z.object({ type: z.literal("stamps_remaining_lte"), stamps: z.number().int().min(1).max(CONDITION_MAX_STAMPS) }),
  /** Sus sellos de hoy están entre `min` y `max` (ambos incluidos). */
  z.object({
    type: z.literal("stamps_between"),
    min: z.number().int().min(0).max(CONDITION_MAX_STAMPS),
    max: z.number().int().min(1).max(CONDITION_MAX_STAMPS),
  }),
  /** Flujo de premio: el hito que activó esta ejecución es el de `stamps` sellos (sin premio en el disparo, no se cumple). */
  z.object({ type: z.literal("loyalty_milestone_is"), stamps: z.number().int().min(1).max(CONDITION_MAX_STAMPS) }),
  /** Hoy es su cumpleaños (en la zona horaria del negocio). */
  z.object({ type: z.literal("birthday_today") }),
  /** Paso 3: una variable de la ejecución (`context.vars`, escrita por «Establecer variable» o «Código JS») vale `value`. */
  z.object({ type: z.literal("var_equals"), key: varKeySchema(), value: z.string().trim().max(500) }),
]).superRefine((r, ctx) => {
  if (r.type === "stamps_between" && r.min > r.max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["max"], message: "El máximo debe ser igual o mayor que el mínimo" });
  }
});
export type ConditionRule = z.infer<typeof conditionRuleSchema>;

/* ─── Switch (Paso 3): varias salidas, un solo camino ─── */

export const SWITCH_MAX_CASES = 8;
export const CASE_ID_PATTERN = /^[a-z0-9]{1,16}$/;
/** El asa de salida de un caso: `case_<id>`. Las asas estáticas (`default`…) no cambian. */
export const CASE_HANDLE_PREFIX = "case_";
export const caseHandle = (id: string): `case_${string}` => `${CASE_HANDLE_PREFIX}${id}`;
export const isCaseHandle = (h: string): h is `case_${string}` =>
  h.startsWith(CASE_HANDLE_PREFIX) && CASE_ID_PATTERN.test(h.slice(CASE_HANDLE_PREFIX.length));

export const switchCaseSchema = z.object({
  id: z.string().regex(CASE_ID_PATTERN, "Id de caso no válido"),
  label: z.string().trim().min(1, "Ponle nombre al caso").max(40),
  rule: conditionRuleSchema,
});
export type SwitchCase = z.infer<typeof switchCaseSchema>;

/**
 * `switch`: evalúa los casos EN ORDEN y sigue por el primero que se cumpla; si ninguno, por la salida `default` («Otro»).
 * Solo en el Modo Visual: una lista no puede mostrar N ramas.
 */
export const switchConfigSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
    cases: z.array(switchCaseSchema).min(1, "Agrega al menos un caso").max(SWITCH_MAX_CASES),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.cases.forEach((k, i) => {
      if (seen.has(k.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cases", i, "id"], message: "Dos casos tienen el mismo id" });
      seen.add(k.id);
    });
  });
export type SwitchConfig = z.infer<typeof switchConfigSchema>;

/** Los ids de caso de una configuración, leídos con tolerancia (una configuración a medias no rompe el lienzo). */
export function switchCaseIds(config: unknown): string[] {
  const cases = (config as { cases?: unknown } | null | undefined)?.cases;
  if (!Array.isArray(cases)) return [];
  const out: string[] = [];
  for (const k of cases) {
    const id = (k as { id?: unknown } | null)?.id;
    if (typeof id === "string" && CASE_ID_PATTERN.test(id) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, SWITCH_MAX_CASES);
}

/* ─── Código JS (Paso 3) ─── */

export const CODE_JS_MAX_CHARS = 4000;
/** Tope de nodos de código por flujo: cada uno gasta CPU del servidor compartido. */
export const CODE_JS_MAX_PER_FLOW = 3;

/** `code_js`: el cuerpo de una función que recibe `input` y devuelve `{ vars: { clave: valor } }`. */
export const codeJsConfigSchema = z.object({
  name: z.string().trim().max(120).optional(),
  code: z.string().max(CODE_JS_MAX_CHARS).refine((c) => c.trim().length > 0, "Escribe el código"),
});
export type CodeJsConfig = z.infer<typeof codeJsConfigSchema>;

/* ─── Atención humana (Paso 5) ─── */

export const HUMAN_HANDOFF_NOTE_MAX = 500;

/**
 * `human_handoff`: pasa la conversación a una persona del equipo. Apaga la IA de esa conversación y avisa en la bandeja.
 * `note` (opcional) es el contexto para quien atiende y admite `{{name}}`, `{{vars.x}}` y las variables de fidelidad; va en el
 * aviso, nunca se manda al cliente.
 */
export const humanHandoffConfigSchema = z.object({
  name: z.string().trim().max(120).optional(),
  note: z.string().trim().max(HUMAN_HANDOFF_NOTE_MAX).optional(),
});
export type HumanHandoffConfig = z.infer<typeof humanHandoffConfigSchema>;

/**
 * Qué hace el Modo Simple según la rama: `continue` sigue con el paso siguiente, `skip_next` lo omite y
 * sigue con el que viene después, `stop` termina el flujo. El motor no las lee: se compilan a aristas
 * `true`/`false` (`compileLinearEdges`) y el intérprete sigue la arista.
 */
export const BRANCH_ACTIONS = ["continue", "skip_next", "stop"] as const;
export type BranchAction = (typeof BRANCH_ACTIONS)[number];

export const conditionConfigSchema = z.object({
  name: z.string().trim().max(120).optional(),
  rule: conditionRuleSchema,
  /** Si se cumple: por defecto sigue. */
  ifTrue: z.enum(BRANCH_ACTIONS).default("continue"),
  /** Si no se cumple: por defecto termina el flujo. */
  ifFalse: z.enum(BRANCH_ACTIONS).default("stop"),
});
export type ConditionConfig = z.infer<typeof conditionConfigSchema>;

/** Lo que el motor sabe del contacto (y de su cita) en el momento de evaluar. */
export type ConditionFacts = {
  tagIds: readonly string[];
  stageId: string | null;
  /** La cita en contexto, o null si el flujo no es de citas. */
  booking: { confirmedAt?: Date | null } | null;
  /**
   * Paso 2 (opcionales: quien no los trae, los trata como «no»): tiene una cita futura agendada; días enteros desde
   * su última cita realizada (`null` = nunca vino); sellos actuales de su tarjeta; y si hoy es su cumpleaños.
   */
  hasUpcomingBooking?: boolean;
  /** Tiene una cita agendada, futura y confirmada. */
  hasConfirmedUpcomingBooking?: boolean;
  /** Días de calendario (zona del negocio) hasta su próxima cita agendada; `null`/ausente = no tiene. */
  daysToNextBooking?: number | null;
  /** Citas realizadas acumuladas. */
  visitCount?: number;
  daysSinceLastVisit?: number | null;
  stamps?: number;
  /** Sellos que le faltan para su próximo premio (`null` = ya los alcanzó todos o no hay programa). */
  stampsToNextMilestone?: number | null;
  /** Los sellos del hito que activó la ejecución (`context.loyalty.milestoneStamps`); `null`/ausente si no nació de un premio. */
  loyaltyMilestoneStamps?: number | null;
  birthdayToday?: boolean;
  /** Paso 3: las variables de la ejecución (`context.vars`). */
  vars?: RunVars;
};

/** El resultado de evaluar una regla: verdadero o falso. */
export type ConditionOutcome = { result: boolean };

/* ─── Grafo: aristas, asas y resultado de un nodo ─── */

/**
 * Por qué «asa» sale una arista: `default` (el camino normal), `true`/`false` (las dos ramas de `condition`),
 * `late` (una espera anclada a la cita que llega tarde) y, en `wait_reply`, la intención de la respuesta
 * (`confirmed`, `declined`, `reschedule`, `other`) o `timeout` si venció el tiempo límite.
 */
export const EDGE_HANDLES = [
  "default",
  "true",
  "false",
  "late",
  "timeout",
  "confirmed",
  "declined",
  "reschedule",
  "other",
] as const;
export type StaticEdgeHandle = (typeof EDGE_HANDLES)[number];
/** Las asas estáticas más las de los casos de un `switch` (`case_<id>`, ver `caseHandle`). */
export type EdgeHandle = StaticEdgeHandle | `case_${string}`;
/** ¿Es un asa que el sistema reconoce (estática o de caso)? */
export const isEdgeHandle = (h: string): h is EdgeHandle => (EDGE_HANDLES as readonly string[]).includes(h) || isCaseHandle(h);

/**
 * Lo que devuelve un nodo al terminar: por qué asa sigue el flujo y, si el siguiente paso no debe correr ya,
 * cuándo (`nextAt`; por defecto, ahora). El intérprete busca la arista `(paso, handle)`: sin arista el flujo termina.
 */
export type NodeResult = { handle: EdgeHandle; nextAt?: Date };

export const RUN_STATUSES = ["running", "waiting", "completed", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const WAITING_FOR = ["reply", "time"] as const;
export type WaitingFor = (typeof WAITING_FOR)[number];

/** El asa que corresponde al resultado de una condición. */
export const conditionHandle = (outcome: ConditionOutcome): "true" | "false" => (outcome.result ? "true" : "false");

export type GraphStepInput = { id: string; stepType: string; config: unknown };
export type CompiledEdge = { sourceStepId: string; targetStepId: string; sourceHandle: EdgeHandle };

/**
 * Compila la lista lineal de pasos (en orden de ejecución) a aristas — el Modo Simple en términos del grafo:
 * - Todo paso lleva `default` al siguiente.
 * - `condition`: `true`/`false` según su `ifTrue`/`ifFalse` (`continue` → el siguiente, `skip_next` → el de
 *   después del siguiente, `stop` → sin arista: el flujo termina). Sin `default`: el resultado manda.
 * - `wait_until`: `default` al siguiente y `late` según su `lateAction` (mismas equivalencias).
 * Una configuración inválida usa los valores por defecto del esquema (`ifTrue` continúa, `ifFalse` termina,
 * `lateAction` omite el siguiente): el motor falla el paso a la vista, no la compilación.
 */
export function compileLinearEdges(steps: readonly GraphStepInput[]): CompiledEdge[] {
  const edges: CompiledEdge[] = [];
  const edge = (from: GraphStepInput, to: GraphStepInput | undefined, sourceHandle: EdgeHandle) => {
    if (to) edges.push({ sourceStepId: from.id, targetStepId: to.id, sourceHandle });
  };
  steps.forEach((step, i) => {
    const next = steps[i + 1];
    const after = steps[i + 2];
    const target = (action: unknown) => (action === "skip_next" ? after : action === "stop" ? undefined : next);
    const c = (step.config ?? {}) as { ifTrue?: unknown; ifFalse?: unknown; lateAction?: unknown };
    if (step.stepType === "condition") {
      edge(step, target(c.ifTrue ?? "continue"), "true");
      edge(step, target(c.ifFalse ?? "stop"), "false");
    } else if (step.stepType === "wait_until") {
      edge(step, next, "default");
      edge(step, target(c.lateAction ?? "skip_next"), "late");
    } else if (step.stepType === "wait_reply") {
      // Sin «default»: la respuesta (o su ausencia) manda. Por defecto solo «confirmó» sigue.
      const r = c as Record<string, unknown>;
      edge(step, target(r.onConfirmed ?? "continue"), "confirmed");
      edge(step, target(r.onDeclined ?? "stop"), "declined");
      edge(step, target(r.onReschedule ?? "stop"), "reschedule");
      edge(step, target(r.onOther ?? "stop"), "other");
      edge(step, target(r.onTimeout ?? "stop"), "timeout");
    } else {
      edge(step, next, "default");
    }
  });
  return edges;
}

/** Evalúa una regla con los datos de ahora. Pura: sin base de datos. */
export function evaluateCondition(rule: ConditionRule, facts: ConditionFacts): ConditionOutcome {
  switch (rule.type) {
    case "tag_has":
      return { result: facts.tagIds.includes(rule.tagId) };
    case "tag_missing":
      return { result: !facts.tagIds.includes(rule.tagId) };
    case "stage_is":
      return { result: facts.stageId === rule.stageId };
    case "booking_confirmed":
      // Sin cita en contexto no hay nada confirmado.
      return { result: !!facts.booking?.confirmedAt };
    case "has_upcoming_booking":
      return { result: !!facts.hasUpcomingBooking };
    case "visited_within_days":
      // `null`/ausente: nunca vino, así que no vino «en los últimos N días».
      return { result: typeof facts.daysSinceLastVisit === "number" && facts.daysSinceLastVisit <= rule.days };
    case "has_confirmed_upcoming_booking":
      return { result: !!facts.hasConfirmedUpcomingBooking };
    case "upcoming_booking_days_lte":
      return { result: typeof facts.daysToNextBooking === "number" && facts.daysToNextBooking <= rule.days };
    case "inactive_for_days_gte":
      // Sin visitas previas (`null`/ausente) no hay «tiempo sin venir» que medir: no se cumple.
      return { result: typeof facts.daysSinceLastVisit === "number" && facts.daysSinceLastVisit >= rule.days };
    case "visits_gte":
      return { result: (facts.visitCount ?? 0) >= rule.visits };
    case "stamps_gte":
      return { result: (facts.stamps ?? 0) >= rule.stamps };
    case "stamps_remaining_lte":
      return { result: typeof facts.stampsToNextMilestone === "number" && facts.stampsToNextMilestone <= rule.stamps };
    case "stamps_between": {
      const n = facts.stamps ?? 0;
      return { result: n >= rule.min && n <= rule.max };
    }
    case "loyalty_milestone_is":
      return { result: facts.loyaltyMilestoneStamps === rule.stamps };
    case "birthday_today":
      return { result: !!facts.birthdayToday };
    case "var_equals": {
      // Texto contra texto: `5` y «5» son lo mismo para quien escribe la regla. Sin definir = vacío.
      const have = facts.vars?.[rule.key];
      return { result: (have === undefined ? "" : String(have)) === rule.value };
    }
  }
}

/** Switch: el asa del primer caso que se cumple, o `default` («Otro») si ninguno. Pura y determinista. */
export function evaluateSwitch(cases: readonly SwitchCase[], facts: ConditionFacts): { handle: EdgeHandle; caseId: string | null } {
  for (const k of cases) {
    if (evaluateCondition(k.rule, facts).result) return { handle: caseHandle(k.id), caseId: k.id };
  }
  return { handle: "default", caseId: null };
}

/** Los días enteros entre una fecha pasada y ahora (nunca negativo): el «hace cuántos días» de `visited_within_days`. */
/** Los días de calendario entre dos fechas `AAAA-MM-DD` (`to` − `from`): 0 = el mismo día; negativo si `to` es anterior. */
export function calendarDaysBetween(fromISO: string, toISO: string): number {
  const a = splitISODate(fromISO);
  const b = splitISODate(toISO);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

export function wholeDaysSince(past: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - past.getTime()) / 86_400_000));
}

/* ─── Esperar la respuesta del cliente ─── */

/** La intención de una respuesta; cada una es un asa de salida de `wait_reply`. */
export const REPLY_INTENTS = ["confirmed", "declined", "reschedule", "other"] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

/** Por defecto la espera dura 7 días; el tope es 30: una espera siempre tiene tiempo límite (spec 035, D2). */
export const REPLY_TIMEOUT_DEFAULT_MINUTES = 7 * 24 * 60;
export const REPLY_TIMEOUT_MAX_MINUTES = 30 * 24 * 60;

const branchAction = z.enum(BRANCH_ACTIONS);

/**
 * `wait_reply`: pausa hasta que el cliente responda o venza `timeoutMinutes`. Cada rama es la acción del Modo
 * Simple (`continue` / `skip_next` / `stop`, ver `compileLinearEdges`). `confirmBooking`: si la intención es
 * `confirmed` y la ejecución viene de una cita, la confirma (la misma función del botón de la Agenda).
 */
export const waitReplyConfigSchema = z.object({
  name: z.string().trim().max(120).optional(),
  timeoutMinutes: z.number().int().min(1).max(REPLY_TIMEOUT_MAX_MINUTES).default(REPLY_TIMEOUT_DEFAULT_MINUTES),
  onConfirmed: branchAction.default("continue"),
  onDeclined: branchAction.default("stop"),
  onReschedule: branchAction.default("stop"),
  onOther: branchAction.default("stop"),
  onTimeout: branchAction.default("stop"),
  confirmBooking: z.boolean().default(true),
});
export type WaitReplyConfig = z.infer<typeof waitReplyConfigSchema>;

/** La llave de la tarea de «venció el tiempo»: la reconoce el motor y la hace única por espera. */
export const REPLY_TIMEOUT_PREFIX = "reply_timeout:";
export const replyTimeoutKey = (runId: string, stepId: string, at: Date) =>
  `${REPLY_TIMEOUT_PREFIX}${runId}:${stepId}:${at.getTime()}`;
export const isReplyTimeoutKey = (key: string | null | undefined) => !!key && key.startsWith(REPLY_TIMEOUT_PREFIX);

/** El nombre con que un paso aparece en el historial: el que le puso el dueño o su tipo. */
export function stepLabel(stepType: string, config: unknown): string {
  const name = (config as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() ? name.trim() : stepType;
}

/* ─── Variables ─── */

/**
 * Reemplaza `{{name}}` / `{{nombre}}` por el nombre del contacto, `{{fecha}}` y `{{hora}}` por el día y la hora de la
 * cita en la zona del negocio (o «» si la tarea no es de una cita), `{{servicio}}` y, desde el Paso 3,
 * `{{vars.clave}}` por una variable de la ejecución («» si no está definida: nunca falla).
 *
 * UNA sola pasada: un valor insertado (el nombre de un contacto, una variable) NO se vuelve a interpretar, así que un
 * `{{...}}` dentro de un dato no se expande. Lo que no se reconoce se deja tal cual.
 */
export function renderVars(
  text: string,
  vars: {
    name: string | null;
    fecha?: string | null;
    hora?: string | null;
    servicio?: string | null;
    vars?: RunVars | null;
    /** `context.loyalty` de un flujo `loyalty_reward_unlocked` (ver `readLoyaltyContext`); sin él, esas variables salen vacías. */
    loyalty?: LoyaltyRunContext | null;
    /** `context.sale` de un flujo `sale_completed` (ver `readSaleContext`); sin él, `{{monto}}` sale vacío. */
    sale?: SaleRunContext | null;
  }
): string {
  return text
    .replace(/\{\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}\}/g, (match, raw: string) => {
      const key = raw.toLowerCase();
      if (key === "name" || key === "nombre") return vars.name?.trim() || "";
      if (key === "fecha") return vars.fecha?.trim() || "";
      if (key === "hora") return vars.hora?.trim() || "";
      if (key === "servicio") return vars.servicio?.trim() || "";
      // Fidelidad: el premio y el hito que activó el flujo. Fuera de un flujo de premio quedan vacías (nunca «undefined»).
      // Venta cobrada: el monto, sin símbolo de moneda («1250» o «1250.50»); quien escribe el mensaje pone el suyo.
      if (key === "monto") return vars.sale ? formatSaleAmount(vars.sale.amountCents) : "";
      if (key === "premio") return vars.loyalty?.title?.trim() || "";
      if (key === "descuento") return vars.loyalty?.discountPercentage != null ? String(vars.loyalty.discountPercentage) : "";
      // Disparador de cada sello: cuánto falta y cuál es el próximo premio (vacías en un flujo de premio o de otro tipo).
      if (key === "faltan") return vars.loyalty?.stampsToNext != null ? String(vars.loyalty.stampsToNext) : "";
      if (key === "proximo_premio") return vars.loyalty?.nextTitle?.trim() || "";
      if (key === "sellos") {
        const n = vars.loyalty?.currentStamps ?? vars.loyalty?.milestoneStamps;
        return n == null ? "" : String(n);
      }
      if (key.startsWith("vars.")) {
        const name = key.slice(5);
        const v = VAR_KEY_PATTERN.test(name) ? vars.vars?.[name] : undefined;
        return v === undefined ? "" : String(v);
      }
      return match;
    })
    .replace(/[ 	]{2,}/g, " ")
    .trim();
}

/* ─── Venta cobrada en el contexto de la ejecución ─── */

/** Lo que el disparador `sale_completed` deja en `automation_run.context.sale`. */
export type SaleRunContext = {
  saleId: string;
  amountCents: number;
  paymentMethod: string | null;
  /** Lo vendido, en una frase («Corte + Barba»). */
  itemName: string | null;
  /** La cita que se cobró, si la venta nació de una. */
  bookingId: string | null;
};

/** `context.sale` de una ejecución, o `null` si no nació de una venta. Ignora lo que no tenga la forma esperada. */
export function readSaleContext(ctx: Record<string, unknown> | null | undefined): SaleRunContext | null {
  const raw = ctx?.sale;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.saleId !== "string" || typeof o.amountCents !== "number" || !Number.isFinite(o.amountCents)) return null;
  return {
    saleId: o.saleId,
    amountCents: o.amountCents,
    paymentMethod: typeof o.paymentMethod === "string" ? o.paymentMethod : null,
    itemName: typeof o.itemName === "string" ? o.itemName : null,
    bookingId: typeof o.bookingId === "string" ? o.bookingId : null,
  };
}

/** Centavos como número legible: 125000 → «1250», 125050 → «1250.50». */
export function formatSaleAmount(amountCents: number): string {
  const units = amountCents / 100;
  return Number.isInteger(units) ? String(units) : units.toFixed(2);
}

/* ─── Fidelidad en el contexto de la ejecución ─── */

/** Lo que el disparador `loyalty_reward_unlocked` deja en `automation_run.context.loyalty` (leído con tolerancia). */
export type LoyaltyRunContext = {
  /** Sellos del hito que se cruzó. */
  milestoneStamps: number | null;
  /** Título del premio. */
  title: string | null;
  /** Porcentaje, si el premio es un descuento. */
  discountPercentage: number | null;
  /** Sellos de la tarjeta cuando se cruzó el hito (o tras el sello ganado). */
  currentStamps: number | null;
  /** `loyalty_stamp_earned`: sellos que sumó este movimiento. */
  stampsAdded?: number | null;
  /** `loyalty_stamp_earned`: sellos que le faltan para su próximo premio (`null` = ya los alcanzó todos). */
  stampsToNext?: number | null;
  /** `loyalty_stamp_earned`: el título de su próximo premio. */
  nextTitle?: string | null;
};

/** `context.loyalty` de una ejecución, o `null` si no nació de un premio de fidelidad. Ignora lo que no tenga la forma esperada. */
export function readLoyaltyContext(ctx: Record<string, unknown> | null | undefined): LoyaltyRunContext | null {
  const raw = ctx?.loyalty;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const out: LoyaltyRunContext = {
    milestoneStamps: int(o.milestoneStamps),
    title: typeof o.title === "string" ? o.title : null,
    discountPercentage: int(o.discountPercentage),
    currentStamps: int(o.currentStamps),
    stampsAdded: int(o.stampsAdded),
    stampsToNext: int(o.stampsToNext),
    nextTitle: o.nextMilestone && typeof o.nextMilestone === "object" && typeof (o.nextMilestone as { title?: unknown }).title === "string" ? (o.nextMilestone as { title: string }).title : null,
  };
  return out.milestoneStamps === null && out.title === null && out.currentStamps === null ? null : out;
}

/** Un hito del programa de fidelidad tal como lo necesita el selector del disparador. */
export type LoyaltyMilestoneOption = { stamps: number; title: string; rewardType?: string; discountPercentage?: number };

/** «Sello 8 · 50% de descuento»: cómo se nombra un hito en el selector. */
export function loyaltyMilestoneLabel(m: LoyaltyMilestoneOption): string {
  return `Sello ${m.stamps} · ${m.title}`;
}

/**
 * Si el flujo está atado a un hito (`stamps`) que el programa ya no tiene, el flujo NUNCA se activa (el filtro es por número
 * de sellos): lo avisa en una frase. `null` si todo cuadra (sin filtro, o el hito existe).
 */
export function loyaltyHitoWarning(stamps: number | null | undefined, milestones: readonly { stamps: number }[]): string | null {
  if (!stamps || milestones.some((m) => m.stamps === stamps)) return null;
  const hoy = [...new Set(milestones.map((m) => m.stamps))].sort((a, b) => a - b).join(", ");
  return `El premio de ${stamps} sellos ya no existe en tu programa de fidelidad${hoy ? ` (hoy: ${hoy})` : ""}. Este flujo no se activará hasta que elijas uno de los premios actuales.`;
}

/* ─── Ventana de 24 h de Meta ─── */

/** El error con que se marca la cola cuando fuera de la ventana no hay plantilla aprobada. */
export const OUT_OF_WINDOW_ERROR = "out_of_window_requires_template";

export type SendDecision =
  | { kind: "text" }
  | { kind: "template" }
  | { kind: "fail"; error: typeof OUT_OF_WINDOW_ERROR | "template_not_approved" };

/**
 * Cómo sale un paso `send_whatsapp`.
 *
 * - Dentro de la ventana: texto libre si el paso lo trae; si solo trae plantilla, la plantilla
 *   (que debe estar aprobada, Meta rechaza el resto).
 * - Fuera de la ventana: SOLO plantilla aprobada. Sin plantilla, o con una que no está aprobada,
 *   falla con `out_of_window_requires_template` (el texto libre ahí lo rechazaría Meta).
 */
export function decideSend(input: {
  windowOpen: boolean;
  config: Pick<SendWhatsappConfig, "content" | "templateId">;
  /** Estado de la plantilla del paso: `null` si no existe. */
  templateStatus: string | null;
}): SendDecision {
  const templateOk = !!input.config.templateId && input.templateStatus === "approved";
  if (input.windowOpen) {
    if (input.config.content) return { kind: "text" };
    return templateOk ? { kind: "template" } : { kind: "fail", error: "template_not_approved" };
  }
  return templateOk ? { kind: "template" } : { kind: "fail", error: OUT_OF_WINDOW_ERROR };
}

/* ─── Disparadores ─── */

/** Hora local (del negocio) a la que sale el saludo de cumpleaños si el flujo no dice otra. */
export const BIRTHDAY_DEFAULT_HOUR = 10;

/** Hasta cuántos días antes del cumpleaños se puede adelantar el saludo (la pantalla ofrece 0, 1 y 2). */
export const BIRTHDAY_MAX_DAYS_BEFORE = 30;

/** `daysOffset` de un flujo de cumpleaños: 0 = el mismo día, -1 = un día antes, … Entero de -30 a 0. */
export const daysOffsetSchema = z.number().int().min(-BIRTHDAY_MAX_DAYS_BEFORE).max(0);

/**
 * `automation_flow.trigger_config`: `toStageId` acota `stage_changed`; `hour` fija la hora del saludo de
 * cumpleaños y `daysOffset` cuántos días antes sale (ausente = 0, el mismo día).
 */
export const flowTriggerConfigSchema = z.object({
  toStageId: z.string().trim().min(1).nullish(),
  /** `tag_added`: solo esa etiqueta (sin ella, cualquiera). */
  tagId: z.string().trim().min(1).nullish(),
  /** `loyalty_reward_unlocked`: solo el hito de esos sellos (sin ello, cualquier premio). `loyalty_stamp_earned`: solo al llegar a EXACTAMENTE esos sellos. */
  stamps: z.number().int().min(1).max(CONDITION_MAX_STAMPS).nullish(),
  /** `loyalty_stamp_earned`: solo al llegar a esos sellos o más. */
  minStamps: z.number().int().min(1).max(CONDITION_MAX_STAMPS).nullish(),
  hour: z.number().int().min(0).max(23).optional(),
  daysOffset: daysOffsetSchema.optional(),
});
export type FlowTriggerConfig = z.infer<typeof flowTriggerConfigSchema>;

/** Un JSON ausente o dañado no apaga el flujo: se cae a los valores por defecto (sin acotar, 10:00). */
export function parseTriggerConfig(raw: unknown): FlowTriggerConfig {
  const parsed = flowTriggerConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** ¿Este flujo `stage_changed` reacciona al cambio a `toStageId`? Sin etapa configurada, a cualquiera. */
export function stageFlowMatches(config: FlowTriggerConfig, toStageId: string): boolean {
  return !config.toStageId || config.toStageId === toStageId;
}

/** ¿Este flujo `tag_added` reacciona a esa etiqueta? Sin etiqueta configurada, a cualquiera. */
export function tagFlowMatches(config: FlowTriggerConfig, tagId: string): boolean {
  return !config.tagId || config.tagId === tagId;
}

/** ¿Este flujo `loyalty_reward_unlocked` reacciona al hito de `stamps` sellos? Sin hito configurado, a cualquiera. */
export function loyaltyFlowMatches(config: FlowTriggerConfig, stamps: number): boolean {
  return !config.stamps || config.stamps === stamps;
}

/**
 * ¿Este flujo `loyalty_stamp_earned` reacciona a un sello tras el cual la tarjeta quedó en `currentStamps`? Sin ajustes, a
 * todos; con `stamps`, solo al exacto; con `minStamps`, a ese y los siguientes; con ambos, deben cumplirse los dos.
 */
export function stampFlowMatches(config: FlowTriggerConfig, currentStamps: number): boolean {
  if (config.stamps && config.stamps !== currentStamps) return false;
  if (config.minStamps && currentStamps < config.minStamps) return false;
  return true;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Día, mes y año de una fecha `AAAA-MM-DD`. */
export function splitISODate(iso: string): { year: number; month: number; day: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { year: y!, month: m!, day: d! };
}

/**
 * Los (día, mes) de cumpleaños que toca saludar en la fecha local `todayISO`. Casi siempre es solo
 * hoy; quien nació un 29 de febrero se saluda el 28 en los años que no son bisiestos.
 */
export function birthdaysDueOn(todayISO: string): { day: number; month: number }[] {
  const { year, month, day } = splitISODate(todayISO);
  const due = [{ day, month }];
  if (month === 2 && day === 28 && !isLeapYear(year)) due.push({ day: 29, month: 2 });
  return due;
}

/**
 * La fecha de cumpleaños que un flujo saluda HOY (`todayISO`, local del negocio): hoy mismo con
 * `daysOffset` 0 y, con -1, mañana (el saludo sale un día antes). Es aritmética de calendario, así que
 * cruza fin de mes y de año sin tropiezos; los bisiestos los resuelve `birthdaysDueOn` sobre esa fecha.
 */
export function birthdayTargetDate(todayISO: string, daysOffset: number | undefined): string {
  const offset = Number.isInteger(daysOffset) && daysOffset! <= 0 && daysOffset! >= -BIRTHDAY_MAX_DAYS_BEFORE ? daysOffset! : 0;
  return addDaysISO(todayISO, -offset);
}

/** El instante UTC de las `hour`:00 locales del día `todayISO` en la zona del negocio. */
export function birthdaySendAt(todayISO: string, hour: number | undefined, timezone: string): Date | null {
  const h = Number.isInteger(hour) && hour! >= 0 && hour! <= 23 ? hour! : BIRTHDAY_DEFAULT_HOUR;
  return zonedWallClockToUtc(todayISO, `${String(h).padStart(2, "0")}:00`, timezone);
}

/* Llaves de idempotencia de los disparadores (`automation_queue.dedupe_key`). */

/** Un saludo por contacto, flujo y AÑO. */
export const birthdayDedupeKey = (year: number) => `birthday:${year}`;
/** Una vez por lead y etapa: ir y volver entre etapas no repite el mensaje al cliente. */
export const stageDedupeKey = (leadId: string, stageId: string) => `stage:${leadId}:${stageId}`;
/**
 * Una etiqueta asignada. La hora de la asignación entra en la llave: quitarla y volver a ponerla es OTRA asignación y
 * rearma el flujo; dos avisos de la misma asignación no lo duplican.
 */
export const tagAddedDedupeKey = (tagId: string, assignedAt: Date) => `tag_added:${tagId}:${assignedAt.getTime()}`;
/** Un premio de fidelidad desbloqueado: una vez por movimiento de sellos y por hito que cruzó. */
export const loyaltyRewardDedupeKey = (transactionId: string, stamps: number) => `loyalty_reward:${transactionId}:${stamps}`;
/** Un sello ganado: una vez por movimiento de sellos (`loyalty_transaction.id`; un movimiento suma un solo sello). */
export const loyaltyStampDedupeKey = (transactionId: string) => `loyalty_stamp:${transactionId}`;
/** Un disparo manual: el `batchId` lo genera la pantalla al abrir el diálogo, así el doble clic no lo repite. */
export const manualDedupeKey = (batchId: string) => `manual:${batchId}`;

/* ─── Disparo manual ─── */

/** El `batchId` de un disparo manual: lo manda la pantalla; solo letras, números, guion y guion bajo. */
export const manualBatchIdSchema = z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/, "batchId no válido");

/** Quién y cómo arrancó una ejecución a mano: va en `automation_run.context` y se ve en el historial. */
export type ManualRunOrigin = { source: "manual"; triggeredBy: string; batchId: string };
export const manualRunContext = (triggeredBy: string, batchId: string): ManualRunOrigin => ({ source: "manual", triggeredBy, batchId });

/** El origen manual de una ejecución, leído de su `context` (null si no nació de un disparo manual). */
export function manualOriginOf(context: unknown): ManualRunOrigin | null {
  const c = (context ?? {}) as Record<string, unknown>;
  if (c.source !== "manual") return null;
  return {
    source: "manual",
    triggeredBy: typeof c.triggeredBy === "string" ? c.triggeredBy : "",
    batchId: typeof c.batchId === "string" ? c.batchId : "",
  };
}

/** Una vez por lead. */
export const leadCreatedDedupeKey = (leadId: string) => `lead_created:${leadId}`;
/**
 * Citas. La hora entra en la llave: al reprogramar, el flujo se rearma para la hora nueva, y reintentar el
 * mismo disparo (o dos pestañas a la vez) no encola dos veces.
 */
export const bookingCreatedDedupeKey = (bookingId: string, scheduledAt: Date) =>
  `booking_created:${bookingId}:${scheduledAt.getTime()}`;
export const bookingConfirmedDedupeKey = (bookingId: string, scheduledAt: Date) =>
  `booking_confirmed:${bookingId}:${scheduledAt.getTime()}`;
/** Una vez por cita. */
export const bookingNoShowDedupeKey = (bookingId: string) => `booking_no_show:${bookingId}`;
/** Una vez por cita: marcarla «realizada» dos veces (o cobrarla después de marcarla) no repite el flujo. */
export const bookingCompletedDedupeKey = (bookingId: string) => `booking_completed:${bookingId}`;
/** Una vez por venta (`service_sale.id`). */
export const saleCompletedDedupeKey = (saleId: string) => `sale_completed:${saleId}`;

/**
 * `trigger_config` de un flujo `ad_referral` (047): a qué reacciona. Exactamente uno de `sourceId` (un anuncio),
 * `adsetId` (todo un conjunto) o `campaignId` (toda una campaña); sin ninguno, a cualquier anuncio. Solo IDs de
 * Meta, nunca nombres: un renombre en Meta no puede romper ni desactualizar un flujo. Los flujos anteriores
 * (`{ sourceId }` o vacío) siguen valiendo tal cual.
 */
export type AdReferralConfig = { sourceId?: string; adsetId?: string; campaignId?: string };
export type AdScopeLevel = "any" | "ad" | "adset" | "campaign";

const idOf = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function parseAdReferralConfig(raw: unknown): AdReferralConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  // Si por un dato viejo o hecho a mano vinieran varias claves, manda la más específica.
  const sourceId = idOf(c.sourceId);
  if (sourceId) return { sourceId };
  const adsetId = idOf(c.adsetId);
  if (adsetId) return { adsetId };
  const campaignId = idOf(c.campaignId);
  if (campaignId) return { campaignId };
  return {};
}

export function adScopeOf(cfg: AdReferralConfig): { level: AdScopeLevel; id: string | null } {
  if (cfg.sourceId) return { level: "ad", id: cfg.sourceId };
  if (cfg.adsetId) return { level: "adset", id: cfg.adsetId };
  if (cfg.campaignId) return { level: "campaign", id: cfg.campaignId };
  return { level: "any", id: null };
}

/** El anuncio que llegó y lo que se sabe de su jerarquía (viene del catálogo `meta_ad`; puede faltar). */
export type AdHierarchy = { adId: string; adsetId?: string | null; campaignId?: string | null };

/**
 * ¿Este anuncio activa el flujo? `unknown` = el flujo es de conjunto/campaña y la jerarquía del anuncio todavía no
 * se conoce (primer mensaje de un anuncio nuevo): no se descarta, se vuelve a evaluar cuando el catálogo lo resuelve.
 */
export function matchesAdTrigger(cfg: AdReferralConfig, ad: AdHierarchy): "yes" | "no" | "unknown" {
  const { level, id } = adScopeOf(cfg);
  if (level === "any") return "yes";
  if (level === "ad") return id === ad.adId ? "yes" : "no";
  const known = level === "adset" ? ad.adsetId : ad.campaignId;
  if (!known) return "unknown";
  return known === id ? "yes" : "no";
}

/** Una vez por contacto y anuncio: el mismo anuncio no vuelve a arrancar el flujo para la misma persona. */
export const adReferralDedupeKey = (sourceId: string) => `ad_referral:${sourceId}`;

/**
 * La llave de un flujo concreto: por anuncio (o cualquiera) es la de siempre; con alcance de conjunto o campaña es
 * por ALCANCE, así un contacto cuya atribución pasa a otro anuncio de la misma campaña no arranca el flujo dos veces.
 */
export function adReferralDedupeKeyFor(cfg: AdReferralConfig, sourceId: string): string {
  const { level, id } = adScopeOf(cfg);
  if (level === "adset") return `ad_referral:adset:${id}`;
  if (level === "campaign") return `ad_referral:campaign:${id}`;
  return adReferralDedupeKey(sourceId);
}
