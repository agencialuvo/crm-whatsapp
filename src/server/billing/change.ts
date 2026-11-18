import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { centsToMpAmount } from "@/lib/billing";
import { decideTransition, type SubAction } from "@/lib/saas";
import { mp, MpApiError } from "@/lib/mercadopago/client";
import { invalidateSubscriptionAccess } from "@/server/saas/enforcement";
import { applyClientBillingChange, planFacts, type ClientChangeResult } from "@/server/saas/subscription";

/**
 * 046 — Los cambios que tocan a la vez la pasarela y la suscripción. Orden: PRIMERO Mercado Pago, LUEGO la puerta.
 * Si la pasarela falla, no cambia nada localmente (502). Si la pasarela acepta y la escritura local falla, el
 * temporizador de reconciliación y el webhook convergen (la pasarela ya tiene el monto/estado nuevo).
 */

export type ChangeFail = { ok: false; status: 404 | 409 | 422 | 502; code: string; message: string };

const providerDown: ChangeFail = { ok: false, status: 502, code: "provider_unavailable", message: "Mercado Pago no responde. No se hizo ningún cambio; intenta de nuevo." };

async function managedSub(organizationId: string) {
  const [row] = await getDb()
    .select({ sub: schema.subscription, plan: schema.plan })
    .from(schema.subscription)
    .innerJoin(schema.plan, eq(schema.subscription.planId, schema.plan.id))
    .where(eq(schema.subscription.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

/** El dueño cambia de plan (subir rige ya; bajar al corte), sin prorrateo. */
export async function changePlanByOwner(input: { organizationId: string; userId: string; planId: string }): Promise<ClientChangeResult | ChangeFail> {
  const row = await managedSub(input.organizationId);
  if (!row || row.sub.billingProvider !== "mercadopago" || !row.sub.mpPreapprovalId || row.sub.mpStatus !== "authorized") {
    return { ok: false, status: 409, code: "not_managed", message: "No tienes una suscripción activa con Mercado Pago" };
  }
  const [target] = await getDb().select().from(schema.plan).where(eq(schema.plan.id, input.planId)).limit(1);
  if (!target || !target.active) return { ok: false, status: 422, code: "plan_not_found", message: "Ese plan no existe o está retirado" };
  if (target.trialDays !== null || target.priceMonthlyCents <= 0) return { ok: false, status: 422, code: "plan_not_billable", message: "Ese plan no se puede contratar" };
  try {
    await mp.updatePreapproval(row.sub.mpPreapprovalId, {
      reason: `Vocero · Plan ${target.name}`,
      auto_recurring: { transaction_amount: centsToMpAmount(target.priceMonthlyCents), currency_id: target.currency },
    });
  } catch (err) {
    if (err instanceof MpApiError && err.kind === "invalid") return { ok: false, status: 422, code: "provider_rejected", message: err.message };
    return providerDown;
  }
  const r = await applyClientBillingChange({ organizationId: input.organizationId, kind: "change_plan", planId: input.planId, actorUserId: input.userId });
  invalidateSubscriptionAccess(input.organizationId);
  return r;
}

/** El dueño cancela: no se cobra más y conserva el acceso hasta el fin del periodo pagado. */
export async function cancelByOwner(input: { organizationId: string; userId: string; reason?: string }): Promise<ClientChangeResult | ChangeFail> {
  const row = await managedSub(input.organizationId);
  if (!row || row.sub.status !== "active") return { ok: false, status: 409, code: "invalid_transition", message: "Solo una suscripción activa se puede cancelar" };
  if (row.sub.cancelAtPeriodEnd) return { ok: false, status: 409, code: "already_cancelling", message: "La suscripción ya se cancela al corte" };
  if (row.sub.billingProvider === "mercadopago" && row.sub.mpPreapprovalId && row.sub.mpStatus === "authorized") {
    try {
      await mp.updatePreapproval(row.sub.mpPreapprovalId, { status: "cancelled" });
    } catch {
      return providerDown;
    }
  }
  const r = await applyClientBillingChange({ organizationId: input.organizationId, kind: "cancel", actorUserId: input.userId, reason: input.reason });
  invalidateSubscriptionAccess(input.organizationId);
  return r;
}

export type AdminPropagation = { ok: true; providerStatus?: string } | ChangeFail;

/**
 * El Super Admin actúa sobre una suscripción cobrada por la pasarela (matriz F4 de la spec 046). Se valida con la
 * misma regla pura que la puerta ANTES de llamar a Mercado Pago, así una transición inválida nunca lo toca.
 */
export async function propagateAdminAction(input: { organizationId: string; action: SubAction; planId?: string; now?: Date }): Promise<AdminPropagation> {
  const row = await managedSub(input.organizationId);
  if (!row || row.sub.billingProvider !== "mercadopago") return { ok: true };
  const managed = row.sub.mpStatus === "authorized" || row.sub.mpStatus === "paused";
  if (!managed) return { ok: true }; // su suscripción en la pasarela ya terminó: funciona como una manual
  if (input.action === "activate" || input.action === "assign") {
    return { ok: false, status: 409, code: "managed_by_provider", message: "Esta suscripción la cobra Mercado Pago: no se activa a mano." };
  }
  if (input.action === "reactivate" && row.sub.mpStatus === "cancelled") {
    return { ok: false, status: 409, code: "needs_new_checkout", message: "La suscripción de Mercado Pago está cancelada: el cliente debe contratar de nuevo." };
  }
  const target = input.planId ? (await getDb().select().from(schema.plan).where(eq(schema.plan.id, input.planId)).limit(1))[0] : undefined;
  const d = decideTransition({
    action: input.action,
    from: {
      status: row.sub.status,
      currentPeriodEnd: row.sub.currentPeriodEnd,
      cancelAtPeriodEnd: row.sub.cancelAtPeriodEnd,
      statusReason: row.sub.statusReason,
      convertedAt: row.sub.convertedAt,
    },
    current: planFacts(row.plan),
    input: { plan: target ? planFacts(target) : null },
    now: input.now ?? new Date(),
  });
  if (!d.ok) return { ok: false, status: d.code === "invalid_transition" ? 409 : 422, code: d.code, message: d.message };

  const id = row.sub.mpPreapprovalId!;
  try {
    if (input.action === "suspend") {
      await mp.updatePreapproval(id, { status: "paused" });
      return { ok: true, providerStatus: "paused" };
    }
    if (input.action === "cancel") {
      await mp.updatePreapproval(id, { status: "cancelled" });
      return { ok: true, providerStatus: "cancelled" };
    }
    if (input.action === "reactivate") {
      await mp.updatePreapproval(id, { status: "authorized" });
      return { ok: true, providerStatus: "authorized" };
    }
    if (input.action === "change_plan" && target && target.trialDays === null && target.priceMonthlyCents > 0) {
      await mp.updatePreapproval(id, {
        reason: `Vocero · Plan ${target.name}`,
        auto_recurring: { transaction_amount: centsToMpAmount(target.priceMonthlyCents), currency_id: target.currency },
      });
    }
  } catch {
    return providerDown;
  }
  return { ok: true };
}
