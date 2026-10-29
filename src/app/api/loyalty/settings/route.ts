import { parseBody, withAuth } from "@/lib/api";
import { loyaltySettingsInputSchema } from "@/lib/loyalty";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { getLoyaltySettings, updateLoyaltySettings } from "@/server/loyalty/actions";

export const dynamic = "force-dynamic";

/** Fidelización — la configuración del programa (sellos requeridos, premio, color). Cualquiera del equipo. */
export const GET = withAuth(async (session) => {
  const denied = salonGate(session, "member");
  if (denied) return denied;
  try {
    return Response.json(await getLoyaltySettings(session.organizationId));
  } catch (err) {
    return salonErrorResponse(err);
  }
});

/** Cambiar las reglas del programa es del dueño o administrador (cambia cuándo se gana un premio). */
export const PUT = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const body = await parseBody(req, loyaltySettingsInputSchema);
  if (!body.ok) return body.response;
  try {
    return Response.json(await updateLoyaltySettings(session.organizationId, body.data));
  } catch (err) {
    return salonErrorResponse(err);
  }
});
