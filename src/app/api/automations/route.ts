import { parseBody, withAuth } from "@/lib/api";
import { flowCreateSchema } from "@/lib/automation-schemas";
import { createFlow, listFlows } from "@/server/automation/flows";
import { automationErrorResponse, automationGate } from "@/server/automation/http";

export const dynamic = "force-dynamic";

/** Automatizaciones — flujos de la organización. Solo dueño/administrador; apagado (AUTOMATIONS) → 404. */
export const GET = withAuth(async (session) => {
  const denied = automationGate(session);
  if (denied) return denied;
  return Response.json({ flows: await listFlows(session.organizationId) });
});

/** Un flujo nace apagado: se le agregan pasos y luego se enciende con PATCH. */
export const POST = withAuth(async (session, req: Request) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const body = await parseBody(req, flowCreateSchema);
  if (!body.ok) return body.response;
  try {
    const flow = await createFlow(session.organizationId, body.data);
    return Response.json({ flow }, { status: 201 });
  } catch (err) {
    return automationErrorResponse(err);
  }
});
