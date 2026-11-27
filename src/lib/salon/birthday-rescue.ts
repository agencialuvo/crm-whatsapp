import { z } from "zod";
import { OUT_OF_WINDOW_ERROR, type BirthdayRunContext } from "@/lib/automation";
import {
  closingWindowStartDay,
  daysLeftInMonth,
  inClosingWindow,
  RESCUE_SUGGESTED_DAYS_LEFT,
  visitedRecently,
} from "@/lib/salon/birthday-campaign";

/**
 * Cumpleaños — reglas PURAS del rescate de fin de mes que no son de la tarjeta: los ajustes (ventana de cierre,
 * margen sin atención reciente, rescate automático), el texto del beneficio y de los plazos que el mensaje puede
 * usar, el detector de un «¡Feliz cumpleaños!» fuera de lugar y los avisos de la campanita.
 *
 * Todo es neutro de rubro: el negocio nombra su beneficio («20% de descuento», «un postre de cortesía», «una
 * clase gratis») y el texto de ejemplo habla de «reservar», no de un servicio concreto.
 */

/* ------------------------------ ajustes ------------------------------ */

export type RescueSettings = {
  /** El barrido lanza el rescate solo, una vez al día dentro de la ventana de cierre. */
  autoEnabled: boolean;
  /** Flujo MANUAL con que sale el rescate automático. */
  flowId: string | null;
  /** Ventana de cierre: los últimos N días del mes, contando hoy. */
  windowDays: number;
  /** No se rescata a quien se atendió hace menos de N días (0 = sin margen). */
  minGapDays: number;
  /** Hora local desde la que sale el rescate automático. */
  sendHour: number;
  /** El beneficio en palabras del negocio; `null` = el descuento de cumpleaños de Caja. */
  benefitText: string | null;
};

export const RESCUE_SETTINGS_DEFAULTS: RescueSettings = {
  autoEnabled: false,
  flowId: null,
  windowDays: RESCUE_SUGGESTED_DAYS_LEFT,
  minGapDays: 7,
  sendHour: 10,
  benefitText: null,
};

export const RESCUE_WINDOW_MAX = 15;
export const RESCUE_GAP_MAX = 60;

export const rescueSettingsSchema = z
  .object({
    autoEnabled: z.boolean(),
    flowId: z.string().trim().min(1).max(64).nullable(),
    windowDays: z.number().int().min(1).max(RESCUE_WINDOW_MAX),
    minGapDays: z.number().int().min(0).max(RESCUE_GAP_MAX),
    sendHour: z.number().int().min(0).max(23),
    benefitText: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .transform((v) => (v ? v : null)),
  })
  .strict()
  .refine((s) => !s.autoEnabled || !!s.flowId, {
    message: "Elige el flujo con que sale el rescate automático",
    path: ["flowId"],
  });

export { closingWindowStartDay, inClosingWindow, visitedRecently };

/* ------------------------------ el mensaje del rescate ------------------------------ */

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** «6 de noviembre». */
export function dateLabel(day: number, month: number): string {
  return `${day} de ${MONTHS[month - 1] ?? ""}`.trim();
}

/** «hoy es el último día» · «queda 1 día» · «quedan 5 días». */
export function deadlineLabel(daysLeft: number): string {
  if (daysLeft <= 0) return "hoy es el último día";
  return daysLeft === 1 ? "queda 1 día" : `quedan ${daysLeft} días`;
}

export const GENERIC_BENEFIT = "tu beneficio de cumpleaños";

/**
 * El beneficio en palabras: lo que escribió el negocio; si no, el descuento de cumpleaños de Caja encendido
 * («20% de descuento»); si no, «tu beneficio de cumpleaños».
 */
export function benefitLabel(input: {
  benefitText: string | null | undefined;
  birthdayEnabled?: boolean | null;
  birthdayPercentage?: number | null;
}): string {
  const own = input.benefitText?.trim();
  if (own) return own;
  if (input.birthdayEnabled && input.birthdayPercentage && input.birthdayPercentage > 0) {
    return `${input.birthdayPercentage}% de descuento`;
  }
  return GENERIC_BENEFIT;
}

/** Lo que el rescate deja en `automation_run.context.birthday` para las variables del mensaje. */
export function buildBirthdayRunContext(input: {
  today: string;
  birthdayDay: number | null;
  benefit: string;
}): BirthdayRunContext {
  const month = Number(input.today.slice(5, 7));
  const todayDay = Number(input.today.slice(8, 10));
  const daysLeft = daysLeftInMonth(input.today);
  return {
    benefit: input.benefit,
    monthEnd: dateLabel(todayDay + daysLeft, month),
    daysLeft,
    birthday: input.birthdayDay ? dateLabel(input.birthdayDay, month) : null,
    birthdayPassed: input.birthdayDay ? input.birthdayDay < todayDay : null,
  };
}

