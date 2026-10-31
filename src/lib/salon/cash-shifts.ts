import { z } from "zod";

/**
 * Cuadre de caja y turnos — contratos compartidos. Todo el dinero viaja en
 * céntimos enteros (como el resto del módulo SALON): nunca decimales.
 */

/** Tope por monto: lo que cabe en un `integer` de Postgres con margen para sumar. */
export const MAX_CASH_CENTS = 1_000_000_000;

const cents = z
  .number({ invalid_type_error: "Escribe un monto válido" })
  .int("El monto va en céntimos enteros")
  .min(0, "El monto no puede ser negativo")
  .max(MAX_CASH_CENTS, "El monto es demasiado grande");

export const openShiftInputSchema = z.object({
  initialCashCents: cents,
});
export type OpenShiftInput = z.infer<typeof openShiftInputSchema>;

export const closeShiftInputSchema = z.object({
  /** Efectivo contado físicamente en la caja al cerrar. */
  finalCashCents: cents,
  notes: z.string().trim().max(500).optional(),
});
export type CloseShiftInput = z.infer<typeof closeShiftInputSchema>;

/** Lo que el sistema calcula al cerrar un turno. */
export type ShiftTotals = {
  totalSalesCents: number;
  totalCommissionsCents: number;
  totalExpensesCents: number;
  /** Ventas − comisiones − gastos. */
  netProfitCents: number;
  /** Efectivo inicial + ventas cobradas en efectivo. */
  expectedCashCents: number;
};

/** Suma pura (testeable sin base de datos) de lo que sale de las consultas del cierre. */
export function computeShiftTotals(input: {
  initialCashCents: number;
  salesCents: number;
  commissionsCents: number;
  expensesCents: number;
  cashSalesCents: number;
}): ShiftTotals {
  return {
    totalSalesCents: input.salesCents,
    totalCommissionsCents: input.commissionsCents,
    totalExpensesCents: input.expensesCents,
    netProfitCents: input.salesCents - input.commissionsCents - input.expensesCents,
    expectedCashCents: input.initialCashCents + input.cashSalesCents,
  };
}

export type CashShiftDto = {
  id: string;
  status: "open" | "closed";
  openedByUserId: string;
  closedByUserId: string | null;
  initialCashCents: number;
  finalCashCents: number | null;
  expectedCashCents: number | null;
  /** Contado − esperado: positivo = sobra, negativo = falta. `null` mientras está abierto. */
  differenceCents: number | null;
  totalSalesCents: number;
  totalCommissionsCents: number;
  totalExpensesCents: number;
  netProfitCents: number;
  openedAt: string;
  closedAt: string | null;
  notes: string | null;
};

/** Vistas con paginación recordada y filas por página permitidas. */
export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const MAX_PAGE_SIZE_VIEWS = 50;

export const tableViewKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Nombre de vista no válido");

export const pageSizeSchema = z
  .number()
  .int()
  .refine((n): n is (typeof PAGE_SIZES)[number] => (PAGE_SIZES as readonly number[]).includes(n), {
    message: `Filas por página: ${PAGE_SIZES.join(", ")}`,
  });

export const setTablePageSizeInputSchema = z.object({
  view: tableViewKeySchema,
  pageSize: pageSizeSchema,
});
export type SetTablePageSizeInput = z.infer<typeof setTablePageSizeInputSchema>;
