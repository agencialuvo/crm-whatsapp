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
 * Planes base. El plan inicial de un negocio nuevo lo elige `pickInitialPlan` según los
 * `defaultModules` de su sector: el más barato que los cubre todos. Por eso hay un plan que
 * cubre el sector `salon` (agenda + salón + fidelización + finanzas) además del Básico.
 */
export const DEFAULT_PLAN: PlanInsert = {
  name: "Básico",
  slug: "basico",
  description: "Plan inicial: WhatsApp, agenda y hasta 3 profesionales.",
  priceMonthlyCents: 0,
  features: {
    maxStaff: 3,
    maxMonthlyAiTurns: 1000,
    channels: ["whatsapp"],
    modules: ["agenda"],
  },
  active: true,
};

export const SALON_PLAN: PlanInsert = {
  name: "Salón",
  slug: "salon",
  description: "Barberías y salones: agenda por sillas, equipo y comisiones, caja, gastos y fidelización.",
  priceMonthlyCents: 0,
  features: {
    maxStaff: 10,
    maxMonthlyAiTurns: 3000,
    channels: ["whatsapp"],
    modules: ["agenda", "salon", "loyalty", "finances"],
  },
  active: true,
};

export const BASE_PLANS: readonly PlanInsert[] = [DEFAULT_PLAN, SALON_PLAN];

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
