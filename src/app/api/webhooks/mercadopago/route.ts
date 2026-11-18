import { mpNotificationSchema, verifyMpSignature } from "@/lib/billing";
import { billingEnabled, mpWebhookSecret } from "@/lib/mercadopago/config";
import { handleNotification } from "@/server/billing/webhook";

export const dynamic = "force-dynamic";

const notFound = () => new Response(null, { status: 404 });

/**
 * 046 — El webhook de Mercado Pago. Orden estricto: bandera apagada → 404; sin secreto → 503; firma inválida →
 * 401 (sin escribir nada); y solo entonces se toca la base. El aviso es un timbre: el estado se consulta a la API.
 */
export async function POST(req: Request): Promise<Response> {
  if (!billingEnabled()) return notFound();
  const secret = mpWebhookSecret();
  if (!secret) {
    console.error("[billing] el secreto del webhook no está configurado: no se acepta ningún aviso");
    return Response.json({ error: { code: "not_configured", message: "Webhook sin secreto" } }, { status: 503 });
  }

  const url = new URL(req.url);
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const parsed = mpNotificationSchema.safeParse(body ?? {});
  const note = parsed.success ? parsed.data : null;
  // El `data.id` firmado es el del query (`?data.id=…`); el cuerpo solo se usa si el query no lo trae.
  const dataId = url.searchParams.get("data.id") ?? (note?.data?.id != null ? String(note.data.id) : null);
  const requestId = req.headers.get("x-request-id");

  const valid = verifyMpSignature({ secret, signatureHeader: req.headers.get("x-signature"), requestId, dataId });
  if (!valid || !dataId || !requestId) {
    return Response.json({ error: { code: "bad_signature", message: "Firma inválida" } }, { status: 401 });
  }

  const topic = url.searchParams.get("type") ?? url.searchParams.get("topic") ?? note?.type ?? note?.topic ?? "";
  const res = await handleNotification({
    requestId,
    topic,
    resourceId: dataId,
    action: note?.action ?? null,
    liveMode: note?.live_mode ?? null,
  });
  return Response.json(res.body, { status: res.status });
}
