import { z } from "zod";
import { PACK_LIMITS } from "@/lib/credits";

/**
 * Monedas en el panel de Super Admin — contratos compartidos entre las rutas y la UI. Las cantidades que escribe una
 * persona van en MONEDAS (con hasta 2 decimales); el servidor las pasa a unidades (1 moneda = 100).
 */

const coins = z
  .number()
  .finite()
  .refine((n) => Math.abs(n) <= 1_000_000, "Máximo 1.000.000 monedas por ajuste")
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "Máximo 2 decimales");

export const creditsActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("adjust"),
    /** `plan`: la cuota del mes (no puede quedar en negativo). `topup`: el saldo de recargas (no vence). */
    bucket: z.enum(["plan", "topup"]),
    /** Con signo: positivo suma, negativo resta. No puede ser 0. */
    coins: coins.refine((n) => n !== 0, "El ajuste no puede ser 0"),
    /** Todo ajuste deja su motivo en el libro. */
    note: z.string().trim().min(3, "Escribe el motivo (mínimo 3 letras)").max(300, "Máximo 300 caracteres"),
    /** Lo genera la pantalla al abrir el formulario: un doble clic o un reintento no ajusta dos veces. */
    requestId: z.string().trim().min(8).max(64),
  }),
  z.object({
    action: z.literal("cut"),
    cutEnabled: z.boolean(),
    /** Cuánto negativo tolera antes de cortar (en monedas). Opcional. */
    overdraftCoins: coins.refine((n) => n >= 0, "No puede ser negativo").optional(),
  }),
]);
export type CreditsActionInput = z.infer<typeof creditsActionSchema>;

export const creditsRootActionSchema = z.object({
  action: z.literal("reconcile"),
  /** Reescribir la caché desde el libro. Solo si se pide expresamente. */
  repair: z.boolean().optional(),
});

const packName = z
  .string()
  .transform((s) => s.replace(/\s+/g, " ").trim())
  .pipe(z.string().min(PACK_LIMITS.nameMin, `Mínimo ${PACK_LIMITS.nameMin} letras`).max(PACK_LIMITS.nameMax, `Máximo ${PACK_LIMITS.nameMax} caracteres`));
const packCoins = z
  .number()
  .finite()
  .min(0.01, "Mínimo 0,01 monedas")
  .max(PACK_LIMITS.maxUnits / 100, "Máximo 1.000.000 monedas")
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "Máximo 2 decimales");
/** El precio se escribe en moneda (soles/dólares) y viaja en centavos enteros. */
const packPriceCents = z.number().int("El precio va en centavos enteros").min(1, "El precio debe ser mayor que 0").max(PACK_LIMITS.maxPriceCents, "Precio demasiado alto");
const packCurrency = z.enum(["PEN", "USD"]);
const packSort = z.number().int().min(0).max(PACK_LIMITS.maxSort);

/** Un paquete nuevo. `coins` en monedas (el servidor lo pasa a unidades); `priceCents` en centavos. */
export const packCreateSchema = z.object({
  name: packName,
  coins: packCoins,
  priceCents: packPriceCents,
  currency: packCurrency.default("PEN"),
  sortOrder: packSort.default(0),
  active: z.boolean().default(true),
});
export type PackCreateInput = z.infer<typeof packCreateSchema>;

/** Cambios a un paquete: cualquiera de los campos, al menos uno. */
export const packUpdateSchema = z
  .object({
    name: packName.optional(),
    coins: packCoins.optional(),
    priceCents: packPriceCents.optional(),
    currency: packCurrency.optional(),
    sortOrder: packSort.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, "No hay nada que cambiar");
export type PackUpdateInput = z.infer<typeof packUpdateSchema>;

/** «59,90» o «59.9» → 5990 centavos; `null` si no es un precio válido (dos decimales como máximo, mayor que 0). */
export function parsePriceToCents(raw: string): number | null {
  const s = raw.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return cents > 0 ? cents : null;
}

/** Un paquete tal como lo ve el Super Admin (todos, también los inactivos). `units` en unidades (100 = 1 moneda). */
export type PackDto = {
  id: string;
  name: string;
  units: number;
  priceCents: number;
  currency: string;
  active: boolean;
  sortOrder: number;
  /** Lo que cuesta cada moneda en este paquete, en centavos: para compararlos. */
  pricePerCoinCents: number;
  createdAt: string;
};

/** Un paquete tal como lo ve un cliente: solo lo necesario para comprarlo (sin orden interno ni fechas). */
export type PublicPackDto = Pick<PackDto, "id" | "name" | "units" | "priceCents" | "currency">;

export const creditsReportQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});
