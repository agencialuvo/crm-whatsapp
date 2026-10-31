import { withAuth } from "@/lib/api";
import { salonGate } from "@/server/business/http";
import { getSaleOptions } from "@/server/business/sales-service";

export const dynamic = "force-dynamic";

/**
 * Lo que necesita el formulario de cobro: servicios, ofertas y profesionales
 * ACTIVOS, sin comisiones. Todo el equipo puede leerlo.
 */
export const GET = withAuth(async (session) => {
  const denied = salonGate(session, "member");
  if (denied) return denied;
  return Response.json(await getSaleOptions(session.organizationId));
});
