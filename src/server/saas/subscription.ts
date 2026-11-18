import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  decidePayment,
  decideTransition,
  planChangeMode,
  type PaymentEvent,
  type SubEventType,
  type PlanFacts,
  type SubAction,
  type SubFacts,
  type SubStatus,
  type TransitionInput,
} from "@/lib/saas";

/**
 * 045 — La ÚNICA puerta que escribe `subscription.status`, `plan_id` y los periodos.
 *
 * Mismo principio que `moveLeadToStage` con `lead.stage_id`: cambiar la suscripción y registrar el cambio en
 * `subscription_event` son la MISMA operación, en la misma transacción. Hay tres caminos (el alta, el panel de
 * Super Admin y el temporizador de vencimiento, y pronto el cobro): si cada uno copiara el «anota el evento», el
 * siguiente lo olvidaría y la conversión mentiría meses después. Una prueba de vigilancia escanea `src/` y falla
 * si otro archivo escribe esos campos. No la relajes: enruta tu cambio por aquí.
 */

export type Tx = Pick<PostgresJsDatabase<typeof schema>, "select" | "insert">;
export type TxWrite = Pick<PostgresJsDatabase<typeof schema>, "select" | "insert" | "update">;

export const planFacts = (p: typeof schema.plan.$inferSelect): PlanFacts => ({
  id: p.id,
  name: p.name,
  slug: p.slug,
  priceMonthlyCents: p.priceMonthlyCents,
  currency: p.currency,
  trialDays: p.trialDays,
  active: p.active,
});

export const DEMO_SLUG = "demo";

/** El plan de prueba con el que nace toda organización nueva, o null si el catálogo aún no lo tiene. */
export async function findDemoPlan(tx: Tx): Promise<PlanFacts | null> {
  const [row] = await tx
    .select()
    .from(schema.plan)
    .where(and(eq(schema.plan.slug, DEMO_SLUG), eq(schema.plan.active, true)))
    .limit(1);
  return row ? planFacts(row) : null;
}

/**
 * El alta: suscripción `trialing` por los días del plan de prueba + el evento `trial_started`. Va DENTRO de
 * la transacción del registro de la organización (`seedOrganization`).
 */
export async function startTrial(tx: Tx, organizationId: string, plan: PlanFacts, now = new Date()): Promise<void> {
  const end = new Date(now.getTime() + (plan.trialDays ?? 14) * 86_400_000);
  await tx.insert(schema.subscription).values({
    id: newId("subscription"),
    organizationId,
    planId: plan.id,
    status: "trialing",
    currentPeriodStart: now,
    currentPeriodEnd: end,
    trialStartedAt: now,
    statusChangedAt: now,
  });
  await tx.insert(schema.subscriptionEvent).values({
    id: newId("subscriptionEvent"),
    organizationId,
    type: "trial_started",
    fromStatus: null,
    toStatus: "trialing",
    toPlanId: plan.id,
    toPlanName: plan.name,
    periodEndAfter: end,
    source: "signup",
    occurredAt: now,
  });
}

/**
 * El respaldo del alta cuando el catálogo no tiene la Demo: la suscripción `trialing` por 30 días al plan que se
 * eligió por el sector (el comportamiento de antes de la 045). Pasa por la puerta como todo lo demás.
 */
export async function startFallbackSubscription(tx: Tx, organizationId: string, plan: { id: string; name: string }, now = new Date()): Promise<void> {
  const end = new Date(now.getTime() + 30 * 86_400_000);
  await tx.insert(schema.subscription).values({
    id: newId("subscription"),
    organizationId,
    planId: plan.id,
    status: "trialing",
    currentPeriodStart: now,
    currentPeriodEnd: end,
    statusChangedAt: now,
  });
  await tx.insert(schema.subscriptionEvent).values({
    id: newId("subscriptionEvent"),
    organizationId,
    type: "trial_started",
    fromStatus: null,
    toStatus: "trialing",
    toPlanId: plan.id,
    toPlanName: plan.name,
    periodEndAfter: end,
    source: "signup",
    // Una prueba con el plan «de respaldo» no es una Demo: no cuenta para la conversión.
    approximate: true,
    occurredAt: now,
  });
}

