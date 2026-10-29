import { apiError, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { loyaltyCardQuerySchema } from "@/lib/loyalty";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { getLoyaltyCardView } from "@/server/loyalty/actions";

export const dynamic = "force-dynamic";

/**
 * Fidelización — la tarjeta de un cliente: `?contactId=` o `?phone=` (dígitos con código
 * de país). Solo lee: si el cliente aún no tiene tarjeta, `card` viene `null`.
 */
export const GET = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "member");
  if (denied) return denied;
  const q = new URL(req.url).searchParams;
  const parsed = loyaltyCardQuerySchema.safeParse({
    contactId: q.get("contactId") ?? undefined,
    phone: q.get("phone") ?? undefined,
  });
  if (!parsed.success) {
    return apiError(422, "invalid_query", parsed.error.issues.map((i) => i.message).join("; "));
  }
  try {
    const view = await getLoyaltyCardView(session.organizationId, parsed.data);
    // El ajuste manual es del dueño o administrador: la pantalla solo ofrece el botón a ellos.
    return Response.json({ ...view, canAdjust: canConfigure(session.role) });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
