import { withAuth } from "@/lib/api";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (session) => {
  // GUARD: el plan del inquilino debe incluir finanzas/caja → 403 UPGRADE_REQUIRED.
  const planBlocked = await moduleGate(session.organizationId, "finances");
  if (planBlocked) return planBlocked;

  // Lógica normal de la API...
  return Response.json({ success: true, data: [] });
});