/**
 * Una prueba con un plan ANTERIOR cambia de plan porque el negocio eligió otro sector (el comportamiento de
 * antes de la 045). No cambia el estado ni el periodo; deja el evento `plan_changed` (`source = system`).
 */
export async function reassignTrialPlan(tx: TxWrite, organizationId: string, next: { id: string; name: string }, now = new Date()): Promise<void> {
  const [row] = await tx
    .select({ sub: schema.subscription, planName: schema.plan.name })
    .from(schema.subscription)
    .innerJoin(schema.plan, eq(schema.subscription.planId, schema.plan.id))
    .where(scoped(schema.subscription.organizationId, organizationId))
    .limit(1);
  if (!row || row.sub.planId === next.id) return;
  await tx
    .update(schema.subscription)
    .set({ planId: next.id, updatedAt: now })
    .where(scoped(schema.subscription.organizationId, organizationId));
  await tx.insert(schema.subscriptionEvent).values({
    id: newId("subscriptionEvent"),
    organizationId,
    type: "plan_changed",
    fromStatus: row.sub.status,
    toStatus: row.sub.status,
    fromPlanId: row.sub.planId,
    fromPlanName: row.planName,
    toPlanId: next.id,
    toPlanName: next.name,
    periodEndBefore: row.sub.currentPeriodEnd,
    periodEndAfter: row.sub.currentPeriodEnd,
    source: "system",
    reason: "sector_changed",
    occurredAt: now,
  });
}

export type Actor = { userId: string; email: string | null; ip: string | null };

export type ApplyResult =
  | {
      ok: true;
      organizationId: string;
      status: SubStatus;
      planId: string;
      currentPeriodEnd: Date;
      eventType: string;
    }
  | { ok: false; status: 404 | 409 | 422; code: string; message: string };

/**
 * Una acción manual del Super Admin sobre la suscripción de una organización: valida con `decideTransition`
 * (pura), cambia la suscripción, escribe el evento y la auditoría. Todo o nada. Dos acciones simultáneas sobre
 * la misma organización se serializan con el candado de fila.
 */
