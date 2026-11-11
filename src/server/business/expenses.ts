import { and, desc, eq, gte, lt, notExists, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  buildExpenseSummary,
  expenseItemInputSchema,
  EXPENSE_MEASURE_UNITS,
  type ExpenseItemDto,
  type ExpenseMeasureUnit,
  type ExpensePresentation,
  type ExpenseItemInput,
  type ExpensesReportDto,
} from "@/lib/salon/expenses";
import { dayIsoInTz, zonedWallClockToUtc } from "@/lib/time/slots";
import { businessTimezone, type ResolvedPeriod } from "@/server/analytics/period";
import { SalonError } from "@/server/business/http";
import { getSalesReport } from "@/server/business/sales-service";

/**
 * Módulo SALON — egresos y gastos operativos (solo dueño/administrador).
 *
 * Toda consulta pasa por `scoped()`: una organización nunca ve ni toca los gastos
 * de otra. Un gasto es fijo (alquiler, luz) o variable (insumos).
 *
 * El día de un gasto se guarda al mediodía del negocio (igual que el de una
 * venta): visto desde otra zona sigue siendo el mismo día.
 */

const item = schema.expenseItem;
const hidden = schema.expenseNameHidden;

/** Llave de comparación de un nombre: sin espacios sobrantes ni mayúsculas. */
function nameKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Cuántos gastos se pintan en la tabla; los totales cuentan todos. */
const REPORT_ROW_LIMIT = 500;

/* -------------------------------- gastos --------------------------------- */

async function expenseInstant(organizationId: string, day: string): Promise<Date> {
  const tz = await businessTimezone(organizationId);
  const at = zonedWallClockToUtc(day, "12:00", tz);
  if (!at) throw new SalonError("invalid_date", 422, "Fecha no válida");
  return at;
}

function toPresentation(v: string | null): ExpensePresentation | null {
  return v === "units" || v === "package" || v === "measure" || v === "service" ? v : null;
}

function toMeasureUnit(v: string | null): ExpenseMeasureUnit | null {
  return (EXPENSE_MEASURE_UNITS as readonly string[]).includes(v ?? "") ? (v as ExpenseMeasureUnit) : null;
}

/** El detalle de la compra (paquetes, unidades por paquete, unidad); un gasto fijo no lo lleva. */
function purchaseDetail(input: ExpenseItemInput) {
  // Normaliza con el mismo esquema de la API: cada presentación conserva solo lo suyo
  // (paquete → unidades por paquete, volumen/peso → su unidad) y un gasto fijo no lleva
  // detalle. Es idempotente sobre un cuerpo ya validado.
  const { quantity, presentation, unitsPerPackage, measureUnit } = expenseItemInputSchema.parse(input);
  return { quantity, presentation, unitsPerPackage, measureUnit };
}

/**
 * Registrar un gasto. Es un egreso financiero y nada más: el insumo / variable también,
 * por su precio total (la cantidad es solo de referencia). No hay almacén ni stock.
 */
export async function createExpense(
  organizationId: string,
  input: ExpenseItemInput
): Promise<{ id: string }> {
  const isFixed = input.isFixed ?? false;
  const id = newId("expenseItem");
  const expenseDate = await expenseInstant(organizationId, input.expenseDate);
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.insert(item).values({
      id,
      organizationId,
      isFixed,
      name: input.name,
      ...purchaseDetail(input),
      totalPriceCents: input.totalPriceCents,
      notes: input.notes ?? null,
      expenseDate,
    });
    await unhideName(tx, organizationId, isFixed, input.name);
  });
  return { id };
}

export async function updateExpense(
  organizationId: string,
  id: string,
  input: ExpenseItemInput
): Promise<void> {
  const isFixed = input.isFixed ?? false;
  const expenseDate = await expenseInstant(organizationId, input.expenseDate);
  await getDb().transaction(async (tx) => {
    const rows = await tx
      .update(item)
      .set({
        isFixed,
        name: input.name,
        ...purchaseDetail(input),
        totalPriceCents: input.totalPriceCents,
        notes: input.notes ?? null,
        expenseDate,
      })
      .where(scoped(item.organizationId, organizationId, eq(item.id, id)))
      .returning({ id: item.id });
    if (rows.length === 0) throw new SalonError("not_found", 404, "El gasto no existe");
    await unhideName(tx, organizationId, isFixed, input.name);
  });
}

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Usar un nombre otra vez lo devuelve a las sugerencias (si se había ocultado). */
async function unhideName(tx: Tx, organizationId: string, isFixed: boolean, name: string): Promise<void> {
  await tx
    .delete(hidden)
    .where(
      scoped(
        hidden.organizationId,
        organizationId,
        eq(hidden.isFixed, isFixed),
        eq(hidden.nameKey, nameKey(name))
      )
    );
}

export async function deleteExpense(organizationId: string, id: string): Promise<void> {
  const rows = await getDb()
    .delete(item)
    .where(scoped(item.organizationId, organizationId, eq(item.id, id)))
    .returning({ id: item.id });
  if (rows.length === 0) throw new SalonError("not_found", 404, "El gasto no existe");
}

function kindTotal(rows: { isFixed: boolean; count: number; totalCents: number }[], fixed: boolean) {
  const r = rows.find((x) => x.isFixed === fixed);
  return { count: r?.count ?? 0, totalCents: r?.totalCents ?? 0 };
}

