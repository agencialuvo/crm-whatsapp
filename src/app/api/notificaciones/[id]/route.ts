import { apiError, withAuth } from "@/lib/api";
import { markRead } from "@/server/notifications/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Marcar una notificación como leída (404 si no es de esta organización). */
export const PATCH = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const ok = await markRead(session.organizationId, session.role, id);
  if (!ok) return apiError(404, "not_found", "La notificación no existe");
  return Response.json({ ok: true });
});
