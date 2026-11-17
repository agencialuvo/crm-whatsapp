import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { newId } from "@/lib/db/ids";
import { construirEventoOlvido } from "@/server/brains/contract";
import { avisarOlvido, type ResultadoOlvido } from "@/server/brains/deliver";
import { publish } from "@/server/events/bus";
import { eliminarConversacion } from "@/server/inbox/eliminar";
import { getConversationDto, markConversationRead, updateConversation } from "@/server/inbox/queries";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  aiEnabled: z.boolean().optional(),
  reactivate: z.boolean().optional(),
  markRead: z.boolean().optional(),
});

type Params = { params: Promise<{ id: string }> };

/** 042 — Una conversación completa (con su preview y etapa): el enlace directo y la apertura de una que aún no se cargó. */
export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const conversation = await getConversationDto(session.organizationId, id);
  if (!conversation) return apiError(404, "not_found", "Conversación no encontrada");
  return Response.json({ conversation });
});

export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  // 042 — Marcar leído, a solas, es lo que se manda al abrir una conversación: no escribe si no había nada
  // por leer y, cuando sí, avisa con un evento ligero en vez de mandar a todo el equipo a recargar la lista.
  const soloLeer =
    body.data.markRead === true && body.data.aiEnabled === undefined && !body.data.reactivate;
  if (soloLeer) {
    const result = await markConversationRead(session.organizationId, id);
    if (!result.found) return apiError(404, "not_found", "Conversación no encontrada");
    if (result.changed) {
      publish(session.organizationId, {
        type: "conversation.read",
        data: { conversationId: id, unreadCount: 0 },
      });
    }
    return Response.json({ conversation: await getConversationDto(session.organizationId, id) });
  }

  const updated = await updateConversation(session.organizationId, id, body.data);
  if (!updated) return apiError(404, "not_found", "Conversación no encontrada");

  const dto = await getConversationDto(session.organizationId, id);
  if (dto) {
    publish(session.organizationId, {
      type: "conversation.updated",
      data: { conversation: dto },
    });
  }
  return Response.json({ conversation: dto });
});

const FECHA_DE_CITA = new Intl.DateTimeFormat("es-MX", { dateStyle: "long" });

/**
 * 026 — Elimina la conversación y le pide al cerebro que la olvide.
 *
 * `?contacto=1` se lleva además a la persona: contacto, lead y citas pasadas.
 * Es irreversible en los dos casos, y por eso exige rol de configuración
 * (propietario o administrador) y no solo operar la bandeja.
 */
export const DELETE = withAuth(async (session, req: Request, ctx: Params) => {
  if (!canConfigure(session.role)) {
    return apiError(
      403,
      "forbidden",
      "Solo quien administra el negocio puede eliminar conversaciones"
    );
  }
  const { id } = await ctx.params;
  const alcance =
    new URL(req.url).searchParams.get("contacto") === "1" ? "contacto" : "hilo";

  const resultado = await eliminarConversacion(session.organizationId, id, alcance);
  if (!resultado.ok) {
    if (resultado.motivo === "cita_pendiente") {
      return apiError(
        409,
        "cita_pendiente",
        `Tiene una cita agendada para el ${FECHA_DE_CITA.format(resultado.cuando)}. Cancélala en Citas antes de eliminar.`
      );
    }
    return apiError(404, "not_found", "Conversación no encontrada");
  }

  // Irreversible y sin papelera: que al menos quede quién y cuándo. Solo ids.
  console.info(
    `[bandeja] ${session.userId} eliminó ${id} (${alcance}) en ${session.organizationId}`
  );

  // El aviso va DESPUÉS del borrado y no lo condiciona: lo que se pidió ya
  // pasó, y un cerebro caído no puede dejar la conversación en la bandeja.
  let agente: ResultadoOlvido = "no_aplica";
  const deletedAt = new Date();
  for (const conversacion of resultado.conversaciones) {
    const aviso = await avisarOlvido(
      construirEventoOlvido({
        eventId: newId("olvido"),
        organization: resultado.organization,
        conversation: conversacion,
        contact: resultado.contact,
        deletedAt,
      })
    );
    if (aviso === "sin_confirmar" || agente === "no_aplica") agente = aviso;
  }

  for (const conversacion of resultado.conversaciones) {
    publish(session.organizationId, {
      type: "conversation.deleted",
      data: {
        conversationId: conversacion.id,
        contactId: resultado.contact.id,
        contactDeleted: alcance === "contacto",
      },
    });
  }
  return Response.json({ ok: true, alcance, agente });
});
