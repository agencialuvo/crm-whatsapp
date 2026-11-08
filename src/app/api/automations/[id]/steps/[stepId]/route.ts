import { parseBody, withAuth } from "@/lib/api";
import { stepPatchSchema } from "@/lib/automation-schemas";
import { deleteStep, updateStep } from "@/server/automation/flows";
import { automationErrorResponse, automationGate } from "@/server/automation/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; stepId: string }> };

/** Edita la `config` del nodo (contra el tipo que ya tiene) y/o lo mueve en el lienzo. */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const { id, stepId } = await ctx.params;
  const body = await parseBody(req, stepPatchSchema);
  if (!body.ok) return body.response;
  try {
    return Response.json({ step: await updateStep(session.organizationId, id, stepId, body.data) });
  } catch (err) {
    return automationErrorResponse(err);
  }
});

/** Borra el nodo. Un flujo encendido que se queda sin pasos se apaga. */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const { id, stepId } = await ctx.params;
  try {
    await deleteStep(session.organizationId, id, stepId);
    return Response.json({ ok: true });
  } catch (err) {
    return automationErrorResponse(err);
  }
});
