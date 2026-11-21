import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { menuConfigSchema, menuTemplateNameSchema } from "@/lib/menu-config";
import { salonErrorResponse } from "@/server/business/http";
import { deleteMenuTemplate, updateMenuTemplate } from "@/server/business/menu-config";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({ name: menuTemplateNameSchema.optional(), config: menuConfigSchema.optional() })
  .refine((o) => o.name !== undefined || o.config !== undefined, "No hay nada que actualizar");

/** Renombrar o actualizar una plantilla GUARDADA de la organización. */
export const PUT = withAuth(async (session, req: Request, ctx: Params) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;
  try {
    const template = await updateMenuTemplate(session.organizationId, id, body.data);
    return Response.json({ template });
  } catch (err) {
    return salonErrorResponse(err);
  }
});

export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const { id } = await ctx.params;
  try {
    await deleteMenuTemplate(session.organizationId, id);
    return Response.json({ ok: true });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
