import { z } from "zod";
import { withAuth } from "@/lib/api";
import { getDb } from "@/lib/db";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { birthdayUsedInYear } from "@/server/loyalty/actions";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  contactId: z.string().trim().min(1).max(64),
  year: z.coerce.number().int().min(2000).max(2200),
});

/**
 * Caja — ¿este cliente ya usó su descuento de cumpleaños ese año? Es de una vez por año: si ya lo usó, el
 * formulario de venta no ofrece el interruptor. Cualquiera del equipo que cobra puede consultarlo.
 */
export const GET = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "member");
  if (denied) return denied;
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    contactId: url.searchParams.get("contactId"),
    year: url.searchParams.get("year"),
  });
  if (!parsed.success) {
    return Response.json({ error: { code: "invalid_query", message: "Indica el cliente y el año" } }, { status: 422 });
  }
  try {
    const used = await birthdayUsedInYear(getDb(), session.organizationId, parsed.data.contactId, parsed.data.year);
    return Response.json({ used });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
