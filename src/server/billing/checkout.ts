import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { CHECKOUT_TTL_MS, centsToMpAmount } from "@/lib/billing";
import { mp, MpApiError } from "@/lib/mercadopago/client";
import { invalidateSubscriptionAccess } from "@/server/saas/enforcement";
import { syncPreapproval } from "./core";

/**
 * 046 — Contratar un plan: crea el intento (`billing_checkout`, su id es el `external_reference` opaco), la
 * suscripción en Mercado Pago y devuelve su `init_point`. Al volver del pago, `getCheckoutStatus` hace una
 * consulta activa: el flujo termina aunque el webhook se retrase o no esté configurado.
 */

export type CheckoutResult =
  | { ok: true; checkoutId: string; url: string }
  | { ok: false; status: 404 | 409 | 422 | 502 | 503; code: string; message: string };

export async function createCheckout(input: { organizationId: string; userId: string; planId: string; now?: Date }): Promise<CheckoutResult> {
  const db = getDb();
  const now = input.now ?? new Date();
  const [plan] = await db.select().from(schema.plan).where(eq(schema.plan.id, input.planId)).limit(1);
  if (!plan || !plan.active) return { ok: false, status: 404, code: "plan_not_found", message: "Ese plan no existe o está retirado" };
  if (plan.trialDays !== null || plan.priceMonthlyCents <= 0) {
    return { ok: false, status: 422, code: "plan_not_billable", message: "Ese plan no se puede contratar" };
  }
  const [sub] = await db.select().from(schema.subscription).where(eq(schema.subscription.organizationId, input.organizationId)).limit(1);
  if (sub?.billingProvider === "mercadopago" && (sub.mpStatus === "authorized" || sub.mpStatus === "paused")) {
    return { ok: false, status: 409, code: "already_subscribed", message: "Ya tienes una suscripción con Mercado Pago: usa «Cambiar de plan»" };
  }
  const [u] = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, input.userId)).limit(1);
  if (!u?.email) return { ok: false, status: 422, code: "no_email", message: "Tu cuenta no tiene correo" };

  // Un solo intento vivo por organización.
  await db
    .update(schema.billingCheckout)
    .set({ status: "replaced" })
    .where(and(eq(schema.billingCheckout.organizationId, input.organizationId), eq(schema.billingCheckout.status, "pending")));

  const id = newId("billingCheckout");
  await db.insert(schema.billingCheckout).values({
    id,
    organizationId: input.organizationId,
    planId: plan.id,
    createdByUserId: input.userId,
    status: "pending",
    amountCents: plan.priceMonthlyCents,
    currency: plan.currency,
    payerEmail: u.email,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CHECKOUT_TTL_MS),
  });

  // Si aún le queda periodo pagado (canceló al corte), el cobro nuevo empieza cuando ese termina: no se paga dos veces el mes.
  const startDate =
    sub?.status === "active" && sub.cancelAtPeriodEnd && sub.currentPeriodEnd.getTime() > now.getTime() ? sub.currentPeriodEnd.toISOString() : undefined;
  const base = (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
  try {
    const pre = await mp.createPreapproval(
      {
        reason: `Vocero · Plan ${plan.name}`,
        external_reference: id,
        payer_email: u.email,
        back_url: `${base}/suscripcion-retorno?checkout=${id}`,
        status: "pending",
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: centsToMpAmount(plan.priceMonthlyCents),
          currency_id: plan.currency,
          ...(startDate ? { start_date: startDate } : {}),
        },
      },
      id
    );
    if (!pre.init_point) throw new MpApiError("invalid", 502, "Mercado Pago no devolvió el enlace de pago", false);
    await db.update(schema.billingCheckout).set({ mpPreapprovalId: pre.id }).where(eq(schema.billingCheckout.id, id));
    return { ok: true, checkoutId: id, url: pre.init_point };
  } catch (err) {
    const msg = err instanceof MpApiError ? err.message : "Error inesperado";
    await db.update(schema.billingCheckout).set({ status: "failed", failureReason: msg, completedAt: new Date() }).where(eq(schema.billingCheckout.id, id));
    if (err instanceof MpApiError && err.kind === "invalid" && /currency/i.test(err.message)) {
      return { ok: false, status: 422, code: "currency_mismatch", message: "La moneda del plan no coincide con la cuenta de Mercado Pago" };
    }
    if (err instanceof MpApiError && err.kind === "auth") {
      return { ok: false, status: 503, code: "provider_misconfigured", message: "El cobro con Mercado Pago no está disponible. Avisa a quien administra la plataforma." };
    }
    return { ok: false, status: 502, code: "provider_unavailable", message: "Mercado Pago no responde. Intenta de nuevo en unos minutos." };
  }
}

export type CheckoutStatusDto = {
  id: string;
  status: "pending" | "authorized" | "paid" | "failed" | "abandoned" | "replaced";
  failureReason: string | null;
  planName: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
};

/** El estado de un intento (de la organización de quien pregunta). Con intento vivo, consulta a Mercado Pago antes. */
export async function getCheckoutStatus(organizationId: string, checkoutId: string): Promise<CheckoutStatusDto | null> {
  const db = getDb();
  const load = async () =>
    (
      await db
        .select({ c: schema.billingCheckout, planName: schema.plan.name })
        .from(schema.billingCheckout)
        .innerJoin(schema.plan, eq(schema.billingCheckout.planId, schema.plan.id))
        .where(and(eq(schema.billingCheckout.id, checkoutId), eq(schema.billingCheckout.organizationId, organizationId)))
        .limit(1)
    )[0];
  let row = await load();
  if (!row) return null;
  if ((row.c.status === "pending" || row.c.status === "authorized" || row.c.status === "failed") && row.c.mpPreapprovalId) {
    try {
      await syncPreapproval(row.c.mpPreapprovalId);
      invalidateSubscriptionAccess(organizationId);
      row = (await load()) ?? row;
    } catch (err) {
      console.error("[billing] la consulta activa del checkout falló:", err instanceof Error ? err.message : err);
    }
  }
  const [sub] = await db
    .select({ status: schema.subscription.status, end: schema.subscription.currentPeriodEnd })
    .from(schema.subscription)
    .where(eq(schema.subscription.organizationId, organizationId))
    .limit(1);
  return {
    id: row.c.id,
    status: row.c.status,
    failureReason: row.c.failureReason,
    planName: row.planName,
    subscriptionStatus: sub?.status ?? null,
    currentPeriodEnd: sub?.end.toISOString() ?? null,
  };
}
