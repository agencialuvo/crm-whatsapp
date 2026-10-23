import { z } from "zod";
import { parseBody, withAuth } from "@/lib/api";
import { markAllRead } from "@/server/notifications/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** Sin ids, se marcan todas las visibles. */
  ids: z.array(z.string().min(1)).max(200).optional(),
});

/** Marcar como leídas varias (o todas) las notificaciones de la organización. */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  const updated = await markAllRead(session.organizationId, session.role, body.data.ids);
  return Response.json({ updated });
});
