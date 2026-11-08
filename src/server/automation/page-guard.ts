import { notFound, redirect } from "next/navigation";
import { canConfigure } from "@/lib/auth/roles";
import { getSessionOrNull, type SessionContext } from "@/lib/auth/session";
import { automationsEnabled } from "@/server/automation/flag";

/**
 * Automatizaciones — la puerta de sus pantallas (mismo criterio que la API y que el módulo SALON).
 *
 * - Sin la bandera `AUTOMATIONS` la pantalla no existe en la instancia: 404.
 * - Sin sesión: al inicio de sesión.
 * - Configurar mensajes automáticos a clientes es del dueño o administrador: un miembro del equipo que
 *   llega por un enlace recibe 404 (no se le enseña que existe), igual que en el menú.
 */
export async function requireAutomationsPage(): Promise<SessionContext> {
  if (!automationsEnabled()) notFound();
  const session = await getSessionOrNull();
  if (!session) redirect("/iniciar-sesion");
  if (!canConfigure(session.role)) notFound();
  return session;
}
