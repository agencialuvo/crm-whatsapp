import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { automationErrorResponse } from "@/server/automation/http";
import { automationsEnabled } from "@/server/automation/flag";
import { launchBirthdayRescue, RESCUE_MAX_PER_LAUNCH } from "@/server/business/birthday-rescue";
import { salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    flowId: z.string().trim().min(1).max(64),
    /** Opcional: acota a estos clientes (nunca agrega: la audiencia la recalcula el servidor). */
    contactIds: z.array(z.string().trim().min(1).max(64)).min(1).max(RESCUE_MAX_PER_LAUNCH).optional(),
  })
  .strict();

/**
 * Panel → Cumpleaños → «Rescate de última oportunidad»: arranca un flujo MANUAL para los cumpleañeros del mes que
 * no reservaron ni aprovecharon (ver `server/business/birthday-rescue.ts`). Solo dueño o administrador. Necesita el
 * módulo de Automatizaciones (sin él la superficie no existe: 404).
 * 404 el flujo no existe · 422 no es manual / cuerpo inválido · 409 el flujo está apagado.
 */
export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  if (!automationsEnabled()) return apiError(404, "automations_off", "El rescate necesita el módulo de Automatizaciones");
  const planBlocked = await moduleGate(session.organizationId, "finances");
  if (planBlocked) return planBlocked;
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  try {
    const result = await launchBirthdayRescue({
      organizationId: session.organizationId,
      flowId: body.data.flowId,
      ...(body.data.contactIds ? { contactIds: body.data.contactIds } : {}),
      triggeredBy: session.userId,
    });
    return Response.json(result, { status: result.enqueued > 0 ? 201 : 200 });
  } catch (err) {
    return automationErrorResponse(err);
  }
});
