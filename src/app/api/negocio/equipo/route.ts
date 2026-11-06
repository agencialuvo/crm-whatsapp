import { parseBody, withAuth } from "@/lib/api";
import { staffInputSchema } from "@/lib/salon/schemas";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { createStaff, listStaff } from "@/server/business/staff";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

/** Módulo SALON — profesionales con su horario y comisiones. Solo dueño/administrador. */
export const GET = withAuth(async (session) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  return Response.json({ staff: await listStaff(session.organizationId) });
});

export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  const body = await parseBody(req, staffInputSchema);
  if (!body.ok) return body.response;
  try {
    const staff = await createStaff(session.organizationId, body.data);
    return Response.json({ staff }, { status: 201 });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
