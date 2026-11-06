import { parseBody, withAuth } from "@/lib/api";
import { clientInputSchema } from "@/lib/salon/schemas";
import {
  getSalonClient,
  removeSalonClient,
  updateSalonClient,
} from "@/server/business/clients";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Ficha de un cliente: sus datos y su historial de servicios y ofertas. */
export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  const { id } = await ctx.params;
  try {
    return Response.json(await getSalonClient(session.organizationId, id));
  } catch (err) {
    return salonErrorResponse(err);
  }
});

/** Editar al cliente (nombre, celular, cumpleaños y notas). */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  const body = await parseBody(req, clientInputSchema);
  if (!body.ok) return body.response;
  const { id } = await ctx.params;
  try {
    return Response.json(await updateSalonClient(session.organizationId, id, body.data));
  } catch (err) {
    return salonErrorResponse(err);
  }
});

/** Quitarlo de Clientes. El contacto y sus ventas se conservan. */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  const { id } = await ctx.params;
  try {
    await removeSalonClient(session.organizationId, id);
    return Response.json({ ok: true });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
