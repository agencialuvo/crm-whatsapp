import { parseBody, withAuth } from "@/lib/api";
import { comboInputSchema } from "@/lib/salon/schemas";
import { createCombo, listCombos } from "@/server/business/catalog";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

/** Módulo SALON — combos y ofertas de publicidad pagada. Solo dueño/administrador. */
export const GET = withAuth(async (session) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  return Response.json({ combos: await listCombos(session.organizationId) });
});

export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  const body = await parseBody(req, comboInputSchema);
  if (!body.ok) return body.response;
  try {
    const combo = await createCombo(session.organizationId, body.data);
    return Response.json({ combo }, { status: 201 });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
