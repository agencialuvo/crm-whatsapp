import {
  baseMime,
  isForbiddenUploadMime,
} from "@/server/whatsapp/media-headers";
import { kindFromMime, MediaValidationError, validateOutgoing } from "@/server/whatsapp/media";

/**
 * Hallazgo A de la auditoría — el adjunto que un operador manda a mano desde la bandeja
 * (`POST /api/conversations/:id/messages/media`).
 *
 * Esa ruta carga el archivo ENTERO en memoria (el formulario multipart, el `File`, el `Buffer` y la subida a Meta), y un
 * documento de 100 MB tumbaba una instancia de 512 MB. Aquí viven las tres defensas, todas puras para poder probarlas:
 *
 * 1. Un tope de cuerpo (`MAX_CUERPO_ADJUNTO_BYTES`) que se aplica ANTES de leer y mientras se lee, aunque el
 *    `Content-Length` falte o mienta (`leerFormularioAcotado`).
 * 2. Un tope por tipo (`MAX_ADJUNTO_MANUAL_BYTES`): el de WhatsApp, y 16 MB para documentos (WhatsApp admite 100 MB,
 *    pero aquí no caben en memoria). Los adjuntos ENTRANTES no se tocan: se guardan en streaming.
 * 3. El tipo real por los bytes de la cabecera, no por el `Content-Type` que declara el cliente.
 */

const MB = 1024 * 1024;

/** Cuánto puede pesar el adjunto según el tipo con que WhatsApp lo trata. */
export const MAX_ADJUNTO_MANUAL_BYTES = {
  image: 5 * MB,
  audio: 16 * MB,
  video: 16 * MB,
  document: 16 * MB,
} as const;

/** Tope del CUERPO completo: el mayor de los topes más el sobre del multipart y el pie de foto. */
export const MAX_CUERPO_ADJUNTO_BYTES = 16 * MB + 64 * 1024;

/** Cuántos bytes del principio bastan para reconocer los formatos de abajo (y para ver si es una página HTML/SVG). */
export const BYTES_CABECERA_ADJUNTO = 4096;

type Familia = "image" | "audio" | "video" | "document";
type Reconocido = { mime: string; familia: Familia };

function ascii(b: Uint8Array, desde: number, hasta: number): string {
  let s = "";
  for (let i = desde; i < hasta && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

/** ¿Empieza como una página (HTML) o un SVG? Un navegador la ejecutaría; no se manda aunque diga ser un PDF. */
function pareceDocumentoActivo(b: Uint8Array): boolean {
  const texto = new TextDecoder("utf-8").decode(b.subarray(0, BYTES_CABECERA_ADJUNTO)).replace(/^﻿/, "");
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+(?:html|svg)[^>]*>\s*)?<(?:html|head|body|script|svg|iframe)[\s>/]/i.test(
    texto
  );
}

/** El formato que dicen los bytes, o `null` si no es ninguno de los que se saben reconocer. */
export function reconocerPorBytes(b: Uint8Array): Reconocido | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", familia: "image" };
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { mime: "image/png", familia: "image" };
  }
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { mime: "image/webp", familia: "image" };
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return { mime: "image/gif", familia: "image" };
  if (b.length >= 5 && ascii(b, 0, 5) === "%PDF-") return { mime: "application/pdf", familia: "document" };
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") {
    const marca = ascii(b, 8, 12);
    const m = marca.toLowerCase();
    if (m === "avif" || m === "avis") return { mime: "image/avif", familia: "image" };
    if (m.startsWith("3g")) return { mime: "video/3gpp", familia: "video" };
    if (m === "m4a " || m === "m4b ") return { mime: "audio/mp4", familia: "audio" };
    return { mime: "video/mp4", familia: "video" }; // isom, mp42, avc1, qt…: cualquier otra marca de contenedor MP4
  }
  if (b.length >= 4 && ascii(b, 0, 4) === "OggS") return { mime: "audio/ogg", familia: "audio" };
  if (b.length >= 5 && ascii(b, 0, 5) === "#!AMR") return { mime: "audio/amr", familia: "audio" };
  if (b.length >= 3 && ascii(b, 0, 3) === "ID3") return { mime: "audio/mpeg", familia: "audio" };
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) {
    // Sincronía de cuadro de audio: capa 00 con 0xF? = AAC en ADTS; cualquier otra capa válida = MPEG (mp3).
    const capa = (b[1]! >> 1) & 0x03;
    if (capa === 0 && (b[1]! & 0xf0) === 0xf0) return { mime: "audio/aac", familia: "audio" };
    if (capa !== 0) return { mime: "audio/mpeg", familia: "audio" };
  }
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return { mime: "application/zip", familia: "document" };
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1) {
    return { mime: "application/x-ole-storage", familia: "document" };
  }
  return null;
}

const GENERICOS = new Set(["application/octet-stream", "binary/octet-stream"]);
const ES_OPENXML = /^application\/vnd\.openxmlformats-officedocument\./;

export type AdjuntoValidado = { mimeType: string; kind: "image" | "audio" | "video" | "document" };

