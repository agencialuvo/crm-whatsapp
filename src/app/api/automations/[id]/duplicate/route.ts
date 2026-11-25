import { withAuth } from "@/lib/api";
import { cloneFlow } from "@/server/automation/flows";
import { automationErrorResponse, automationGate } from "@/server/automation/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Duplica un flujo: la copia nace pausada, con el mismo disparador, pasos, conexiones y configuraciones, y un nombre único
 * («Nombre (copia)», «Nombre (copia 2)»…). No copia ejecuciones ni historial. Solo dueño/administrador; apagado → 404.
 */
export const POST = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    return Response.json({ flow: await cloneFlow(session.organizationId, id) }, { status: 201 });
  } catch (err) {
    return automationErrorResponse(err);
  }
});