/** Las variables que el mensaje del rescate puede usar (además de `{{nombre}}`). */
export const RESCUE_VARIABLES = [
  { key: "{{beneficio}}", label: "El beneficio de cumpleaños" },
  { key: "{{cierre_mes}}", label: "Último día del mes («30 de noviembre»)" },
  { key: "{{plazo}}", label: "«quedan 5 días» / «hoy es el último día»" },
  { key: "{{cumple}}", label: "Fecha del cumpleaños («6 de noviembre»)" },
] as const;

/**
 * Texto de ejemplo para el flujo del rescate: recuerda el beneficio y el plazo, no felicita (el cumpleaños pudo
 * haber pasado hace días) y no nombra un servicio de un rubro.
 */
export const RESCUE_MESSAGE_SUGGESTION =
  "Hola {{nombre}}, tu beneficio de cumpleaños sigue activo: {{beneficio}}. Lo puedes usar hasta el {{cierre_mes}} ({{plazo}}). ¿Te reservo un espacio?";

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const GREETING_PATTERNS = [
  /\bfeliz\s+(cumple|cumpleanos|dia)\b/,
  /\bhappy\s+(birthday|bday)\b/,
  /\bhoy\s+(es\s+)?tu\s+(cumple|cumpleanos|dia)\b/,
  /\bmuchas\s+felicidades\b/,
  /\bfelicidades\s+(en\s+tu\s+dia|por\s+tu\s+cumple)/,
  /\bque\s+cumplas\s+muchos\s+mas\b/,
];

/**
 * ¿El texto felicita como si fuera el día del cumpleaños? En un rescate de fin de mes el cumpleaños pudo haber sido
 * hace semanas: el mensaje debe recordar el beneficio y el plazo, no repetir el saludo.
 */
export function looksLikeBirthdayGreeting(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = fold(text);
  return GREETING_PATTERNS.some((re) => re.test(t));
}

/**
 * El saludo manual del Panel según el día: el mismo día felicita; antes avisa que se acerca; después NO felicita
 * como si fuera hoy y recuerda el beneficio hasta el cierre del mes.
 */
export function manualBirthdayText(input: {
  name: string;
  day: number;
  month: number;
  today: string;
  benefit: string;
}): string {
  const first = input.name.trim().split(/\s+/)[0] ?? "";
  const hi = first ? `¡Hola ${first}!` : "¡Hola!";
  const todayDay = Number(input.today.slice(8, 10));
  const monthEnd = dateLabel(todayDay + daysLeftInMonth(input.today), input.month);
  if (input.day === todayDay) return `${hi} 🎉 Feliz cumpleaños de parte de todo el equipo. Este mes tienes ${input.benefit}.`;
  if (input.day > todayDay) {
    return `${hi} Se acerca tu cumpleaños (el ${dateLabel(input.day, input.month)}) y queremos celebrarlo contigo: este mes tienes ${input.benefit}.`;
  }
  return `${hi} Esperamos que hayas tenido un gran cumpleaños. Tu beneficio sigue activo hasta el ${monthEnd}: ${input.benefit}. ¿Te reservamos un espacio?`;
}

/* ------------------------------ avisos de la campanita ------------------------------ */

export const BIRTHDAY_ALERT_KINDS = ["greeting_failed", "greeting_not_fired", "rescue_failed", "rescue_not_fired"] as const;
export type BirthdayAlertKind = (typeof BIRTHDAY_ALERT_KINDS)[number];

export const ALERT_REASONS = [
  "delivery_failed",
  "out_of_window",
  "no_credit",
  "rate_limit",
  "no_conversation",
  "not_queued",
  "send_error",
  "flow_missing",
  "flow_inactive",
  "not_manual_flow",
  "greeting_copy",
] as const;
export type AlertReason = (typeof ALERT_REASONS)[number];

export const ALERT_REASON_LABEL: Record<AlertReason, string> = {
  delivery_failed: "WhatsApp no entregó el mensaje",
  out_of_window: "pasaron las 24 h y el flujo no usa una plantilla aprobada",
  no_credit: "no hay monedas para la plantilla",
  rate_limit: "el cliente llegó al tope de mensajes automáticos",
  no_conversation: "el cliente no tiene un chat de WhatsApp",
  not_queued: "no entró a la cola (el chat se abrió después o el barrido no corrió)",
  send_error: "error al enviar",
  flow_missing: "no hay un flujo elegido o se borró",
  flow_inactive: "el flujo está apagado",
  not_manual_flow: "el flujo elegido no es de disparador «Manual»",
  greeting_copy: "el mensaje felicita como si fuera el día del cumpleaños",
};

