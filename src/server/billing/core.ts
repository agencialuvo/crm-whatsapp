import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { canAdvancePayment, classifyPayment, mapPreapprovalStatus, mpAmountToCents, rejectionMessage, type PaymentState } from "@/lib/billing";
import { mp, type MpAuthorizedPayment, type MpPreapproval } from "@/lib/mercadopago/client";
import { invalidateSubscriptionAccess } from "@/server/saas/enforcement";
import { applyPaymentEvent, type PaymentApplyResult } from "@/server/saas/subscription";

/**
 * 046 — El corazón del cobro: dado lo que Mercado Pago DICE (consultado a su API con nuestro token, nunca el
 * cuerpo de un webhook), guarda el cobro y lo aplica a la suscripción por la puerta única. Lo usan el webhook, la
 * «consulta activa» al volver del pago y el temporizador de reconciliación: los tres convergen aquí, y por eso
 * aplicar lo mismo dos veces no hace nada (idempotencia por `mp_authorized_payment_id` y `applied_at`).
 */

export type Located = { organizationId: string; checkout: typeof schema.billingCheckout.$inferSelect | null };

/** ¿De qué organización es esta suscripción de la pasarela? Por el vínculo ya guardado, o por el checkout. */
export async function locate(pre: Pick<MpPreapproval, "id" | "external_reference">): Promise<Located | null> {
  const db = getDb();
  const [sub] = await db
    .select({ organizationId: schema.subscription.organizationId })
    .from(schema.subscription)
    .where(eq(schema.subscription.mpPreapprovalId, pre.id))
    .limit(1);
  const [byPre] = await db.select().from(schema.billingCheckout).where(eq(schema.billingCheckout.mpPreapprovalId, pre.id)).limit(1);
  if (byPre) return { organizationId: byPre.organizationId, checkout: byPre };
  if (pre.external_reference?.startsWith("bck_")) {
    const [byRef] = await db.select().from(schema.billingCheckout).where(eq(schema.billingCheckout.id, pre.external_reference)).limit(1);
    if (byRef) {
      // Se aprendió el id de la suscripción de la pasarela antes de que `createCheckout` lo guardara (carrera).
      if (!byRef.mpPreapprovalId) await db.update(schema.billingCheckout).set({ mpPreapprovalId: pre.id }).where(eq(schema.billingCheckout.id, byRef.id));
      return { organizationId: byRef.organizationId, checkout: { ...byRef, mpPreapprovalId: pre.id } };
    }
  }
  if (sub) return { organizationId: sub.organizationId, checkout: null };
  return null;
}

const BELOW: Record<PaymentState, PaymentState[]> = {
  pending: ["pending", "cancelled"],
  cancelled: ["pending", "cancelled"],
  rejected: ["pending", "cancelled", "rejected"],
  approved: ["pending", "cancelled", "rejected", "approved"],
  refunded: ["pending", "cancelled", "rejected", "approved", "refunded", "charged_back"],
  charged_back: ["pending", "cancelled", "rejected", "approved", "refunded", "charged_back"],
};

