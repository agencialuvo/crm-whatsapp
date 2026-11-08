import { withAuth } from "@/lib/api";
import { automationErrorResponse, automationGate } from "@/server/automation/http";
import { getStats } from "@/server/automation/monitor";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Estado del motor para UN flujo. Un flujo de otra organización o inexistente → 404. */
export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    return Response.json({ stats: await getStats(session.organizationId, id) });
  } catch (err) {
    return automationErrorResponse(err);
  }
});
