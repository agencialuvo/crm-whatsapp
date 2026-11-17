import { desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { effectiveStatus, isTrialPlan, matchesStatusFilter, type EventFacts, type OrgFacts, type PlanFacts, type SubFacts } from "@/lib/saas";
import type {
  AuditEntryDto,
  OrganizationDetailDto,
  OrganizationRowDto,
  PlanDto,
  SubscriptionEventDto,
} from "@/lib/super-admin";
import { normalizeText } from "@/lib/search";

/**
 * 045 — Lecturas CROSS-TENANT del panel de Super Admin.
 *
 * Este módulo es la ÚNICA excepción controlada a `scoped()` (que acota toda consulta a UNA organización): aquí se
 * lee a propósito sobre todas. Por eso vive aislado en `src/server/super-admin/` y una prueba de vigilancia falla
 * si cualquier otro archivo lo importa. Y por eso solo se leen METADATOS de la cuenta: nombre de la organización,
 * dueño (nombre y correo), plan, estado y fechas. Nunca conversaciones, contactos, mensajes ni credenciales.
 */

export type OrgRecord = OrgFacts & { name: string; ownerName: string | null; ownerEmail: string | null };

const toPlan = (p: typeof schema.plan.$inferSelect): PlanFacts => ({
  id: p.id,
  name: p.name,
  slug: p.slug,
  priceMonthlyCents: p.priceMonthlyCents,
  currency: p.currency,
  trialDays: p.trialDays,
  active: p.active,
});

/** Todas las organizaciones con su suscripción, su plan y su dueño (el primero con rol `owner`). */
export async function loadOrganizations(): Promise<OrgRecord[]> {
  const rows = await getDb()
    .select({
      orgId: schema.organization.id,
      name: schema.organization.name,
      createdAt: schema.organization.createdAt,
      sub: schema.subscription,
      plan: schema.plan,
      ownerName: sql<string | null>`(
        select u.name from member m join "user" u on u.id = m.user_id
        where m.organization_id = ${schema.organization.id} and m.role = 'owner'
        order by m.created_at limit 1
      )`,
      ownerEmail: sql<string | null>`(
        select u.email from member m join "user" u on u.id = m.user_id
        where m.organization_id = ${schema.organization.id} and m.role = 'owner'
        order by m.created_at limit 1
      )`,
    })
    .from(schema.organization)
    .leftJoin(schema.subscription, eq(schema.subscription.organizationId, schema.organization.id))
    .leftJoin(schema.plan, eq(schema.subscription.planId, schema.plan.id))
    .orderBy(desc(schema.organization.createdAt));

  return rows.map((r) => {
    const sub: SubFacts | null = r.sub
      ? {
          status: r.sub.status,
          currentPeriodEnd: r.sub.currentPeriodEnd,
          cancelAtPeriodEnd: r.sub.cancelAtPeriodEnd,
          statusReason: r.sub.statusReason,
          convertedAt: r.sub.convertedAt,
        }
      : null;
    return {
      orgId: r.orgId,
      name: r.name,
      createdAt: r.createdAt,
      plan: r.plan ? toPlan(r.plan) : null,
      sub,
      ownerName: r.ownerName,
      ownerEmail: r.ownerEmail,
    };
  });
}

/** Solo los dos tipos que la conversión necesita (`trial_started` y `converted`). */
export async function loadConversionEvents(): Promise<EventFacts[]> {
  const rows = await getDb()
    .select({
      organizationId: schema.subscriptionEvent.organizationId,
      type: schema.subscriptionEvent.type,
      occurredAt: schema.subscriptionEvent.occurredAt,
      approximate: schema.subscriptionEvent.approximate,
    })
    .from(schema.subscriptionEvent)
    .where(inArray(schema.subscriptionEvent.type, ["trial_started", "converted"]));
  return rows;
}

export function toRow(o: OrgRecord, now: Date): OrganizationRowDto {
  const eff = o.sub ? effectiveStatus(o.sub, o.plan, now) : null;
  return {
    id: o.orgId,
    name: o.name,
    ownerName: o.ownerName,
    ownerEmail: o.ownerEmail,
    planId: o.plan?.id ?? null,
    planName: o.plan?.name ?? null,
    planActive: o.plan?.active ?? null,
    isTrialPlan: isTrialPlan(o.plan),
    priceMonthlyCents: o.plan?.priceMonthlyCents ?? null,
    status: eff?.status ?? null,
    statusReason: o.sub?.statusReason ?? null,
    daysLeft: eff?.daysLeft ?? null,
    currentPeriodEnd: o.sub?.currentPeriodEnd.toISOString() ?? null,
    cancelAtPeriodEnd: o.sub?.cancelAtPeriodEnd ?? false,
    createdAt: o.createdAt.toISOString(),
  };
}

export type DirectoryFilters = {
  q?: string;
  plan?: string;
  status?: OrganizationRowDto["status"] | "none";
  limit?: number;
};

/** El directorio, filtrado en memoria (hasta 5 000 filas: la tabla del panel pagina en el cliente). */
export async function listOrganizations(filters: DirectoryFilters = {}, now = new Date()): Promise<OrganizationRowDto[]> {
  const all = await loadOrganizations();
  const q = filters.q?.trim() ? normalizeText(filters.q.trim()) : "";
  const rows = all
    .filter((o) => {
      if (q) {
        const hay = normalizeText(`${o.name} ${o.ownerName ?? ""} ${o.ownerEmail ?? ""}`);
        if (!hay.includes(q)) return false;
      }
      if (filters.plan && o.plan?.id !== filters.plan && o.plan?.slug !== filters.plan) return false;
      if (filters.status) {
        const eff = o.sub ? effectiveStatus(o.sub, o.plan, now).status : null;
        if (!matchesStatusFilter(eff, o.sub?.statusReason, filters.status)) return false;
      }
      return true;
    })
    .slice(0, filters.limit ?? 5000);
  return rows.map((o) => toRow(o, now));
}

export async function listPlans(): Promise<PlanDto[]> {
  const rows = await getDb()
    .select()
    .from(schema.plan)
    .where(eq(schema.plan.active, true))
    .orderBy(schema.plan.sortOrder, schema.plan.priceMonthlyCents);
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    priceMonthlyCents: p.priceMonthlyCents,
    currency: p.currency,
    trialDays: p.trialDays,
    active: p.active,
    modules: [...p.features.modules],
  }));
}

