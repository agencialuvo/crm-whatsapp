import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { borrarMedio, MedioError, renombrarMedio } from "@/server/medios/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const renameSchema = z.object({
  nombre: z.string().trim().min(1, "Escribe un nombre").max(120, "Máximo 120 caracteres"),
});

/** Cambia el nombre de un medio. Quien lo subió, el dueño o un administrador. */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  if (!/^med_[a-z0-9]{20}$/.test(id)) return apiError(404, "not_found", "Ese archivo ya no existe.");
  const body = await parseBody(req, renameSchema);
  if (!body.ok) return body.response;
  try {
    const medio = await renombrarMedio({
      organizationId: session.organizationId,
      userId: session.userId,
      puedeAdministrar: canConfigure(session.role),
      id,
      nombre: body.data.nombre,
    });
    return Response.json({ medio });
  } catch (err) {
    if (err instanceof MedioError) {
      const status = err.code === "forbidden" ? 403 : err.code === "empty" ? 422 : err.code === "in_use" ? 409 : 404;
      return apiError(status, err.code, err.message);
    }
    throw err;
  }
});

/** Borra un medio y su archivo. Quien lo subió, el dueño o un administrador. */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  if (!/^med_[a-z0-9]{20}$/.test(id)) return apiError(404, "not_found", "Ese archivo ya no existe.");
  try {
    await borrarMedio({
      organizationId: session.organizationId,
      userId: session.userId,
      puedeAdministrar: canConfigure(session.role),
      id,
    });
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof MedioError) {
      return apiError(err.code === "forbidden" ? 403 : err.code === "in_use" ? 409 : 404, err.code, err.message);
    }
    throw err;
  }
});
