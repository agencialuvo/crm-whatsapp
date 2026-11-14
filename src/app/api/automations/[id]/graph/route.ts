import { withAuth } from "@/lib/api";
import { getFlow } from "@/server/automation/flows";
import { getGraph } from "@/server/automation/graph";
import { automationErrorResponse, automationGate } from "@/server/automation/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * El grafo del flujo: nodos (los pasos, con su posición), aristas (`source` → `target` por un asa) y el paso de
 * entrada. Es la fuente de verdad que consumirá el lienzo visual; el Modo Simple la mantiene al día.
 */
export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const { flow } = await getFlow(session.organizationId, id); // 404 si no es de esta organización
    return Response.json({ flow, ...(await getGraph(session.organizationId, id)) });
  } catch (err) {
    return automationErrorResponse(err);
  }
});
