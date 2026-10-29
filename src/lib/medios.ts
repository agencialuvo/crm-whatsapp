/**
 * Módulo Medios — reglas de formato y peso, compartidas por el cliente (para
 * avisar ANTES de subir) y el servidor (que es quien las hace valer: la
 * validación del navegador es comodidad, no seguridad).
 *
 * Sin GIF a propósito. El SVG solo se admite como icono (los sellos de la
 * tarjeta de fidelidad): únicamente donde quien sube lo pide (`svg: true`), y
 * el servidor lo revisa por dentro (sin guiones ni enlaces externos). El resto
 * del sistema (WhatsApp, Meta) no lo quiere.
 */

const MB = 1024 * 1024;

export type MedioTipo = "image" | "video";

export type FormatoMedio = {
  /** Extensión canónica, sin punto. */
  ext: string;
  mime: string;
  tipo: MedioTipo;
  maxBytes: number;
  /** Cómo se le llama al formato en los avisos. */
  etiqueta: string;
  /** Solo se acepta cuando quien sube lo pide (iconos), nunca en la biblioteca general. */
  soloIcono?: boolean;
};

/** Opciones de subida: `svg` admite SVG (solo el selector de iconos lo pide). */
export type OpcionesFormato = { svg?: boolean };

/** Imágenes estándar: hasta 3 MB. Modernas (webp/avif): hasta 1,5 MB. Video mp4: hasta 50 MB. */
export const FORMATOS_MEDIO: readonly FormatoMedio[] = [
  { ext: "jpg", mime: "image/jpeg", tipo: "image", maxBytes: 3 * MB, etiqueta: "JPG" },
  { ext: "png", mime: "image/png", tipo: "image", maxBytes: 3 * MB, etiqueta: "PNG" },
  { ext: "webp", mime: "image/webp", tipo: "image", maxBytes: 1.5 * MB, etiqueta: "WEBP" },
  { ext: "avif", mime: "image/avif", tipo: "image", maxBytes: 1.5 * MB, etiqueta: "AVIF" },
  { ext: "mp4", mime: "video/mp4", tipo: "video", maxBytes: 50 * MB, etiqueta: "MP4" },
  { ext: "svg", mime: "image/svg+xml", tipo: "image", maxBytes: 256 * 1024, etiqueta: "SVG", soloIcono: true },
];

/** Lo que hay que mandarle a `<input type="file" accept>`. */
export const ACCEPT_MEDIOS = ".jpg,.jpeg,.png,.webp,.avif,.mp4,image/jpeg,image/png,image/webp,image/avif,video/mp4";

/** Lo mismo, solo imágenes (selector de imagen de los formularios). */
export const ACCEPT_IMAGENES = ".jpg,.jpeg,.png,.webp,.avif,image/jpeg,image/png,image/webp,image/avif";

/** Imágenes más SVG (selector de iconos). */
export const ACCEPT_ICONOS = `${ACCEPT_IMAGENES},.svg,image/svg+xml`;

/** Tope del cuerpo de una subida: el mayor de los límites más el sobre del multipart. */
export const MAX_SUBIDA_BYTES = 50 * MB + 64 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0).replace(".", ",")} MB`;
}

/** Los límites de las imágenes, para el selector que no admite video. */
export function resumenDeLimitesImagen(): string {
  return "JPG y PNG hasta 3 MB · WEBP y AVIF hasta 1,5 MB";
}

/** Los límites del selector de iconos: las imágenes y el SVG. */
export function resumenDeLimitesIcono(): string {
  return `${resumenDeLimitesImagen()} · SVG hasta 256 KB`;
}

/** Texto de ayuda con los límites, para la zona de subida. */
export function resumenDeLimites(): string {
  return "JPG y PNG hasta 3 MB · WEBP y AVIF hasta 1,5 MB · MP4 hasta 50 MB";
}

function extensionDe(nombre: string): string {
  const i = nombre.lastIndexOf(".");
  return i < 0 ? "" : nombre.slice(i + 1).toLowerCase();
}

/** Busca el formato por MIME y, si el navegador no lo declara, por extensión. */
export function formatoDe(nombre: string, mime: string, opts: OpcionesFormato = {}): FormatoMedio | null {
  const m = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const admitidos = FORMATOS_MEDIO.filter((f) => !f.soloIcono || opts.svg);
  const porMime = admitidos.find((f) => f.mime === m);
  if (porMime) return porMime;
  const ext = extensionDe(nombre);
  const canonica = ext === "jpeg" ? "jpg" : ext;
  // Sin MIME declarado se cree la extensión; con un MIME que no es de la lista
  // no (un `.mp4` que dice ser `text/html` es justo lo que no se quiere).
  if (m && m !== "application/octet-stream") return null;
  return admitidos.find((f) => f.ext === canonica) ?? null;
}

export type ValidacionMedio =
  | { ok: true; formato: FormatoMedio }
  | { ok: false; code: "empty" | "unsupported_type" | "too_large"; message: string };

/**
 * ¿Se puede subir este archivo? Los mensajes están pensados para enseñarse tal
 * cual: dicen qué pasó y cuál es el límite que aplica a ese formato.
 */
export function validarMedio(
  nombre: string,
  mime: string,
  bytes: number,
  opts: OpcionesFormato = {}
): ValidacionMedio {
  const formato = formatoDe(nombre, mime, opts);
  if (!formato) {
    return {
      ok: false,
      code: "unsupported_type",
      message: `«${nombre}» no es un formato válido. Se aceptan JPG, PNG, WEBP, AVIF${opts.svg ? ", SVG" : ""} y MP4.`,
    };
  }
  if (bytes <= 0) {
    return { ok: false, code: "empty", message: `«${nombre}» está vacío.` };
  }
  if (bytes > formato.maxBytes) {
    return {
      ok: false,
      code: "too_large",
      message: `«${nombre}» pesa ${formatBytes(bytes)} y el máximo para ${formato.etiqueta} es ${formatBytes(formato.maxBytes)}.`,
    };
  }
  return { ok: true, formato };
}

/** Nombre mostrable a partir de una URL o archivo: sin ruta, sin extensión, acotado. */
export function nombreLegible(crudo: string): string {
  const sinRuta = crudo.split(/[\\/]/).pop() ?? crudo;
  const sinQuery = sinRuta.split(/[?#]/)[0] ?? sinRuta;
  let decodificado = sinQuery;
  try {
    decodificado = decodeURIComponent(sinQuery);
  } catch {
    // Un % suelto: se queda como vino.
  }
  const i = decodificado.lastIndexOf(".");
  const base = i > 0 ? decodificado.slice(0, i) : decodificado;
  // Fuera caracteres de control.
  const limpio = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (limpio || "medio").slice(0, 120);
}

/** Cómo viaja un medio por la API. */
export type MedioDto = {
  id: string;
  nombre: string;
  tipo: MedioTipo;
  mime: string;
  bytes: number;
  origen: "archivo" | "url";
  /** La URL de origen, cuando se trajo de un enlace. */
  urlOrigen: string | null;
  /** Ruta (relativa al origen) del archivo servido: `/api/medios/<id>/archivo`. */
  ruta: string;
  creadoEn: string;
};
