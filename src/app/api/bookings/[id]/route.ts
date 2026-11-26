import { z } from "zod";
import { parseBody, withAuth } from "@/lib/api";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import {
  cancelBooking,
  confirmBooking,
  markBookingStatus,
  rescheduleBooking,
  retryMeetingLink,
} from "@/server/agenda/service";
import { requestCalendarSync } from "@/server/agenda/calendar-sync/sync";
import { bookingErrorResponse } from "@/server/agenda/http";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reschedule"), startUtc: z.string().min(1) }),
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("confirm") }),
  z.object({
    action: z.literal("status"),
    status: z.enum(["realizada", "no_show"]),
  }),
  z.object({ action: z.literal("retry_link") }),
  // Paso 3: volver a publicar la cita en Google Calendar (tras agotar reintentos o reconectar).
  z.object({ action: z.literal("retry_calendar_sync") }),
]);

/**
 * 015 — Reprogramar, cancelar (idempotente), marcar el resultado o reintentar
 * el enlace que el proveedor no entregó.
 */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const planBlocked = await moduleGate(session.organizationId, "agenda");
  if (planBlocked) return planBlocked;
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  try {
    switch (body.data.action) {
      case "reschedule": {
        const result = await rescheduleBooking({
          organizationId: session.organizationId,
          bookingId: id,
          startUtc: body.data.startUtc,
        });
        return Response.json({ ok: true, label: result.label });
      }
      case "cancel": {
        await cancelBooking({
          organizationId: session.organizationId,
          bookingId: id,
        });
        return Response.json({ ok: true });
      }
      case "confirm": {
        const result = await confirmBooking({
          organizationId: session.organizationId,
          bookingId: id,
        });
        return Response.json({ ok: true, alreadyConfirmed: result.alreadyConfirmed });
      }
      case "status": {
        await markBookingStatus({
          organizationId: session.organizationId,
          bookingId: id,
          status: body.data.status,
        });
        return Response.json({ ok: true });
      }
      case "retry_calendar_sync": {
        // Sin la sincronización encendida no hace nada; una cita ajena o de prueba no se marca.
        await requestCalendarSync(session.organizationId, id);
        return Response.json({ ok: true });
      }
      case "retry_link": {
        const result = await retryMeetingLink({
          organizationId: session.organizationId,
          bookingId: id,
        });
        return Response.json({
          ok: true,
          meetingLink: result.meetingLink,
          linkPending: result.linkPending,
        });
      }
    }
  } catch (err) {
    return bookingErrorResponse(err);
  }
});