/** Guarda el cobro con estado monótono: solo avanza. Devuelve la fila resultante. */
async function upsertPayment(p: {
  organizationId: string;
  planId: string | null;
  planName: string | null;
  ap: MpAuthorizedPayment;
  preapprovalId: string;
  state: PaymentState;
  currencyFallback: string;
}): Promise<typeof schema.billingPayment.$inferSelect> {
  const db = getDb();
  const apId = String(p.ap.id);
  const amountCents = mpAmountToCents(p.ap.transaction_amount ?? 0);
  const paidAt = p.state === "approved" ? new Date() : null;
  await db
    .insert(schema.billingPayment)
    .values({
      id: newId("billingPayment"),
      organizationId: p.organizationId,
      planId: p.planId,
      planName: p.planName,
      mpPreapprovalId: p.preapprovalId,
      mpAuthorizedPaymentId: apId,
      mpPaymentId: p.ap.payment?.id !== undefined ? String(p.ap.payment.id) : null,
      status: p.state,
      statusDetail: p.ap.payment?.status_detail ?? null,
      amountCents,
      currency: p.ap.currency_id ?? p.currencyFallback,
      retryAttempt: p.ap.retry_attempt ?? 0,
      debitDate: p.ap.debit_date ? new Date(p.ap.debit_date) : null,
      paidAt,
    })
    .onConflictDoNothing({ target: schema.billingPayment.mpAuthorizedPaymentId });
  const [existing] = await db.select().from(schema.billingPayment).where(eq(schema.billingPayment.mpAuthorizedPaymentId, apId)).limit(1);
  if (!existing) throw new Error("billing_payment no se pudo guardar");
  if (canAdvancePayment(existing.status, p.state) && existing.status !== p.state) {
    await db
      .update(schema.billingPayment)
      .set({
        status: p.state,
        statusDetail: p.ap.payment?.status_detail ?? existing.statusDetail,
        mpPaymentId: p.ap.payment?.id !== undefined ? String(p.ap.payment.id) : existing.mpPaymentId,
        retryAttempt: p.ap.retry_attempt ?? existing.retryAttempt,
        paidAt: p.state === "approved" ? (existing.paidAt ?? new Date()) : existing.paidAt,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.billingPayment.id, existing.id), inArray(schema.billingPayment.status, BELOW[p.state])));
  }
  const [row] = await db.select().from(schema.billingPayment).where(eq(schema.billingPayment.id, existing.id)).limit(1);
  return row ?? existing;
}

export type CoreOutcome = { kind: "applied" | "noop" | "duplicate" | "ignored" | "orphan"; organizationId?: string; detail?: string };

const fromApply = (r: PaymentApplyResult, organizationId: string): CoreOutcome =>
  r.ok ? { kind: r.outcome, organizationId, detail: r.detail } : { kind: "ignored", organizationId, detail: r.code };

/** Un cobro mensual (o el primero) ya consultado a Mercado Pago. */
export async function processAuthorizedPayment(ap: MpAuthorizedPayment, pre?: MpPreapproval | null): Promise<CoreOutcome> {
  const preapprovalId = ap.preapproval_id;
  const preapproval = pre ?? (await mp.getPreapproval(preapprovalId).catch(() => null));
  const loc = await locate({ id: preapprovalId, external_reference: preapproval?.external_reference });
  if (!loc) return { kind: "orphan", detail: "preapproval_unknown" };
  const { organizationId, checkout } = loc;
  const state = classifyPayment({ authorizedStatus: ap.status, paymentStatus: ap.payment?.status });

  // El primer cobro es el del checkout (plan y monto pactados); los siguientes, los de la suscripción vigente.
  const [sub] = await getDb().select().from(schema.subscription).where(eq(schema.subscription.organizationId, organizationId)).limit(1);
  // «Primero» = el checkout aún no quedó pagado (aunque la suscripción ya esté autorizada o el primer intento haya
  // sido rechazado y un reintento tardío sí se apruebe: sigue valiendo el plan y el monto del checkout).
  const firstOfCheckout = !!checkout && checkout.status !== "paid";
  const planId = firstOfCheckout ? checkout!.planId : (sub?.planId ?? null);
  const [plan] = planId ? await getDb().select().from(schema.plan).where(eq(schema.plan.id, planId)).limit(1) : [];

  const row = await upsertPayment({
    organizationId,
    planId: plan?.id ?? planId,
    planName: plan?.name ?? null,
    ap,
    preapprovalId,
    state,
    currencyFallback: checkout?.currency ?? plan?.currency ?? "PEN",
  });

  // Monto y moneda del primer cobro deben ser los del checkout: si no, alguien debe mirarlo y NO se activa.
  if (state === "approved" && firstOfCheckout) {
    const cents = mpAmountToCents(ap.transaction_amount ?? 0);
    const currency = ap.currency_id ?? checkout!.currency;
    if (cents !== checkout!.amountCents || currency !== checkout!.currency) {
      await getDb().update(schema.billingPayment).set({ needsReview: true, updatedAt: new Date() }).where(eq(schema.billingPayment.id, row.id));
      return { kind: "ignored", organizationId, detail: "amount_mismatch" };
    }
  }

  const link = {
    preapprovalId,
    payerId: preapproval?.payer_id != null ? String(preapproval.payer_id) : (sub?.mpPayerId ?? null),
    mpStatus: mapPreapprovalStatus(preapproval?.status ?? "authorized"),
    amountCents: row.amountCents,
    currency: row.currency,
    nextPaymentAt: preapproval?.next_payment_date ? new Date(preapproval.next_payment_date) : undefined,
  };

  let result: PaymentApplyResult | null = null;
  if (state === "approved") {
    result = await applyPaymentEvent({
      organizationId,
      event: { kind: "payment_approved", plan: { id: "", name: "", slug: "", priceMonthlyCents: 0, currency: "PEN", trialDays: null, active: true } },
      paymentId: row.id,
      providerRef: String(ap.id),
      planId: firstOfCheckout ? checkout!.planId : undefined,
      checkoutId: firstOfCheckout ? checkout!.id : undefined,
      link,
    });
  } else if (state === "rejected" && row.status === "rejected") {
    result = await applyPaymentEvent({
      organizationId,
      event: { kind: "payment_rejected" },
      paymentId: row.id,
      providerRef: String(ap.id),
      checkoutId: firstOfCheckout ? checkout!.id : undefined,
      reason: rejectionMessage(ap.payment?.status_detail),
    });
  } else if ((state === "refunded" || state === "charged_back") && row.status === state) {
    result = await applyPaymentEvent({
      organizationId,
      event: { kind: "payment_refunded" },
      paymentId: row.id,
      providerRef: String(ap.id),
      reason: state === "charged_back" ? "chargeback" : "refund",
    });
  }
  invalidateSubscriptionAccess(organizationId);
  return result ? fromApply(result, organizationId) : { kind: "noop", organizationId, detail: `payment_${state}` };
}

