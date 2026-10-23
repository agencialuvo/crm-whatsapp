import { parseBody, withAuth } from "@/lib/api";
import { clientCreateSchema } from "@/lib/salon/schemas";
import { createSalonClient, listSalonClients } from "@/server/business/clients";
import { salonErrorResponse, salonGate } from "@/server/business/http";

export const dynamic = "force-dynamic";

/**
 * Módulo SALON — los clientes del salón (`?q=` busca por nombre o celular; `?limit=` acota).
 * Muestran lo gastado, así que es solo del dueño/administrador, como la caja.
 */
export const GET = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  try {
    const params = new URL(req.url).searchParams;
    // `limit` (1-50) acota la lista: lo usa el alta para sugerir coincidencias.
    const limit = Number(params.get("limit"));
    const max = Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : undefined;
    return Response.json(
      await listSalonClients(session.organizationId, params.get("q") ?? undefined, max)
    );
  } catch (err) {
    return salonErrorResponse(err);
  }
});

/** Dar de alta a un cliente junto con su primera compra (servicio u oferta, quién atendió y pago). */
export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const body = await parseBody(req, clientCreateSchema);
  if (!body.ok) return body.response;
  try {
    // Sin nombre ni celular es una venta de mostrador: no hay ficha que devolver.
    const client = await createSalonClient(session.organizationId, body.data);
    return Response.json(client ?? { client: null, counterSale: true }, { status: 201 });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
