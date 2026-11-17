import { apiError, } from "@/lib/api";
import { withSuperAdmin } from "@/lib/auth/super-admin";
import { organizationsQuerySchema } from "@/lib/super-admin";
import { listOrganizations } from "@/server/super-admin/directory";

export const dynamic = "force-dynamic";

/** El directorio de organizaciones con su dueño, plan y estado (hasta 5 000 filas). */
export const GET = withSuperAdmin(async (_admin, req) => {
  const parsed = organizationsQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return apiError(422, "invalid_query", parsed.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; "));
  }
  const { q, plan, status, limit } = parsed.data;
  const organizations = await listOrganizations({ q: q || undefined, plan: plan || undefined, status, limit });
  return Response.json({ organizations, serverTime: new Date().toISOString() });
});
