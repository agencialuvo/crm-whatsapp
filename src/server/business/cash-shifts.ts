import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  DEFAULT_HISTORY_ROWS,
  MAX_HISTORY_ROWS,
  closeShiftInputSchema,
  computeShiftTotals,
  type CashShiftDetailDto,
  type CashShiftRowDto,
  openShiftInputSchema,
  type CashShiftDto,
  type CloseShiftInput,
  type OpenShiftInput,
} from "@/lib/salon/cash-shifts";
import { isPgError, SalonError, UNIQUE_VIOLATION } from "@/server/business/http";

/**
 * Módulo SALON — cuadre de caja y turnos.
 *
 * Un turno se abre con el efectivo inicial y se cierra con el efectivo contado. Al
 * cerrar, el sistema suma las ventas, comisiones y gastos del periodo y calcula la
 * ganancia neta y el efectivo que debería haber. Solo puede haber UN turno abierto
 * por organización: lo garantiza el índice único parcial `cash_register_shift_org_open_uq`.
 *
 * Estas funciones NO son Server Actions a propósito: reciben `organizationId` y
 * `userId` y confían en ellos, así que solo las llaman rutas que ya los sacaron de la
 * sesión (y comprobaron el rol con `salonGate`). Exponerlas al cliente permitiría
 * operar la caja de otra organización.
 */

const shift = schema.cashRegisterShift;

type ShiftRow = typeof shift.$inferSelect;

export function serializeShift(row: ShiftRow): CashShiftDto {
  const closed = row.status === "closed";
  return {
    id: row.id,
    status: row.status,
    openedByUserId: row.openedByUserId,
    closedByUserId: row.closedByUserId,
    initialCashCents: row.initialCashCents,
    finalCashCents: row.finalCashCents,
    expectedCashCents: row.expectedCashCents,
    differenceCents:
      closed && row.finalCashCents !== null && row.expectedCashCents !== null
        ? row.finalCashCents - row.expectedCashCents
        : null,
    totalSalesCents: row.totalSalesCents,
    totalCommissionsCents: row.totalCommissionsCents,
    totalExpensesCents: row.totalExpensesCents,
    netProfitCents: row.netProfitCents,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    notes: row.notes,
  };
}

/** Quien opera la caja tiene que ser de esta organización. */
async function assertMember(organizationId: string, userId: string): Promise<void> {
  const [row] = await getDb()
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(scoped(schema.member.organizationId, organizationId, eq(schema.member.userId, userId)))
    .limit(1);
  if (!row) throw new SalonError("forbidden", 404, "Usuario no encontrado en esta organización");
}

/** La conexión o la transacción en curso. */
type Db = Pick<ReturnType<typeof getDb>, "select">;

/**
 * Lo que ocurrió entre `from` y `until` (ventas y comisiones por fecha de cobro,
 * gastos por fecha de REGISTRO: `expense_date` se guarda al mediodía del día
 * elegido, así que un gasto anotado en la tarde caería antes de abrir el turno).
 */
async function totalsBetween(
  db: Db,
  organizationId: string,
  initialCashCents: number,
  from: Date,
  until: Date
) {
  const sale = schema.serviceSale;
  const expense = schema.expenseItem;

  const [sales] = await db
    .select({
      total: sql<number>`coalesce(sum(${sale.amountCents}), 0)`.mapWith(Number),
      commissions: sql<number>`coalesce(sum(${sale.staffCommissionCents}), 0)`.mapWith(Number),
      cash: sql<number>`coalesce(sum(${sale.amountCents}) filter (where ${sale.paymentMethod} = 'efectivo'), 0)`.mapWith(Number),
    })
    .from(sale)
    .where(scoped(sale.organizationId, organizationId, gte(sale.createdAt, from), lte(sale.createdAt, until)));

  const [expenses] = await db
    .select({ total: sql<number>`coalesce(sum(${expense.totalPriceCents}), 0)`.mapWith(Number) })
    .from(expense)
    .where(scoped(expense.organizationId, organizationId, gte(expense.createdAt, from), lte(expense.createdAt, until)));

  return computeShiftTotals({
    initialCashCents,
    salesCents: sales?.total ?? 0,
    commissionsCents: sales?.commissions ?? 0,
    expensesCents: expenses?.total ?? 0,
    cashSalesCents: sales?.cash ?? 0,
  });
}