export async function applySubscriptionAction(input: {
  organizationId: string;
  action: SubAction;
  planId?: string;
  days?: number;
  periodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
  /** 046: lo que la pasarela quedó diciendo tras propagarle la acción (`paused`, `cancelled`, `authorized`). */
  providerStatus?: string;
  reason: string;
  actor: Actor;
  now?: Date;
}): Promise<ApplyResult> {
  return getDb().transaction(async (tx): Promise<ApplyResult> => {
    const [org] = await tx
      .select({ id: schema.organization.id, name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, input.organizationId))
      .for("update")
      .limit(1);
    if (!org) return { ok: false, status: 404, code: "not_found", message: "Organización no encontrada" };
    // La hora del cambio se toma DESPUÉS del candado: dos acciones simultáneas quedan en la historia en el orden
    // en que de verdad se aplicaron (con la hora tomada antes de esperar, la segunda podía quedar «antes»).
    const now = input.now ?? new Date();

    const [row] = await tx
      .select({ sub: schema.subscription, plan: schema.plan })
      .from(schema.subscription)
      .innerJoin(schema.plan, eq(schema.subscription.planId, schema.plan.id))
      .where(scoped(schema.subscription.organizationId, input.organizationId))
      .limit(1);

    let target: PlanFacts | null = null;
    if (input.planId) {
      const [p] = await tx.select().from(schema.plan).where(eq(schema.plan.id, input.planId)).limit(1);
      if (!p) return { ok: false, status: 422, code: "plan_not_found", message: "El plan no existe" };
      if (!p.active) return { ok: false, status: 422, code: "plan_inactive", message: "Ese plan está retirado" };
      target = planFacts(p);
    }

    const from: SubFacts | null = row
      ? {
          status: row.sub.status,
          currentPeriodEnd: row.sub.currentPeriodEnd,
          cancelAtPeriodEnd: row.sub.cancelAtPeriodEnd,
          statusReason: row.sub.statusReason,
          convertedAt: row.sub.convertedAt,
        }
      : null;
    const current = row ? planFacts(row.plan) : null;
    const transitionInput: TransitionInput = {
      plan: target,
      days: input.days,
      periodEnd: input.periodEnd,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    };
    const d = decideTransition({ action: input.action, from, current, input: transitionInput, now });
    if (!d.ok) {
      return { ok: false, status: d.code === "invalid_transition" ? 409 : 422, code: d.code, message: d.message };
    }

    const newPlanId = d.planId ?? row?.sub.planId ?? "";
    const newPeriodEnd = d.periodEnd ?? row?.sub.currentPeriodEnd ?? now;
    const keepsReason = d.eventType === "plan_changed" || d.eventType === "period_changed";
    const statusChanged = !row || row.sub.status !== d.status;

    if (!row) {
      await tx.insert(schema.subscription).values({
        id: newId("subscription"),
        organizationId: input.organizationId,
        planId: newPlanId,
        status: d.status,
        currentPeriodStart: d.periodStart ?? now,
        currentPeriodEnd: newPeriodEnd,
        cancelAtPeriodEnd: false,
        trialStartedAt: d.status === "trialing" ? now : null,
        statusReason: d.statusReason,
        statusChangedAt: now,
      });
    } else {
      await tx
        .update(schema.subscription)
        .set({
          status: d.status,
          ...(d.planId ? { planId: d.planId } : {}),
          ...(d.periodStart ? { currentPeriodStart: d.periodStart } : {}),
          ...(d.periodEnd ? { currentPeriodEnd: d.periodEnd } : {}),
          ...(d.cancelAtPeriodEnd !== null ? { cancelAtPeriodEnd: d.cancelAtPeriodEnd } : {}),
          ...(keepsReason ? {} : { statusReason: d.statusReason }),
          ...(d.isConversion ? { convertedAt: now } : {}),
          ...(statusChanged ? { statusChangedAt: now } : {}),
          ...(input.providerStatus ? { mpStatus: input.providerStatus } : {}),
          updatedAt: now,
        })
        .where(scoped(schema.subscription.organizationId, input.organizationId));
    }

    await tx.insert(schema.subscriptionEvent).values({
      id: newId("subscriptionEvent"),
      organizationId: input.organizationId,
      type: d.eventType,
      fromStatus: row?.sub.status ?? null,
      toStatus: d.status,
      fromPlanId: current?.id ?? null,
      fromPlanName: current?.name ?? null,
      toPlanId: newPlanId,
      toPlanName: d.planName ?? current?.name ?? target?.name ?? null,
      periodEndBefore: row?.sub.currentPeriodEnd ?? null,
      periodEndAfter: newPeriodEnd,
      source: "admin",
      actorUserId: input.actor.userId,
      reason: input.reason,
      occurredAt: now,
    });

    await tx.insert(schema.superAdminAudit).values({
      id: newId("superAdminAudit"),
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email,
      action: input.action,
      targetOrganizationId: org.id,
      targetOrganizationName: org.name,
      before: row
        ? {
            plan: current?.name,
            status: row.sub.status,
            currentPeriodEnd: row.sub.currentPeriodEnd.toISOString(),
            cancelAtPeriodEnd: row.sub.cancelAtPeriodEnd,
          }
        : null,
      after: {
        plan: d.planName ?? current?.name ?? target?.name,
        status: d.status,
        currentPeriodEnd: newPeriodEnd.toISOString(),
        cancelAtPeriodEnd: d.cancelAtPeriodEnd ?? row?.sub.cancelAtPeriodEnd ?? false,
      },
      reason: input.reason,
      ip: input.actor.ip,
      createdAt: now,
    });

    return {
      ok: true,
      organizationId: input.organizationId,
      status: d.status,
      planId: newPlanId,
      currentPeriodEnd: newPeriodEnd,
      eventType: d.eventType,
    };
  });
}

const BATCH = 200;

