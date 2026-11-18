import { apiError } from "@/lib/api";
import { getCheckoutStatus } from "@/server/billing/checkout";
import { withBilling } from "@/server/billing/guard";

export const dynamic = "force-dynamic";

/** El estado de un intento de pago (solo de la propia organización). Con intento vivo consulta a Mercado Pago. */
export const GET = withBilling(async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const dto = await getCheckoutStatus(session.organizationId, id);
  if (!dto) return apiError(404, "not_found", "No encontrado");
  return Response.json(dto);
});
