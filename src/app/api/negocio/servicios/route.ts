import { parseBody, withAuth } from "@/lib/api";
import { serviceInputSchema } from "@/lib/salon/schemas";
import { createService, listServices } from "@/server/business/catalog";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

/** Módulo SALON — servicios del catálogo. Solo dueño/administrador. */
export const GET = withAuth(async (session) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  return Response.json({ services: await listServices(session.organizationId) });
});

export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  const body = await parseBody(req, serviceInputSchema);
  if (!body.ok) return body.response;
  try {
    const service = await createService(session.organizationId, body.data);
    return Response.json({ service }, { status: 201 });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
