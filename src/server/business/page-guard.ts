import { notFound, redirect } from "next/navigation";
import { canConfigure } from "@/lib/auth/roles";
import { getSessionOrNull, type SessionContext } from "@/lib/auth/session";
import { agendaEnabled } from "@/server/agenda/flag";
import { salonEnabled } from "@/server/business/flag";
import { getPlanAccess } from "@/server/business/saas-guard";
import type { PlanModule } from "@/lib/plan-modules";

/**
 * Módulo SALON — la puerta de cada pantalla (Servicios, Equipo, Caja y Agenda
 * por sillas son páginas propias del menú, sin un layout «Negocio» que las
 * guarde a todas).
 *
 * - Sin la bandera `SALON` la pantalla no existe en la instancia: 404.
 * - Sin sesión: al inicio de sesión.
 * - `manage`: dueño o administrador. Un miembro del equipo que llega por un
 *   enlace va a Citas (donde está la agenda por sillas) si hay agenda; si no, 404.
 * - `needsAgenda`: la pantalla es una vista del motor de citas (`AGENDA`).
 * - `module`: el plan de suscripción debe incluirlo (ver `requirePlanModule`).
 */
export async function requireSalonPage(
  opts: { manage?: boolean; needsAgenda?: boolean; module?: PlanModule | readonly PlanModule[] } = {}
): Promise<SessionContext> {
  if (!salonEnabled()) notFound();
  if (opts.needsAgenda && !agendaEnabled()) notFound();
  const session = await getSessionOrNull();
  if (!session) redirect("/iniciar-sesion");
  if (opts.manage && !canConfigure(session.role)) {
    if (agendaEnabled()) redirect("/citas");
    notFound();
  }
  if (opts.module) await requirePlanModule(session, opts.module);
  return session;
}

/**
 * Candado por plan para una PÁGINA (Server Component). Va después de la bandeja de
 * despliegue y del rol: esas deciden si la pantalla existe (404) o si la persona puede (rol);
 * esta decide si su plan la incluye. Si no, redirige a `/plan-requerido` con el módulo en
 * la URL — la misma invitación a mejorar el plan del menú, en vez de renderizar la pantalla
 * (y sin llegar a consultar sus datos). Sin suscripción no se restringe nada.
 */
export async function requirePlanModule(
  session: SessionContext,
  moduleName: PlanModule | readonly PlanModule[]
): Promise<void> {
  const needed = typeof moduleName === "string" ? [moduleName] : moduleName;
  const access = await getPlanAccess(session.organizationId);
  if (access.unrestricted || needed.some((m) => access.modules.includes(m))) return;
  redirect(`/plan-requerido?modulo=${encodeURIComponent(needed[0] ?? "")}`);
}
