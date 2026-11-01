import { count, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";

/** Etapas sembradas del pipeline (US2). */
const SEED_STAGES: { name: string; kind: "open" | "won" | "lost" }[] = [
  { name: "Nuevo", kind: "open" },
  { name: "En conversación", kind: "open" },
  { name: "Interesado", kind: "open" },
  { name: "Cliente", kind: "won" },
  { name: "Perdido", kind: "lost" },
];

/** Siembra pipeline + perfil del agente de una organización recién creada. */
async function seedOrganization(
  tx: Pick<PostgresJsDatabase<typeof schema>, "insert">,
  orgId: string
) {
  await tx.insert(schema.pipelineStage).values(
    SEED_STAGES.map((s, i) => ({
      id: newId("stage"),
      organizationId: orgId,
      name: s.name,
      position: i,
      kind: s.kind,
    }))
  );
  await tx.insert(schema.agentProfile).values({
    id: newId("agentProfile"),
    organizationId: orgId,
  });
}

/**
 * Primer registro de la instancia: crea la organización, deja al usuario como
 * propietario y siembra pipeline + perfil del agente.
 *
 * Solo actúa si NO existe ninguna organización (las cuentas de equipo las crea
 * el propietario y reciben su membresía explícita). Un advisory lock evita que
 * dos registros simultáneos en instancia vacía creen dos organizaciones.
 */
export async function onUserCreated(
  userId: string,
  userName: string,
  /** Conexión propia (el script `crear-usuario` abre la suya); por defecto la de la app. */
  db: PostgresJsDatabase<typeof schema> = getDb()
) {
  await db.transaction(async (tx) => {
    // Lock transaccional de "primer arranque" (clave arbitraria fija):
    // dos registros simultáneos en instancia vacía → solo uno crea la org.
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
    await seedOrganization(tx, orgId);
  });
}

/**
 * Registro público de un propietario (`ALLOW_SIGNUP=true`): crea SU PROPIO negocio —organización,
 * membresía de propietario, pipeline y perfil del agente— sin importar cuántos haya. Lo que cada
 * negocio guarda queda aislado por `organization_id` (`scoped()`), así que un registro nuevo no ve
 * nada de los demás. El primero conserva el slug histórico `principal`; el resto lleva uno único.
 * Las cuentas de equipo NO pasan por aquí: las crea el propietario con su membresía explícita.
 */
export async function onOwnerRegistered(
  userId: string,
  userName: string,
  db: PostgresJsDatabase<typeof schema> = getDb()
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
    await seedOrganization(tx, orgId);
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