/**
 * Por qué un envío de cumpleaños no llegó, a partir de lo que dejó el motor: el registro del paso, el estado del
 * mensaje, el de la ejecución y el error de la cola. `null` = no es un fallo que avisar (llegó, sigue en marcha, o
 * el cliente se dio de baja: eso es cumplimiento, no un problema).
 */
export function classifyFailure(input: {
  logStatus?: string | null;
  messageStatus?: string | null;
  runStatus?: string | null;
  error?: string | null;
}): AlertReason | null {
  const err = input.error ?? "";
  if (input.logStatus === "skipped_opt_out" || err.includes("skipped_opt_out")) return null;
  if (input.logStatus === "success") return input.messageStatus === "failed" ? "delivery_failed" : null;
  const failed = input.logStatus === "failed" || input.runStatus === "failed" || input.runStatus === "cancelled";
  if (!failed) return null;
  if (err.includes(OUT_OF_WINDOW_ERROR)) return "out_of_window";
  if (err.includes("no_credit")) return "no_credit";
  if (err.includes("rate_limit")) return "rate_limit";
  if (err.includes("no_conversation")) return "no_conversation";
  if (err.includes("flow_inactive")) return "flow_inactive";
  return "send_error";
}

/** «WhatsApp no entregó el mensaje (2) · el flujo está apagado (1)», del más frecuente al menos. */
export function summarizeReasons(reasons: readonly AlertReason[]): string {
  const counts = new Map<AlertReason, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => (counts.size === 1 ? ALERT_REASON_LABEL[r] : `${ALERT_REASON_LABEL[r]} (${n})`))
    .join(" · ");
}

/** Llave del control de avisos: un aviso por tipo, flujo y mes (y otro solo si crecen los afectados). */
export function birthdayAlertKey(kind: BirthdayAlertKind, flowId: string | null, period: string, extra?: string): string {
  return [kind, flowId ?? "-", period, ...(extra ? [extra] : [])].join(":");
}

export function birthdayAlertCopy(
  kind: BirthdayAlertKind,
  input: { flowName: string | null; count: number; reasons: readonly AlertReason[] }
): { title: string; message: string } {
  const flow = input.flowName ? `«${input.flowName}»` : "sin flujo";
  const who = `${input.count} cliente${input.count === 1 ? "" : "s"}`;
  const why = input.reasons.length > 0 ? ` Motivo: ${summarizeReasons(input.reasons)}.` : "";
  switch (kind) {
    case "greeting_failed":
      return {
        title: "Falló el saludo de cumpleaños",
        message: `La automatización ${flow} no pudo entregar el saludo a ${who} este mes.${why}`,
      };
    case "greeting_not_fired":
      return {
        title: "Un saludo de cumpleaños no salió",
        message: `La automatización ${flow} no se disparó para ${who} cuyo saludo ya tocaba.${why}`,
      };
    case "rescue_failed":
      return {
        title: "Falló el rescate de cumpleaños",
        message: `El rescate de fin de mes con ${flow} no llegó a ${who}.${why}`,
      };
    case "rescue_not_fired":
      return {
        title: "El rescate automático no salió",
        message: `El rescate de fin de mes (${flow}) no se envió: ${who} sin cita ni compra se quedaron sin él.${why}`,
      };
  }
}

/* ------------------------------ detección de fallos y de saludos que no salieron ------------------------------ */

/** Un paso de envío del motor en una ejecución de cumpleaños (saludo `birthday:AAAA` o rescate `birthday_rescue:AAAA-MM`). */
export type MonitorSendRow = {
  flowId: string;
  contactId: string;
  key: string;
  logStatus: string;
  messageStatus: string | null;
  error: string | null;
};

/** Una ejecución de cumpleaños con el error de su tarea (si terminó `failed`/`cancelled`). */
export type MonitorRunRow = { flowId: string; contactId: string; key: string; status: string; error: string | null };

export type FailureAlert = {
  kind: "greeting_failed" | "rescue_failed";
  flowId: string;
  contactIds: string[];
  reasons: AlertReason[];
};

const kindOfKey = (key: string): FailureAlert["kind"] => (key.startsWith("birthday_rescue:") ? "rescue_failed" : "greeting_failed");

