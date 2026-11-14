import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { tagPatchSchema } from "@/lib/tags";
import { deleteTag, TagError, updateTag } from "@/server/tags/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Renombrar o cambiar el color: solo el dueño o un administrador (afecta a todo el equipo). */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  if (!canConfigure(session.role)) return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  const { id } = await ctx.params;
  const body = await parseBody(req, tagPatchSchema);
  if (!body.ok) return body.response;
  try {
    return Response.json({ tag: await updateTag(session.organizationId, id, body.data) });
  } catch (err) {
    if (err instanceof TagError) return apiError(err.status, err.code, err.message);
    throw err;
  }
});

/** Borrar: se quita de todos los contactos (cascada). Un paso que la use fallará a la vista en el historial. */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  if (!canConfigure(session.role)) return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  const { id } = await ctx.params;
  try {
    await deleteTag(session.organizationId, id);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof TagError) return apiError(err.status, err.code, err.message);
    throw err;
  }
});
