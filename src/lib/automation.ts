import { z } from "zod";

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

export const DELAY_UNITS = ["minutes", "hours", "days"] as const;
const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

export const delayConfigSchema = z.object({
  name: z.string().trim().max(120).optional(),
  amount: z.number().int().positive().max(366),
  unit: z.enum(DELAY_UNITS),
});
export type DelayConfig = z.infer<typeof delayConfigSchema>;

export function delayToMs(cfg: Pick<DelayConfig, "amount" | "unit">): number {
  return cfg.amount * UNIT_MS[cfg.unit];
}

/** El nombre con que un paso aparece en el historial: el que le puso el dueño o su tipo. */
export function stepLabel(stepType: string, config: unknown): string {
  const name = (config as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() ? name.trim() : stepType;
}

/* ─── Variables ─── */

/** Reemplaza `{{name}}` / `{{nombre}}` por el nombre del contacto (o «» si no tiene). */
export function renderVars(text: string, vars: { name: string | null }): string {
  const name = vars.name?.trim() || "";
  return text
    .replace(/\{\{\s*(?:name|nombre)\s*\}\}/gi, name)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
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
