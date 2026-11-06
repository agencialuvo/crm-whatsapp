import { parseBody, withAuth } from "@/lib/api";
import { quickContactSchema } from "@/lib/salon/schemas";
import { quickCreateContact } from "@/server/business/clients";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

/**
 * «Crear cliente rápido» desde Citas: nombre y celular. Si el celular ya existe se
 * devuelve ese contacto (`existing: true`) en vez de duplicarlo. Todo el equipo
 * agenda, así que basta ser del equipo.
 */
export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "member");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, ["salon", "finances", "agenda"]);
  if (planBlocked) return planBlocked;
  const body = await parseBody(req, quickContactSchema);
  if (!body.ok) return body.response;
  try {
    const contact = await quickCreateContact(session.organizationId, body.data);
    return Response.json({ contact }, { status: contact.existing ? 200 : 201 });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