/**
 * El turno abierto de la organización, o `null`. Los totales y el efectivo esperado
 * son los de AHORA (se recalculan en cada consulta): el panel del turno los muestra
 * en vivo y el cierre solo los congela.
 */
export async function getOpenShift(organizationId: string): Promise<CashShiftDto | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(shift)
    .where(scoped(shift.organizationId, organizationId, eq(shift.status, "open")))
    .limit(1);
  if (!row) return null;
  const live = await totalsBetween(db, organizationId, row.initialCashCents, row.openedAt, new Date());
  return serializeShift({ ...row, ...live });
}

/** Nombres de quien abrió y cerró (las dos uniones salen de la misma tabla `user`). */
const openerT = alias(schema.user, "shift_opener");
const closerT = alias(schema.user, "shift_closer");

function toRow(
  row: ShiftRow,
  names: { opener: string | null; closer: string | null }
): CashShiftRowDto {
  return { ...serializeShift(row), openedByName: names.opener, closedByName: names.closer };
}

/**
 * Historial: los turnos CERRADOS de la organización, del más reciente al más antiguo.
 * `period` acota por la fecha de cierre (días del negocio, `end` exclusivo). Pagina con
 * `limit` y `offset`; `total` cuenta todas las páginas.
 */
export async function listShifts(
  organizationId: string,
  opts: { period?: { start: Date; end: Date }; limit?: number; offset?: number } = {}
): Promise<{ shifts: CashShiftRowDto[]; total: number }> {
  const db = getDb();
  const where = scoped(
    shift.organizationId,
    organizationId,
    eq(shift.status, "closed"),
    opts.period ? gte(shift.closedAt, opts.period.start) : undefined,
    opts.period ? lt(shift.closedAt, opts.period.end) : undefined
  );
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_HISTORY_ROWS, 1), MAX_HISTORY_ROWS);
  const offset = Math.max(opts.offset ?? 0, 0);

  const [rows, [count]] = await Promise.all([
    db
      .select({ shift, opener: openerT.name, closer: closerT.name })
      .from(shift)
      .leftJoin(openerT, eq(shift.openedByUserId, openerT.id))
      .leftJoin(closerT, eq(shift.closedByUserId, closerT.id))
      .where(where)
      .orderBy(desc(shift.closedAt), desc(shift.openedAt))
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(shift).where(where),
  ]);
  return {
    shifts: rows.map((r) => toRow(r.shift, { opener: r.opener, closer: r.closer })),
    total: count?.n ?? 0,
  };
}

/**
 * El desglose de un turno (abierto o cerrado): cómo se cobró lo vendido en su periodo,
 * cuántas ventas y gastos hubo, y si las ventas de hoy ya no coinciden con lo que se
 * congeló al cerrar.
 */
export async function getShiftDetail(organizationId: string, shiftId: string): Promise<CashShiftDetailDto> {
  const db = getDb();
  const [found] = await db
    .select({ shift, opener: openerT.name, closer: closerT.name })
    .from(shift)
    .leftJoin(openerT, eq(shift.openedByUserId, openerT.id))
    .leftJoin(closerT, eq(shift.closedByUserId, closerT.id))
    .where(scoped(shift.organizationId, organizationId, eq(shift.id, shiftId)))
    .limit(1);
  if (!found) throw new SalonError("not_found", 404, "Turno no encontrado");

  const until = found.shift.closedAt ?? new Date();
  const sale = schema.serviceSale;
  const expense = schema.expenseItem;
  const [byPayment, [expenses]] = await Promise.all([
    db
      .select({
        method: sale.paymentMethod,
        count: sql<number>`count(*)`.mapWith(Number),
        amountCents: sql<number>`coalesce(sum(${sale.amountCents}), 0)`.mapWith(Number),
      })
      .from(sale)
      .where(scoped(sale.organizationId, organizationId, gte(sale.createdAt, found.shift.openedAt), lte(sale.createdAt, until)))
      .groupBy(sale.paymentMethod)
      .orderBy(desc(sql`sum(${sale.amountCents})`)),
    db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(expense)
      .where(scoped(expense.organizationId, organizationId, gte(expense.createdAt, found.shift.openedAt), lte(expense.createdAt, until))),
  ]);

  // Un turno abierto enseña lo de ahora, como el panel.
  const live =
    found.shift.status === "open"
      ? await totalsBetween(db, organizationId, found.shift.initialCashCents, found.shift.openedAt, until)
      : null;
  const row = toRow(live ? { ...found.shift, ...live } : found.shift, { opener: found.opener, closer: found.closer });

  return {
    ...row,
    byPayment,
    salesCount: byPayment.reduce((n, p) => n + p.count, 0),
    expensesCount: expenses?.n ?? 0,
    currentSalesCents: byPayment.reduce((n, p) => n + p.amountCents, 0),
  };
}

