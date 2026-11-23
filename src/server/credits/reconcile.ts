import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { creditsEnabled } from "./flag";
import { lockAccount, saveAccount } from "./internal";

/**
 * Monedas — la conciliación: el saldo de `credit_account` es una CACHÉ del libro y tiene que ser igual a su suma.
 * Si alguna vez no lo es (una escritura manual, un fallo a medias que la transacción no debió permitir), esto lo
 * encuentra, y con `repair` reescribe la caché desde el libro, que es la verdad.
 *
 * Las cuentas `unlimited` no descuentan, así que su libro tampoco tiene gastos y cuadran igual.
 */

export type Drift = {
  organizationId: string;
  planCached: number;
  planLedger: number;
  topupCached: number;
  topupLedger: number;
};

export type ReconcileResult = { checked: number; drifts: Drift[]; repaired: number };

export async function reconcileCredits(
  opts: { organizationId?: string; repair?: boolean } = {}
): Promise<ReconcileResult> {
  if (!creditsEnabled()) return { checked: 0, drifts: [], repaired: 0 };
  const db = getDb();
  const org = opts.organizationId ?? null;

  const rows = await db.execute<{
    organization_id: string;
    plan_balance: number;
    topup_balance: number;
    plan_ledger: number;
    topup_ledger: number;
  }>(sql`
    select a.organization_id, a.plan_balance, a.topup_balance,
           coalesce(sum(l.amount) filter (where l.bucket = 'plan'), 0)::int as plan_ledger,
           coalesce(sum(l.amount) filter (where l.bucket = 'topup'), 0)::int as topup_ledger
    from credit_account a
    left join credit_ledger l on l.organization_id = a.organization_id
    where (${org}::text is null or a.organization_id = ${org})
    group by a.organization_id, a.plan_balance, a.topup_balance
  `);

  const drifts: Drift[] = rows
    .filter((r) => r.plan_balance !== r.plan_ledger || r.topup_balance !== r.topup_ledger)
    .map((r) => ({
      organizationId: r.organization_id,
      planCached: r.plan_balance,
      planLedger: r.plan_ledger,
      topupCached: r.topup_balance,
      topupLedger: r.topup_ledger,
    }));

  let repaired = 0;
  if (opts.repair) {
    for (const d of drifts) {
      await db.transaction(async (tx) => {
        await lockAccount(tx, d.organizationId);
        // El libro manda: la caché se reescribe desde él (la cuota del plan nunca queda en negativo).
        await saveAccount(tx, d.organizationId, { planBalance: Math.max(d.planLedger, 0), topupBalance: d.topupLedger });
      });
      repaired++;
    }
  }
  return { checked: rows.length, drifts, repaired };
}
