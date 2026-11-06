import { parseBody, withAuth } from "@/lib/api";
import { servicePatchSchema } from "@/lib/salon/schemas";
import { deleteService, updateService } from "@/server/business/catalog";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  const { id } = await ctx.params;
  const body = await parseBody(req, servicePatchSchema);
  if (!body.ok) return body.response;
  try {
    const service = await updateService(session.organizationId, id, body.data);
    return Response.json({ service });
  } catch (err) {
    return salonErrorResponse(err);
  }
});

/** 409 `in_use` si ya tiene ventas: la UI ofrece desactivarlo. */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  const { id } = await ctx.params;
  try {
    await deleteService(session.organizationId, id);
    return Response.json({ ok: true });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