/**
 * Agrupa por tipo y flujo a los clientes a quienes una automatización de cumpleaños NO les llegó: algún paso de envío
 * falló (o su mensaje terminó `failed`) sin ninguna entrega, o la ejecución terminó `failed`/`cancelled` sin enviar.
 * Una baja (`skipped_opt_out`) no es un fallo que avisar; algo que sigue en marcha, tampoco.
 */
export function collectFailureAlerts(input: { sends: readonly MonitorSendRow[]; runs: readonly MonitorRunRow[] }): FailureAlert[] {
  type Acc = { delivered: boolean; reasons: AlertReason[]; runReason: AlertReason | null; flowId: string; key: string; contactId: string };
  const byRun = new Map<string, Acc>();
  const acc = (flowId: string, contactId: string, key: string): Acc => {
    const id = `${flowId}|${contactId}|${key}`;
    let a = byRun.get(id);
    if (!a) byRun.set(id, (a = { delivered: false, reasons: [], runReason: null, flowId, key, contactId }));
    return a;
  };
  for (const s of input.sends) {
    const a = acc(s.flowId, s.contactId, s.key);
    const reason = classifyFailure({ logStatus: s.logStatus, messageStatus: s.messageStatus, error: s.error });
    if (s.logStatus === "success" && !reason) a.delivered = true;
    else if (reason) a.reasons.push(reason);
  }
  for (const r of input.runs) {
    if (r.status !== "failed" && r.status !== "cancelled") continue;
    const a = acc(r.flowId, r.contactId, r.key);
    a.runReason = classifyFailure({ runStatus: r.status, error: r.error });
  }
  const groups = new Map<string, FailureAlert>();
  for (const a of byRun.values()) {
    if (a.delivered) continue;
    const reason = a.reasons[a.reasons.length - 1] ?? a.runReason;
    if (!reason) continue;
    const kind = kindOfKey(a.key);
    const gid = `${kind}|${a.flowId}`;
    let g = groups.get(gid);
    if (!g) groups.set(gid, (g = { kind, flowId: a.flowId, contactIds: [], reasons: [] }));
    if (!g.contactIds.includes(a.contactId)) {
      g.contactIds.push(a.contactId);
      g.reasons.push(reason);
    }
  }
  return [...groups.values()];
}

/**
 * Saludos de cumpleaños que YA tocaban y no entraron a la cola: por cada flujo de cumpleaños activo, los cumpleañeros
 * del mes cuyo día de envío (cumpleaños + `daysOffset`) ya pasó, que existían cuando tocaba, cuando el flujo ya
 * existía, y que no tienen ninguna ejecución de ese flujo con la llave del año. Quien se dio de baja no cuenta.
 */
export function expectedGreetingMisses(input: {
  today: string;
  year: number;
  flows: readonly { id: string; createdOn: string; daysOffset: number }[];
  contacts: readonly { id: string; day: number; month: number; createdOn: string; reachable: boolean; optedOut: boolean }[];
  /** `flowId|contactId` con ejecución de saludo de ese año. */
  started: ReadonlySet<string>;
}): { flowId: string; contactId: string; reason: "no_conversation" | "not_queued" }[] {
  const out: { flowId: string; contactId: string; reason: "no_conversation" | "not_queued" }[] = [];
  for (const c of input.contacts) {
    if (c.optedOut) continue;
    const bday = `${input.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
    if (Number.isNaN(Date.parse(`${bday}T00:00:00Z`)) || new Date(`${bday}T00:00:00Z`).getUTCDate() !== c.day) continue;
    for (const f of input.flows) {
      const send = new Date(Date.parse(`${bday}T00:00:00Z`) + f.daysOffset * 86_400_000).toISOString().slice(0, 10);
      if (!(send < input.today)) continue; // hoy todavía puede salir a su hora
      if (send < f.createdOn || send < c.createdOn) continue; // el flujo o el cliente no existían cuando tocaba
      if (input.started.has(`${f.id}|${c.id}`)) continue;
      out.push({ flowId: f.id, contactId: c.id, reason: c.reachable ? "not_queued" : "no_conversation" });
    }
  }
  return out;
}

/** Qué motivo del aviso corresponde a un error del lanzamiento del rescate automático. */
export function launchErrorReason(code: string): AlertReason {
  switch (code) {
    case "not_found":
      return "flow_missing";
    case "flow_inactive":
      return "flow_inactive";
    case "not_manual_flow":
      return "not_manual_flow";
    case "greeting_copy":
      return "greeting_copy";
    default:
      return "send_error";
  }
}
