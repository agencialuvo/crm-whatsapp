import { apiError, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { atribucionDisabledResponse, atribucionEnabled } from "@/server/attribution/flag";
import { listCatalogAds } from "@/server/attribution/ad-flow";

export const dynamic = "force-dynamic";

/**
 * 039 — Los anuncios de la cuenta publicitaria conectada, para elegir uno al vincular un flujo. Vacío sin
 * cuenta conectada (el diálogo sigue pidiendo el ID a mano). Mismo permiso que la lista de flujos.
 */
export const GET = withAuth(async (session) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  return Response.json(await listCatalogAds(session.organizationId));
});