/**
 * Abre el turno. Si ya hay uno abierto, el índice único lo rechaza y aquí se
 * traduce a un mensaje claro (sin pre-consulta: dos cajas abriendo a la vez no se
 * cuelan por una carrera entre «preguntar» y «insertar»).
 */
export async function openShift(
  input: { organizationId: string; userId: string } & OpenShiftInput
): Promise<CashShiftDto> {
  const parsed = openShiftInputSchema.safeParse({ initialCashCents: input.initialCashCents });
  if (!parsed.success) {
    throw new SalonError("invalid_amount", 422, parsed.error.issues[0]?.message ?? "Monto no válido");
  }
  await assertMember(input.organizationId, input.userId);

  try {
    const [row] = await getDb()
      .insert(shift)
      .values({
        id: newId("cashRegisterShift"),
        organizationId: input.organizationId,
        openedByUserId: input.userId,
        status: "open",
        initialCashCents: parsed.data.initialCashCents,
      })
      .returning();
    // Recién abierto no hay movimiento: lo esperado en caja es el efectivo inicial.
    return serializeShift({ ...row!, expectedCashCents: row!.initialCashCents });
  } catch (err) {
    if (isPgError(err, UNIQUE_VIOLATION)) {
      throw new SalonError("shift_already_open", 409, "Ya existe un turno de caja abierto");
    }
    throw err;
  }
}

/**
 * Cierra el turno en UNA transacción: bloquea la fila, suma lo ocurrido entre la
 * apertura y ahora, y la actualiza solo si seguía abierta (dos cierres a la vez: gana
 * uno, el otro recibe «ya está cerrado»).
 *
 * - Ventas y comisiones: `service_sale` por su fecha de cobro.
 * - Gastos: `expense_item` por su fecha de REGISTRO (`created_at`), no por `expense_date`:
 *   esa se guarda al mediodía del día elegido, así que un gasto anotado en la tarde
 *   caería antes de la apertura y no entraría al turno.
 * - Efectivo esperado: inicial + ventas cobradas en efectivo.
 */
export async function closeShift(
  input: { organizationId: string; userId: string; shiftId: string } & CloseShiftInput
): Promise<CashShiftDto> {
  const parsed = closeShiftInputSchema.safeParse({ finalCashCents: input.finalCashCents, notes: input.notes });
  if (!parsed.success) {
    throw new SalonError("invalid_amount", 422, parsed.error.issues[0]?.message ?? "Monto no válido");
  }
  await assertMember(input.organizationId, input.userId);

  return getDb().transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(shift)
      .where(scoped(shift.organizationId, input.organizationId, eq(shift.id, input.shiftId)))
      .for("update")
      .limit(1);
    if (!current) throw new SalonError("not_found", 404, "Turno no encontrado");
    if (current.status !== "open") throw new SalonError("shift_closed", 409, "Este turno ya está cerrado");

    const closedAt = new Date();
    const totals = await totalsBetween(tx, input.organizationId, current.initialCashCents, current.openedAt, closedAt);

    const [closed] = await tx
      .update(shift)
      .set({
        status: "closed",
        closedByUserId: input.userId,
        closedAt,
        finalCashCents: parsed.data.finalCashCents,
        notes: parsed.data.notes || current.notes,
        ...totals,
      })
      .where(and(eq(shift.id, current.id), eq(shift.organizationId, input.organizationId), eq(shift.status, "open")))
      .returning();
    if (!closed) throw new SalonError("shift_closed", 409, "Este turno ya está cerrado");
    return serializeShift(closed);
  });
}
