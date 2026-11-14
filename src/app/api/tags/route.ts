import { apiError, parseBody, withAuth } from "@/lib/api";
import { tagCreateSchema } from "@/lib/tags";
import { createTag, listTags, TagError } from "@/server/tags/store";

export const dynamic = "force-dynamic";

/** Las etiquetas del negocio, con cuántos contactos tiene cada una. Cualquier miembro puede verlas. */
export const GET = withAuth(async (session) => {
  return Response.json({ tags: await listTags(session.organizationId) });
});

/** Crea una etiqueta. Cualquier miembro puede: se crean «al vuelo» desde la ficha del contacto. */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, tagCreateSchema);
  if (!body.ok) return body.response;
  try {
    const tag = await createTag(session.organizationId, body.data);
    return Response.json({ tag }, { status: 201 });
  } catch (err) {
    if (err instanceof TagError) return apiError(err.status, err.code, err.message);
    throw err;
  }
});
