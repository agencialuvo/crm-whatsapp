import { withAuth } from "@/lib/api";
import { automationErrorResponse, automationGate, parseLogsQuery } from "@/server/automation/http";
import { listLogs } from "@/server/automation/monitor";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Historial de ejecuciones de UN flujo, lo más reciente primero. `?status=success|failed|skipped…&limit=&offset=`. */
export const GET = withAuth(async (session, req: Request, ctx: Params) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const query = parseLogsQuery(req);
  if (!query.ok) return query.response;
  const { id } = await ctx.params;
  try {
    return Response.json(await listLogs(session.organizationId, id, query.data));
  } catch (err) {
    return automationErrorResponse(err);
  }
});
