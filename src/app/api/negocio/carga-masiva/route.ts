import { apiError, withAuth } from "@/lib/api";
import { BULK_MAX_BYTES, BULK_MODULES, type BulkModule } from "@/lib/salon/bulk";
import { runImport } from "@/server/business/bulk-import";
import { salonErrorResponse, salonGate } from "@/server/business/http";

export const dynamic = "force-dynamic";

/**
 * Carga masiva desde Excel (`multipart/form-data`, campo `file`; `?modulo=` es
 * servicios, equipo o clientes). Es configuración y datos del negocio: solo
 * dueño o administrador. Las filas válidas se importan en lotes y las malas
 * vuelven con su fila y columna, sin frenar a las demás.
 */
export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;

  const modulo = new URL(req.url).searchParams.get("modulo");
  if (!BULK_MODULES.includes(modulo as BulkModule)) {
    return apiError(422, "invalid_query", "modulo debe ser servicios, equipo o clientes");
  }
  // Antes de leer el cuerpo: un archivo enorme no se carga en memoria para rechazarlo.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > BULK_MAX_BYTES + 64 * 1024) {
    return apiError(413, "too_large", "El archivo pesa más de 2 MB. Divídelo en partes.");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError(422, "invalid_body", "La subida no llegó completa. Inténtalo de nuevo.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return apiError(422, "invalid_body", "Falta el archivo (campo «file»).");

  try {
    const result = await runImport(session.organizationId, modulo as BulkModule, Buffer.from(await file.arrayBuffer()));
    return Response.json(result);
  } catch (err) {
    return salonErrorResponse(err);
  }
});
