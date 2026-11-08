import { withAuth } from "@/lib/api";
import { automationGate } from "@/server/automation/http";
import { getStats } from "@/server/automation/monitor";

export const dynamic = "force-dynamic";

/** Estado del motor de TODA la organización: cola por estado y resultados. Dueño/administrador; apagado → 404. */
export const GET = withAuth(async (session) => {
  const denied = automationGate(session);
  if (denied) return denied;
  return Response.json({ stats: await getStats(session.organizationId, null) });
});
