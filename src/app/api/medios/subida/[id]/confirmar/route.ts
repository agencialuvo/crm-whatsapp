import { apiError, withAuth } from "@/lib/api";
import { confirmarSubida, MedioError } from "@/server/medios/store";
import { r2Enabled } from "@/server/storage";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 048 — Paso 3 de la subida directa: el servidor comprueba lo que el navegador dice haber subido (tamaño real y
 * formato por los bytes) y solo entonces el medio queda disponible. Idempotente. Un archivo que no cuadra se borra.
 */
export const POST = withAuth(async (session, _req: Request, ctx: Params) => {
  if (!r2Enabled()) return apiError(404, "not_found", "No encontrado");
  const { id } = await ctx.params;
  if (!/^med_[a-z0-9]{20}$/.test(id)) return apiError(404, "not_found", "Esa subida ya no existe.");
  try {
    const { medio, aviso } = await confirmarSubida({ organizationId: session.organizationId, userId: session.userId, id });
    return Response.json({ medio, aviso }, { status: 201 });
  } catch (err) {
    if (err instanceof MedioError) {
      const status = err.code === "not_found" ? 404 : err.code === "too_large" ? 413 : err.code === "unavailable" ? 503 : 422;
      return apiError(status, err.code, err.message);
    }
    throw err;
  }
});
