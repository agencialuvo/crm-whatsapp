import { apiError, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { atribucionDisabledResponse, atribucionEnabled } from "@/server/attribution/flag";
import { deleteAdFlow } from "@/server/attribution/ad-flow";
import { adFlowErrorResponse } from "@/server/attribution/ad-flow-http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Quita el flujo de un anuncio: sus conversaciones vuelven al comportamiento genérico del anuncio. */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const { id } = await ctx.params;
  try {
    await deleteAdFlow(session.organizationId, id);
    return Response.json({ ok: true });
  } catch (err) {
    return adFlowErrorResponse(err);
  }
});
