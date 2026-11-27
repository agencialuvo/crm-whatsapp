import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { todayInTz } from "@/lib/time/slots";
import { businessTimezone } from "@/server/analytics/period";
import {
  BirthdayGreetingError,
  recordManualGreeting,
  removeManualGreeting,
} from "@/server/business/birthday-campaign";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ contactId: z.string().trim().min(1).max(64) });

/**
 * Panel → Cumpleaños: «Saludar» abre WhatsApp con el saludo listo y, a la vez, registra el saludo manual para
 * que cuente como «contactado» (POST). DELETE quita la marca si fue un error. El año es el de HOY en la zona del
 * negocio (la tarjeta muestra el mes en curso). Mismo acceso que el Panel: dueño o administrador.
 */
async function handle(req: Request, organizationId: string, act: (year: number, contactId: string) => Promise<void>) {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  try {
    const year = Number(todayInTz(new Date(), await businessTimezone(organizationId)).slice(0, 4));
    await act(year, body.data.contactId);
    return Response.json({ ok: true, year });
  } catch (err) {
    if (err instanceof BirthdayGreetingError) return apiError(404, err.code, err.message);
    return salonErrorResponse(err);
  }
}

export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "finances");
  if (planBlocked) return planBlocked;
  return handle(req, session.organizationId, (year, contactId) =>
    recordManualGreeting({ organizationId: session.organizationId, contactId, year, userId: session.userId })
  );
});

export const DELETE = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "finances");
  if (planBlocked) return planBlocked;
  return handle(req, session.organizationId, (year, contactId) =>
    removeManualGreeting({ organizationId: session.organizationId, contactId, year })
  );
});
