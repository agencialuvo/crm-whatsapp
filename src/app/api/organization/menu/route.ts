import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { menuBaseKeySchema, menuConfigSchema } from "@/lib/menu-config";
import { salonErrorResponse } from "@/server/business/http";
import { resetActiveMenu, saveActiveMenu } from "@/server/business/menu-config";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ config: menuConfigSchema, baseKey: menuBaseKeySchema });

/**
 * El menú lateral de la organización. Solo propietario o administrador: cambia lo que ve todo el equipo. Es solo
 * presentación —visibilidad, orden, nombres e iconos—: no concede ni quita acceso a ninguna pantalla.
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  try {
    const saved = await saveActiveMenu(session.organizationId, body.data);
    return Response.json({ menu: saved });
  } catch (err) {
    return salonErrorResponse(err);
  }
});

/** Vuelve al menú estándar; las plantillas guardadas se conservan. */
export const DELETE = withAuth(async (session) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  await resetActiveMenu(session.organizationId);
  return Response.json({ ok: true });
});
