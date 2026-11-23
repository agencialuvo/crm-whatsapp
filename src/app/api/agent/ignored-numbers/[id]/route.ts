import { apiError, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { removeIgnored } from "@/server/ai/ignored";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Quita un número de la lista. Surte efecto de inmediato: la lista es la fuente de verdad y no hay pausa copiada
 * en el contacto que limpiar. Una entrada de otra organización responde 404, igual que una que no existe.
 */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const { id } = await ctx.params;
  const removed = await removeIgnored(session.organizationId, id);
  if (!removed) return apiError(404, "not_found", "Ese número no está en la lista");
  return Response.json({ ok: true });
});
