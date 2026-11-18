import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { billingEnabled } from "@/lib/mercadopago/config";
import { invalidateSubscriptionAccess } from "@/server/saas/enforcement";
import { syncPreapproval } from "./core";
import { reprocessPending } from "./webhook";

/**
 * 046 — La red de seguridad del cobro (corre en el temporizador horario, solo con la bandera encendida):
 *  1. reprocesa los avisos que no terminaron;
 *  2. repasa las suscripciones de la pasarela sin noticias hace más de 36 h (por si se perdió un webhook);
 *  3. marca como abandonados los checkouts vencidos sin pagar;
 *  4. poda la bandeja de avisos de más de 60 días.
 */
export async function reconcileBilling(now = new Date()): Promise<{ reprocessed: number; synced: number; abandoned: number }> {
  if (!billingEnabled()) return { reprocessed: 0, synced: 0, abandoned: 0 };
  const db = getDb();
  const reprocessed = await reprocessPending(now).catch(() => 0);

  const stale = new Date(now.getTime() - 36 * 3600 * 1000);
  const subs = await db
    .select({ org: schema.subscription.organizationId, pre: schema.subscription.mpPreapprovalId })
    .from(schema.subscription)
    .where(
      and(
        eq(schema.subscription.billingProvider, "mercadopago"),
        inArray(schema.subscription.status, ["active", "past_due", "paused"]),
        lt(schema.subscription.updatedAt, stale)
      )
    )
    .limit(50);
  let synced = 0;
  for (const s of subs) {
    if (!s.pre) continue;
    try {
      await syncPreapproval(s.pre);
      invalidateSubscriptionAccess(s.org);
      synced++;
    } catch (err) {
      console.error("[billing] no se pudo reconciliar una suscripción:", err instanceof Error ? err.message : err);
    }
  }

  const abandoned = await db
    .update(schema.billingCheckout)
    .set({ status: "abandoned", completedAt: now })
    .where(and(inArray(schema.billingCheckout.status, ["pending", "authorized"]), lt(schema.billingCheckout.expiresAt, now)))
    .returning({ id: schema.billingCheckout.id });

  await db.delete(schema.billingWebhookEvent).where(lt(schema.billingWebhookEvent.receivedAt, new Date(now.getTime() - 60 * 86_400_000)));
  return { reprocessed, synced, abandoned: abandoned.length };
}
