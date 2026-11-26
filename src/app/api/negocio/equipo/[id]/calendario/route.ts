import { apiError, withAuth } from "@/lib/api";
import { salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";
import { staffCalendarsDisabledResponse, staffCalendarsEnabled } from "@/server/agenda/staff-calendar/flag";
import { disconnectStaffCalendar } from "@/server/agenda/staff-calendar/connection";
import { syncStaffBusy } from "@/server/agenda/staff-calendar/busy";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Mejora 3 — El Google Calendar de UN profesional. Solo dueño o administrador.
 *  - POST: «Leer ahora» (no espera al barrido de 5 min). Si Google falla responde 200 con el estado: la agenda
 *    sigue con lo último leído.
 *  - DELETE: desconectar (revoca el permiso en Google, borra la conexión y SUS bloqueos, anula sus enlaces).
 */
export const POST = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  if (!staffCalendarsEnabled()) return staffCalendarsDisabledResponse();
  const { id } = await ctx.params;
  const result = await syncStaffBusy(session.organizationId, id);
  if (result.outcome === "not_connected" || result.outcome === "disabled") {
    return apiError(409, "not_connected", "Ese profesional no tiene su Google Calendar conectado.");
  }
  return Response.json({ result });
});

export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  if (!staffCalendarsEnabled()) return staffCalendarsDisabledResponse();
  const { id } = await ctx.params;
  const out = await disconnectStaffCalendar(session.organizationId, id, { revoke: true });
  return Response.json({ ok: true, ...out });
});
