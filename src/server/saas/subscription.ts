import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  decideTransition,
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
