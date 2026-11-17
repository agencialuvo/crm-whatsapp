import { z } from "zod";
import { apiError, withAuth } from "@/lib/api";
import { CHANNEL_ORDER, type Channel } from "@/lib/channels";
import { decodeColumnCursor } from "@/lib/pipeline-cursor";
import { COLUMN_PAGE_DEFAULT, COLUMN_PAGE_MAX, listColumnPage } from "@/server/leads/board";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(COLUMN_PAGE_MAX).default(COLUMN_PAGE_DEFAULT),
  cursor: z.string().min(1).max(200).optional(),
  q: z.string().trim().max(120).optional(),
  priority: z.enum(["alta", "media", "baja", "sin"]).optional(),
  tag: z.string().trim().min(1).max(64).optional(),
  channel: z.enum(CHANNEL_ORDER as unknown as [string, ...string[]]).optional(),
});

/** 044 — La siguiente página de UNA columna (cursor sobre `(position, id)`), con los mismos filtros del tablero. */
export const GET = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return apiError(
      422,
      "invalid_query",
      parsed.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ")
    );
  }
  const p = parsed.data;
  let cursor = null;
  if (p.cursor) {
    cursor = decodeColumnCursor(p.cursor);
    if (!cursor) return apiError(422, "invalid_cursor", "El cursor no es válido");
  }
  const page = await listColumnPage(session.organizationId, id, {
    limit: p.limit,
    cursor,
    filters: { q: p.q || undefined, priority: p.priority, tag: p.tag, channel: p.channel as Channel | undefined },
  });
  return Response.json({ serverTime: new Date().toISOString(), ...page });
});