/**
 * El vencimiento automático: toda suscripción `trialing` de un plan de PRUEBA cuyo periodo venció pasa a
 * `past_due` (`status_reason = 'trial_ended'`) y deja el evento `expired`. Idempotente y por tandas. No toca
 * planes de pago ni planes anteriores (hoy no vencen y siguen sin vencer).
 */
export async function expireTrials(now = new Date()): Promise<number> {
  return getDb().transaction(async (tx) => {
    const due = await tx
      .select({ sub: schema.subscription, plan: schema.plan })
      .from(schema.subscription)
      .innerJoin(schema.plan, eq(schema.subscription.planId, schema.plan.id))
      .where(
        and(
          eq(schema.subscription.status, "trialing"),
          lt(schema.subscription.currentPeriodEnd, now),
          isNotNull(schema.plan.trialDays)
        )
      )
      .limit(BATCH)
      .for("update", { of: schema.subscription, skipLocked: true });
    if (due.length === 0) return 0;
    await tx
      .update(schema.subscription)
      .set({ status: "past_due", statusReason: "trial_ended", statusChangedAt: now, updatedAt: now })
      .where(inArray(schema.subscription.id, due.map((d) => d.sub.id)));
    await tx.insert(schema.subscriptionEvent).values(
      due.map((d) => ({
        id: newId("subscriptionEvent"),
        organizationId: d.sub.organizationId,
        type: "expired" as const,
        fromStatus: "trialing",
        toStatus: "past_due",
        fromPlanId: d.plan.id,
        fromPlanName: d.plan.name,
        toPlanId: d.plan.id,
        toPlanName: d.plan.name,
        periodEndBefore: d.sub.currentPeriodEnd,
        periodEndAfter: d.sub.currentPeriodEnd,
        source: "system" as const,
        reason: "trial_ended",
        occurredAt: now,
      }))
    );
    return due.length;
  });
}

/* ---------- 046 · Cobro automático (Mercado Pago) ---------- */

export type PaymentApplyInput = {
  organizationId: string;
  event: PaymentEvent;
  /** `bpy_…`: el cobro ya guardado por `server/billing`. Con él, `applied_at` da la idempotencia. */
  paymentId?: string;
  /** El id del cobro (o de la suscripción) de la pasarela: queda en el evento de la historia. */
  providerRef?: string;
  /** Plan del primer cobro (el del checkout). Sin él: el programado, o el vigente. */
  planId?: string;
  checkoutId?: string;
  /** Qué sabe la pasarela de esta suscripción (se guarda aunque el estado no cambie). */
  link?: { preapprovalId: string; payerId: string | null; mpStatus: string; amountCents?: number; currency?: string; nextPaymentAt?: Date | null };
  /** Motivo legible (cobro rechazado…). */
  reason?: string;
  now?: Date;
};

export type PaymentApplyResult =
  | { ok: true; outcome: "applied" | "noop" | "duplicate"; status: SubStatus; eventType: SubEventType | null; detail?: string }
  | { ok: false; code: "no_subscription" | "plan_not_found"; message: string };

const toFacts = (sub: typeof schema.subscription.$inferSelect): SubFacts => ({
  status: sub.status,
  currentPeriodEnd: sub.currentPeriodEnd,
  cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  statusReason: sub.statusReason,
  convertedAt: sub.convertedAt,
  billingProvider: sub.billingProvider,
  billedAmountCents: sub.billedAmountCents,
  billedCurrency: sub.billedCurrency,
  pendingPlanId: sub.pendingPlanId,
});

/**
 * El cobro entra por la MISMA puerta que las acciones del panel. Bajo el candado de la organización: decide con
 * `decidePayment` (pura), cambia la suscripción, escribe el evento (`source = payment`) y marca el cobro como
 * aplicado, todo o nada. Dos avisos simultáneos del mismo cobro se serializan y el segundo ve `applied_at`.
 */
