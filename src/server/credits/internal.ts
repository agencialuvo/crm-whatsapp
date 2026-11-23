import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import type { Bucket, LedgerKind, LedgerService } from "@/lib/credits";

/**
 * Lo que comparten las operaciones de la puerta única. NO se exporta fuera de `server/credits/`.
 *
 * Toda operación que mueve saldo sigue el mismo guion, dentro de UNA transacción: bloquear la fila de la cuenta
 * (`FOR UPDATE`), insertar la fila del libro con `ON CONFLICT (organization_id, idempotency_key) DO NOTHING` (si no
 * entró, la operación ya existía: no se hace nada más) y actualizar la caché de saldos. El candado de la cuenta
 * serializa las operaciones de UNA organización; las de otras ni se enteran.
 */

export type Db = ReturnType<typeof getDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Account = typeof schema.creditAccount.$inferSelect;

export type Balance = { plan: number; topup: number; total: number };

export const balanceOf = (a: Pick<Account, "planBalance" | "topupBalance">): Balance => ({
  plan: a.planBalance,
  topup: a.topupBalance,
  total: a.planBalance + a.topupBalance,
});

/** Crea la cuenta si no existe y la devuelve BLOQUEADA hasta el fin de la transacción. */
export async function lockAccount(tx: Tx, organizationId: string): Promise<Account> {
  await tx
    .insert(schema.creditAccount)
    .values({ id: newId("creditAccount"), organizationId })
    .onConflictDoNothing({ target: schema.creditAccount.organizationId });
  const [row] = await tx
    .select()
    .from(schema.creditAccount)
    .where(scoped(schema.creditAccount.organizationId, organizationId))
    .limit(1)
    .for("update");
  if (!row) throw new Error(`credit_account de ${organizationId} no existe tras crearla`);
  return row;
}

export type LedgerRow = {
  organizationId: string;
  kind: LedgerKind;
  bucket: Bucket;
  service?: LedgerService | null;
  /** Con signo, en unidades. */
  amount: number;
  key: string;
  refType?: string | null;
  refId?: string | null;
  periodStart?: Date | null;
  actorUserId?: string | null;
  note?: string | null;
  meta?: Record<string, unknown> | null;
};

/** Inserta una fila del libro. `false` = esa clave ya existía (la operación se había hecho): no se inserta nada. */
export async function insertLedgerRow(tx: Tx, r: LedgerRow): Promise<boolean> {
  const inserted = await tx
    .insert(schema.creditLedger)
    .values({
      id: newId("creditLedger"),
      organizationId: r.organizationId,
      kind: r.kind,
      bucket: r.bucket,
      service: r.service ?? null,
      amount: r.amount,
      idempotencyKey: r.key,
      refType: r.refType ?? null,
      refId: r.refId ?? null,
      periodStart: r.periodStart ?? null,
      actorUserId: r.actorUserId || null,
      note: r.note ?? null,
      meta: r.meta ?? null,
    })
    .onConflictDoNothing({ target: [schema.creditLedger.organizationId, schema.creditLedger.idempotencyKey] })
    .returning({ id: schema.creditLedger.id });
  return inserted.length > 0;
}

export type AccountPatch = Partial<
  Pick<Account, "planBalance" | "topupBalance" | "unlimited" | "planPeriodStart" | "planPeriodEnd" | "cutEnabled" | "overdraftLimit">
>;

/** Actualiza la caché de saldos de la cuenta (ya bloqueada por esta transacción). */
export async function saveAccount(tx: Tx, organizationId: string, patch: AccountPatch): Promise<void> {
  await tx
    .update(schema.creditAccount)
    .set({ ...patch, updatedAt: new Date() })
    .where(scoped(schema.creditAccount.organizationId, organizationId));
}

/** Las operaciones piden enteros: un decimal o un NaN aquí es un error de programación, no un dato a corregir. */
export function assertInt(value: number, what: string): void {
  if (!Number.isInteger(value)) throw new Error(`${what} debe ser un entero (recibido ${value})`);
}
