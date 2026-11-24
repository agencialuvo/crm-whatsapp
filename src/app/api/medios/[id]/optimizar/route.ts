import { apiError, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { MedioError, reintentarOptimizacion } from "@/server/medios/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * «Reintentar optimización» de un video de la biblioteca: lo vuelve a encolar (intentos en 0, espera borrada) y despierta
 * al trabajador. Quien lo subió, el dueño o un administrador. Devuelve el medio actualizado.
 * 401 sin sesión · 403 sin permiso · 404 no existe · 409 ya está listo/enviable o la cola está inactiva · 410 falta el original.
 */
export const POST = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  if (!/^med_[a-z0-9]{20}$/.test(id)) return apiError(404, "not_found", "Ese archivo ya no existe.");
  try {
    const medio = await reintentarOptimizacion({
      organizationId: session.organizationId,
      userId: session.userId,
      puedeAdministrar: canConfigure(session.role),
      id,
    });
    return Response.json({ medio });
  } catch (err) {
    if (err instanceof MedioError) {
      const status = err.code === "forbidden" ? 403 : err.code === "conflict" ? 409 : err.code === "gone" ? 410 : 404;
      return apiError(status, err.code, err.message);
    }
    throw err;
  }
});
