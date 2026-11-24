import { z } from "zod";
import {
  CONDITION_MAX_STAMPS,
  addTagConfigSchema,
  codeJsConfigSchema,
  conditionConfigSchema,
  daysOffsetSchema,
  delayConfigSchema,
  removeTagConfigSchema,
  sendMediaConfigSchema,
  sendWhatsappConfigSchema,
  setStageConfigSchema,
  setVarConfigSchema,
  switchConfigSchema,
  waitReplyConfigSchema,
  waitUntilConfigSchema,
} from "@/lib/automation";

/**
 * Automatizaciones — contratos de la API de gestión de flujos y pasos (compartidos cliente/servidor).
 *
 * Solo se pueden CREAR los tipos de flujo y de paso que hoy tienen quién los ejecute: un flujo
 * `booking_reminder` se guardaría y no haría nada, y eso es peor que rechazarlo con un mensaje claro. La base conserva el catálogo completo (enum del
 * esquema); esta lista es lo que la API acepta.
 */

export const FLOW_TRIGGER_TYPES = [
  "birthday",
  "stage_changed",
  "lead_created",
  "manual",
  "booking_created",
  "booking_confirmed",
  "booking_no_show",
  "ad_referral",
  "tag_added",
  "loyalty_reward_unlocked",
] as const;
export type FlowTriggerType = (typeof FLOW_TRIGGER_TYPES)[number];

export const STEP_TYPES = [
  "send_whatsapp",
  "send_media",
  "delay",
  "wait_until",
  "wait_reply",
  "add_tag",
  "remove_tag",
  "set_stage",
  "condition",
  // Paso 3: variables entre nodos, enrutamiento multi-rama (solo lienzo) y código aislado (tras una bandera de plataforma).
  "set_var",
  "switch",
  "code_js",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

/** Tope de nodos por flujo: un flujo de cientos de pasos es un error de uso, no un caso real. */
export const MAX_STEPS_PER_FLOW = 50;

const MAX_COORD = 100_000;
const coord = z.number().int().min(-MAX_COORD).max(MAX_COORD);

/**
 * Ajustes del disparador, por tipo. Estrictos: una clave desconocida es un error de quien llama, no
 * algo que se guarde en silencio. `manual` y `lead_created` no llevan ajustes.
 */
export const TRIGGER_CONFIG_SCHEMAS = {
  birthday: z.object({ hour: z.number().int().min(0).max(23).optional(), daysOffset: daysOffsetSchema.optional() }).strict(),
  stage_changed: z.object({ toStageId: z.string().trim().min(1).max(64).nullish() }).strict(),
  lead_created: z.object({}).strict(),
  // Se dispara a mano para un contacto (`POST /api/automations/[id]/trigger`): no lleva ajustes.
  manual: z.object({}).strict(),
  // Sin `tagId`, cualquier etiqueta asignada; con él, solo esa (debe ser de la organización: lo comprueba `resolveTriggerConfig`).
  tag_added: z.object({ tagId: z.string().trim().min(1).max(64).nullish() }).strict(),
  // Sin `stamps`, cualquier premio; con él, solo el hito de esos sellos.
  loyalty_reward_unlocked: z.object({ stamps: z.number().int().min(1).max(CONDITION_MAX_STAMPS).nullish() }).strict(),
  booking_created: z.object({}).strict(),
  booking_confirmed: z.object({}).strict(),
  booking_no_show: z.object({}).strict(),
  // Sin nada, cualquier anuncio; con `sourceId`, solo ese (el `source_id` del referral de Meta); con `adsetId` o
  // `campaignId` (047), todo un conjunto o una campaña. Exactamente uno: solo IDs, nunca nombres.
  ad_referral: z
    .object({
      sourceId: z.string().trim().min(1).max(200).nullish(),
      adsetId: z.string().trim().min(1).max(200).nullish(),
      campaignId: z.string().trim().min(1).max(200).nullish(),
    })
    .strict()
    .refine((v) => [v.sourceId, v.adsetId, v.campaignId].filter(Boolean).length <= 1, {
      message: "Elige un anuncio, un conjunto o una campaña, no varios a la vez",
    }),
} as const satisfies Record<FlowTriggerType, z.ZodTypeAny>;

/**
 * Valida y normaliza `triggerConfig` para un tipo de flujo. Devuelve el JSON a guardar (`null` si
 * quedó vacío) o el mensaje del primer problema.
 */
export function parseTriggerConfigFor(
  triggerType: FlowTriggerType,
  raw: unknown
): { ok: true; value: Record<string, unknown> | null } | { ok: false; message: string } {
  const parsed = TRIGGER_CONFIG_SCHEMAS[triggerType].safeParse(raw ?? {});
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, message: `triggerConfig${i?.path.length ? `.${i.path.join(".")}` : ""}: ${i?.message ?? "no válido"}` };
  }
  const value = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined && v !== null));
  return { ok: true, value: Object.keys(value).length ? value : null };
}

const flowName = z.string().trim().min(1, "Escribe un nombre").max(120);

