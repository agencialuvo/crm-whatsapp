import { withAuth } from "@/lib/api";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { getOpenShift } from "@/server/business/cash-shifts";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

/** Caja — el turno abierto de la organización con sus totales de ahora, o `{ shift: null }`. */
export const GET = withAuth(async (session) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "finances");
  if (planBlocked) return planBlocked;
  try {
    return Response.json({ shift: await getOpenShift(session.organizationId) });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
