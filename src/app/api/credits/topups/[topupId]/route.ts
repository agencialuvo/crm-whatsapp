import { apiError, withAuth } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { topupStatus } from "@/server/billing/credit-topup";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ topupId: string }> };

/**
 * El estado de una compra de la organización de la sesión (otra organización = 404). Si sigue pendiente, la asienta
 * contra Culqi antes de responder, así que quien vuelve del checkout ve sus monedas aunque el aviso aún no llegue.
 */
export const GET = withAuth(
  async (session, _req: Request, ctx: Params) => {
    const rate = checkRateLimit(`credit-topup-status:${session.organizationId}`, { windowMs: 60_000, max: 30 });
    if (!rate.allowed) return apiError(429, "rate_limited", "Demasiadas consultas; espera un momento");
    const { topupId } = await ctx.params;
    const t = await topupStatus(session.organizationId, topupId);
    return t ? Response.json({ topup: t }) : apiError(404, "not_found", "Compra no encontrada");
  },
  { allowInactive: true }
);
