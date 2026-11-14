import { z } from "zod";

/**
 * Enrutamiento por anuncio — contratos compartidos entre la pantalla, la API y el agente.
 *
 * Puro: sin base de datos ni red. Un flujo vincula el `source_id` de un anuncio de Meta con UN servicio u
 * oferta (o con ninguno, si solo lleva reglas) y dice cómo se porta el agente cuando una conversación
 * llega de ese anuncio.
 */

export const AD_FLOW_RULES_MAX = 1500;
export const AD_FLOW_SOURCE_ID_MAX = 128;
export const AD_FLOW_HEADLINE_MAX = 300;

/** Texto opcional: recortado; vacío ⇒ null. */
const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .nullish()
    .transform((v) => (v ? v : null));

/** Id de servicio u oferta opcional: vacío o ausente ⇒ null. */
const optionalId = z
  .string()
  .trim()
  .max(64)
  .nullish()
  .transform((v) => (v ? v : null));

export const adFlowSchema = z
  .object({
    /** El id del anuncio en Meta (`referral.source_id`). Sin espacios. */
    sourceId: z
      .string({ required_error: "Escribe el ID del anuncio" })
      .trim()
      .min(1, "Escribe el ID del anuncio")
      .max(AD_FLOW_SOURCE_ID_MAX, `Admite hasta ${AD_FLOW_SOURCE_ID_MAX} caracteres`)
      .regex(/^\S+$/, "El ID del anuncio no lleva espacios"),
    headline: optionalText(AD_FLOW_HEADLINE_MAX, `Admite hasta ${AD_FLOW_HEADLINE_MAX} caracteres`),
    serviceId: optionalId,
    comboId: optionalId,
    promptRules: optionalText(AD_FLOW_RULES_MAX, `Admite hasta ${AD_FLOW_RULES_MAX} caracteres`),
    active: z
      .boolean()
      .nullish()
      .transform((v) => v ?? true),
    exclusive: z
      .boolean()
      .nullish()
      .transform((v) => v ?? true),
  })
  .superRefine((v, ctx) => {
    if (v.serviceId && v.comboId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comboId"],
        message: "Elige un servicio o una oferta, no los dos",
      });
    }
    // Exclusivo sin nada que perseguir no tiene sentido: el agente no sabría qué ofrecer.
    if (v.exclusive && !v.serviceId && !v.comboId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serviceId"],
        message: "El modo exclusivo necesita un servicio o una oferta",
      });
    }
  });
export type AdFlowInput = z.input<typeof adFlowSchema>;
export type AdFlowParsed = z.output<typeof adFlowSchema>;

/* ------------------------------ respuestas ------------------------------ */

export type AdFlowTargetKind = "service" | "combo";

export type AdFlowDto = {
  id: string;
  sourceId: string;
  headline: string | null;
  serviceId: string | null;
  comboId: string | null;
  /** Nombre del servicio u oferta vinculados (null si no hay o ya se borró). */
  targetName: string | null;
  promptRules: string | null;
  active: boolean;
  exclusive: boolean;
  updatedAt: string;
};

/** Una fila de la lista: un anuncio detectado, uno configurado, o los dos. */
export type AdFlowRowDto = {
  sourceId: string;
  /** El titular que mandó Meta (el más reciente) o, si no hay, la etiqueta del flujo. */
  headline: string | null;
  sourceType: string | null;
  /** Miniatura del creativo (adjunto privado), si se alcanzó a copiar. */
  imageAssetId: string | null;
  /** Conversaciones que llegaron de este anuncio. 0 si solo está configurado a mano. */
  conversations: number;
  lastSeenAt: string | null;
  /** null = detectado pero sin configurar. */
  flow: AdFlowDto | null;
};

export type AdFlowListDto = { items: AdFlowRowDto[]; truncated: boolean };

/* ------------------------ contexto del agente (puro) ------------------------ */

/** Lo que el agente necesita saber del servicio u oferta del anuncio: datos OFICIALES del negocio. */
export type AdFlowTarget = {
  kind: AdFlowTargetKind;
  id: string;
  name: string;
  description: string | null;
  /** Ya formateado en la moneda del negocio («S/ 25.00»). */
  priceLabel: string;
  durationMinutes: number | null;
  /** Nombres de quienes lo dan; null = lo da todo el equipo. */
  providers: string[] | null;
};

export type AdFlowContext = {
  flowId: string;
  sourceId: string;
  /**
   * Efectivo: un flujo exclusivo cuyo servicio ya no existe (o está desactivado) se trata como NO
   * exclusivo, porque no hay nada que perseguir en exclusiva.
   */
  exclusive: boolean;
  promptRules: string | null;
  target: AdFlowTarget | null;
};

/** Qué cae en `createSessionBooking` cuando el agente agenda desde una conversación de este anuncio. */
export function bookingTargetOf(
  ctx: Pick<AdFlowContext, "target"> | null | undefined
): { serviceId?: string; comboId?: string; durationMinutes?: number } {
  const t = ctx?.target;
  if (!t) return {};
  return {
    ...(t.kind === "service" ? { serviceId: t.id } : { comboId: t.id }),
    ...(t.durationMinutes ? { durationMinutes: t.durationMinutes } : {}),
  };
}

/**
 * ¿Debe un segundo anuncio REEMPLAZAR al primero en `ad_attribution`? «El primer anuncio gana», salvo que
 * el primero no tuviera flujo activo y el nuevo sí: así el agente no pierde el enrutamiento por haber
 * entrado antes por un anuncio sin configurar.
 */
export function shouldReplaceAttribution(input: {
  existingSourceId: string | null;
  incomingSourceId: string | null;
  existingHasFlow: boolean;
  incomingHasFlow: boolean;
}): boolean {
  if (!input.incomingSourceId) return false;
  if (input.existingSourceId === input.incomingSourceId) return false;
  return !input.existingHasFlow && input.incomingHasFlow;
}
