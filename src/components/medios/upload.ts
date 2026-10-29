import type { MedioDto } from "@/lib/medios";

/**
 * Módulo Medios — subir UN archivo a la biblioteca con el avance real (fetch no
 * lo reporta). La usan la pantalla de Medios y el selector de imagen de los
 * formularios, para que subir se comporte igual en los dos sitios.
 */
export function subirArchivo(
  file: File,
  onProgress: (fraccion: number) => void,
  /** Si se da, el servidor solo acepta ese tipo (el selector de imagen pide `image`). */
  soloTipo?: "image" | "video",
  /** Admite SVG (solo el selector de iconos). */
  icono?: boolean
): Promise<MedioDto> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", soloTipo ? `/api/medios?tipo=${soloTipo}${icono ? "&icono=1" : ""}` : "/api/medios");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: { medio?: MedioDto; error?: { message?: string } } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Respuesta que no es JSON (un proxy cortó la subida): se explica abajo.
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.medio) return resolve(body.medio);
      if (xhr.status === 401) return reject(new Error("Tu sesión expiró. Vuelve a iniciar sesión."));
      if (xhr.status === 413 && !body?.error) {
        return reject(new Error("El archivo es demasiado grande para el servidor."));
      }
      reject(new Error(body?.error?.message ?? "No se pudo subir el archivo. Inténtalo de nuevo."));
    };
    xhr.onerror = () => reject(new Error("No se pudo conectar. Revisa tu conexión e inténtalo de nuevo."));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}
