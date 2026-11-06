import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { PLAN_MODULES } from "@/lib/plan-modules";

export type OrganizationContext = {
  organizationId: string;
  organizationName: string;
  slug: string | null;
  plan: {
    id: string;
    name: string;
    slug: string;
    features: {
      maxStaff?: number;
      maxMonthlyAiTurns?: number;
      channels: ("whatsapp" | "instagram" | "messenger" | "tiktok")[];
      modules: ("agenda" | "salon" | "atribucion" | "loyalty" | "finances")[];
    };
  };
  subscriptionStatus: string;
  category: {
    key: string;
    name: string;
    labels: {
      staffName: string;
      serviceName: string;
      resourceName: string;
      clientName: string;
    };
  };
  customLabels: Record<string, string>;
  customAiPromptRules: string | null;
};

/**
 * Obtiene el contexto completo SaaS de una organización (Plan, Límites, Módulos y Etiquetas).
 * Combina los valores por defecto de su categoría de sector con las personalizaciones (overrides) del negocio.
 */
export async function getOrganizationContext(organizationId: string): Promise<OrganizationContext | null> {
  const db = getDb();

  // 1. Obtener la organización
  const [org] = await db
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);

  if (!org) return null;

  // 2. Obtener la suscripción activa y su plan
  const [sub] = await db
    .select({
      status: schema.subscription.status,
      planId: schema.subscription.planId,
      planName: schema.plan.name,
      planSlug: schema.plan.slug,
      planFeatures: schema.plan.features,
    })
    .from(schema.subscription)
    .innerJoin(schema.plan, eq(schema.subscription.planId, schema.plan.id))
    .where(eq(schema.subscription.organizationId, organizationId))
    .limit(1);

  // Organización SIN suscripción (creada antes del módulo SaaS): sin restricciones. Darle el plan
  // Básico le quitaría de golpe módulos que ya usa; el plan solo limita a quien tiene uno asignado.
  const SIN_PLAN: OrganizationContext["plan"] = {
    id: "sin-plan",
    name: "Sin plan (acceso completo)",
    slug: "sin-plan",
    features: {
      channels: ["whatsapp", "instagram", "messenger", "tiktok"],
      modules: [...PLAN_MODULES],
    },
  };
  const planInfo: OrganizationContext["plan"] = sub ? {
    id: sub.planId,
    name: sub.planName,
    slug: sub.planSlug,
    features: sub.planFeatures,
  } : SIN_PLAN;

  // 3. Obtener el perfil de negocio y su categoría de sector
  const [profile] = await db
    .select({
      customLabels: schema.businessProfile.customLabels,
      customAiPromptRules: schema.businessProfile.customAiPromptRules,
      categoryKey: schema.businessCategory.key,
      categoryName: schema.businessCategory.name,
      categoryLabels: schema.businessCategory.labels,
    })
    .from(schema.businessProfile)
    .innerJoin(schema.businessCategory, eq(schema.businessProfile.categoryId, schema.businessCategory.id))
    .where(eq(schema.businessProfile.organizationId, organizationId))
    .limit(1);

  // Categoría por defecto de respaldo (salon)
  const categoryInfo = profile ? {
    key: profile.categoryKey,
    name: profile.categoryName,
    labels: profile.categoryLabels,
  } : {
    key: "salon",
    name: "Salón / Barbería",
    labels: { staffName: "Barbero", serviceName: "Servicio", resourceName: "Silla", clientName: "Cliente" },
  };

  return {
    organizationId: org.id,
    organizationName: org.name,
    slug: org.slug,
    plan: planInfo,
    subscriptionStatus: sub?.status ?? "active",
    category: categoryInfo,
    customLabels: profile?.customLabels ?? {},
    customAiPromptRules: profile?.customAiPromptRules ?? null,
  };
}

/**
 * Valida de manera rápida si una organización tiene un módulo habilitado 
 * ya sea por su plan SaaS o por compatibilidad.
 */
export async function organizationHasModule(
  organizationId: string, 
  moduleName: "agenda" | "salon" | "atribucion" | "loyalty" | "finances"
): Promise<boolean> {
  const context = await getOrganizationContext(organizationId);
  if (!context) return false;

  // Verificamos si el plan incluye el módulo
  return context.plan.features.modules.includes(moduleName);
}