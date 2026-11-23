import { z } from "zod";

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

export const creditsReportQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});
