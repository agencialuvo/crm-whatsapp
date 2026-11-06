import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { PLAN_MODULES, PLAN_MODULE_LABEL, type PlanModule } from "@/lib/plan-modules";

/**
 * Candado de módulos por plan de suscripción (SaaS). Es la fuente de verdad del SERVIDOR:
 * el menú solo pinta el candado; lo que cierra el acceso es esto, en cada route handler
 * (`moduleGate`) y en cada página (`requirePlanModule`, en `page-guard.ts`).
 *
 * Reglas:
 * - El plan solo RESTRINGE. Las banderas de despliegue (`SALON`, `AGENDA`…) y el rol siguen
 *   decidiendo si la superficie existe (404) o si la persona puede (403 `forbidden`); esto
 *   va después y responde 403 `UPGRADE_REQUIRED`.
 * - Una organización SIN suscripción (creada antes del módulo SaaS) no está restringida:
 *   darle el plan Básico le quitaría de golpe lo que ya usa.
 * - Se aceptan varios módulos («cualquiera de»): una pantalla compartida (p. ej. las opciones
 *   de cobro, que usan Caja y Citas) abre con cualquiera de los módulos que la necesitan.
 */

export type PlanAccess = {
  planName: string;
  /** Sin suscripción: nada se restringe. */
  unrestricted: boolean;
  modules: readonly PlanModule[];
};

/** Una sola consulta (suscripción + plan) por petición. */
export async function getPlanAccess(organizationId: string): Promise<PlanAccess> {
  const [row] = await getDb()
    .select({ name: schema.plan.name, features: schema.plan.features })
    .from(schema.subscription)
    .innerJoin(schema.plan, eq(schema.subscription.planId, schema.plan.id))
    .where(scoped(schema.subscription.organizationId, organizationId))
    .limit(1);
  if (!row) return { planName: "Sin plan", unrestricted: true, modules: PLAN_MODULES };
  return { planName: row.name, unrestricted: false, modules: row.features.modules };
}

export class UpgradeRequiredError extends Error {
  readonly code = "UPGRADE_REQUIRED";
  constructor(
    readonly modules: readonly PlanModule[],
    readonly planName: string
  ) {
    super(
      `UPGRADE_REQUIRED: «${modules.map((m) => PLAN_MODULE_LABEL[m]).join(" / ")}» no está incluido en tu plan actual (${planName}).`
    );
    this.name = "UpgradeRequiredError";
  }
}

function asList(m: PlanModule | readonly PlanModule[]): readonly PlanModule[] {
  return typeof m === "string" ? [m] : m;
}

/** Lanza `UpgradeRequiredError` si el plan no incluye NINGUNO de los módulos. Devuelve el acceso. */
export async function enforceModuleAccess(
  organizationId: string,
  moduleName: PlanModule | readonly PlanModule[]
): Promise<PlanAccess> {
  const needed = asList(moduleName);
  const access = await getPlanAccess(organizationId);
  if (!access.unrestricted && !needed.some((m) => access.modules.includes(m))) {
    throw new UpgradeRequiredError(needed, access.planName);
  }
  return access;
}

/** El 403 del contrato: `{ error: { code: "UPGRADE_REQUIRED", message, modules } }`. */
export function upgradeRequiredResponse(err: UpgradeRequiredError): Response {
  return Response.json(
    { error: { code: err.code, message: err.message, modules: err.modules, plan: err.planName } },
    { status: 403 }
  );
}

/**
 * Guardia para route handlers, en el mismo estilo que `salonGate`: devuelve la `Response`
 * que corta la petición, o `null` si puede seguir.
 *
 *   const blocked = await moduleGate(session.organizationId, "finances");
 *   if (blocked) return blocked;
 */
export async function moduleGate(
  organizationId: string,
  moduleName: PlanModule | readonly PlanModule[]
): Promise<Response | null> {
  try {
    await enforceModuleAccess(organizationId, moduleName);
    return null;
  } catch (err) {
    if (err instanceof UpgradeRequiredError) return upgradeRequiredResponse(err);
    throw err;
  }
}
