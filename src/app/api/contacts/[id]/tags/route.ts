import { apiError, parseBody, withAuth } from "@/lib/api";
import { tagAssignSchema } from "@/lib/tags";
import { assignTag, ensureTag, tagsOfContact, TagError, unassignTag } from "@/server/tags/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  return Response.json({ tags: await tagsOfContact(session.organizationId, id) });
});

/**
 * Asigna una etiqueta al contacto: una existente (`{ tagId }`) o una nueva «al vuelo» (`{ name, color }`;
 * si ya existe una con ese nombre se usa esa). Idempotente: devuelve `assigned: false` si ya la tenía.
 */
export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, tagAssignSchema);
  if (!body.ok) return body.response;
  try {
    const tagId = "tagId" in body.data ? body.data.tagId : (await ensureTag(session.organizationId, body.data)).id;
    const assigned = await assignTag(session.organizationId, id, tagId);
    return Response.json({ assigned, tags: await tagsOfContact(session.organizationId, id) });
  } catch (err) {
    if (err instanceof TagError) return apiError(err.status, err.code, err.message);
    throw err;
  }
});

/** Quita una etiqueta (`?tagId=`). Quitar una que no tenía no es un error. */
export const DELETE = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const tagId = new URL(req.url).searchParams.get("tagId");
  if (!tagId) return apiError(422, "validation_error", "Falta tagId");
  await unassignTag(session.organizationId, id, tagId);
  return Response.json({ tags: await tagsOfContact(session.organizationId, id) });
});
