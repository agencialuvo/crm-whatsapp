import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { MAX_BUSY_CALENDARS } from "@/lib/google-calendar";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { getCalendarChoices, saveCalendarChoices } from "@/server/agenda/google-calendars";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

/**
 * Mejora 2 — Los calendarios de la cuenta de Google conectada: en cuál se publican las citas y cuáles se leen
 * como ocupado. Solo dueño o administrador (es configuración del negocio).
 *
 *  - GET: la lista de la cuenta (en el momento) y lo elegido; o por qué no se puede elegir (`reason`).
 *  - PUT `{ publishCalendarId, busyCalendarIds }`: valida contra la lista fresca, guarda, mueve las citas que
 *    vienen si cambió el calendario de publicación y relee lo ocupado si cambió lo que se lee.
 */

const forbidden = () => apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");

export const GET = withAuth(async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const planBlocked = await moduleGate(session.organizationId, "agenda");
  if (planBlocked) return planBlocked;
  if (!canConfigure(session.role)) return forbidden();
  const choices = await getCalendarChoices(session.organizationId);
  if (!choices) return apiError(409, "not_connected", "Google Calendar no está conectado.");
  return Response.json(choices);
});

const putSchema = z.object({
  publishCalendarId: z.string().trim().min(1).max(300),
  busyCalendarIds: z.array(z.string().trim().min(1).max(300)).min(1).max(MAX_BUSY_CALENDARS),
});

export const PUT = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const planBlocked = await moduleGate(session.organizationId, "agenda");
  if (planBlocked) return planBlocked;
  if (!canConfigure(session.role)) return forbidden();
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;
  const result = await saveCalendarChoices(session.organizationId, body.data);
  if (!result.ok) return apiError(result.status, result.code, result.message);
  return Response.json({ ...result.choices, moved: result.moved, publishChanged: result.publishChanged });
});
