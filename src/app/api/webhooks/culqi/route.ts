import { CulqiApiError } from "@/lib/culqi/client";
import { culqiEnabled, culqiWebhookSecret } from "@/lib/culqi/config";
import { parseCulqiEvent, secretMatches, webhookToken } from "@/lib/culqi/webhook";
import { confirmOrder, confirmRefund } from "@/server/billing/credit-topup";

export const dynamic = "force-dynamic";

/**
 * Monedas 5.4 — el webhook de Culqi. Orden estricto: bandera apagada → 404; sin secreto → 503; secreto incorrecto →
 * 401 (sin tocar la base); y solo entonces se atiende. El aviso es un timbre: el estado se consulta a la API de
 * Culqi. Un fallo de Culqi o de la base responde 5xx para que reintente; un aviso que no entendemos o no nos toca
 * responde 200 (reintentarlo no lo arreglaría).
 */
export async function POST(req: Request): Promise<Response> {
  if (!culqiEnabled()) return new Response(null, { status: 404 });
  const secret = culqiWebhookSecret();
  if (!secret) {
    console.error("[culqi] el secreto del webhook no está configurado: no se acepta ningún aviso");
    return Response.json({ error: { code: "not_configured", message: "Webhook sin secreto" } }, { status: 503 });
  }
  if (!secretMatches(webhookToken(req), secret)) {
    return Response.json({ error: { code: "bad_token", message: "No autorizado" } }, { status: 401 });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const event = parseCulqiEvent(body);
  if (!event) return Response.json({ received: true, handled: false });

  try {
    if (event.type.startsWith("order.") && event.orderId) {
      const r = await confirmOrder(event.orderId);
      if (r.status === "disabled") return Response.json({ error: { code: "credits_disabled", message: "Monedas apagadas" } }, { status: 503 });
      return Response.json({ received: true, handled: true, result: r.status });
    }
    if (event.type.startsWith("refund.") && event.chargeId) {
      const r = await confirmRefund(event.chargeId);
      if (r.status === "disabled") return Response.json({ error: { code: "credits_disabled", message: "Monedas apagadas" } }, { status: 503 });
      return Response.json({ received: true, handled: true, result: r.status });
    }
    return Response.json({ received: true, handled: false });
  } catch (err) {
    const transient = err instanceof CulqiApiError ? err.retryable : true;
    console.error("[culqi] el aviso no se pudo atender:", err instanceof Error ? err.message : err);
    return Response.json({ error: { code: "retry", message: "No se pudo atender el aviso" } }, { status: transient ? 503 : 200 });
  }
}
