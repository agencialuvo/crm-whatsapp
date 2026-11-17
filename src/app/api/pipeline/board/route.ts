import { z } from "zod";
import { apiError, withAuth } from "@/lib/api";
import { CHANNEL_ORDER, type Channel } from "@/lib/channels";
import { getBranding } from "@/server/branding";
import { boardDelta, boardSnapshot, COLUMN_PAGE_DEFAULT, COLUMN_PAGE_MAX } from "@/server/leads/board";

export const dynamic = "force-dynamic";

const boardQuerySchema = z.object({
  /** Tarjetas por columna en la primera carga. */
  limit: z.coerce.number().int().min(1).max(COLUMN_PAGE_MAX).default(COLUMN_PAGE_DEFAULT),
  q: z.string().trim().max(120).optional(),
  priority: z.enum(["alta", "media", "baja", "sin"]).optional(),
  tag: z.string().trim().min(1).max(64).optional(),
  channel: z.enum(CHANNEL_ORDER as unknown as [string, ...string[]]).optional(),
  /** ISO de la `serverTime` anterior: devuelve solo lo que cambió. */
  since: z.string().min(1).max(40).optional(),
});

/**
 * 044 — El tablero, paginado POR COLUMNA. Cada etapa trae su total (conteo y suma, con los filtros
 * aplicados), su primera página de tarjetas y un cursor para pedir más
 * (`GET /api/pipeline/stages/[id]/leads`). Con `since` devuelve solo lo que cambió (delta).
 */
export const GET = withAuth(async (session, req: Request) => {
  const parsed = boardQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
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
    priority: p.priority,
    tag: p.tag,
    channel: p.channel as Channel | undefined,
  };
  // La hora del servidor se toma ANTES de consultar: lo que cambie mientras tanto entra en el siguiente delta.
  const serverTime = new Date();
  // La moneda del negocio viaja con el tablero: el cliente muestra las sumas y necesita saber cuál es la sumable.
  const { currency } = await getBranding(session.organizationId);

  if (p.since) {
    const since = new Date(p.since);
    if (Number.isNaN(since.getTime())) return apiError(422, "invalid_query", "since: fecha inválida");
    const delta = await boardDelta(session.organizationId, currency, since, filters);
    return Response.json({ currency, serverTime: serverTime.toISOString(), ...delta });
  }

  const stages = await boardSnapshot(session.organizationId, currency, { limit: p.limit, filters });
  return Response.json({ currency, serverTime: serverTime.toISOString(), stages });
});