export async function applyPaymentEvent(input: PaymentApplyInput): Promise<PaymentApplyResult> {
  return getDb().transaction(async (tx): Promise<PaymentApplyResult> => {
    await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, input.organizationId))
      .for("update")
      .limit(1);
    const now = input.now ?? new Date();

    const [row] = await tx
      .select({ sub: schema.subscription, plan: schema.plan })
      .from(schema.subscription)
      .innerJoin(schema.plan, eq(schema.subscription.planId, schema.plan.id))
      .where(scoped(schema.subscription.organizationId, input.organizationId))
      .limit(1);
    if (!row) return { ok: false, code: "no_subscription", message: "La organización no tiene suscripción" };

    const payment = input.paymentId
      ? (await tx.select().from(schema.billingPayment).where(eq(schema.billingPayment.id, input.paymentId)).limit(1))[0]
      : undefined;
    if (input.event.kind === "payment_approved" && payment?.appliedAt) {
      return { ok: true, outcome: "duplicate", status: row.sub.status, eventType: null };
    }
    if (input.event.kind === "payment_refunded" && payment?.needsReview) {
      return { ok: true, outcome: "duplicate", status: row.sub.status, eventType: null };
    }

    let event = input.event;
    if (event.kind === "payment_approved") {
      const targetId = input.planId ?? row.sub.pendingPlanId ?? row.sub.planId;
      const [p] = await tx.select().from(schema.plan).where(eq(schema.plan.id, targetId)).limit(1);
      if (!p) return { ok: false, code: "plan_not_found", message: "El plan del cobro no existe" };
      event = { kind: "payment_approved", plan: planFacts(p) };
    }

    const d = decidePayment({ event, from: toFacts(row.sub), current: planFacts(row.plan), now });
    const link = input.link;
    const linkSet = link
      ? {
          billingProvider: "mercadopago" as const,
          mpPreapprovalId: link.preapprovalId,
          mpPayerId: link.payerId,
          mpStatus: link.mpStatus,
          ...(link.nextPaymentAt !== undefined ? { nextPaymentAt: link.nextPaymentAt } : {}),
        }
      : {};

    if (d.noop) {
      if (link) await tx.update(schema.subscription).set({ ...linkSet, updatedAt: now }).where(scoped(schema.subscription.organizationId, input.organizationId));
      if (input.checkoutId) {
        const next = event.kind === "preapproval_authorized" ? "authorized" : event.kind === "payment_rejected" ? "failed" : null;
        if (next) {
          await tx
            .update(schema.billingCheckout)
            .set({ status: next, ...(next === "failed" ? { failureReason: input.reason ?? null, completedAt: now } : {}) })
            .where(and(eq(schema.billingCheckout.id, input.checkoutId), inArray(schema.billingCheckout.status, ["pending", "authorized"])));
        }
      }
      return { ok: true, outcome: "noop", status: row.sub.status, eventType: null, detail: d.reason };
    }

    const approved = event.kind === "payment_approved";
    await tx
      .update(schema.subscription)
      .set({
        status: d.status,
        ...(d.planId ? { planId: d.planId } : {}),
        ...(d.periodStart ? { currentPeriodStart: d.periodStart } : {}),
        ...(d.periodEnd ? { currentPeriodEnd: d.periodEnd } : {}),
        ...(d.cancelAtPeriodEnd !== null ? { cancelAtPeriodEnd: d.cancelAtPeriodEnd } : {}),
        statusReason: d.statusReason,
        ...(d.isConversion ? { convertedAt: now } : {}),
        ...(row.sub.status !== d.status ? { statusChangedAt: now } : {}),
        ...(d.clearPendingPlan ? { pendingPlanId: null } : {}),
        ...(approved
          ? {
              lastPaymentAt: now,
              ...(link?.amountCents !== undefined ? { billedAmountCents: link.amountCents, billedCurrency: link.currency ?? row.plan.currency } : {}),
            }
          : {}),
        ...linkSet,
        updatedAt: now,
      })
      .where(scoped(schema.subscription.organizationId, input.organizationId));

    await tx.insert(schema.subscriptionEvent).values({
      id: newId("subscriptionEvent"),
      organizationId: input.organizationId,
      type: d.eventType,
      fromStatus: row.sub.status,
      toStatus: d.status,
      fromPlanId: row.plan.id,
      fromPlanName: row.plan.name,
      toPlanId: d.planId ?? row.plan.id,
      toPlanName: d.planName ?? row.plan.name,
      periodEndBefore: row.sub.currentPeriodEnd,
      periodEndAfter: d.periodEnd ?? row.sub.currentPeriodEnd,
      source: "payment",
      reason: input.reason ?? d.statusReason,
      providerRef: input.providerRef ?? null,
      occurredAt: now,
    });

    if (payment) {
      await tx
        .update(schema.billingPayment)
        .set({
          ...(approved ? { appliedAt: now } : {}),
          ...(d.needsReview ? { needsReview: true } : {}),
          updatedAt: now,
        })
        .where(eq(schema.billingPayment.id, payment.id));
    }
    if (input.checkoutId && approved) {
      await tx.update(schema.billingCheckout).set({ status: "paid", completedAt: now }).where(eq(schema.billingCheckout.id, input.checkoutId));
    }
    return { ok: true, outcome: "applied", status: d.status, eventType: d.eventType };
  });
}