/** Una organización con su historia de suscripción y su auditoría. null si no existe. */
export async function getOrganizationDetail(organizationId: string, now = new Date()): Promise<OrganizationDetailDto | null> {
  const db = getDb();
  const all = await loadOrganizations();
  const org = all.find((o) => o.orgId === organizationId);
  if (!org) return null;

  const events = await db
    .select({ e: schema.subscriptionEvent, actorName: schema.user.name })
    .from(schema.subscriptionEvent)
    .leftJoin(schema.user, eq(schema.subscriptionEvent.actorUserId, schema.user.id))
    .where(eq(schema.subscriptionEvent.organizationId, organizationId))
    .orderBy(desc(schema.subscriptionEvent.occurredAt), desc(schema.subscriptionEvent.id))
    .limit(100);

  const audit = await db
    .select()
    .from(schema.superAdminAudit)
    .where(eq(schema.superAdminAudit.targetOrganizationId, organizationId))
    .orderBy(desc(schema.superAdminAudit.createdAt), desc(schema.superAdminAudit.id))
    .limit(50);

  return {
    organization: toRow(org, now),
    events: events.map(
      ({ e, actorName }): SubscriptionEventDto => ({
        id: e.id,
        type: e.type,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        fromPlanName: e.fromPlanName,
        toPlanName: e.toPlanName,
        periodEndAfter: e.periodEndAfter?.toISOString() ?? null,
        source: e.source,
        actorName,
        reason: e.reason,
        approximate: e.approximate,
        occurredAt: e.occurredAt.toISOString(),
      })
    ),
    audit: audit.map(
      (a): AuditEntryDto => ({
        id: a.id,
        action: a.action,
        actorEmail: a.actorEmail,
        reason: a.reason,
        before: a.before,
        after: a.after,
        createdAt: a.createdAt.toISOString(),
      })
    ),
  };
}
