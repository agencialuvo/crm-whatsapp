import { apiError, withAuth } from "@/lib/api";
import { BULK_FILENAMES, BULK_MODULES, type BulkModule } from "@/lib/salon/bulk";
import { buildTemplate } from "@/server/business/bulk-import";
import { salonGate } from "@/server/business/http";

export const dynamic = "force-dynamic";

/** La plantilla Excel del módulo (`?modulo=`), con los encabezados exactos y filas de ejemplo. */
export const GET = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const modulo = new URL(req.url).searchParams.get("modulo");
  if (!BULK_MODULES.includes(modulo as BulkModule)) {
    return apiError(422, "invalid_query", "modulo debe ser servicios, equipo o clientes");
  }
  const buffer = await buildTemplate(modulo as BulkModule);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${BULK_FILENAMES[modulo as BulkModule]}"`,
      "cache-control": "no-store",
    },
  });
});