/**
 * Valida un adjunto saliente con lo que se sabe ANTES de cargarlo entero: tamaño declarado por el archivo y los primeros
 * bytes. Lanza `MediaValidationError` (`empty` / `too_large` / `unsupported_type`) o devuelve el tipo verificado, que es
 * el que se debe usar de ahí en adelante (el declarado por el cliente se descarta si los bytes lo contradicen).
 *
 * - Lo que WhatsApp trata como imagen/audio/video: los bytes tienen que ser de esa familia, y el MIME final es el
 *   detectado.
 * - HTML y SVG se rechazan por contenido, aunque se declaren como otra cosa.
 * - `application/pdf` y Office moderno (zip) tienen que traer su firma. Si se declara tipo genérico y se reconoce, se
 *   usa el reconocido. Otros documentos (txt, csv…) no tienen firma que comprobar y pasan.
 */
export function validarAdjuntoManual(input: { mimeType: string | null | undefined; size: number; head: Uint8Array }): AdjuntoValidado {
  if (!Number.isFinite(input.size) || input.size <= 0) {
    throw new MediaValidationError("empty", "El archivo está vacío");
  }
  const declarado = baseMime(input.mimeType) ?? "application/octet-stream";
  if (isForbiddenUploadMime(declarado) || pareceDocumentoActivo(input.head)) {
    throw new MediaValidationError(
      "unsupported_type",
      "Los archivos HTML y SVG no se pueden enviar como adjunto: un navegador los abriría como página. Conviértelo a PDF o a imagen"
    );
  }

  // Tamaño contra el límite de la Cloud API (con el MIME declarado) y luego contra el tope de memoria de la bandeja.
  let kind = validateOutgoing(declarado, input.size);
  const topeDocumento = MAX_ADJUNTO_MANUAL_BYTES.document;
  if (kind === "document" && input.size > topeDocumento) {
    throw new MediaValidationError("too_large", `El archivo excede el límite de documento (máx. ${topeDocumento / MB} MB desde la bandeja)`);
  }

  const real = reconocerPorBytes(input.head);
  const familiaDeclarada = declarado.split("/")[0];
  let mimeType = declarado;

  if (kind !== "document") {
    // Imagen, audio o video «nativo»: tiene que serlo de verdad.
    if (!real || real.familia !== kind) {
      throw new MediaValidationError("unsupported_type", `El contenido del archivo no es ${etiqueta(kind)}: no coincide con el tipo que declara (${declarado})`);
    }
    mimeType = real.mime;
  } else {
    if (real && (familiaDeclarada === "image" || familiaDeclarada === "audio" || familiaDeclarada === "video") && real.familia !== familiaDeclarada) {
      throw new MediaValidationError("unsupported_type", `El contenido del archivo no coincide con el tipo que declara (${declarado})`);
    }
    if (declarado === "application/pdf" && real?.mime !== "application/pdf") {
      throw new MediaValidationError("unsupported_type", "El archivo dice ser un PDF pero su contenido no lo es");
    }
    if ((ES_OPENXML.test(declarado) || declarado === "application/zip") && real?.mime !== "application/zip") {
      throw new MediaValidationError("unsupported_type", `El archivo dice ser «${declarado}» pero su contenido no lo es`);
    }
    if (GENERICOS.has(declarado) && real) mimeType = real.mime === "application/x-ole-storage" ? declarado : real.mime;
  }

  // Un tipo reconocido puede cambiar la clase (octet-stream + bytes de JPEG → imagen): se vuelve a medir con la clase real.
  kind = kindFromMime(mimeType);
  if (kind !== "document" || mimeType !== declarado) validateOutgoing(mimeType, input.size);
  if (kind === "document" && input.size > topeDocumento) {
    throw new MediaValidationError("too_large", `El archivo excede el límite de documento (máx. ${topeDocumento / MB} MB desde la bandeja)`);
  }
  return { mimeType, kind };
}

function etiqueta(kind: "image" | "audio" | "video"): string {
  return kind === "image" ? "una imagen (jpeg/png/webp)" : kind === "audio" ? "un audio compatible" : "un video compatible (mp4/3gpp)";
}

export class CuerpoDemasiadoGrande extends Error {
  constructor() {
    super("El cuerpo de la petición excede el límite");
    this.name = "CuerpoDemasiadoGrande";
  }
}

/**
 * Lee el formulario multipart contando los bytes que llegan: en cuanto pasan de `maxBytes` se corta la lectura y se
 * lanza `CuerpoDemasiadoGrande`, sin importar lo que diga (o calle) `Content-Length`. Así un cuerpo enorme nunca se
 * termina de cargar para rechazarlo después.
 */
export async function leerFormularioAcotado(req: Request, maxBytes: number): Promise<FormData> {
  if (!req.body) throw new TypeError("La petición no trae cuerpo");
  const estado = { total: 0, excedido: false };
  const contador = new TransformStream<Uint8Array, Uint8Array>({
    transform(trozo, controller) {
      estado.total += trozo.byteLength;
      if (estado.total > maxBytes) {
        estado.excedido = true;
        controller.error(new CuerpoDemasiadoGrande());
        return;
      }
      controller.enqueue(trozo);
    },
  });
  try {
    return await new Response(req.body.pipeThrough(contador), {
      headers: { "content-type": req.headers.get("content-type") ?? "" },
    }).formData();
  } catch (err) {
    if (estado.excedido) throw new CuerpoDemasiadoGrande();
    throw err;
  }
}