export type ClientChangeInput =
  | { organizationId: string; kind: "change_plan"; planId: string; actorUserId: string; now?: Date }
  | { organizationId: string; kind: "cancel"; actorUserId: string; reason?: string; now?: Date };

export type ClientChangeResult =
  | { ok: true; mode: "immediate" | "scheduled" | "cancel_at_period_end"; eventType: SubEventType; planName: string | null }
  | { ok: false; status: 404 | 409 | 422; code: string; message: string };

/**
 * Lo que el DUEÑO pide desde su pantalla (cambiar de plan o cancelar), ya con la pasarela actualizada. Sin
 * prorrateo: subir rige ya y el precio nuevo desde el próximo cobro; bajar queda programado para el corte.
 */
export async function applyClientBillingChange(input: ClientChangeInput): Promise<ClientChangeResult> {
  return getDb().transaction(async (tx): Promise<ClientChangeResult> => {
    await tx.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.id, input.organizationId)).for("update").limit(1);
    const now = input.now ?? new Date();
    const [row] = await tx
      .select({ sub: schema.subscription, plan: schema.plan })
      .from(schema.subscription)
      .innerJoin(schema.plan, eq(schema.subscription.planId, schema.plan.id))
      .where(scoped(schema.subscription.organizationId, input.organizationId))
      .limit(1);
    if (!row) return { ok: false, status: 404, code: "no_subscription", message: "La organización no tiene suscripción" };
    if (row.sub.status !== "active") return { ok: false, status: 409, code: "invalid_transition", message: "Solo una suscripción activa admite este cambio" };

    if (input.kind === "cancel") {
      if (row.sub.cancelAtPeriodEnd) return { ok: false, status: 409, code: "already_cancelling", message: "La suscripción ya se cancela al corte" };
      await tx
        .update(schema.subscription)
        .set({ cancelAtPeriodEnd: true, statusReason: "customer_cancelled", ...(row.sub.billingProvider ? { mpStatus: "cancelled" } : {}), updatedAt: now })
        .where(scoped(schema.subscription.organizationId, input.organizationId));
      await tx.insert(schema.subscriptionEvent).values({
        id: newId("subscriptionEvent"),
        organizationId: input.organizationId,
        type: "status_changed",
        fromStatus: "active",
        toStatus: "active",
        fromPlanId: row.plan.id,
        fromPlanName: row.plan.name,
        toPlanId: row.plan.id,
        toPlanName: row.plan.name,
        periodEndBefore: row.sub.currentPeriodEnd,
        periodEndAfter: row.sub.currentPeriodEnd,
        source: "payment",
        actorUserId: input.actorUserId,
        reason: input.reason?.trim() || "customer_cancelled",
        occurredAt: now,
      });
      return { ok: true, mode: "cancel_at_period_end", eventType: "status_changed", planName: row.plan.name };
    }

    const [target] = await tx.select().from(schema.plan).where(eq(schema.plan.id, input.planId)).limit(1);
    if (!target || !target.active) return { ok: false, status: 422, code: "plan_not_found", message: "Ese plan no existe o está retirado" };
    if (target.trialDays !== null || target.priceMonthlyCents <= 0) return { ok: false, status: 422, code: "plan_not_billable", message: "Ese plan no se puede contratar" };
    if (target.id === row.plan.id && !row.sub.pendingPlanId) return { ok: false, status: 409, code: "same_plan", message: "Ya estás en ese plan" };
    if (target.id === row.plan.id) {
      // Volver al plan vigente: se anula el cambio programado.
      await tx.update(schema.subscription).set({ pendingPlanId: null, updatedAt: now }).where(scoped(schema.subscription.organizationId, input.organizationId));
      return { ok: true, mode: "immediate", eventType: "plan_changed", planName: row.plan.name };
    }
    const currentPrice = row.sub.billedAmountCents ?? row.plan.priceMonthlyCents;
    const mode = planChangeMode(currentPrice, target.priceMonthlyCents);
    if (mode === "same") return { ok: false, status: 409, code: "same_price", message: "Ese plan cuesta lo mismo que el actual" };
    const immediate = mode === "immediate";
    await tx
      .update(schema.subscription)
      .set(
        immediate
          ? { planId: target.id, pendingPlanId: null, billedAmountCents: target.priceMonthlyCents, billedCurrency: target.currency, updatedAt: now }
          : { pendingPlanId: target.id, updatedAt: now }
      )
      .where(scoped(schema.subscription.organizationId, input.organizationId));
    await tx.insert(schema.subscriptionEvent).values({
      id: newId("subscriptionEvent"),
      organizationId: input.organizationId,
      type: "plan_changed",
      fromStatus: "active",
      toStatus: "active",
      fromPlanId: row.plan.id,
      fromPlanName: row.plan.name,
      toPlanId: target.id,
      toPlanName: target.name,
      periodEndBefore: row.sub.currentPeriodEnd,
      periodEndAfter: row.sub.currentPeriodEnd,
      source: "payment",
      actorUserId: input.actorUserId,
      reason: immediate ? "upgrade" : "downgrade_scheduled",
      occurredAt: now,
    });
    return { ok: true, mode: immediate ? "immediate" : "scheduled", eventType: "plan_changed", planName: target.name };
  });
}

