import { z } from "zod";
import type { PeriodDto } from "@/lib/analytics";
import { PAGE_SIZE_ALL, PAGE_SIZES, pageSizeLabel, rowsPerPage } from "@/lib/pagination";
import type { PaymentMethod } from "@/lib/salon/schemas";

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

/** Un turno del historial: el turno y quién lo abrió y lo cerró (por nombre, no por id). */
export type CashShiftRowDto = CashShiftDto & {
  openedByName: string | null;
  closedByName: string | null;
};

export type ShiftPaymentDto = { method: PaymentMethod; count: number; amountCents: number };

/** El desglose de un turno: cómo se cobró lo que vendió. */
export type CashShiftDetailDto = CashShiftRowDto & {
  byPayment: ShiftPaymentDto[];
  salesCount: number;
  expensesCount: number;
  /**
   * Las ventas del periodo del turno tal como están HOY. Si difiere de `totalSalesCents`
   * (lo congelado al cerrar), alguna venta se anuló o editó después del cierre.
   */
  currentSalesCents: number;
};

/** Historial: filas por consulta (tope del servidor) y respuesta. */
export const MAX_HISTORY_ROWS = 200;
export const DEFAULT_HISTORY_ROWS = 25;

export type ShiftHistoryDto = {
  shifts: CashShiftRowDto[];
  /** Cuántos turnos cerrados hay en el periodo (todas las páginas). */
  total: number;
  period: PeriodDto;
};

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_HISTORY_ROWS).default(DEFAULT_HISTORY_ROWS),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

// La regla de paginación vive en `@/lib/pagination`; se re-exporta para no romper importadores.
export { PAGE_SIZE_ALL, PAGE_SIZES, pageSizeLabel, rowsPerPage };

export const MAX_PAGE_SIZE_VIEWS = 50;

export const tableViewKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Nombre de vista no válido");

export const pageSizeSchema = z
  .number()
  .int()
  .refine((n): n is (typeof PAGE_SIZES)[number] => (PAGE_SIZES as readonly number[]).includes(n), {
    message: `Filas por página: ${PAGE_SIZES.map(pageSizeLabel).join(", ")}`,
  });

export const setTablePageSizeInputSchema = z.object({
  view: tableViewKeySchema,
  pageSize: pageSizeSchema,
});
export type SetTablePageSizeInput = z.infer<typeof setTablePageSizeInputSchema>;