/* -------------------------------- reporte -------------------------------- */

/**
 * Los gastos de un periodo y el comparativo contra lo que entró:
 * ganancia neta real = ingresos − comisiones − gastos. Los ingresos y las
 * comisiones salen del MISMO reporte de Caja (sin filas), así los números de las
 * dos pantallas siempre coinciden. Los filtros (`kind`) acotan
 * la tabla; el resumen es siempre el de todo el periodo.
 */
export async function getExpensesReport(
  organizationId: string,
  period: ResolvedPeriod,
  filters: { kind?: "fixed" | "variable" | null } = {}
): Promise<ExpensesReportDto> {
  const db = getDb();
  const inRange = scoped(
    item.organizationId,
    organizationId,
    gte(item.expenseDate, period.start),
    lt(item.expenseDate, period.end)
  );
  const tz = period.timezone;

  const [sales, rows, totals, byKindRows] = await Promise.all([
    getSalesReport(organizationId, period, null, false),
    db
      .select({
        id: item.id,
        isFixed: item.isFixed,
        name: item.name,
        quantity: item.quantity,
        presentation: item.presentation,
        unitsPerPackage: item.unitsPerPackage,
        measureUnit: item.measureUnit,
        totalPriceCents: item.totalPriceCents,
        notes: item.notes,
        expenseDate: item.expenseDate,
      })
      .from(item)
      .where(
        and(
          inRange,
          filters.kind ? eq(item.isFixed, filters.kind === "fixed") : undefined
        )
      )
      .orderBy(desc(item.expenseDate), desc(item.createdAt))
      .limit(REPORT_ROW_LIMIT + 1),
    db
      .select({ total: sql<number>`coalesce(sum(${item.totalPriceCents}), 0)::int` })
      .from(item)
      .where(inRange),
    db
      .select({
        isFixed: item.isFixed,
        count: sql<number>`count(*)::int`,
        totalCents: sql<number>`coalesce(sum(${item.totalPriceCents}), 0)::int`,
      })
      .from(item)
      .where(inRange)
      .groupBy(item.isFixed),
  ]);

  const truncated = rows.length > REPORT_ROW_LIMIT;
  return {
    period: {
      from: period.dto.from,
      to: period.dto.to,
      timezone: tz,
      days: period.dto.days,
    },
    summary: buildExpenseSummary({
      revenueCents: sales.totals.revenueCents,
      commissionsCents: sales.totals.commissionsCents,
      expensesCents: totals[0]?.total ?? 0,
      byKind: {
        fixed: kindTotal(byKindRows, true),
        variable: kindTotal(byKindRows, false),
      },
    }),
    items: rows.slice(0, REPORT_ROW_LIMIT).map(
      (r): ExpenseItemDto => ({
        id: r.id,
        isFixed: r.isFixed,
        name: r.name,
        quantity: r.quantity,
        presentation: toPresentation(r.presentation),
        unitsPerPackage: r.unitsPerPackage,
        measureUnit: toMeasureUnit(r.measureUnit),
        totalPriceCents: r.totalPriceCents,
        notes: r.notes,
        expenseDate: dayIsoInTz(r.expenseDate, tz),
      })
    ),
    truncated,
  };
}

/**
 * Nombres que el negocio ya usó en sus gastos del mismo tipo (fijo o variable), para
 * autocompletar y no duplicarlos con otra ortografía. Uno por nombre (sin distinguir
 * mayúsculas), del más reciente al más antiguo.
 */
export async function listExpenseNames(
  organizationId: string,
  kind: "fixed" | "variable"
): Promise<{ name: string; unitsPerPackage: number | null }[]> {
  const rows = await getDb()
    .select({
      name: sql<string>`(array_agg(${item.name} order by ${item.createdAt} desc))[1]`,
      // Las unidades por paquete de la última compra en «Paquete / Caja», para autocompletar.
      unitsPerPackage: sql<
        number | null
      >`(array_agg(${item.unitsPerPackage} order by ${item.createdAt} desc) filter (where ${item.presentation} = 'package' and ${item.unitsPerPackage} is not null))[1]`,
    })
    .from(item)
    .where(
      scoped(
        item.organizationId,
        organizationId,
        eq(item.isFixed, kind === "fixed"),
        // Sin los nombres que el negocio ocultó de las sugerencias.
        notExists(
          getDb()
            .select({ one: sql`1` })
            .from(hidden)
            .where(
              and(
                eq(hidden.organizationId, item.organizationId),
                eq(hidden.isFixed, item.isFixed),
                sql`${hidden.nameKey} = lower(${item.name})`
              )
            )
        )
      )
    )
    .groupBy(sql`lower(${item.name})`)
    .orderBy(desc(sql`max(${item.createdAt})`))
    .limit(200);
  return rows;
}

/**
 * Oculta un nombre de las sugerencias del tipo dado. No toca ningún gasto: la tabla, los
 * totales y los reportes quedan igual. Idempotente.
 */
export async function hideExpenseName(
  organizationId: string,
  kind: "fixed" | "variable",
  name: string
): Promise<void> {
  const key = nameKey(name);
  if (key.length === 0) throw new SalonError("invalid_name", 422, "Escribe el nombre a ocultar");
  await getDb()
    .insert(hidden)
    .values({ organizationId, isFixed: kind === "fixed", nameKey: key })
    .onConflictDoNothing();
}
