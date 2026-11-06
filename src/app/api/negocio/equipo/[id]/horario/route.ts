import { parseBody, withAuth } from "@/lib/api";
import { scheduleInputSchema } from "@/lib/salon/schemas";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { setSchedule } from "@/server/business/staff";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Reemplaza el horario semanal del profesional (días libres incluidos). */
export const PUT = withAuth(async (session, req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  const { id } = await ctx.params;
  const body = await parseBody(req, scheduleInputSchema);
  if (!body.ok) return body.response;
  try {
    const staff = await setSchedule(session.organizationId, id, body.data);
    return Response.json({ staff });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
