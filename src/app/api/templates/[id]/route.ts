import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import {
  deleteTemplate,
  editTemplate,
  serializeTemplate,
  TemplateError,
  templateErrorStatus,
} from "@/server/whatsapp/templates";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const editSchema = z.object({
  category: z.enum(["UTILITY", "MARKETING"]),
  body: z.string().trim().min(1).max(1024),
  examples: z.array(z.string().trim().max(200)).max(10).optional(),
});

/**
 * Edita el texto (y la categoría, si no está aprobada) y la manda otra vez a revisión de Meta. El nombre y el
 * idioma no cambian. Mismos permisos que crear. 409 `not_editable` si está en revisión; 409 `in_use` si una
 * automatización la usa y cambia el número de variables.
 */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, editSchema);
  if (!body.ok) return body.response;
  try {
    const template = await editTemplate(session.organizationId, id, body.data);
    return Response.json({ template: serializeTemplate(template) });
  } catch (err) {
    if (err instanceof TemplateError) {
      return apiError(templateErrorStatus(err), err.code, err.message);
    }
    throw err;
  }
});

/**
 * Borra una plantilla en Meta y aquí. Solo dueño o administrador: es irreversible y Meta no deja reusar el
 * nombre de una plantilla aprobada durante 30 días. 409 `in_use` si una automatización la envía.
 */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede borrar plantillas");
  }
  const { id } = await ctx.params;
  try {
    await deleteTemplate(session.organizationId, id);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof TemplateError) {
      return apiError(templateErrorStatus(err), err.code, err.message);
    }
    throw err;
  }
});
