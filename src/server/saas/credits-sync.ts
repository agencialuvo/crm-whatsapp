import { and, eq, gt, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { quotaForPlan } from "@/lib/credits";
import {
  adjustPeriodQuota,
  creditsEnabled,
  ensureDefaultRates,
  expirePeriodQuota,
  getCreditBalance,
  grantPeriodQuota,
} from "@/server/credits";

/**
 * Monedas — la cuota mensual sigue a la suscripción. Esto es SOLO LECTURA de `subscription`/`plan` más las
 * operaciones de la puerta única de monedas: aquí no se escribe ninguna tabla de suscripciones (esa puerta es
 * `saas/subscription.ts`) y, a propósito, ningún camino de la suscripción llama a esto dentro de su transacción:
 * si las monedas fallan, la suscripción no se entera. Lo disparan el barrido horario y la primera consulta de un
 * consumo (`ensureCreditAccount`).
 *
 * - Suscripción `active`/`trialing`: se concede la cuota de su periodo (idempotente por `period:<sub>:<inicio>`);
 *   si el periodo cambió, la puerta vence lo que sobró del anterior ANTES de cargar la nueva.
 * - Cualquier otro estado con el periodo ya cumplido: se vence lo que quede de la cuota (las recargas no vencen).
 */

const LIVE = ["active", "trialing"] as const;
const BATCH = 200;

type Row = {
  orgId: string;
  subId: string;
  status: string;
  start: Date;
  end: Date;
  slug: string;
  features: { monthlyCoins?: number } | null;
  accPeriodStart: Date | null;
};

async function loadRows(where: SQL, limit: number): Promise<Row[]> {
  return getDb()
    .select({
      orgId: schema.subscription.organizationId,
      subId: schema.subscription.id,
      status: schema.subscription.status,
      start: schema.subscription.currentPeriodStart,
      end: schema.subscription.currentPeriodEnd,
      slug: schema.plan.slug,
      features: schema.plan.features,
      accPeriodStart: schema.creditAccount.planPeriodStart,
    })
    .from(schema.subscription)
    .innerJoin(schema.plan, eq(schema.plan.id, schema.subscription.planId))
    .leftJoin(schema.creditAccount, eq(schema.creditAccount.organizationId, schema.subscription.organizationId))
    .where(where)
    .limit(limit);
}

async function applyRow(r: Row, now: Date): Promise<boolean> {
  if ((LIVE as readonly string[]).includes(r.status)) {
    const units = quotaForPlan({ slug: r.slug, features: r.features });
    const res = await grantPeriodQuota({
      organizationId: r.orgId,
      subscriptionId: r.subId,
      periodStart: r.start,
      periodEnd: r.end,
      units,
    });
    if (res.status === "disabled" || res.status === "stale") return false;
    // Mismo periodo ya cargado con otra cuota (cambio de plan a mitad de periodo): se ajusta, solo hacia arriba.
    if (res.status !== "applied") {
      const adj = await adjustPeriodQuota({ organizationId: r.orgId, subscriptionId: r.subId, periodStart: r.start, units });
      if (adj.status === "applied" || adj.status === "unlimited") return true;
    }
    return true;
  }
  // Suspendida, cancelada o vencida: lo que quede de la cuota del periodo cumplido no se arrastra.
  if (r.accPeriodStart && r.end.getTime() <= now.getTime()) {
    const res = await expirePeriodQuota({ organizationId: r.orgId, periodStart: r.accPeriodStart });
    return res.status === "applied";
  }
  return false;
}

/**
 * Pone al día la cuota de UNA organización. Nunca lanza (devuelve `false` si falló o no había nada que hacer): quien
 * llama es el camino de un consumo, que no debe caerse por esto.
 */
export async function syncOrgQuota(organizationId: string, now: Date = new Date()): Promise<boolean> {
  if (!creditsEnabled()) return false;
  try {
    const [row] = await loadRows(eq(schema.subscription.organizationId, organizationId), 1);
    return row ? await applyRow(row, now) : false;
  } catch (err) {
    console.error(`[monedas] no se pudo poner al día la cuota de ${organizationId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Una barrida: siembra las tarifas provisionales y pone al día las organizaciones cuya cuenta no existe o cuyo
 * periodo cargado ya no es el de su suscripción. Por tandas; nunca lanza. Devuelve cuántas tocó.
 */
export async function syncAllQuotas(now: Date = new Date()): Promise<number> {
  if (!creditsEnabled()) return 0;
  let touched = 0;
  try {
    await ensureDefaultRates();
    // «Hay trabajo»: sin cuenta, o con el periodo cargado distinto al de la suscripción. Los vivos se conceden;
    // el resto solo importa mientras les quede cuota del periodo que ya se cumplió.
    // (Los `Date` van por los operadores tipados de drizzle: dentro de una plantilla `sql` cruda no se serializan.)
    const pending = or(
      isNull(schema.creditAccount.organizationId),
      sql`${schema.creditAccount.planPeriodStart} is distinct from ${schema.subscription.currentPeriodStart}`,
      and(
        gt(schema.creditAccount.planBalance, 0),
        lte(schema.subscription.currentPeriodEnd, now),
        notInArray(schema.subscription.status, [...LIVE])
      )
    )!;
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const rows = (await loadRows(pending, BATCH)).filter((r) => !seen.has(r.orgId));
      if (rows.length === 0) break;
      for (const r of rows) {
        seen.add(r.orgId);
        try {
          if (await applyRow(r, now)) touched++;
        } catch (err) {
          console.error(`[monedas] cuota de ${r.orgId}:`, err instanceof Error ? err.message : err);
        }
      }
      if (rows.length < BATCH) break;
    }
  } catch (err) {
    console.error("[monedas] la barrida de cuotas falló:", err instanceof Error ? err.message : err);
  }
  return touched;
}

/* ───────────────────── Cambio de plan a mitad de periodo ───────────────────── */

/**
 * Se llama DESPUÉS de que una transacción de la suscripción confirmó (cambio de plan, cobro, acción del panel). Pone
 * al día la cuota con el plan vigente: si subió, entra la diferencia en el mismo periodo, idempotente. NO espera ni
 * lanza: la suscripción ya quedó escrita y, si las monedas fallan, la barrida o el siguiente consumo lo corrigen. Con
 * `CREDITS` apagada no hace nada.
 */
export function afterSubscriptionCommit(organizationId: string): void {
  if (!creditsEnabled()) return;
  void syncOrgQuota(organizationId).catch(() => {});
}

/* ───────────────────── Primera consulta de un consumo ───────────────────── */

const NEGATIVE_TTL_MS = 5 * 60_000;
const g = globalThis as unknown as { __creditNoAccount?: Map<string, number> };
const noAccount = (): Map<string, number> => (g.__creditNoAccount ??= new Map());

/**
 * Antes de decidir un corte: si la organización aún no tiene cuenta de monedas, se le concede la cuota de su periodo
 * (no hay que esperar a la próxima barrida). Una organización sin suscripción no tiene cuenta y no se medirá: se
 * recuerda 5 min para no consultar en cada turno. Nunca lanza.
 */
export async function ensureCreditAccount(organizationId: string): Promise<void> {
  if (!creditsEnabled()) return;
  try {
    if (await getCreditBalance(organizationId)) return;
    const until = noAccount().get(organizationId);
    if (until && until > Date.now()) return;
    const done = await syncOrgQuota(organizationId);
    if (!done) noAccount().set(organizationId, Date.now() + NEGATIVE_TTL_MS);
  } catch (err) {
    console.error(`[monedas] ensureCreditAccount(${organizationId}):`, err instanceof Error ? err.message : err);
  }
}

