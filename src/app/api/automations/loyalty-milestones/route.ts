import { withAuth } from "@/lib/api";
import { sortMilestones } from "@/lib/loyalty";
import { automationGate } from "@/server/automation/http";
import { getLoyaltySettings } from "@/server/loyalty/actions";

export const dynamic = "force-dynamic";

/**
 * Automatizaciones — los hitos (premios) del programa de fidelidad del negocio, para el selector del disparador
 * «Premio de fidelidad». Misma puerta que el resto de `/api/automations` (dueño o administrador; apagado → 404): un negocio
 * cuyo plan no incluye el módulo de fidelización puede igual abrir sus flujos.
 */
export const GET = withAuth(async (session) => {
  const denied = automationGate(session);
  if (denied) return denied;
  const settings = await getLoyaltySettings(session.organizationId);
  const milestones = sortMilestones(settings.milestones).map((m) => ({
    stamps: m.stamps,
    title: m.title ?? "",
    rewardType: m.rewardType,
    ...(m.discountPercentage !== undefined ? { discountPercentage: m.discountPercentage } : {}),
  }));
  return Response.json({ enabled: settings.enabled, milestones });
});
