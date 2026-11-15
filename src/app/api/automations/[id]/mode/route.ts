import { z } from "zod";
import { parseBody, withAuth } from "@/lib/api";
import { setEditorMode } from "@/server/automation/canvas";
import { automationErrorResponse, automationGate } from "@/server/automation/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const modeSchema = z.object({ mode: z.enum(["simple", "canvas"]) }).strict();

/**
 * Cambia entre Modo Simple (lista) y Modo Visual (lienzo). Simple → Visual siempre se puede; Visual → Simple solo
 * si la topología cabe en una lista (409 `graph_not_linear` con los motivos y sin tocar nada).
 */
export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await parseBody(req, modeSchema);
  if (!body.ok) return body.response;
  try {
    return Response.json(await setEditorMode(session.organizationId, id, body.data.mode));
  } catch (err) {
    return automationErrorResponse(err);
  }
});
