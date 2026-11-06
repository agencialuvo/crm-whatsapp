import { withAuth } from "@/lib/api";
import { searchContactMatches } from "@/server/business/clients";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

/**
 * Autocompletado de Caja y del alta de clientes: busca entre TODOS los contactos
 * de WhatsApp (ya clientes o no) por celular o nombre (`?q=`, `?limit=` hasta 10).
 * Quien cobra en el mostrador también lo usa, así que basta ser del equipo.
 */
export const GET = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "member");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, ["salon", "finances", "agenda"]);
  if (planBlocked) return planBlocked;
  try {
    const params = new URL(req.url).searchParams;
    const limit = Number(params.get("limit"));
    const max = Number.isInteger(limit) && limit >= 1 && limit <= 10 ? limit : 5;
    return Response.json({
      matches: await searchContactMatches(session.organizationId, params.get("q") ?? "", max),
    });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
