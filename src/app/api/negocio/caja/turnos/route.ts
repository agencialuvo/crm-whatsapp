import { apiError, withAuth } from "@/lib/api";
import { historyQuerySchema, type ShiftHistoryDto } from "@/lib/salon/cash-shifts";
import { periodFromRequest } from "@/server/analytics/period";
import { listShifts } from "@/server/business/cash-shifts";
import { salonErrorResponse, salonGate } from "@/server/business/http";

export const dynamic = "force-dynamic";

/**
 * Caja — historial de turnos CERRADOS. `?from=AAAA-MM-DD&to=AAAA-MM-DD` (días del negocio,
 * inclusivos, por fecha de cierre; sin ellos, los últimos 30) y paginación con
 * `?limit=` (1–200) y `?offset=`. Es dinero: solo dueño o administrador.
 */
export const GET = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const url = new URL(req.url);
  const query = historyQuerySchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined,
  });
  if (!query.success) {
    return apiError(422, "invalid_query", query.error.issues[0]?.message ?? "Paginación no válida");
  }
  try {
    const period = await periodFromRequest(session.organizationId, url);
    const { shifts, total } = await listShifts(session.organizationId, { period, ...query.data });
    const body: ShiftHistoryDto = { shifts, total, period: period.dto };
    return Response.json(body);
  } catch (err) {
    return salonErrorResponse(err);
  }
});
