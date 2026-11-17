import { eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";

type Db = ReturnType<typeof getDb>;

/**
 * Catálogo base de la plataforma SaaS: categorías de sector y plan por defecto.
 *
 * Son datos de REFERENCIA (no de una organización), así que viven aquí y no en el
 * seed demo. `seedPlatformCatalog` es idempotente: cada fila se identifica por su
 * llave natural (`key` / `slug`, ambas UNIQUE) y `ON CONFLICT DO NOTHING` la deja
 * como está, de modo que un dueño o una migración posterior pueden ajustar un
 * plan sin que el siguiente arranque lo pise. Se llama al arrancar el servidor
 * (`instrumentation-node.ts`) y desde `pnpm seed:platform`.
 */

type CategoryInsert = Omit<typeof schema.businessCategory.$inferInsert, "id" | "createdAt">;
type PlanInsert = Omit<typeof schema.plan.$inferInsert, "id" | "createdAt">;

export const BASE_CATEGORIES: readonly CategoryInsert[] = [
  {
    key: "salon",
    name: "Salón de belleza / Barbería",
    description: "Barberías, salones, manicure y spas: varias personas atendiendo a la vez.",
    labels: {
      staffName: "Barbero",
      serviceName: "Servicio",
      resourceName: "Silla",
      clientName: "Cliente",
    },
    defaultModules: ["agenda", "salon", "loyalty", "finances"],
  },
  {
    key: "health",
    name: "Salud / Clínica",
    description: "Consultorios, clínicas y centros de salud con citas por especialista.",
    labels: {
      staffName: "Doctor",
      serviceName: "Consulta",
      resourceName: "Consultorio",
      clientName: "Paciente",
    },
    defaultModules: ["agenda"],
  },
  {
    key: "personal_brand",
    name: "Marca personal",
    description: "Coaches, creadores, mentores y consultores que venden su propio nombre: sesiones, programas y asesorías.",
    labels: {
      staffName: "Especialista",
      serviceName: "Programa",
      resourceName: "Sesión",
      clientName: "Cliente",
    },
    defaultModules: ["agenda"],
  },
  {
    key: "services",
    name: "Servicios profesionales",
    description: "Consultoría, asesorías y otros servicios por cita o proyecto.",
    labels: {
      staffName: "Especialista",
      serviceName: "Servicio",
      resourceName: "Sala",
      clientName: "Cliente",
    },
    defaultModules: ["agenda"],
  },
];

/**
 * Planes base de la plataforma SaaS (045). Precios en CENTAVOS de sol (PEN).
 *
 * - **Demo**: la prueba de 14 días con la que nace TODA organización nueva. Incluye todo (los módulos y canales
 *   de Pro): la prueba tiene que enseñar el producto completo, y lo único que la limita es el tiempo.
 * - **Emprendedor / Pro / Enterprise**: los tres planes de pago.
 *
 * Los límites (`maxStaff`, `maxMonthlyAiTurns`) hoy solo se DECLARAN: ninguna parte del sistema los aplica
 * todavía (`-1` = ilimitado). Los antiguos «Básico» y «Salón» ya no se siembran: la migración 0080 los retira
 * (`active = false`) y quien los tiene conserva su acceso. Un plan ya sembrado no se pisa (`ON CONFLICT DO
 * NOTHING` por `slug`): ajustar un precio es una decisión consciente, no un efecto del siguiente arranque.
 */
export const DEMO_PLAN: PlanInsert = {
  name: "Demo",
  slug: "demo",
  description: "Prueba gratuita de 14 días con todo incluido.",
  priceMonthlyCents: 0,
  trialDays: 14,
  currency: "PEN",
  sortOrder: 0,
  features: {
    maxStaff: 3,
    maxMonthlyAiTurns: 1000,
    channels: ["whatsapp", "instagram", "messenger"],
    modules: ["agenda", "salon", "loyalty", "finances", "atribucion"],
  },
  active: true,
};

export const EMPRENDEDOR_PLAN: PlanInsert = {
  name: "Emprendedor",
  slug: "emprendedor",
  description: "Para empezar: WhatsApp, agenda, equipo y fidelización.",
  priceMonthlyCents: 7900,
  trialDays: null,
  currency: "PEN",
  sortOrder: 1,
  features: {
    maxStaff: 3,
    maxMonthlyAiTurns: 1000,
    channels: ["whatsapp"],
    modules: ["agenda", "salon", "loyalty"],
  },
  active: true,
};

export const PRO_PLAN: PlanInsert = {
  name: "Pro",
  slug: "pro",
  description: "El recomendado: finanzas, atribución de anuncios y más canales.",
  priceMonthlyCents: 14900,
  trialDays: null,
  currency: "PEN",
  sortOrder: 2,
  features: {
    maxStaff: 10,
    maxMonthlyAiTurns: 5000,
    channels: ["whatsapp", "instagram", "messenger"],
    modules: ["agenda", "salon", "loyalty", "finances", "atribucion"],
  },
  active: true,
};

export const ENTERPRISE_PLAN: PlanInsert = {
  name: "Enterprise",
  slug: "enterprise",
  description: "Sin límites: todos los módulos y canales.",
  priceMonthlyCents: 29900,
  trialDays: null,
  currency: "PEN",
  sortOrder: 3,
  features: {
    maxStaff: -1,
    maxMonthlyAiTurns: -1,
    channels: ["whatsapp", "instagram", "messenger", "tiktok"],
    modules: ["agenda", "salon", "loyalty", "finances", "atribucion"],
  },
  active: true,
};

export const BASE_PLANS: readonly PlanInsert[] = [DEMO_PLAN, EMPRENDEDOR_PLAN, PRO_PLAN, ENTERPRISE_PLAN];

/** Inserta lo que falte. Devuelve cuántas filas nuevas entraron (0 en un arranque normal). */
export async function seedPlatformCatalog(
  db: Db = getDb()
): Promise<{ categories: number; plans: number }> {
  const categories = await db
    .insert(schema.businessCategory)
    .values(BASE_CATEGORIES.map((c) => ({ ...c, id: newId("businessCategory") })))
    .onConflictDoNothing({ target: schema.businessCategory.key })
    .returning({ id: schema.businessCategory.id });
  const plans = await db
    .insert(schema.plan)
    .values(BASE_PLANS.map((p) => ({ ...p, id: newId("plan") })))
    .onConflictDoNothing({ target: schema.plan.slug })
    .returning({ id: schema.plan.id });
  return { categories: categories.length, plans: plans.length };
}

/**
 * Los negocios creados ANTES del módulo SaaS no tienen perfil de negocio, y sin él «Ajustes → Tipo de
 * negocio» no aparece. Se les crea uno con el sector por defecto y estado `skipped` (no se les
 * interrumpe con el asistente: lo cambian cuando quieran). NO se les crea suscripción: sin ella
 * el negocio sigue con acceso completo y nada de lo que ya usan queda restringido. Idempotente.
 */
export async function backfillBusinessProfiles(db: Db = getDb(), defaultKey = "salon"): Promise<number> {
  const [category] = await db
    .select({ id: schema.businessCategory.id })
    .from(schema.businessCategory)
    .where(eq(schema.businessCategory.key, defaultKey))
    .limit(1);
  if (!category) return 0;
  const sinPerfil = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .leftJoin(schema.businessProfile, eq(schema.businessProfile.organizationId, schema.organization.id))
    .where(isNull(schema.businessProfile.id));
  if (sinPerfil.length === 0) return 0;
  const creados = await db
    .insert(schema.businessProfile)
    .values(
      sinPerfil.map((o) => ({
        id: newId("businessProfile"),
        organizationId: o.id,
        categoryId: category.id,
        sectorStatus: "skipped" as const,
      }))
    )
    .onConflictDoNothing()
    .returning({ id: schema.businessProfile.id });
  return creados.length;
}
