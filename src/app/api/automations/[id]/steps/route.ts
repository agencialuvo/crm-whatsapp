import { parseBody, withAuth } from "@/lib/api";
import { stepCreateSchema } from "@/lib/automation-schemas";
import { createStep } from "@/server/automation/flows";
import { automationErrorResponse, automationGate } from "@/server/automation/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Agrega un nodo al flujo: `stepType`, su `config` (según el tipo) y su posición en el lienzo. */
export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await parseBody(req, stepCreateSchema);
  if (!body.ok) return body.response;
  try {
    const step = await createStep(session.organizationId, id, body.data);
    return Response.json({ step }, { status: 201 });
  } catch (err) {
    return automationErrorResponse(err);
  }
});
