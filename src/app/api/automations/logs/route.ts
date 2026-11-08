import { withAuth } from "@/lib/api";
import { automationGate, parseLogsQuery } from "@/server/automation/http";
import { listLogs } from "@/server/automation/monitor";

export const dynamic = "force-dynamic";

/** Historial de ejecuciones de TODA la organización, lo más reciente primero. `?status=success|failed|skipped…&limit=&offset=`. */
export const GET = withAuth(async (session, req: Request) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const query = parseLogsQuery(req);
  if (!query.ok) return query.response;
  return Response.json(await listLogs(session.organizationId, null, query.data));
});
