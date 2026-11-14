import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { adFlowSchema } from "@/lib/ad-flow";
import { atribucionDisabledResponse, atribucionEnabled } from "@/server/attribution/flag";
import { listAdFlows, upsertAdFlow } from "@/server/attribution/ad-flow";
import { adFlowErrorResponse } from "@/server/attribution/ad-flow-http";

export const dynamic = "force-dynamic";

/**
 * Enrutamiento por anuncio: qué servicio u oferta persigue el agente según el anuncio de Meta del que
 * llegó la conversación. Ajustes → Anuncios.
 *
 * Sin la bandera `ATRIBUCION` esto no existe: 404, no 403 (no hay nada que revelar sobre un endpoint que
 * esta instancia no tiene). Configurar lo que el agente le dice a los clientes es del dueño o de un
 * administrador, también para LEER la lista.
 */

export const GET = withAuth(async (session) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  return Response.json(await listAdFlows(session.organizationId));
});

/** Crea el flujo de un anuncio o actualiza el que ya tiene (una fila por `sourceId`). */
export const POST = withAuth(async (session, req: Request) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const body = await parseBody(req, adFlowSchema);
  if (!body.ok) return body.response;
  try {
    return Response.json({ flow: await upsertAdFlow(session.organizationId, body.data) });
  } catch (err) {
    return adFlowErrorResponse(err);
  }
});