/**
 * Las suscripciones cobradas por la pasarela que pidieron cancelar al corte y cuyo periodo pagado ya terminó
 * pasan a `canceled`. Solo las de la pasarela: las manuales conservan el comportamiento de 045.
 */
export async function closeCancelledPeriods(now = new Date()): Promise<number> {
  return getDb().transaction(async (tx) => {
    const due = await tx
      .select({ sub: schema.subscription, plan: schema.plan })
      .from(schema.subscription)
      .innerJoin(schema.plan, eq(schema.subscription.planId, schema.plan.id))
      .where(
        and(
          eq(schema.subscription.billingProvider, "mercadopago"),
          eq(schema.subscription.status, "active"),
          eq(schema.subscription.cancelAtPeriodEnd, true),
          lt(schema.subscription.currentPeriodEnd, now)
        )
      )
      .limit(BATCH)
      .for("update", { of: schema.subscription, skipLocked: true });
    if (due.length === 0) return 0;
    await tx
      .update(schema.subscription)
      .set({ status: "canceled", statusChangedAt: now, updatedAt: now })
      .where(inArray(schema.subscription.id, due.map((d) => d.sub.id)));
    await tx.insert(schema.subscriptionEvent).values(
      due.map((d) => ({
        id: newId("subscriptionEvent"),
        organizationId: d.sub.organizationId,
        type: "status_changed" as const,
        fromStatus: "active",
        toStatus: "canceled",
        fromPlanId: d.plan.id,
        fromPlanName: d.plan.name,
        toPlanId: d.plan.id,
        toPlanName: d.plan.name,
        periodEndBefore: d.sub.currentPeriodEnd,
        periodEndAfter: d.sub.currentPeriodEnd,
        source: "system" as const,
        reason: d.sub.statusReason ?? "customer_cancelled",
        occurredAt: now,
      }))
    );
    return due.length;
  });
}
