import { validarMedio, type MedioDto } from "@/lib/medios";

/**
 * Módulo Medios — subir UN archivo a la biblioteca con el avance real (fetch no
 * lo reporta). La usan la pantalla de Medios y el selector de imagen de los
 * formularios, para que subir se comporte igual en los dos sitios.
 *
 * 048: con el conector R2 encendido el navegador sube DIRECTO al bucket (los bytes no pasan por el servidor):
 * 1) pide una URL firmada (el servidor valida formato y peso), 2) hace el `PUT` con progreso, 3) confirma. Con R2
 * apagado (`/api/medios/subida` responde 404) se sube por el servidor como siempre; el resultado se recuerda.
 */

type Opciones = {
  /** Si se da, el servidor solo acepta ese tipo (el selector de imagen pide `image`). */
  soloTipo?: "image" | "video";
  /** Admite SVG (solo el selector de iconos). */
  icono?: boolean;
  /** Avisos no bloqueantes del servidor (p. ej. un MP4 que no parece H.264). */
  onAviso?: (aviso: string) => void;
};

/** `null` = aún no se sabe; `true` = R2 encendido; `false` = apagado (se sube por el servidor). */
let directa: boolean | null = null;

type ErrorApi = { error?: { message?: string } };

async function json<T>(res: Response): Promise<(T & ErrorApi) | null> {
  try {
    return (await res.json()) as T & ErrorApi;
  } catch {
    return null;
  }
}

function mensajeDe(status: number, body: ErrorApi | null, porDefecto: string): string {
  if (status === 401) return "Tu sesión expiró. Vuelve a iniciar sesión.";
  return body?.error?.message ?? porDefecto;
}

/** El `PUT` directo a R2 con progreso. Los errores de red/CORS se explican, no se tragan. */
function ponerEnR2(url: string, headers: Record<string, string>, file: File, onProgress: (f: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      if (xhr.status === 403) return reject(new Error("La subida expiró o no se permitió. Inténtalo de nuevo."));
      reject(new Error("No se pudo subir el archivo al almacenamiento. Inténtalo de nuevo."));
    };
    xhr.onerror = () =>
      reject(new Error("No se pudo conectar con el almacenamiento. Revisa tu conexión (o la configuración CORS del bucket)."));
    xhr.send(file);
  });
}

async function subirDirecto(file: File, onProgress: (f: number) => void, o: Opciones): Promise<MedioDto | "no-disponible"> {
  const res = await fetch("/api/medios/subida", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      nombre: file.name,
      mime: file.type || "application/octet-stream",
      bytes: file.size,
      ...(o.soloTipo ? { tipo: o.soloTipo } : {}),
      ...(o.icono ? { icono: true } : {}),
    }),
  }).catch(() => null);
  if (!res) throw new Error("No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.");
  if (res.status === 404) return "no-disponible";
  const firmada = await json<{ medio: MedioDto; subida: { url: string; headers: Record<string, string> } }>(res);
  if (!res.ok || !firmada?.subida) throw new Error(mensajeDe(res.status, firmada, "No se pudo preparar la subida. Inténtalo de nuevo."));

  // El avance del PUT ocupa casi toda la barra; el resto es la confirmación.
  await ponerEnR2(firmada.subida.url, firmada.subida.headers, file, (f) => onProgress(f * 0.95));

  const conf = await fetch(`/api/medios/subida/${firmada.medio.id}/confirmar`, { method: "POST" }).catch(() => null);
  if (!conf) throw new Error("El archivo se subió pero no se pudo confirmar. Inténtalo de nuevo.");
  const hecho = await json<{ medio: MedioDto; aviso: string | null }>(conf);
  if (!conf.ok || !hecho?.medio) throw new Error(mensajeDe(conf.status, hecho, "No se pudo confirmar el archivo. Inténtalo de nuevo."));
  onProgress(1);
  if (hecho.aviso) o.onAviso?.(hecho.aviso);
  return hecho.medio;
}

function subirPorServidor(file: File, onProgress: (f: number) => void, o: Opciones): Promise<MedioDto> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", o.soloTipo ? `/api/medios?tipo=${o.soloTipo}${o.icono ? "&icono=1" : ""}` : "/api/medios");
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
    // Cuerpo directo (no multipart): el servidor lo procesa en flujo y no carga el archivo entero.
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-Nombre", encodeURIComponent(file.name));
    xhr.send(file);
  });
}

export async function subirArchivo(
  file: File,
  onProgress: (fraccion: number) => void,
  /** Si se da, el servidor solo acepta ese tipo (el selector de imagen pide `image`). */
  soloTipo?: "image" | "video",
  /** Admite SVG (solo el selector de iconos). */
  icono?: boolean,
  onAviso?: (aviso: string) => void
): Promise<MedioDto> {
  const o: Opciones = { soloTipo, icono, onAviso };
  // Misma validación que hará el servidor, ANTES de pedir la firma: no se gasta una subida en algo que se rechazará.
  const v = validarMedio(file.name, file.type, file.size, { svg: icono === true });
  if (!v.ok) throw new Error(v.message);
  if (directa !== false) {
    const r = await subirDirecto(file, onProgress, o);
    if (r !== "no-disponible") {
      directa = true;
      return r;
    }
    directa = false;
  }
  return subirPorServidor(file, onProgress, o);
}
