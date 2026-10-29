import { z } from "zod";

/**
 * Módulo SALON — egresos y gastos operativos: contratos compartidos entre la
 * pantalla y la API (esquemas Zod y formas de respuesta). Los montos viajan en
 * centavos enteros. El precio de un gasto es lo REAL pagado: nunca se multiplica
 * por la cantidad (en un insumo, la cantidad solo informa cuántas unidades vinieron).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Tope por gasto (cabe en un entero de la base) y por cantidad. */
export const EXPENSE_MAX_TOTAL_CENTS = 2_000_000_000;
export const EXPENSE_MAX_QUANTITY = 100_000;

export const EXPENSE_PRESENTATIONS = ["units", "package", "dozen"] as const;
export type ExpensePresentation = (typeof EXPENSE_PRESENTATIONS)[number];
/** Una docena son siempre 12 unidades. */
export const DOZEN_UNITS = 12;

const tidy =(v: string) => v.replace(/\s+/g, " ").trim();

export const expenseItemInputSchema = z
  .object({
    /** Fijo (alquiler, luz, agua) o insumo / variable (hojas, ceras…). */
    isFixed: z
      .boolean()
      .nullish()
      .transform((v) => v ?? false),
    name: z
      .string({ required_error: "Escribe qué se compró o pagó" })
      .transform(tidy)
      .pipe(
        z
          .string()
          .min(2, "Escribe qué se compró o pagó")
          .max(120, "Admite hasta 120 caracteres")
      ),
    /**
     * Detalle de la compra, solo de REFERENCIA (opcional): cuántos paquetes/bultos (o unidades
     * sueltas). No cambia el precio ni mueve ningún stock.
     */
    quantity: z
      .number({ invalid_type_error: "Escribe la cantidad" })
      .int("La cantidad debe ser un número entero")
      .min(1, "La cantidad mínima es 1")
      .max(EXPENSE_MAX_QUANTITY, "La cantidad es demasiado grande")
      .nullish()
      .transform((v) => v ?? null),
    /** Cómo vino la compra: unidades, paquete / caja o docena (12 unidades). */
    presentation: z.enum(EXPENSE_PRESENTATIONS).nullish().transform((v) => v ?? null),
    /** Unidades que trae cada paquete o caja (en docena se fija en 12). */
    unitsPerPackage: z
      .number({ invalid_type_error: "Escribe las unidades por paquete" })
      .int("Debe ser un número entero")
      .min(1, "El mínimo es 1")
      .max(EXPENSE_MAX_QUANTITY, "El número es demasiado grande")
      .nullish()
      .transform((v) => v ?? null),
    /** Lo REAL pagado por toda la compra, tal cual: nunca se multiplica por la cantidad. */
    totalPriceCents: z
      .number({ invalid_type_error: "Escribe el precio", required_error: "Escribe el precio" })
      .int("El monto debe estar en centavos enteros")
      .min(0, "El precio no puede ser negativo")
      .max(EXPENSE_MAX_TOTAL_CENTS, "El precio es demasiado grande"),
    /** Día del pago o de la compra (AAAA-MM-DD, del negocio). */
    expenseDate: z
      .string({ required_error: "Elige la fecha" })
      .regex(ISO_DATE, "Fecha no válida (AAAA-MM-DD)"),
    notes: z
      .string()
      .trim()
      .max(500, "Admite hasta 500 caracteres")
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  // En «Paquete / Caja» con cantidad, las unidades por paquete son obligatorias.
  .superRefine((v, ctx) => {
    const presentation = v.presentation ?? (v.unitsPerPackage ? "package" : "units");
    if (!v.isFixed && v.quantity !== null && presentation === "package" && v.unitsPerPackage === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unitsPerPackage"],
        message: "Escribe cuántas unidades trae cada paquete",
      });
    }
  })
  // Un gasto fijo es un solo monto: no lleva detalle de compra. Sin cantidad tampoco hay
  // presentación ni unidades por paquete. La docena son siempre 12 unidades; en «Unidades»
  // no hay paquete.
  .transform((v) => {
    if (v.isFixed || v.quantity === null) {
      return { ...v, quantity: null, presentation: null, unitsPerPackage: null };
    }
    const presentation: ExpensePresentation = v.presentation ?? (v.unitsPerPackage ? "package" : "units");
    const unitsPerPackage =
      presentation === "dozen" ? DOZEN_UNITS : presentation === "package" ? v.unitsPerPackage : null;
    return { ...v, presentation, unitsPerPackage };
  });
export type ExpenseItemInput = z.input<typeof expenseItemInputSchema>;
export type ExpenseItemParsed = z.output<typeof expenseItemInputSchema>;

/** Total de unidades de la compra (paquetes × unidades por paquete); null si no hay detalle. */
export function expenseTotalUnits(e: {
  quantity: number | null;
  unitsPerPackage: number | null;
}): number | null {
  if (e.quantity === null) return null;
  return e.quantity * (e.unitsPerPackage ?? 1);
}

/* ------------------------------ respuestas ------------------------------ */

export type ExpenseItemDto = {
  id: string;
  isFixed: boolean;
  name: string;
  /** Paquetes/bultos (o unidades sueltas) comprados; solo insumos, opcional. */
  quantity: number | null;
  presentation: ExpensePresentation | null;
  /** Unidades por paquete (12 en docena); null = unidades. */
  unitsPerPackage: number | null;
  totalPriceCents: number;
  notes: string | null;
  /** Día del gasto en la zona del negocio (AAAA-MM-DD). */
  expenseDate: string;
};

/**
 * Lo que entró contra lo que salió en un periodo:
 *
 *   ganancia neta real = ingresos − comisiones del equipo − gastos operativos
 *
 * (`netBeforeExpensesCents` es la «ganancia neta» de Caja: ingresos menos
 * comisiones, antes de descontar los gastos.)
 */
export type ExpenseKindTotal = { count: number; totalCents: number };

export type ExpenseSummaryDto = {
  revenueCents: number;
  commissionsCents: number;
  netBeforeExpensesCents: number;
  expensesCents: number;
  realNetCents: number;
  /** Fijos (alquiler, luz…) contra variables (insumos). */
  byKind: { fixed: ExpenseKindTotal; variable: ExpenseKindTotal };
};

export type ExpensesReportDto = {
  period: { from: string; to: string; timezone: string; days: number };
  summary: ExpenseSummaryDto;
  items: ExpenseItemDto[];
  /** Se muestran solo los más recientes; los totales incluyen todos. */
  truncated: boolean;
};

/** Cálculo del resumen, puro y sin base de datos (lo prueba la suite). */
export function buildExpenseSummary(input: {
  revenueCents: number;
  commissionsCents: number;
  expensesCents: number;
  byKind: ExpenseSummaryDto["byKind"];
}): ExpenseSummaryDto {
  const netBeforeExpensesCents = input.revenueCents - input.commissionsCents;
  return {
    revenueCents: input.revenueCents,
    commissionsCents: input.commissionsCents,
    netBeforeExpensesCents,
    expensesCents: input.expensesCents,
    realNetCents: netBeforeExpensesCents - input.expensesCents,
    byKind: input.byKind,
  };
}
