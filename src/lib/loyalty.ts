import { z } from "zod";

/** Contratos de la API de fidelización (compartidos cliente/servidor). */

export const LOYALTY_TYPES = ["earned", "redeemed", "birthday_excluded", "adjusted"] as const;

/** El ajuste manual cambia el saldo a mano: queda siempre con su motivo, para auditoría. */
export const MIN_ADJUST_NOTE = 3;

/** Qué cliente: por id del CRM o por celular (dígitos con código de país). Uno de los dos. */
export const loyaltyCardQuerySchema = z
  .object({
    contactId: z.string().trim().min(1).max(64).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\d{7,15}$/, "Celular en dígitos, con código de país (ej. 51987654321)")
      .optional(),
  })
  .refine((v) => Boolean(v.contactId) !== Boolean(v.phone), "Indica contactId o phone (uno solo)");

export const loyaltyTransactionInputSchema = z
  .object({
    contactId: z.string().trim().min(1).max(64),
    type: z.enum(LOYALTY_TYPES),
    staffId: z.string().trim().min(1).max(64).nullish(),
    notes: z.string().trim().max(200).nullish(),
    /** Solo `adjusted`: sellos a sumar (+) o quitar (−). */
    stampsChange: z.number().int().min(-100).max(100).optional(),
    /** Solo `redeemed`: el hito que se canjea (su número de sellos). Sin él, el mejor alcanzado. */
    milestoneStamps: z.number().int().min(1).max(100).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type !== "redeemed" && v.milestoneStamps !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["milestoneStamps"],
        message: "milestoneStamps solo aplica al tipo redeemed",
      });
    }
    if (v.type === "adjusted" && (v.notes ?? "").length < MIN_ADJUST_NOTE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notes"],
        message: `Escribe el motivo del ajuste (mínimo ${MIN_ADJUST_NOTE} caracteres)`,
      });
    }
    if (v.type === "adjusted" && !v.stampsChange) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stampsChange"],
        message: "El ajuste necesita un número de sellos distinto de 0",
      });
    }
    if (v.type !== "adjusted" && v.stampsChange !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stampsChange"],
        message: "stampsChange solo aplica al tipo adjusted",
      });
    }
  });
export type LoyaltyTransactionInput = z.infer<typeof loyaltyTransactionInputSchema>;

export const REWARD_TYPES = ["service_free", "percentage_discount", "product_free"] as const;
export type RewardType = (typeof REWARD_TYPES)[number];

export const REWARD_TYPE_LABELS: Record<RewardType, string> = {
  service_free: "Servicio gratis",
  percentage_discount: "Descuento porcentual",
  product_free: "Producto gratis",
};

export const MAX_STAMPS_REQUIRED = 50;

export const MAX_MILESTONES = 10;

/** Un premio por hito: se desbloquea al llegar al sello `stamps`. */
export const loyaltyMilestoneSchema = z
  .object({
    stamps: z
      .number({
        required_error: "Escribe en qué sello se gana",
        invalid_type_error: "Escribe en qué sello se gana",
      })
      .int("Debe ser un número entero")
      .min(1, "Mínimo 1 sello")
      .max(MAX_STAMPS_REQUIRED, `Máximo ${MAX_STAMPS_REQUIRED} sellos`),
    title: z.string().trim().min(1, "Describe el premio").max(120, "Máximo 120 caracteres"),
    rewardType: z.enum(REWARD_TYPES),
    /** Solo con `percentage_discount`. */
    discountPercentage: z
      .number({ invalid_type_error: "Escribe el porcentaje" })
      .int("Debe ser un número entero")
      .min(1, "Mínimo 1%")
      .max(100, "Máximo 100%")
      .nullish()
      .transform((v) => v ?? undefined),
    /** Solo con `service_free`: el servicio al que aplica (vacío = cualquiera). */
    serviceIdRestriction: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .nullish()
      .transform((v) => v ?? undefined),
  })
  .superRefine((v, ctx) => {
    if (v.rewardType === "percentage_discount" && v.discountPercentage == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discountPercentage"],
        message: "Escribe el porcentaje de descuento",
      });
    }
  })
  // Cada tipo guarda solo lo suyo.
  .transform((v) => ({
    stamps: v.stamps,
    title: v.title,
    rewardType: v.rewardType,
    ...(v.rewardType === "percentage_discount" && v.discountPercentage != null
      ? { discountPercentage: v.discountPercentage }
      : {}),
    ...(v.rewardType === "service_free" && v.serviceIdRestriction
      ? { serviceIdRestriction: v.serviceIdRestriction }
      : {}),
  }));
export type LoyaltyMilestoneDto = z.output<typeof loyaltyMilestoneSchema>;

