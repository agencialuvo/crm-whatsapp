import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { menuConfigSchema, menuTemplateNameSchema } from "@/lib/menu-config";
import { salonErrorResponse } from "@/server/business/http";
import { createMenuTemplate } from "@/server/business/menu-config";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ name: menuTemplateNameSchema, config: menuConfigSchema });

/** Guardar el menú que se está armando como plantilla NUEVA de la organización (las del sistema nunca se sobrescriben). */
export const POST = withAuth(async (session, req: Request) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  try {
    const template = await createMenuTemplate(session.organizationId, body.data);
    return Response.json({ template }, { status: 201 });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
