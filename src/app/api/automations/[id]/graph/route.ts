import { parseBody, withAuth } from "@/lib/api";
import { graphPayloadSchema } from "@/lib/automation-graph";
import { saveGraph } from "@/server/automation/canvas";
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

/**
 * Guarda el grafo dibujado (nodos, aristas, disparador y cámara) en UNA transacción, con control de concurrencia
 * optimista (`expectedUpdatedAt`). 422 `invalid_graph` si la topología no es válida; 409 `stale_graph` si otra
 * persona guardó antes. Devuelve el grafo guardado (con los ids de los nodos nuevos ya reales) y los avisos.
 */
export const PUT = withAuth(async (session, req: Request, ctx: Params) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await parseBody(req, graphPayloadSchema);
  if (!body.ok) return body.response;
  try {
    return Response.json(await saveGraph(session.organizationId, id, body.data));
  } catch (err) {
    return automationErrorResponse(err);
  }
});
