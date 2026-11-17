import { z } from "zod";
import { apiError, withAuth } from "@/lib/api";
import { CHANNEL_ORDER, type Channel } from "@/lib/channels";
import { decodeListCursor } from "@/lib/inbox-cursor";
import {
  getConversationByContact,
  listConversationsDelta,
  listConversationsPage,
  PAGE_DEFAULT,
  PAGE_MAX,
} from "@/server/inbox/queries";

export const dynamic = "force-dynamic";

/**
 * 042 — La lista de la bandeja.
 *
 * - Sin `since`: una PÁGINA (`limit`, por omisión 40) por cursor, con los filtros del servidor
 *   (`q`, `stage`, `channel`, `filter`). La primera página trae además `counts` y `stages`.
 * - Con `since`: un DELTA — lo que cambió desde ese instante, sin filtros (≤ 200; `truncated` si hubo más).
 * - Con `contactId`: la conversación de ese contacto, sin paginar (enlace directo).
 */
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  cursor: z.string().min(1).max(400).optional(),
  q: z.string().trim().max(120).optional(),
  stage: z.string().trim().max(120).optional(),
  channel: z.enum(CHANNEL_ORDER as unknown as [string, ...string[]]).optional(),
  filter: z.enum(["all", "unread", "anuncios"]).default("all"),
  since: z.string().min(1).max(40).optional(),
  contactId: z.string().min(1).max(64).optional(),
});

export const GET = withAuth(async (session, req: Request) => {
  const url = new URL(req.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return apiError(
      422,
      "invalid_query",
      parsed.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ")
    );
  }
  const p = parsed.data;
  const filters = {
    q: p.q || undefined,
    stage: p.stage || undefined,
    channel: p.channel as Channel | undefined,
    filter: p.filter,
  };

  if (p.contactId) {
    const conversation = await getConversationByContact(session.organizationId, p.contactId);
    return Response.json({
      conversations: conversation ? [conversation] : [],
      nextCursor: null,
      serverTime: new Date().toISOString(),
    });
  }

  if (p.since) {
    const since = new Date(p.since);
    if (Number.isNaN(since.getTime())) return apiError(422, "invalid_query", "since: fecha inválida");
    return Response.json(await listConversationsDelta(session.organizationId, since, filters));
  }

  let cursor = null;
  if (p.cursor) {
    cursor = decodeListCursor(p.cursor);
    if (!cursor) return apiError(422, "invalid_cursor", "El cursor no es válido");
  }
  return Response.json(
    await listConversationsPage(session.organizationId, { limit: p.limit, cursor, filters })
  );
});
