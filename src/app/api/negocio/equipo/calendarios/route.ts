import { withAuth } from "@/lib/api";
import { salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";
import { staffCalendarsEnabled } from "@/server/agenda/staff-calendar/flag";
import { listStaffCalendarStatus } from "@/server/agenda/staff-calendar/connection";
import { getWatchStatuses } from "@/server/agenda/calendar-watch/reconcile";

export const dynamic = "force-dynamic";

/**
 * Mejora 3 — El Google Calendar de cada profesional activo (conectado, enlace pendiente o nada) para la
 * pantalla Equipo. Solo dueño o administrador. Con `GOOGLE_STAFF_CALENDARS` apagada responde
 * `{ available: false }` y la pantalla no muestra nada.
 */
export const GET = withAuth(async (session) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  if (!staffCalendarsEnabled()) return Response.json({ available: false, staff: [] });
  const staff = await listStaffCalendarStatus(session.organizationId);
  // Mejora 4: cómo llegan los cambios de cada calendario conectado.
  const watch = (await getWatchStatuses(session.organizationId).catch(() => null))?.staff ?? new Map();
  return Response.json({
    available: true,
    staff: staff.map((s) => ({ ...s, watch: watch.get(s.staffId) ?? { status: "off" } })),
  });
});
