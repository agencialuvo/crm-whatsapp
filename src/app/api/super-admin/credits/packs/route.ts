import { apiError, parseBody } from "@/lib/api";
import { auditIp, withSuperAdmin } from "@/lib/auth/super-admin";
import { packCreateSchema } from "@/lib/super-admin-credits";
import { packCreate, packsOverview } from "@/server/super-admin/credits";

export const dynamic = "force-dynamic";

/** El catálogo de paquetes de recarga completo (activos e inactivos). Solo Super Admin. */
export const GET = withSuperAdmin(async () => Response.json({ packs: await packsOverview() }));

/** Crea un paquete. Nombre único (sin distinguir mayúsculas), monedas y precio mayores que 0, máximo 50 paquetes. */
export const POST = withSuperAdmin(async (admin, req) => {
  const body = await parseBody(req, packCreateSchema);
  if (!body.ok) return body.response;
  const r = await packCreate({ userId: admin.userId, email: admin.email, ip: auditIp(req) }, body.data);
  if (!r.ok) return apiError(r.status, r.code, r.message);
  return Response.json({ pack: r.pack }, { status: 201 });
});
