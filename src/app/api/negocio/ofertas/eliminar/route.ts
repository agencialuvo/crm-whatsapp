import { parseBody, withAuth } from "@/lib/api";
import { catalogBulkDeleteSchema } from "@/lib/salon/schemas";
import { removeCatalogItems } from "@/server/business/catalog";
import { salonErrorResponse, salonGate } from "@/server/business/http";

export const dynamic = "force-dynamic";

/**
 * Eliminar varios ofertas a la vez. Los que nunca se vendieron se borran; los que ya tienen
 * ventas se desactivan (se conserva el historial de Caja). Responde cuántos fueron de cada tipo.
 */
export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const body = await parseBody(req, catalogBulkDeleteSchema);
  if (!body.ok) return body.response;
  try {
    return Response.json(await removeCatalogItems(session.organizationId, "combo", body.data.ids));
  } catch (err) {
    return salonErrorResponse(err);
  }
});
