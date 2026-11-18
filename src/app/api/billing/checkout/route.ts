import { apiError, parseBody } from "@/lib/api";
import { checkoutBodySchema, isAllowedCheckoutUrl } from "@/lib/billing";
import { extraCheckoutHosts } from "@/lib/mercadopago/config";
import { createCheckout } from "@/server/billing/checkout";
import { withBilling } from "@/server/billing/guard";

export const dynamic = "force-dynamic";

/** Contratar un plan: crea el intento y la suscripción en Mercado Pago; devuelve el enlace de pago. */
export const POST = withBilling(
  async (session, req) => {
    const body = await parseBody(req, checkoutBodySchema);
    if (!body.ok) return body.response;
    const r = await createCheckout({ organizationId: session.organizationId, userId: session.userId, planId: body.data.planId });
    if (!r.ok) return apiError(r.status, r.code, r.message);
    // Nunca se redirige a una URL arbitraria: solo a Mercado Pago (o a su mock en pruebas).
    if (!isAllowedCheckoutUrl(r.url, extraCheckoutHosts())) return apiError(502, "bad_checkout_url", "Mercado Pago devolvió un enlace no permitido");
    return Response.json({ checkoutId: r.checkoutId, url: r.url });
  },
  { mutation: true }
);
