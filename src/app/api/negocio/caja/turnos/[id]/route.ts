import { withAuth } from "@/lib/api";
import { getShiftDetail } from "@/server/business/cash-shifts";
import { salonErrorResponse, salonGate } from "@/server/business/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Caja — el desglose de un turno (métodos de pago, notas, quién lo abrió y cerró). Solo dueño o administrador. */
export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    return Response.json({ shift: await getShiftDetail(session.organizationId, id.slice(0, 64)) });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
