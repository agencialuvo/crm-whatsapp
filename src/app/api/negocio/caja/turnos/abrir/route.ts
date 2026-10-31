import { parseBody, withAuth } from "@/lib/api";
import { openShiftInputSchema } from "@/lib/salon/cash-shifts";
import { openShift } from "@/server/business/cash-shifts";
import { salonErrorResponse, salonGate } from "@/server/business/http";

export const dynamic = "force-dynamic";

/** Caja — abrir el turno con el efectivo inicial (céntimos). Solo dueño o administrador. */
export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const body = await parseBody(req, openShiftInputSchema);
  if (!body.ok) return body.response;
  try {
    const shift = await openShift({
      organizationId: session.organizationId,
      userId: session.userId,
      initialCashCents: body.data.initialCashCents,
    });
    return Response.json({ shift }, { status: 201 });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
