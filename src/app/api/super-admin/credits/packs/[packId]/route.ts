import { apiError, parseBody } from "@/lib/api";
import { auditIp, withSuperAdmin } from "@/lib/auth/super-admin";
import { packUpdateSchema } from "@/lib/super-admin-credits";
import { packUpdate } from "@/server/super-admin/credits";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ packId: string }> };

/**
 * Edita un paquete (nombre, monedas, precio, moneda, orden) o lo activa/desactiva. Nunca se borra: las compras ya
 * hechas copian sus unidades y precio, así que cambiar o desactivar un paquete no las altera.
 */
export const PATCH = withSuperAdmin(async (admin, req, ctx: Params) => {
  const { packId } = await ctx.params;
  const body = await parseBody(req, packUpdateSchema);
  if (!body.ok) return body.response;
  const r = await packUpdate({ userId: admin.userId, email: admin.email, ip: auditIp(req) }, packId, body.data);
  if (!r.ok) return apiError(r.status, r.code, r.message);
  return Response.json({ pack: r.pack, changed: r.changed });
});
