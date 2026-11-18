import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { effectiveStatus, type EffectiveStatus } from "@/lib/saas";
import { rejectionMessage } from "@/lib/billing";

export type BillingPlanDto = { id: string; name: string; priceMonthlyCents: number; currency: string; modules: string[]; current: boolean; pending: boolean };

export type PaymentDto = {
  id: string;
  planName: string | null;
  status: string;
  amountCents: number;
  currency: string;
  statusDetail: string | null;
  message: string | null;
  debitDate: string | null;
  paidAt: string | null;
  createdAt: string;
};

export type BillingStatusDto = {
  status: EffectiveStatus | null;
  statusReason: string | null;
  planId: string | null;
  planName: string | null;
  isTrialPlan: boolean;
  daysLeft: number | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  billingProvider: string | null;
  mpStatus: string | null;
  billedAmountCents: number | null;
  currency: string | null;
  pendingPlanName: string | null;
  lastPaymentAt: string | null;
  nextPaymentAt: string | null;
  graceEndsAt: string | null;
  plans: BillingPlanDto[];
  payments: PaymentDto[];
};

/** Lo que la pantalla de suscripción de UNA organización necesita (planes de pago, estado y cobros). */
export async function getBillingStatus(organizationId: string, graceDays: number, now = new Date()): Promise<BillingStatusDto> {
  const db = getDb();
  const [row] = await db
    .select({ sub: schema.subscription, plan: schema.plan })
    .from(schema.subscription)
    .innerJoin(schema.plan, eq(schema.subscription.planId, schema.plan.id))
    .where(eq(schema.subscription.organizationId, organizationId))
    .limit(1);
  const plans = await db.select().from(schema.plan).where(eq(schema.plan.active, true)).orderBy(schema.plan.sortOrder, schema.plan.priceMonthlyCents);
  const payments = await db
    .select()
    .from(schema.billingPayment)
    .where(eq(schema.billingPayment.organizationId, organizationId))
    .orderBy(desc(schema.billingPayment.createdAt))
    .limit(50);
  const pendingPlan = row?.sub.pendingPlanId ? plans.find((p) => p.id === row.sub.pendingPlanId) : undefined;
  const eff = row ? effectiveStatus(row.sub, row.plan, now) : null;
  const grace =
    row && row.sub.status === "past_due" && row.sub.statusReason === "payment_failed"
      ? new Date(row.sub.currentPeriodEnd.getTime() + graceDays * 86_400_000)
      : null;
  return {
    status: eff?.status ?? null,
    statusReason: row?.sub.statusReason ?? null,
    planId: row?.plan.id ?? null,
    planName: row?.plan.name ?? null,
    isTrialPlan: row ? row.plan.trialDays !== null : false,
    daysLeft: eff?.daysLeft ?? null,
    currentPeriodEnd: row?.sub.currentPeriodEnd.toISOString() ?? null,
    cancelAtPeriodEnd: row?.sub.cancelAtPeriodEnd ?? false,
    billingProvider: row?.sub.billingProvider ?? null,
    mpStatus: row?.sub.mpStatus ?? null,
    billedAmountCents: row?.sub.billedAmountCents ?? null,
    currency: row?.sub.billedCurrency ?? row?.plan.currency ?? null,
    pendingPlanName: pendingPlan?.name ?? null,
    lastPaymentAt: row?.sub.lastPaymentAt?.toISOString() ?? null,
    nextPaymentAt: row?.sub.nextPaymentAt?.toISOString() ?? null,
    graceEndsAt: grace?.toISOString() ?? null,
    plans: plans
      .filter((p) => p.trialDays === null && p.priceMonthlyCents > 0)
      .map((p) => ({
        id: p.id,
        name: p.name,
        priceMonthlyCents: p.priceMonthlyCents,
        currency: p.currency,
        modules: [...p.features.modules],
        current: row?.plan.id === p.id,
        pending: row?.sub.pendingPlanId === p.id,
      })),
    payments: payments.map((p) => ({
      id: p.id,
      planName: p.planName,
      status: p.status,
      amountCents: p.amountCents,
      currency: p.currency,
      statusDetail: p.statusDetail,
      message: p.status === "rejected" ? rejectionMessage(p.statusDetail) : null,
      debitDate: p.debitDate?.toISOString() ?? null,
      paidAt: p.paidAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
  };
}

/** Los cobros de una organización para el cajón del Super Admin (solo metadatos). */
export async function listPayments(organizationId: string, limit = 20): Promise<PaymentDto[]> {
  const rows = await getDb()
    .select()
    .from(schema.billingPayment)
    .where(eq(schema.billingPayment.organizationId, organizationId))
    .orderBy(desc(schema.billingPayment.createdAt))
    .limit(limit);
  return rows.map((p) => ({
    id: p.id,
    planName: p.planName,
    status: p.status,
    amountCents: p.amountCents,
    currency: p.currency,
    statusDetail: p.statusDetail,
    message: p.status === "rejected" ? rejectionMessage(p.statusDetail) : null,
    debitDate: p.debitDate?.toISOString() ?? null,
    paidAt: p.paidAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  }));
}