/** La configuración del programa (PUT /api/loyalty/settings). */
export const loyaltySettingsInputSchema = z
  .object({
    milestones: z
      .array(loyaltyMilestoneSchema)
      .min(1, "Agrega al menos un premio")
      .max(MAX_MILESTONES, `Máximo ${MAX_MILESTONES} premios`),
    cardTitle: z.string().trim().min(1, "Ponle un nombre a la tarjeta").max(40, "Máximo 40 caracteres"),
    brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color HEX de 6 dígitos (ej. #111827)"),
    /** Imagen de la biblioteca de medios que dibuja cada sello (`null` = el palomito por defecto). */
    stampIconMediaId: z.string().trim().min(1).max(64).nullish(),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<number>();
    v.milestones.forEach((m, i) => {
      if (seen.has(m.stamps)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["milestones", i, "stamps"],
          message: "Ya hay un premio en ese sello",
        });
      }
      seen.add(m.stamps);
    });
  });
export type LoyaltySettingsInput = z.output<typeof loyaltySettingsInputSchema>;

/** Los hitos de menor a mayor sello (no muta el original). */
export function sortMilestones<T extends { stamps: number }>(milestones: readonly T[]): T[] {
  return [...milestones].sort((a, b) => a.stamps - b.stamps);
}

export interface MilestoneProgress<T extends { stamps: number }> {
  /** El premio final: el hito de más sellos (cierra la tarjeta). */
  final: T | null;
  /** Hitos alcanzados con los sellos actuales, de menor a mayor. */
  reached: T[];
  /** El siguiente hito por alcanzar (`null` si ya se alcanzaron todos). */
  next: T | null;
  /** El mejor premio que se puede canjear hoy (el alcanzado de más sellos). */
  best: T | null;
  /** Sellos que faltan para `next` (0 si no hay). */
  stampsRemaining: number;
}

/** Qué hitos alcanzó una tarjeta con `stamps` sellos. Pura: la usan el servidor y la pantalla. */
export function milestoneProgress<T extends { stamps: number }>(
  milestones: readonly T[],
  stamps: number
): MilestoneProgress<T> {
  const sorted = sortMilestones(milestones);
  const reached = sorted.filter((m) => m.stamps <= stamps);
  const next = sorted.find((m) => m.stamps > stamps) ?? null;
  return {
    final: sorted[sorted.length - 1] ?? null,
    reached,
    next,
    best: reached[reached.length - 1] ?? null,
    stampsRemaining: next ? next.stamps - stamps : 0,
  };
}

/** Lo que Caja informa tras sellar una venta. */
export type SaleLoyaltyDto = {
  /** `earned` = +1 sello; `birthday_excluded` = descuento de cumpleaños, no suma. */
  type: "earned" | "birthday_excluded";
  currentStamps: number;
  /** Sellos del premio final (cierra la tarjeta). */
  stampsRequired: number;
  rewardReady: boolean;
  rewardJustUnlocked: boolean;
  /** Título del premio que se acaba de desbloquear (el de más sellos si fueron varios). */
  unlockedTitle: string | null;
};

/** La respuesta de `GET /api/loyalty/card` tal como llega por JSON (las fechas, en ISO). */
export type LoyaltyTransactionDto = {
  id: string;
  type: (typeof LOYALTY_TYPES)[number];
  stampsChange: number;
  notes: string | null;
  createdAt: string;
};

export type LoyaltyCardViewDto = {
  settings: {
    milestones: LoyaltyMilestoneDto[];
    cardTitle: string;
    brandColor: string;
    stampIconMediaId: string | null;
    /** Ruta pública del icono de los sellos (`null` = palomito por defecto). */
    stampIconUrl: string | null;
  };
  card: { currentStamps: number; totalStampsEarned: number; totalRewardsRedeemed: number } | null;
  contact: { id: string; name: string; phone: string | null };
  /** Quien consulta puede ajustar sellos a mano (dueño o administrador). */
  canAdjust: boolean;
  /** Hay al menos un premio canjeable hoy. */
  rewardReady: boolean;
  /** Sellos que faltan para el siguiente hito (0 si ya los alcanzó todos). */
  stampsRemaining: number;
  /** Premios alcanzados y canjeables hoy (cada canje descuenta los sellos de su hito). */
  availableMilestones: LoyaltyMilestoneDto[];
  nextMilestone: LoyaltyMilestoneDto | null;
  recent: LoyaltyTransactionDto[];
};

export const LOYALTY_TYPE_LABELS: Record<(typeof LOYALTY_TYPES)[number], string> = {
  earned: "Sello ganado",
  redeemed: "Premio canjeado",
  birthday_excluded: "Cumpleaños (sin sello)",
  adjusted: "Ajuste",
};

/** La frase de Caja tras cobrar: cómo quedó la tarjeta de fidelidad (vacía si no hubo). */
export function loyaltyNotice(result: { loyalty: SaleLoyaltyDto | null }): string {
  const l = result.loyalty;
  if (!l) return "";
  if (l.type === "birthday_excluded") return " Descuento de cumpleaños: no suma sello.";
  if (l.rewardJustUnlocked) {
    const what = l.unlockedTitle ? `: ${l.unlockedTitle}` : "";
    return ` ¡Premio de fidelidad desbloqueado${what}! (${l.currentStamps}/${l.stampsRequired} sellos)`;
  }
  return ` Sello ${l.currentStamps}/${l.stampsRequired}.`;
}
