import { apiError, parseBody, withAuth } from "@/lib/api";
import { rescueSettingsSchema } from "@/lib/salon/birthday-rescue";
import { automationErrorResponse } from "@/server/automation/http";
import { automationsEnabled } from "@/server/automation/flag";
import { getRescueSettings, saveRescueSettings } from "@/server/business/birthday-rescue-settings";
import { salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

async function gate(session: Parameters<typeof salonGate>[0]): Promise<Response | null> {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  if (!automationsEnabled()) return apiError(404, "automations_off", "El rescate necesita el módulo de Automatizaciones");
  return moduleGate(session.organizationId, "finances");
}

/** Panel → Cumpleaños → ajustes del rescate de fin de mes (ventana, margen, automático y beneficio). Dueño/admin. */
export const GET = withAuth(async (session) => {
  const blocked = await gate(session);
  if (blocked) return blocked;
  const { lastAutoRunOn, ...settings } = await getRescueSettings(session.organizationId);
  return Response.json({ settings, lastAutoRunOn });
});

/** 422 cuerpo inválido o flujo que no es «Manual» · 404 el flujo no existe. */
export const PUT = withAuth(async (session, req: Request) => {
  const blocked = await gate(session);
  if (blocked) return blocked;
  const body = await parseBody(req, rescueSettingsSchema);
  if (!body.ok) return body.response;
  try {
    const settings = await saveRescueSettings(session.organizationId, body.data);
    return Response.json({ settings });
  } catch (err) {
    return automationErrorResponse(err);
  }
});
