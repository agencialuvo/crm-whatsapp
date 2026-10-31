import { apiError, withAuth } from "@/lib/api";
import { parseItemFilter } from "@/lib/salon/funnel";
import { todayInTz } from "@/lib/time/slots";
import { periodFromRequest } from "@/server/analytics/period";
import { getDashboard } from "@/server/business/dashboard";
import { salonErrorResponse, salonGate } from "@/server/business/http";

export const dynamic = "force-dynamic";

/**
 * Módulo SALON — el panel ejecutivo del negocio. `?from=AAAA-MM-DD&to=AAAA-MM-DD`
 * (días del negocio, inclusivos; sin ellos, los últimos 30), `?staffId=` y `?item=`. Muestra dinero y
 * datos de clientes: solo dueño/administrador.
 */
export const GET = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  try {
    const period = await periodFromRequest(session.organizationId, new URL(req.url));
    const today = todayInTz(new Date(), period.timezone);
    const params = new URL(req.url).searchParams;
    // `?staffId=` acota el panel a un profesional (auditoría rápida).
    const staffId = params.get("staffId")?.slice(0, 64) || null;
    // `?item=service|combo|service:<id>|combo:<id>` acota tarjetas y gráfica a un servicio o combo.
    const rawItem = params.get("item");
    const item = parseItemFilter(rawItem);
    if (rawItem && !item) return apiError(422, "invalid_item", "Filtro de servicio no válido");
    return Response.json(await getDashboard(session.organizationId, period, today, { staffId, item }));
  } catch (err) {
    return salonErrorResponse(err);
  }
});
