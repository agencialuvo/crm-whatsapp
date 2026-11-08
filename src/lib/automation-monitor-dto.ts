import { LOGS_MAX_LIMIT, type LogStatusFilter } from "@/lib/automation-schemas";
import { stepLabel } from "@/lib/automation-dto";

/**
 * Automatizaciones (monitoreo) — tipos y textos de las pantallas de estado e historial (compartidos y
 * sin React, para probarlos). Los tipos describen lo que devuelven `/api/automations/stats` y
 * `/api/automations/logs`; las funciones los convierten en lo que lee la persona.
 */

/** Tope de filas por consulta del historial (el del servidor): «Todos» pide hasta aquí. */
export const MAX_LOG_ROWS = LOGS_MAX_LIMIT;

export type StatsDto = {
  flowId: string | null;
  summary: { pending: number; success: number; failed: number; skipped: number };
  queue: {
    pending: number;
    processing: number;
    completed: number;
    cancelled: number;
    failed: number;
    nextScheduledFor: string | null;
  };
  executions: {
    success: number;
    failed: number;
    skippedRateLimit: number;
    skippedOptOut: number;
    total: number;
    lastExecutedAt: string | null;
  };
};

export type LogStatus = "success" | "failed" | "skipped_rate_limit" | "skipped_opt_out";

export type LogDto = {
  id: string;
  flowId: string;
  flowName: string;
  step: { id: string; stepType: string | null } | null;
  queueId: string | null;
  status: LogStatus;
  contact: { id: string; name: string; phone: string | null };
  error: string | null;
  metadata: Record<string, unknown> | null;
  executedAt: string;
};

export type LogsPageDto = { logs: LogDto[]; total: number; limit: number; offset: number };

/* ─── Estado ─── */

export const LOG_FILTERS: readonly { value: LogStatusFilter | "all"; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "success", label: "Exitosos" },
  { value: "failed", label: "Fallidos" },
  { value: "skipped", label: "Omitidos" },
];

export const LOG_STATUS_LABELS: Record<string, string> = {
  success: "Enviado",
  failed: "Fallido",
  skipped_rate_limit: "Omitido · frecuencia",
  skipped_opt_out: "Omitido · baja",
};

export const logStatusLabel = (status: string): string => LOG_STATUS_LABELS[status] ?? status;

export type LogTone = "success" | "destructive" | "warning" | "secondary";

export function logStatusTone(status: string): LogTone {
  if (status === "success") return "success";
  if (status === "failed") return "destructive";
  if (status.startsWith("skipped")) return "warning";
  return "secondary";
}

/** Por qué se omitió, en una frase. */
export const SKIP_REASONS: Record<string, string> = {
  skipped_rate_limit: "Se omitió por la regla de frecuencia: ese contacto ya recibió un mensaje hace poco.",
  skipped_opt_out: "Se omitió porque el contacto pidió no recibir más mensajes.",
};

/* ─── Errores ─── */

const ERROR_EXPLANATIONS: [RegExp, string][] = [
  [
    /out_of_window_requires_template/,
    "Pasaron más de 24 h desde el último mensaje del cliente, y fuera de esa ventana WhatsApp solo permite plantillas aprobadas. Usa una plantilla en este paso.",
  ],
  [/max_attempts_exceeded/, "Se agotaron los reintentos: el envío falló todas las veces que se intentó."],
  [/no_conversation/, "El contacto no tiene una conversación de WhatsApp a la que enviar."],
  [/sandbox_conversation/, "Es una conversación de prueba del Laboratorio: nunca se le envía por la API real."],
  [/not_whatsapp_channel/, "La conversación del contacto no es de WhatsApp."],
  [/invalid_step_config/, "Los ajustes del paso no son válidos: edítalo y revisa sus campos."],
  [/step_type_not_supported/, "Este tipo de paso todavía no se puede ejecutar."],
  [/flow_inactive/, "El flujo estaba apagado cuando le tocaba ejecutarse."],
];

/** Una explicación en lenguaje llano para los errores conocidos (el texto exacto se muestra aparte), o `null`. */
export function explainError(error: string | null): string | null {
  if (!error) return null;
  return ERROR_EXPLANATIONS.find(([re]) => re.test(error))?.[1] ?? null;
}

/* ─── Una línea del historial ─── */

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const asText = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** El nombre del paso tal como estaba al ejecutarse (la «foto» de `metadata.step`), o el del tipo. */
export function logStepTitle(log: Pick<LogDto, "step" | "metadata">): string {
  const snap = asRecord(log.metadata?.step);
  const name = asText(snap?.stepName);
  if (name) return name;
  const type = asText(snap?.stepType) ?? log.step?.stepType ?? null;
  if (type) return stepLabel(type);
  return "Paso eliminado";
}

export type LogDetail = {
  title: string;
  /** El paso sigue existiendo (la línea no quedó huérfana). */
  stepExists: boolean;
  stepType: string | null;
  attempt: number | null;
  /** Mensaje exacto del error, tal como lo guardó el motor. */
  error: string | null;
  errorHint: string | null;
  skipReason: string | null;
  /** ID del mensaje en la API de WhatsApp (Meta), si se envió. */
  waMessageId: string | null;
  /** ID del mensaje dentro del CRM. */
  messageId: string | null;
  windowOpen: boolean | null;
  nextAt: string | null;
  payload: unknown;
  stepConfig: Record<string, unknown> | null;
  /** Lo que sobra de `metadata` y no tiene su propio campo: se muestra completo en «Datos técnicos». */
  raw: Record<string, unknown> | null;
};

/** Lo que el diálogo del registro muestra de `metadata`: el motor guarda la foto del paso y, según el caso, el resultado. */
export function describeLog(log: Pick<LogDto, "status" | "step" | "error" | "metadata">): LogDetail {
  const md = log.metadata ?? null;
  const snap = asRecord(md?.step);
  const attempt = typeof md?.attempt === "number" ? md.attempt : null;
  const error = log.error ?? asText(md?.error);
  return {
    title: logStepTitle({ step: log.step, metadata: md }),
    stepExists: log.step !== null,
    stepType: asText(snap?.stepType) ?? log.step?.stepType ?? null,
    attempt,
    error,
    errorHint: explainError(error),
    skipReason: SKIP_REASONS[log.status] ?? null,
    waMessageId: asText(md?.waMessageId),
    messageId: asText(md?.messageId),
    windowOpen: typeof md?.windowOpen === "boolean" ? md.windowOpen : null,
    nextAt: asText(md?.nextAt),
    payload: md && "payload" in md ? md.payload : null,
    stepConfig: asRecord(snap?.config),
    raw: md,
  };
}

/** JSON legible (con sangría) para el bloque de datos técnicos. */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

/* ─── Fechas ─── */

/** «8 nov 2026, 16:48» en el idioma de la persona; `—` si falta o no es una fecha. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Cuánto falta o cuánto pasó, en una frase corta («en 5 min», «hace 2 h»). */
export function relativeWhen(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = t - now;
  const abs = Math.abs(diff);
  const unit =
    abs < 60_000 ? "menos de 1 min" : abs < 3_600_000 ? `${Math.round(abs / 60_000)} min` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)} h` : `${Math.round(abs / 86_400_000)} d`;
  return diff >= 0 ? `en ${unit}` : `hace ${unit}`;
}
