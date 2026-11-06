import { count, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { pickInitialPlan } from "@/server/business/plan-selection";

/** Etapas sembradas del pipeline (US2). */
const SEED_STAGES: { name: string; kind: "open" | "won" | "lost" }[] = [
  { name: "Nuevo", kind: "open" },
  { name: "En conversación", kind: "open" },
  { name: "Interesado", kind: "open" },
  { name: "Cliente", kind: "won" },
  { name: "Perdido", kind: "lost" },
];

/** Sector con el que nace un negocio si el registro no dice otro. */
export const DEFAULT_CATEGORY_KEY = "salon";

/**
 * Siembra pipeline, perfil del agente, suscripción SaaS y perfil de negocio de una organización
 * recién creada. El plan inicial no es fijo: lo decide el sector (ver `pickInitialPlan`).
 */
async function seedOrganization(
  tx: Pick<PostgresJsDatabase<typeof schema>, "insert" | "select">,
  orgId: string,
  categoryKey: string = DEFAULT_CATEGORY_KEY
) {
  // 1. Siembra pipeline inicial
  await tx.insert(schema.pipelineStage).values(
    SEED_STAGES.map((s, i) => ({
      id: newId("stage"),
      organizationId: orgId,
      name: s.name,
      position: i,
      kind: s.kind,
    }))
  );

  // 2. Siembra perfil del agente
  await tx.insert(schema.agentProfile).values({
    id: newId("agentProfile"),
    organizationId: orgId,
  });

  // 3. SaaS: el sector primero, porque de sus módulos sale el plan inicial.
  const findCategory = async (key: string) =>
    (await tx.select().from(schema.businessCategory).where(eq(schema.businessCategory.key, key)).limit(1))[0];
  // Un sector desconocido no deja al negocio sin sector (ni con un plan que no case con su menú): cae al por defecto.
  const category =
    (await findCategory(categoryKey)) ??
    (categoryKey === DEFAULT_CATEGORY_KEY ? undefined : await findCategory(DEFAULT_CATEGORY_KEY));

  // 4. SaaS: plan inicial = el más barato que incluye todos los módulos del sector. Así el menú que
  // va a ver el negocio nuevo no aparece bloqueado desde el primer minuto.
  const plans = await tx.select().from(schema.plan).where(eq(schema.plan.active, true));
  const initialPlan = pickInitialPlan(plans, category?.defaultModules ?? []);

  if (initialPlan) {
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + 30); // 30 días de periodo inicial / trial

    await tx.insert(schema.subscription).values({
      id: newId("subscription"),
      organizationId: orgId,
      planId: initialPlan.id,
      status: "trialing",
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    });
  }

  // 5. SaaS: perfil de negocio (sector)
  if (category) {
    await tx.insert(schema.businessProfile).values({
      id: newId("businessProfile"),
      organizationId: orgId,
      categoryId: category.id,
      customLabels: {},
      // Nace con el sector por defecto; el panel le ofrece elegir el suyo (se puede omitir).
      sectorStatus: "pending",
    });
  }
}

/**
 * Primer registro de la instancia: crea la organización, deja al usuario como
 * propietario y siembra pipeline + perfil del agente + SaaS.
 */
export async function onUserCreated(
  userId: string,
  userName: string,
  /** Conexión propia (el script `crear-usuario` abre la suya); por defecto la de la app. */
  db: PostgresJsDatabase<typeof schema> = getDb(),
  /** Sector del negocio (`business_category.key`); decide también el plan inicial. */
  categoryKey: string = DEFAULT_CATEGORY_KEY
) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(874201)`);
    const [orgs] = await tx
      .select({ n: count() })
      .from(schema.organization);
    if ((orgs?.n ?? 0) > 0) return;

    const orgId = newId("organization");
    await tx.insert(schema.organization).values({
      id: orgId,
      name: userName ? `Negocio de ${userName}` : "Mi negocio",
      slug: "principal",
    });
    await tx.insert(schema.member).values({
      id: newId("member"),
      organizationId: orgId,
      userId,
      role: "owner",
    });
    await seedOrganization(tx, orgId, categoryKey);
  });
}

/**
 * Registro público de un propietario (`ALLOW_SIGNUP=true`): crea SU PROPIO negocio —organización,
 * membresía de propietario, pipeline, perfil del agente y entorno SaaS— de forma aislada.
 */
export async function onOwnerRegistered(
  userId: string,
  userName: string,
  db: PostgresJsDatabase<typeof schema> = getDb(),
  /** Sector del negocio (`business_category.key`); decide también el plan inicial. */
  categoryKey: string = DEFAULT_CATEGORY_KEY
) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(874201)`);
    const [orgs] = await tx.select({ n: count() }).from(schema.organization);
    const first = (orgs?.n ?? 0) === 0;

    const orgId = newId("organization");
    await tx.insert(schema.organization).values({
      id: orgId,
      name: userName ? `Negocio de ${userName}` : "Mi negocio",
      slug: first ? "principal" : `negocio-${orgId.slice(-8).toLowerCase()}`,
    });
    await tx.insert(schema.member).values({
      id: newId("member"),
      organizationId: orgId,
      userId,
      role: "owner",
    });
    await seedOrganization(tx, orgId, categoryKey);
  });
}

/** Organización activa de un usuario (su primera membresía). */
export async function resolveActiveOrganizationId(
  userId: string
): Promise<string | null> {
  return (await resolveMembership(userId))?.organizationId ?? null;
}

export async function resolveMembership(
  userId: string
): Promise<{ organizationId: string; role: string } | null> {
  const db = getDb();
  const rows = await db
    .select({
      organizationId: schema.member.organizationId,
      role: schema.member.role,
    })
    .from(schema.member)
    .where(eq(schema.member.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}