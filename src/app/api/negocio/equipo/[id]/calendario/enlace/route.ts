import { apiError, withAuth } from "@/lib/api";
import { salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";
import { staffCalendarsDisabledResponse, staffCalendarsEnabled } from "@/server/agenda/staff-calendar/flag";
import { createInvite, InviteError, revokeInvites } from "@/server/agenda/staff-calendar/invite";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Mejora 3 — El enlace de 24 h para que el profesional conecte su Google Calendar. Solo dueño o administrador.
 *  - POST: genera uno nuevo (anula el anterior sin usar) y lo devuelve EN CLARO esta única vez.
 *  - DELETE: anula el enlace pendiente.
 */
export const POST = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  if (!staffCalendarsEnabled()) return staffCalendarsDisabledResponse();
  const { id } = await ctx.params;
  try {
    const invite = await createInvite({ organizationId: session.organizationId, staffId: id, userId: session.userId });
    return Response.json({ url: invite.url, expiresAt: invite.expiresAt.toISOString() }, { status: 201 });
  } catch (err) {
    if (err instanceof InviteError) {
      return apiError(err.code === "staff_not_found" ? 404 : 409, err.code, err.message);
    }
    throw err;
  }
});

export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "salon");
  if (planBlocked) return planBlocked;
  if (!staffCalendarsEnabled()) return staffCalendarsDisabledResponse();
  const { id } = await ctx.params;
  await revokeInvites(session.organizationId, id);
  return Response.json({ ok: true });
});
