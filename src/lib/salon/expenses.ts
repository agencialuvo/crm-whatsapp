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

/** Cómo vino la compra: unidades, paquete / caja, volumen o peso, o servicio / licencia. */
export const EXPENSE_PRESENTATIONS = ["units", "package", "measure", "service"] as const;
export type ExpensePresentation = (typeof EXPENSE_PRESENTATIONS)[number];

/** Unidades de volumen o peso (solo en la presentación «measure»). */
export const EXPENSE_MEASURE_UNITS = ["l", "ml", "kg", "g"] as const;
export type ExpenseMeasureUnit = (typeof EXPENSE_MEASURE_UNITS)[number];

/** Etiquetas cortas de cada presentación (la unidad de medida usa su propio símbolo). */
export const EXPENSE_PRESENTATION_LABELS: Record<ExpensePresentation, { title: string; short: string }> = {
  units: { title: "Unidades", short: "und" },
  package: { title: "Paquetes / Cajas", short: "paq" },
  measure: { title: "Volumen / Peso", short: "" },
  service: { title: "Servicios / Licencias", short: "srv" },
};

const tidy = (v: string) => v.replace(/\s+/g, " ").trim();

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
    /** Cómo vino la compra (ver `EXPENSE_PRESENTATIONS`). */
    presentation: z.enum(EXPENSE_PRESENTATIONS).nullish().transform((v) => v ?? null),
    /** Unidad de volumen o peso; solo aplica en «measure». */
    measureUnit: z.enum(EXPENSE_MEASURE_UNITS).nullish().transform((v) => v ?? null),
    /** Unidades que trae cada paquete o caja (solo en «package»). */
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
  // Con cantidad, «Paquete / Caja» exige las unidades por paquete y «Volumen / Peso» su unidad.
  .superRefine((v, ctx) => {
    if (v.isFixed || v.quantity === null) return;
    const presentation = v.presentation ?? (v.unitsPerPackage ? "package" : "units");
    if (presentation === "package" && v.unitsPerPackage === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unitsPerPackage"],
        message: "Escribe cuántas unidades trae cada paquete",
      });
    }
    if (presentation === "measure" && v.measureUnit === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["measureUnit"],
        message: "Elige la unidad de medida",
      });
    }
  })
  // Un gasto fijo es un solo monto: no lleva detalle de compra. Sin cantidad tampoco hay
  // presentación, paquete ni unidad. Cada presentación conserva solo lo suyo.
  .transform((v) => {
    if (v.isFixed || v.quantity === null) {
      return { ...v, quantity: null, presentation: null, unitsPerPackage: null, measureUnit: null };
    }
    const presentation: ExpensePresentation = v.presentation ?? (v.unitsPerPackage ? "package" : "units");
    return {
      ...v,
      presentation,
      unitsPerPackage: presentation === "package" ? v.unitsPerPackage : null,
      measureUnit: presentation === "measure" ? v.measureUnit : null,
    };
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

/**
 * Costo por unidad de medida a partir de lo pagado (centavos, redondeado). Es solo
 * informativo: nunca se guarda ni cambia el total. null si no hay cantidad o precio.
 */
export function expenseUnitCostCents(e: {
  totalPriceCents: number;
  quantity: number | null;
  unitsPerPackage: number | null;
}): number | null {
  const units = expenseTotalUnits(e);
  if (units === null || units <= 0 || e.totalPriceCents <= 0) return null;
  return Math.round(e.totalPriceCents / units);
}

/** Texto de la cantidad comprada para la tabla («3 × 100 = 300 und», «2 kg»…); null si no hay detalle. */
export function expenseQuantityLabel(e: {
  quantity: number | null;
  presentation: ExpensePresentation | null;
  unitsPerPackage: number | null;
  measureUnit: ExpenseMeasureUnit | null;
}): { main: string; sub: string | null } | null {
  if (e.quantity === null) return null;
  switch (e.presentation) {
    case "package":
      return e.unitsPerPackage
        ? {
            main: `${e.quantity} paq × ${e.unitsPerPackage}`,
            sub: `= ${e.quantity * e.unitsPerPackage} und`,
          }
        : { main: `${e.quantity} paq`, sub: null };
    case "measure":
      return { main: `${e.quantity} ${e.measureUnit ?? ""}`.trim(), sub: null };
    case "service":
      return { main: `${e.quantity} srv`, sub: null };
    default:
      return { main: `${e.quantity} und`, sub: null };
  }
}

/* ------------------------------ respuestas ------------------------------ */

export type ExpenseItemDto = {
  id: string;
  isFixed: boolean;
  name: string;
  /** Paquetes/bultos (o unidades sueltas) comprados; solo insumos, opcional. */
  quantity: number | null;
  presentation: ExpensePresentation | null;
  /** Unidades por paquete; solo en «package». */
  unitsPerPackage: number | null;
  /** Unidad de volumen o peso; solo en «measure». */
  measureUnit: ExpenseMeasureUnit | null;
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
  // Todo en centavos enteros: no hay punto flotante en ninguna resta.
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
