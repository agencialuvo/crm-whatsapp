import { parseBody, withAuth } from "@/lib/api";
import { flowPatchSchema } from "@/lib/automation-schemas";
import { deleteFlow, getFlow, updateFlow } from "@/server/automation/flows";
import { automationErrorResponse, automationGate } from "@/server/automation/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** El flujo con sus pasos en orden de ejecución (de arriba abajo, de izquierda a derecha). */
export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    return Response.json(await getFlow(session.organizationId, id));
  } catch (err) {
    return automationErrorResponse(err);
  }
});

/** Renombrar, cambiar los ajustes del disparador o encender/apagar. Encender exige al menos un paso (409). */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await parseBody(req, flowPatchSchema);
  if (!body.ok) return body.response;
  try {
    return Response.json({ flow: await updateFlow(session.organizationId, id, body.data) });
  } catch (err) {
    return automationErrorResponse(err);
  }
});

/** Borra el flujo; sus pasos, su cola y su historial se van por la cascada de la base. */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    await deleteFlow(session.organizationId, id);
    return Response.json({ ok: true });
  } catch (err) {
    return automationErrorResponse(err);
  }
});
