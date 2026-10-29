import { apiError, withAuth } from "@/lib/api";
import { MAX_SUBIDA_BYTES } from "@/lib/medios";
import { crearMedio, listarMedios, MedioError } from "@/server/medios/store";

export const dynamic = "force-dynamic";

/** Módulo Medios — la biblioteca de la organización, lo más nuevo primero. */
export const GET = withAuth(async (session, req: Request) => {
  const tipo = new URL(req.url).searchParams.get("tipo");
  if (tipo !== null && tipo !== "image" && tipo !== "video") {
    return apiError(422, "invalid_query", "tipo debe ser image o video");
  }
  return Response.json({ medios: await listarMedios(session.organizationId, tipo ?? undefined) });
});

/**
 * Sube UN archivo desde el dispositivo (`multipart/form-data`, campo `file`).
 * El cliente manda los archivos de a uno para poder enseñar el avance y para
 * que uno que no cumple no tire a los demás.
 */
export const POST = withAuth(async (session, req: Request) => {
  // Antes de leer el cuerpo: un archivo enorme no se carga en memoria para
  // rechazarlo después.
  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (declarado > MAX_SUBIDA_BYTES) {
    return apiError(413, "too_large", "El archivo es demasiado grande (el máximo es 50 MB, para MP4).");
  }

  const soloTipo = new URL(req.url).searchParams.get("tipo");
  if (soloTipo !== null && soloTipo !== "image" && soloTipo !== "video") {
    return apiError(422, "invalid_query", "tipo debe ser image o video");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError(422, "invalid_body", "La subida no llegó completa. Inténtalo de nuevo.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return apiError(422, "invalid_body", "Falta el archivo (campo «file»).");
  }

  try {
    const medio = await crearMedio({
      organizationId: session.organizationId,
      userId: session.userId,
      data: Buffer.from(await file.arrayBuffer()),
      nombre: file.name || "medio",
      source: "upload",
      soloTipo: soloTipo ?? undefined,
      // Solo el selector de iconos (`?icono=1`) admite SVG.
      permitirSvg: new URL(req.url).searchParams.get("icono") === "1" && soloTipo === "image",
    });
    return Response.json({ medio }, { status: 201 });
  } catch (err) {
    if (err instanceof MedioError) {
      return apiError(err.code === "too_large" ? 413 : 422, err.code, err.message);
    }
    throw err;
  }
});
