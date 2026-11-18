import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { lecturaDe, medioPublico } from "@/server/medios/store";
import { objectStore } from "@/server/storage";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Sirve el archivo de un medio. **Ruta pública**: es la URL que el botón
 * «Copiar URL» entrega para pegarla en otras partes (una plantilla, un
 * anuncio, el sitio web), y esas partes no llevan la sesión del CRM. Lo
 * protege el id —20 caracteres al azar— y que no hay forma de listar medios
 * sin sesión. Es el mismo trato que el icono de la marca.
 *
 * Es contenido que subió una persona, servido desde el origen de la sesión:
 * `nosniff` + una CSP que no deja ejecutar nada (misma receta que los
 * adjuntos, #78). El tipo sale de lo que se detectó al guardar, no de lo que
 * el archivo decía ser. Acepta `Range`, sin el cual Safari no reproduce video.
 */
function cabeceras(mime: string, extra: Record<string, string> = {}): Headers {
  return new Headers({
    "content-type": mime,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "cross-origin",
    "accept-ranges": "bytes",
    // El id no se reutiliza ni el contenido cambia: se puede cachear para siempre.
    "cache-control": "public, max-age=31536000, immutable",
    ...extra,
  });
}

export async function GET(req: Request, ctx: Params) {
  const { id } = await ctx.params;
  const medio = await medioPublico(id);
  if (!medio) return new Response("No encontrado", { status: 404 });

  const lectura = lecturaDe(medio);
  const descargar = new URL(req.url).searchParams.has("descargar");
  const nombre = `${medio.name.replace(/[^\w.-]+/g, "_") || "medio"}.${medio.mimeType.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") ?? "bin"}`;

  // 048: un archivo en R2 NO pasa por este servidor: se redirige a una URL firmada de 10 min y los bytes salen de R2
  // directo al visitante. El enlace público (el id) no caduca; lo que vence es la firma interna.
  if (lectura.donde === "r2") {
    const r2 = objectStore();
    if (!r2) return new Response("El almacenamiento no está disponible", { status: 503 });
    const url = await r2
      .signRead(lectura.clave, { fileName: nombre, download: descargar, contentType: medio.mimeType, ttlSeconds: 600 })
      .catch(() => null);
    if (!url) return new Response("El almacenamiento no está disponible", { status: 503 });
    return new Response(null, { status: 302, headers: { location: url, "cache-control": "private, max-age=300" } });
  }

  const archivo = lectura.ruta;
  let tam: number;
  try {
    tam = (await stat(archivo)).size;
  } catch {
    return new Response("El archivo no está en el volumen", { status: 410 });
  }

  const disposicion = `${descargar ? "attachment" : "inline"}; filename="${nombre}"`;

  const rango = req.headers.get("range");
  if (rango) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rango.trim());
    let inicio = m && m[1] !== "" ? Number(m[1]) : NaN;
    let fin = m && m[2] !== "" ? Number(m[2]) : NaN;
    if (!m || (Number.isNaN(inicio) && Number.isNaN(fin))) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${tam}` } });
    }
    if (Number.isNaN(inicio)) {
      // «bytes=-500»: los últimos 500.
      inicio = Math.max(0, tam - fin);
      fin = tam - 1;
    } else if (Number.isNaN(fin) || fin >= tam) {
      fin = tam - 1;
    }
    if (inicio > fin || inicio >= tam) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${tam}` } });
    }
    const cuerpo = Readable.toWeb(createReadStream(archivo, { start: inicio, end: fin })) as ReadableStream;
    return new Response(cuerpo, {
      status: 206,
      headers: cabeceras(medio.mimeType, {
        "content-range": `bytes ${inicio}-${fin}/${tam}`,
        "content-length": String(fin - inicio + 1),
        "content-disposition": disposicion,
      }),
    });
  }

  const cuerpo = Readable.toWeb(createReadStream(archivo)) as ReadableStream;
  return new Response(cuerpo, {
    headers: cabeceras(medio.mimeType, {
      "content-length": String(tam),
      "content-disposition": disposicion,
    }),
  });
}
