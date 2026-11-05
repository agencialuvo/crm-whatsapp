import { parseBody, withAuth } from "@/lib/api";
import { birthdayCampaignInputSchema } from "@/lib/loyalty";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { getBirthdayCampaign, updateBirthdayCampaign } from "@/server/loyalty/actions";

export const dynamic = "force-dynamic";

/** Marketing — la campaña de cumpleaños (encendida, porcentaje y servicios). Cualquiera del equipo la lee. */
export const GET = withAuth(async (session) => {
  const denied = salonGate(session, "member");
  if (denied) return denied;
  try {
    return Response.json(await getBirthdayCampaign(session.organizationId));
  } catch (err) {
    return salonErrorResponse(err);
  }
});

/** Cambiar a quién se le rebaja es del dueño o administrador (es dinero del negocio). */
export const PUT = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const body = await parseBody(req, birthdayCampaignInputSchema);
  if (!body.ok) return body.response;
  try {
    return Response.json(await updateBirthdayCampaign(session.organizationId, body.data));
  } catch (err) {
    return salonErrorResponse(err);
  }
});
