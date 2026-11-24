import { z } from "zod";
import { parseBody, withAuth } from "@/lib/api";
import { manualBatchIdSchema } from "@/lib/automation";
import { automationErrorResponse, automationGate } from "@/server/automation/http";
import { triggerManualFlow } from "@/server/automation/manual";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({ contactId: z.string().trim().min(1).max(64), batchId: manualBatchIdSchema }).strict();

/**
 * Ejecuta un flujo MANUAL para un contacto. `batchId` (lo genera la pantalla al abrir el diálogo) evita el doble clic:
 * repetirlo responde `{ started: false }`. Hereda los controles del motor (baja, tope de mensajes, ventana de 24 h).
 * 404 el flujo o el contacto no existen · 422 no es manual o el contacto no tiene chat · 409 el flujo está apagado.
 */
export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  try {
    const result = await triggerManualFlow({
      organizationId: session.organizationId,
      flowId: id,
      contactId: body.data.contactId,
      batchId: body.data.batchId,
      triggeredBy: session.userId,
    });
    return Response.json(result, { status: result.started ? 201 : 200 });
  } catch (err) {
    return automationErrorResponse(err);
  }
});
