import { z } from "zod";
import { parseBody, withAuth } from "@/lib/api";
import { closeShiftInputSchema } from "@/lib/salon/cash-shifts";
import { closeShift } from "@/server/business/cash-shifts";
import { salonErrorResponse, salonGate } from "@/server/business/http";

export const dynamic = "force-dynamic";

const bodySchema = closeShiftInputSchema.extend({ shiftId: z.string().min(1).max(64) });

/** Caja — cerrar el turno con el efectivo contado (céntimos). Calcula y congela el cuadre. */
export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  try {
    const shift = await closeShift({
      organizationId: session.organizationId,
      userId: session.userId,
      ...body.data,
    });
    return Response.json({ shift });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
