import { apiError, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { getBusyState, syncGoogleBusy } from "@/server/agenda/calendar-busy/sync";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

/**
 * Paso 4 — «Leer ahora»: lee lo ocupado en Google Calendar en el momento (sin esperar al barrido de 5 min)
 * y devuelve el estado. Si Google falla, responde 200 con el estado de error: la agenda sigue con lo último
 * que se leyó y eso es lo que hay que mostrar, no un fallo de la pantalla.
 */
export const POST = withAuth(async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const planBlocked = await moduleGate(session.organizationId, "agenda");
  if (planBlocked) return planBlocked;
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const result = await syncGoogleBusy(session.organizationId);
  if (result.outcome === "disabled") {
    return apiError(409, "busy_disabled", "Primero enciende «Tener en cuenta lo ocupado en Google Calendar».");
  }
  if (result.outcome === "not_connected" && !result.error) {
    return apiError(409, "not_connected", "Google Calendar no está conectado.");
  }
  return Response.json({ result, busy: await getBusyState(session.organizationId) });
});
