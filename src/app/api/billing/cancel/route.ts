import { apiError, parseBody } from "@/lib/api";
import { cancelBodySchema } from "@/lib/billing";
import { cancelByOwner } from "@/server/billing/change";
import { withBilling } from "@/server/billing/guard";

export const dynamic = "force-dynamic";

/** Cancelar: no se cobra más y conserva el acceso hasta el fin del periodo pagado. */
export const POST = withBilling(
  async (session, req) => {
    const body = await parseBody(req, cancelBodySchema);
    if (!body.ok) return body.response;
    const r = await cancelByOwner({ organizationId: session.organizationId, userId: session.userId, reason: body.data.reason });
    if (!r.ok) return apiError(r.status, r.code, r.message);
    return Response.json({ ok: true, mode: r.mode });
  },
  { mutation: true }
);
