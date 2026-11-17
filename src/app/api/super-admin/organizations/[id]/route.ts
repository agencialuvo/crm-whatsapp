import { apiError } from "@/lib/api";
import { withSuperAdmin } from "@/lib/auth/super-admin";
import { getOrganizationDetail } from "@/server/super-admin/directory";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Una organización con la historia de su suscripción y el registro de auditoría. */
export const GET = withSuperAdmin(async (_admin, _req, ctx: Params) => {
  const { id } = await ctx.params;
  const detail = await getOrganizationDetail(id);
  if (!detail) return apiError(404, "not_found", "Organización no encontrada");
  return Response.json(detail);
});