export const flowCreateSchema = z
  .object({
    name: flowName,
    triggerType: z.enum(FLOW_TRIGGER_TYPES, {
      errorMap: () => ({
        message: `triggerType debe ser uno de: ${FLOW_TRIGGER_TYPES.join(", ")} (booking_reminder aún no tiene disparador)`,
      }),
    }),
    triggerConfig: z.record(z.unknown()).nullish(),
  })
  // Sin `active`: un flujo nace apagado (sin pasos no hay nada que ejecutar) y se enciende con PATCH
  // cuando ya tiene pasos. `strict` hace que mandar `active` aquí sea un 422 y no algo ignorado.
  .strict();
export type FlowCreateInput = z.infer<typeof flowCreateSchema>;

/** `triggerType` no se cambia: el tipo decide qué significan los ajustes; para otro tipo, un flujo nuevo. */
export const flowPatchSchema = z
  .object({
    name: flowName.optional(),
    triggerConfig: z.record(z.unknown()).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Envía al menos un campo para actualizar" });
export type FlowPatchInput = z.infer<typeof flowPatchSchema>;

/** Un paso: el tipo decide la forma de `config`. */
export const stepCreateSchema = z
  .discriminatedUnion(
    "stepType",
    [
      z.object({ stepType: z.literal("send_whatsapp"), config: sendWhatsappConfigSchema }),
      z.object({ stepType: z.literal("send_media"), config: sendMediaConfigSchema }),
      z.object({ stepType: z.literal("delay"), config: delayConfigSchema }),
      z.object({ stepType: z.literal("wait_until"), config: waitUntilConfigSchema }),
      z.object({ stepType: z.literal("wait_reply"), config: waitReplyConfigSchema }),
      z.object({ stepType: z.literal("add_tag"), config: addTagConfigSchema }),
      z.object({ stepType: z.literal("remove_tag"), config: removeTagConfigSchema }),
      z.object({ stepType: z.literal("set_stage"), config: setStageConfigSchema }),
      z.object({ stepType: z.literal("condition"), config: conditionConfigSchema }),
      z.object({ stepType: z.literal("set_var"), config: setVarConfigSchema }),
      z.object({ stepType: z.literal("switch"), config: switchConfigSchema }),
      z.object({ stepType: z.literal("code_js"), config: codeJsConfigSchema }),
    ],
    {
      errorMap: (issue, ctx) =>
        issue.code === "invalid_union_discriminator"
          ? { message: `stepType debe ser uno de: ${STEP_TYPES.join(", ")}` }
          : { message: ctx.defaultError },
    }
  )
  .and(
    z.object({
      positionX: coord.default(0),
      positionY: coord.default(0),
    })
  );
export type StepCreateInput = z.infer<typeof stepCreateSchema>;

/** Editar un paso: `config` se valida contra el tipo que YA tiene (el tipo no cambia). */
export const stepPatchSchema = z
  .object({
    config: z.record(z.unknown()).optional(),
    positionX: coord.optional(),
    positionY: coord.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Envía al menos un campo para actualizar" });
export type StepPatchInput = z.infer<typeof stepPatchSchema>;

const STEP_CONFIG_SCHEMAS = {
  send_whatsapp: sendWhatsappConfigSchema,
  send_media: sendMediaConfigSchema,
  delay: delayConfigSchema,
  wait_until: waitUntilConfigSchema,
  wait_reply: waitReplyConfigSchema,
  add_tag: addTagConfigSchema,
  remove_tag: removeTagConfigSchema,
  set_stage: setStageConfigSchema,
  condition: conditionConfigSchema,
  set_var: setVarConfigSchema,
  switch: switchConfigSchema,
  code_js: codeJsConfigSchema,
} as const satisfies Record<StepType, z.ZodTypeAny>;

/** Valida `config` de un paso contra su tipo. */
export function parseStepConfig(
  stepType: StepType,
  raw: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const schema = STEP_CONFIG_SCHEMAS[stepType];
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, message: `config${i?.path.length ? `.${i.path.join(".")}` : ""}: ${i?.message ?? "no válido"}` };
  }
  return { ok: true, value: parsed.data as Record<string, unknown> };
}

/* ─── Monitoreo: historial de ejecuciones ─── */

/** Filtros del historial. `skipped` agrupa los dos motivos de salto (frecuencia y baja del contacto). */
export const LOG_STATUS_FILTERS = ["success", "failed", "skipped", "skipped_rate_limit", "skipped_opt_out"] as const;
export type LogStatusFilter = (typeof LOG_STATUS_FILTERS)[number];

export const LOGS_DEFAULT_LIMIT = 25;
export const LOGS_MAX_LIMIT = 100;

/** Query del historial: filtro por estado y paginación simple (`limit` + `offset`). */
export const logsQuerySchema = z.object({
  status: z.enum(LOG_STATUS_FILTERS).optional(),
  limit: z.coerce.number().int().min(1).max(LOGS_MAX_LIMIT).default(LOGS_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type LogsQuery = z.infer<typeof logsQuerySchema>;
