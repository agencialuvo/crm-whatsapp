import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { loyaltyTransactionInputSchema } from "@/lib/loyalty";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { registerLoyaltyTransaction } from "@/server/loyalty/actions";

export const dynamic = "force-dynamic";

/**
 * Fidelización — el staff da un sello, aplica el canje o deja constancia de un descuento de
 * cumpleaños. Sin sellos suficientes para canjear → 409 `not_enough_stamps`. El ajuste manual
 * (`adjusted`) cambia el saldo a mano, así que es solo del dueño o administrador.
 */
export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "member");
  if (denied) return denied;
  const body = await parseBody(req, loyaltyTransactionInputSchema);
  if (!body.ok) return body.response;
  if (body.data.type === "adjusted" && !canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede ajustar sellos a mano");
  }
  try {
    const result = await registerLoyaltyTransaction({
      organizationId: session.organizationId,
      ...body.data,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
