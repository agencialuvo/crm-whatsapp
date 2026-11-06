import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { DEFAULT_SECTOR_KEY, type BusinessSector } from "@/lib/business-sector";
import { pickInitialPlan } from "@/server/business/plan-selection";

/**
 * Elegir (o dejar para después) el sector del negocio, ya con el negocio creado. El registro no lo
 * pregunta: el negocio nace con el sector por defecto y el panel le ofrece elegir uno, de forma
 * opcional (`business_profile.sector_status`: pending → skipped | chosen).
 */

export type SectorSetup = {
  status: "pending" | "skipped" | "chosen";
  categoryKey: string;
};

/** Los sectores del catálogo: primero el de por defecto y luego el resto por nombre. */
export async function listBusinessSectors(): Promise<BusinessSector[]> {
  const rows = await getDb()
    .select({
      key: schema.businessCategory.key,
      name: schema.businessCategory.name,
      description: schema.businessCategory.description,
    })
    .from(schema.businessCategory)
    .orderBy(asc(schema.businessCategory.name));
  return rows.sort(
    (a, b) => Number(b.key === DEFAULT_SECTOR_KEY) - Number(a.key === DEFAULT_SECTOR_KEY) || a.name.localeCompare(b.name)
  );
}

/** El estado del sector de esta organización; `null` si no tiene perfil de negocio (anterior al módulo SaaS). */
export async function getSectorSetup(organizationId: string): Promise<SectorSetup | null> {
  const [row] = await getDb()
    .select({ status: schema.businessProfile.sectorStatus, categoryKey: schema.businessCategory.key })
    .from(schema.businessProfile)
    .innerJoin(schema.businessCategory, eq(schema.businessProfile.categoryId, schema.businessCategory.id))
    .where(scoped(schema.businessProfile.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

export type ChooseSectorResult =
  | { ok: true; categoryKey: string; planSlug: string | null; planChanged: boolean }
  | { ok: false; reason: "unknown_sector" };

/**
 * Fija el sector. Y, solo mientras la suscripción siga en PRUEBA (`trialing`), reajusta el plan
 * inicial al que cubre los módulos del sector nuevo. Una suscripción ya activa (pagada) no se toca:
 * cambiar de sector nunca debe mover un plan contratado. Una organización sin suscripción (anterior
 * al módulo SaaS) tampoco recibe una: quedaría restringida.
 */
export async function chooseSector(organizationId: string, categoryKey: string): Promise<ChooseSectorResult> {
  return getDb().transaction(async (tx) => {
    const [category] = await tx
      .select()
      .from(schema.businessCategory)
      .where(eq(schema.businessCategory.key, categoryKey))
      .limit(1);
    if (!category) return { ok: false, reason: "unknown_sector" } as const;

    // Un solo perfil por organización (índice único): el upsert evita la carrera entre dos pestañas.
    await tx
      .insert(schema.businessProfile)
      .values({
        id: newId("businessProfile"),
        organizationId,
        categoryId: category.id,
        sectorStatus: "chosen",
      })
      .onConflictDoUpdate({
        target: schema.businessProfile.organizationId,
        set: { categoryId: category.id, sectorStatus: "chosen", updatedAt: new Date() },
      });

    let planSlug: string | null = null;
    let planChanged = false;
    const [sub] = await tx
      .select({ id: schema.subscription.id, status: schema.subscription.status, planId: schema.subscription.planId })
      .from(schema.subscription)
      .where(scoped(schema.subscription.organizationId, organizationId))
      .limit(1);
    if (sub) {
      const plans = await tx.select().from(schema.plan).where(eq(schema.plan.active, true));
      const current = plans.find((p) => p.id === sub.planId);
      planSlug = current?.slug ?? null;
      if (sub.status === "trialing") {
        const next = pickInitialPlan(plans, category.defaultModules);
        if (next && next.id !== sub.planId) {
          await tx
            .update(schema.subscription)
            .set({ planId: next.id, updatedAt: new Date() })
            .where(eq(schema.subscription.id, sub.id));
          planSlug = next.slug;
          planChanged = true;
        }
      }
    }
    return { ok: true, categoryKey: category.key, planSlug, planChanged } as const;
  });
}

/** «Configurar más tarde»: el asistente no vuelve a aparecer solo. Solo cierra un `pending`; no pisa una elección. */
export async function skipSectorSetup(organizationId: string): Promise<void> {
  await getDb()
    .update(schema.businessProfile)
    .set({ sectorStatus: "skipped", updatedAt: new Date() })
    .where(
      scoped(
        schema.businessProfile.organizationId,
        organizationId,
        sql`${schema.businessProfile.sectorStatus} = 'pending'`
      )
    );
}
