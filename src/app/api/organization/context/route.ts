import { apiError, withAuth } from "@/lib/api";
import { getOrganizationContext } from "@/server/business/organization-context";

export const dynamic = "force-dynamic";

/**
 * Contexto SaaS de la organización activa (plan, módulos, canales y etiquetas del
 * sector). Lo consume `useOrganizationContext()`, p. ej. la barra lateral para
 * marcar los módulos que el plan no incluye. Cualquier rol puede leerlo: no lleva
 * montos ni secretos.
 */
export const GET = withAuth(async (session) => {
  const context = await getOrganizationContext(session.organizationId);
  if (!context) return apiError(404, "not_found", "Organización no encontrada");
  return Response.json({ success: true, data: context });
});
