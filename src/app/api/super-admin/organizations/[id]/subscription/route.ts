import { apiError, parseBody } from "@/lib/api";
import { auditIp, withSuperAdmin } from "@/lib/auth/super-admin";
import type { SubAction } from "@/lib/saas";
import { subscriptionActionSchema } from "@/lib/super-admin";
import { propagateAdminAction } from "@/server/billing/change";
import { invalidateSubscriptionAccess } from "@/server/saas/enforcement";
import { applySubscriptionAction } from "@/server/saas/subscription";
import { getOrganizationDetail } from "@/server/super-admin/directory";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Una acción manual sobre la suscripción de una organización (asignar, activar, cambiar de plan, extender la
 * prueba, fijar el corte, suspender, cancelar, reactivar). Exige un motivo. Transaccional: cambia la
 * suscripción, escribe el evento de la historia y la auditoría. Transición inválida → 409 y no se escribe nada.
 */
export const POST = withSuperAdmin(async (admin, req, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, subscriptionActionSchema);
  if (!body.ok) return body.response;
  const d = body.data;
  // 046: si la suscripción la cobra Mercado Pago, primero se le propaga la acción (la matriz de la spec); si la
  // pasarela falla o la acción no cabe, no cambia nada localmente.
  const prop = await propagateAdminAction({ organizationId: id, action: d.action as SubAction, planId: d.planId });
  if (!prop.ok) return apiError(prop.status, prop.code, prop.message);
  const result = await applySubscriptionAction({
    providerStatus: prop.providerStatus,
    organizationId: id,
    action: d.action as SubAction,
    planId: d.planId,
    days: d.days,
    periodEnd: d.periodEnd ? new Date(d.periodEnd.length === 10 ? `${d.periodEnd}T12:00:00Z` : d.periodEnd) : undefined,
    cancelAtPeriodEnd: d.cancelAtPeriodEnd,
    reason: d.reason,
    actor: { userId: admin.userId, email: admin.email, ip: auditIp(req) },
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);
  // La próxima petición de esa organización ve el estado nuevo de inmediato (el acceso se guarda 15 s).
  invalidateSubscriptionAccess(id);
  const detail = await getOrganizationDetail(id);
  return Response.json({ ok: true, ...detail });
});
