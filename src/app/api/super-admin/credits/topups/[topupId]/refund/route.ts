import { z } from "zod";
import { apiError, parseBody } from "@/lib/api";
import { withSuperAdmin } from "@/lib/auth/super-admin";
import { topupRefund } from "@/server/super-admin/credits";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ topupId: string }> };

const bodySchema = z.object({ reason: z.string().trim().min(3).max(200).optional() }).strict();

/**
 * Reembolsa una recarga: primero se devuelve el dinero en Culqi y solo si lo acepta se descuentan las monedas (quién
 * y por qué quedan en el libro). Repetirlo no hace nada: una compra ya reembolsada responde `duplicate: true`.
 */
export const POST = withSuperAdmin(async (admin, req, ctx: Params) => {
  const { topupId } = await ctx.params;
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  const r = await topupRefund(admin.userId, topupId, body.data.reason);
  if (!r.ok) return apiError(r.status, r.code, r.message);
  return Response.json({ refunded: true, duplicate: r.duplicate });
});
