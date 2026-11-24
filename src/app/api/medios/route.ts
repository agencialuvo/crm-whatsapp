import { apiError, withAuth } from "@/lib/api";
import { maxSubidaBytes, MAX_SUBIDA_MULTIPART_BYTES } from "@/lib/medios";
import { videoOptimizeEnabled } from "@/server/medios/flag";
import { crearMedio, crearMedioDesdeFlujo, listarMedios, MedioError } from "@/server/medios/store";

export const dynamic = "force-dynamic";

/** Módulo Medios — la biblioteca de la organización, lo más nuevo primero. */
export const GET = withAuth(async (session, req: Request) => {
  const tipo = new URL(req.url).searchParams.get("tipo");
  if (tipo !== null && tipo !== "image" && tipo !== "video" && tipo !== "document") {
    return apiError(422, "invalid_query", "tipo debe ser image, video o document");
  }
  return Response.json({ medios: await listarMedios(session.organizationId, tipo ?? undefined) });
});

/** El nombre que manda el cliente en la cabecera `X-Nombre` (codificado, porque una cabecera no admite tildes). */
function nombreDeCabecera(req: Request): string {
  const crudo = req.headers.get("x-nombre") ?? "";
  try {
    return decodeURIComponent(crudo).trim() || "medio";
  } catch {
    return crudo.trim() || "medio";
  }
}

/**
 * Sube UN archivo desde el dispositivo. El cliente manda los archivos de a uno
 * para poder enseñar el avance y para que uno que no cumple no tire a los demás.
 *
 * Dos formas de mandarlo:
 * - **Cuerpo directo** (lo que usa la pantalla): los bytes del archivo tal cual,
 *   con el nombre en `X-Nombre`. Se procesa en flujo, así que un video de hasta
 *   5 GB no pasa por la memoria del servidor.
 * - **`multipart/form-data`** (campo `file`): compatibilidad con quien ya lo usa.
 *   El servidor lo carga entero, por eso su tope es el de antes (50 MB).
 */
export const POST = withAuth(async (session, req: Request) => {
  const soloTipo = new URL(req.url).searchParams.get("tipo");
  if (soloTipo !== null && soloTipo !== "image" && soloTipo !== "video") {
    return apiError(422, "invalid_query", "tipo debe ser image o video");
  }
  // Solo el selector de iconos (`?icono=1`) admite SVG.
  const permitirSvg = new URL(req.url).searchParams.get("icono") === "1" && soloTipo === "image";
  const multipart = (req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");

  // Antes de leer el cuerpo: un archivo enorme no se acepta para rechazarlo después.
  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (multipart && declarado > MAX_SUBIDA_MULTIPART_BYTES) {
    return apiError(413, "too_large", "Esta forma de subir admite hasta 50 MB; para un archivo mayor manda los bytes directos en el cuerpo.");
  }
  // Con `MEDIA_VIDEO_OPTIMIZE` el video admite hasta 250 MB (cuerpo directo, en flujo a disco); sin ella, 16 MB como siempre.
  const optimizarVideo = videoOptimizeEnabled();
  if (declarado > maxSubidaBytes(optimizarVideo)) {
    return apiError(413, "too_large", `El archivo es demasiado grande (el máximo es ${optimizarVideo ? "250" : "16"} MB).`);
  }

  try {
    if (multipart) {
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
      const medio = await crearMedio({
        organizationId: session.organizationId,
        userId: session.userId,
        data: Buffer.from(await file.arrayBuffer()),
        nombre: file.name || "medio",
        source: "upload",
        soloTipo: soloTipo ?? undefined,
        permitirSvg,
      });
      return Response.json({ medio }, { status: 201 });
    }

    if (!req.body) {
      return apiError(422, "invalid_body", "Falta el archivo en el cuerpo de la petición.");
    }
    const medio = await crearMedioDesdeFlujo({
      organizationId: session.organizationId,
      userId: session.userId,
      flujo: req.body,
      nombre: nombreDeCabecera(req),
      soloTipo: soloTipo ?? undefined,
      permitirSvg,
    });
    return Response.json({ medio }, { status: 201 });
  } catch (err) {
    if (err instanceof MedioError) {
      return apiError(err.code === "too_large" ? 413 : err.code === "unavailable" ? 503 : 422, err.code, err.message);
    }
    throw err;
  }
});