/**
 * Pone al día una suscripción de la pasarela: la consulta, aplica su estado y repasa sus cobros. La usan el
 * webhook, la consulta al volver del pago y el temporizador.
 */
export async function syncPreapproval(preapprovalId: string): Promise<CoreOutcome> {
  const pre = await mp.getPreapproval(preapprovalId);
  const loc = await locate(pre);
  if (!loc) return { kind: "orphan", detail: "preapproval_unknown" };
  const { organizationId, checkout } = loc;
  const status = mapPreapprovalStatus(pre.status);
  const [sub] = await getDb().select().from(schema.subscription).where(eq(schema.subscription.organizationId, organizationId)).limit(1);
  const linked = sub?.mpPreapprovalId === pre.id;
  const link = {
    preapprovalId: pre.id,
    payerId: pre.payer_id != null ? String(pre.payer_id) : null,
    mpStatus: status,
    nextPaymentAt: pre.next_payment_date ? new Date(pre.next_payment_date) : null,
  };

  let outcome: CoreOutcome = { kind: "noop", organizationId };
  if (status === "authorized") {
    const r = await applyPaymentEvent({ organizationId, event: { kind: "preapproval_authorized" }, providerRef: pre.id, checkoutId: checkout?.id, link });
    outcome = fromApply(r, organizationId);
  } else if (status === "cancelled") {
    if (linked) {
      outcome = fromApply(await applyPaymentEvent({ organizationId, event: { kind: "preapproval_cancelled" }, providerRef: pre.id, link }), organizationId);
    } else if (checkout && (checkout.status === "pending" || checkout.status === "authorized")) {
      await getDb()
        .update(schema.billingCheckout)
        .set({ status: "failed", failureReason: "Cancelaste el pago en Mercado Pago.", completedAt: new Date() })
        .where(eq(schema.billingCheckout.id, checkout.id));
    }
  } else if (status === "paused" && linked) {
    outcome = fromApply(await applyPaymentEvent({ organizationId, event: { kind: "preapproval_paused" }, providerRef: pre.id, link }), organizationId);
  }

  if (status === "authorized" || linked) {
    const payments = await mp.searchAuthorizedPayments(pre.id).catch(() => [] as MpAuthorizedPayment[]);
    // Del más viejo al más nuevo: el primer cobro tiene que aplicarse antes que las renovaciones.
    const ordered = [...payments].sort((a, b) => (a.debit_date ?? "").localeCompare(b.debit_date ?? "") || String(a.id).localeCompare(String(b.id)));
    for (const ap of ordered) {
      const o = await processAuthorizedPayment(ap, pre);
      if (o.kind === "applied") outcome = o;
    }
  }
  invalidateSubscriptionAccess(organizationId);
  return outcome;
}
