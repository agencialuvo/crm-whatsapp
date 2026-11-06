import { parseBody, withAuth } from "@/lib/api";
import { clientBulkDeleteSchema } from "@/lib/salon/schemas";
import { removeSalonClients } from "@/server/business/clients";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

/**
 * Eliminar varios clientes a la vez. Con historia (atenciones, conversaciones,
 * citas…) se quitan solo de Clientes y se conserva todo; sin nada detrás, se
 * borra el contacto. Responde cuántos fueron de cada tipo.
 */
export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  const body = await parseBody(req, clientBulkDeleteSchema);
  if (!body.ok) return body.response;
  try {
    return Response.json(await removeSalonClients(session.organizationId, body.data.ids));
  } catch (err) {
    return salonErrorResponse(err);
  }
});
