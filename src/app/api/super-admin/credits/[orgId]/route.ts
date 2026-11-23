import { apiError, parseBody } from "@/lib/api";
import { withSuperAdmin } from "@/lib/auth/super-admin";
import { creditsActionSchema } from "@/lib/super-admin-credits";
import { applyCreditsAction, creditsOrgDetail } from "@/server/super-admin/credits";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/** El saldo de una organización: cuenta, últimos movimientos del libro y últimos `wouldCut`. */
export const GET = withSuperAdmin(async (_admin, _req, ctx: Params) => {
  const { orgId } = await ctx.params;
  const detail = await creditsOrgDetail(orgId);
  if (!detail) return apiError(404, "not_found", "Organización no encontrada");
  return Response.json(detail);
});

/**
 * Un ajuste manual de saldo (con motivo; queda en el libro con quién lo hizo) o activar/desactivar el corte de ESA
 * organización. Idempotente por `requestId`. Con `CREDITS` apagada responde 409 y no cambia nada.
 */
export const POST = withSuperAdmin(async (admin, req, ctx: Params) => {
  const { orgId } = await ctx.params;
  const body = await parseBody(req, creditsActionSchema);
  if (!body.ok) return body.response;
  const result = await applyCreditsAction(admin, orgId, body.data);
  if (!result.ok) return apiError(result.status, result.code, result.message);
  const detail = await creditsOrgDetail(orgId);
  return Response.json({ ok: true, duplicate: result.duplicate, detail });
});
