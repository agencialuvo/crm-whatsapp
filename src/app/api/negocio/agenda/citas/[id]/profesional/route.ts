import { parseBody, withAuth } from "@/lib/api";
import { assignStaffSchema } from "@/lib/salon/schemas";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { assignBookingStaff } from "@/server/business/board";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Asigna (o quita con `{ "staffId": null }`) el profesional de una cita. 409
 * `staff_busy` si esa persona ya tiene otra a la misma hora.
 */
export const PUT = withAuth(async (session, req: Request, ctx: Params) => {
  const denied = salonGate(session, "member");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "agenda");
  if (planBlocked) return planBlocked;
  if (!agendaEnabled()) return agendaDisabledResponse();
  const { id } = await ctx.params;
  const body = await parseBody(req, assignStaffSchema);
  if (!body.ok) return body.response;
  try {
    await assignBookingStaff(session.organizationId, id, body.data.staffId);
    return Response.json({ ok: true });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
