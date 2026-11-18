import { apiError, parseBody } from "@/lib/api";
import { changePlanBodySchema } from "@/lib/billing";
import { changePlanByOwner } from "@/server/billing/change";
import { withBilling } from "@/server/billing/guard";

export const dynamic = "force-dynamic";

/** Cambiar de plan sin prorrateo: subir rige ya; bajar queda para el próximo corte. */
export const POST = withBilling(
  async (session, req) => {
    const body = await parseBody(req, changePlanBodySchema);
    if (!body.ok) return body.response;
    const r = await changePlanByOwner({ organizationId: session.organizationId, userId: session.userId, planId: body.data.planId });
    if (!r.ok) return apiError(r.status, r.code, r.message);
    return Response.json({ ok: true, mode: r.mode, planName: r.planName });
  },
  { mutation: true }
);
