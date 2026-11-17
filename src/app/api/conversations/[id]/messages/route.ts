import {
  MAX_TEXT_CHARS_ANY_CHANNEL,
  TEXT_TOO_LONG_ANY_CHANNEL,
} from "@/server/channels/capabilities";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { decodeThreadCursor } from "@/lib/inbox-cursor";
import {
  getConversation,
  listMessages,
  listMessagesPage,
  PAGE_MAX,
  THREAD_PAGE_DEFAULT,
} from "@/server/inbox/queries";
import { serializeMessage } from "@/server/inbox/ingest";
import { SEND_ERROR_STATUS } from "@/server/inbox/send-status";
import { SendError, sendStructured, sendText } from "@/server/inbox/send";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 042 — El hilo, por páginas hacia arriba: los `limit` (50) más recientes, o los anteriores a `before`, en orden
 * ascendente por hora del evento. Con `since`, los mensajes registrados después (para quien lo necesite).
 */
export const GET = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const row = await getConversation(session.organizationId, id);
  if (!row) return apiError(404, "not_found", "Conversación no encontrada");

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");
  if (sinceParam) {
    const since = new Date(sinceParam);
    if (Number.isNaN(since.getTime())) return apiError(422, "invalid_query", "since: fecha inválida");
    const messages = await listMessages(session.organizationId, id, since);
    return Response.json({
      messages: messages.map((r) => serializeMessage(r.message, r.media)),
      hasMore: false,
      nextBefore: null,
      serverTime: new Date().toISOString(),
    });
  }

  const limitParam = Number(url.searchParams.get("limit") ?? THREAD_PAGE_DEFAULT);
  const limit = Number.isInteger(limitParam) && limitParam >= 1 ? Math.min(limitParam, PAGE_MAX) : THREAD_PAGE_DEFAULT;
  const beforeParam = url.searchParams.get("before");
  let before = null;
  if (beforeParam) {
    before = decodeThreadCursor(beforeParam);
    if (!before) return apiError(422, "invalid_cursor", "El cursor no es válido");
  }
  return Response.json(await listMessagesPage(session.organizationId, id, { limit, before }));
});

// 008: además de texto, el body acepta ubicación y contactos (discriminado
// por `type`; sin `type` sigue siendo texto — compat con clientes previos).
const sendSchema = z.union([
  z.object({
    type: z.literal("text").optional(),
    // 022: el tope de aquí es el del canal que más admite; el de cada
    // canal lo comprueba el envío (`text_too_long`).
    text: z.string().trim().min(1).max(MAX_TEXT_CHARS_ANY_CHANNEL, TEXT_TOO_LONG_ANY_CHANNEL),
  }),
  z.object({
    type: z.literal("location"),
    location: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      name: z.string().trim().max(1000).optional(),
      address: z.string().trim().max(1000).optional(),
    }),
  }),
  z.object({
    type: z.literal("contacts"),
    contacts: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(200),
          phone: z.string().trim().min(5).max(30),
        })
      )
      .min(1)
      .max(5),
  }),
]);

export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, sendSchema);
  if (!body.ok) return body.response;

  try {
    const data = body.data;
    const result =
      "text" in data
        ? await sendText({
            conversationId: id,
            organizationId: session.organizationId,
            text: data.text,
          })
        : data.type === "location"
          ? await sendStructured({
              conversationId: id,
              organizationId: session.organizationId,
              kind: "location",
              location: data.location,
            })
          : await sendStructured({
              conversationId: id,
              organizationId: session.organizationId,
              kind: "contacts",
              contacts: data.contacts,
            });
    return Response.json({ messageId: result.messageId });
  } catch (err) {
    if (err instanceof SendError) {
      return apiError(SEND_ERROR_STATUS[err.code], err.code, err.message);
    }
    throw err;
  }
});
