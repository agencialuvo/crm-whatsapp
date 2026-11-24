/**
 * Módulo Medios — reglas de formato y peso, compartidas por el cliente (para
 * avisar ANTES de subir) y el servidor (que es quien las hace valer: la
 * validación del navegador es comodidad, no seguridad).
 *
 * Video: por defecto solo MP4 de hasta 16 MB. Con la bandera `MEDIA_VIDEO_OPTIMIZE` (que el servidor lee y el cliente recibe
 * ya resuelta) entran MP4 y MOV de hasta 250 MB para optimizarlos a una variante apta para WhatsApp.
 *
 * Sin GIF a propósito. El SVG solo se admite como icono (los sellos de la
 * tarjeta de fidelidad): únicamente donde quien sube lo pide (`svg: true`), y
 * el servidor lo revisa por dentro (sin guiones ni enlaces externos). El resto
 * del sistema (WhatsApp, Meta) no lo quiere.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

export type MedioTipo = "image" | "video" | "document";

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
  /** 048: WhatsApp no lo admite como adjunto (se puede guardar y usar en otros sitios, pero no enviar). */
  noWhatsapp?: boolean;
  /** Solo se acepta con la bandera `MEDIA_VIDEO_OPTIMIZE` (se optimiza a una variante antes de poder enviarse). */
  soloOptimizar?: boolean;
};

/**
 * Opciones de subida: `svg` admite SVG (solo el selector de iconos lo pide); `optimizarVideo` es la bandera
 * `MEDIA_VIDEO_OPTIMIZE` ya resuelta (admite MOV y sube el tope de entrada del video a 250 MB).
 */
export type OpcionesFormato = { svg?: boolean; optimizarVideo?: boolean };

/** WhatsApp Cloud API no manda un video de más de 16 MB: es el tope duro de lo ENVIABLE y de la variante (048). */
export const MAX_VIDEO_BYTES = 16 * MB;

/** Tope de ENTRADA de un video con `MEDIA_VIDEO_OPTIMIZE` encendida: se optimiza a una variante de menos de 16 MB. */
export const MAX_VIDEO_ENTRADA_BYTES = 250 * MB;

/** Imágenes estándar: hasta 3 MB. Modernas (webp/avif): hasta 1,5 MB. Video mp4 y PDF: hasta 16 MB (048). */
export const FORMATOS_MEDIO: readonly FormatoMedio[] = [
  { ext: "jpg", mime: "image/jpeg", tipo: "image", maxBytes: 3 * MB, etiqueta: "JPG" },
  { ext: "png", mime: "image/png", tipo: "image", maxBytes: 3 * MB, etiqueta: "PNG" },
  { ext: "webp", mime: "image/webp", tipo: "image", maxBytes: 1.5 * MB, etiqueta: "WEBP" },
  { ext: "avif", mime: "image/avif", tipo: "image", maxBytes: 1.5 * MB, etiqueta: "AVIF", noWhatsapp: true },
  { ext: "mp4", mime: "video/mp4", tipo: "video", maxBytes: MAX_VIDEO_BYTES, etiqueta: "MP4" },
  // Hasta que exista la variante optimizada, un MOV no se puede enviar por WhatsApp (`noWhatsapp`).
  { ext: "mov", mime: "video/quicktime", tipo: "video", maxBytes: MAX_VIDEO_ENTRADA_BYTES, etiqueta: "MOV", noWhatsapp: true, soloOptimizar: true },
  { ext: "pdf", mime: "application/pdf", tipo: "document", maxBytes: 16 * MB, etiqueta: "PDF" },
  { ext: "svg", mime: "image/svg+xml", tipo: "image", maxBytes: 256 * 1024, etiqueta: "SVG", soloIcono: true },
];

/** Lo que hay que mandarle a `<input type="file" accept>`. */
export const ACCEPT_MEDIOS = ".jpg,.jpeg,.png,.webp,.avif,.mp4,.pdf,image/jpeg,image/png,image/webp,image/avif,video/mp4,application/pdf";

/** Lo mismo con `MEDIA_VIDEO_OPTIMIZE` encendida: además MOV (QuickTime). */
export const acceptMedios = (optimizarVideo?: boolean): string => (optimizarVideo ? `${ACCEPT_MEDIOS},.mov,video/quicktime` : ACCEPT_MEDIOS);

/** Lo mismo, solo imágenes (selector de imagen de los formularios). */
export const ACCEPT_IMAGENES = ".jpg,.jpeg,.png,.webp,.avif,image/jpeg,image/png,image/webp,image/avif";

/** Imágenes más SVG (selector de iconos). */
export const ACCEPT_ICONOS = `${ACCEPT_IMAGENES},.svg,image/svg+xml`;

/** Tope del cuerpo de una subida: el mayor de los límites más el sobre del multipart. */
export const MAX_SUBIDA_BYTES = 16 * MB + 64 * 1024;

/** Lo mismo según la bandera: con `MEDIA_VIDEO_OPTIMIZE`, el video admite hasta 250 MB (cuerpo directo o subida directa a R2). */
export const maxSubidaBytes = (optimizarVideo?: boolean): number => (optimizarVideo ? MAX_VIDEO_ENTRADA_BYTES + 64 * 1024 : MAX_SUBIDA_BYTES);

/** El peso máximo de un formato según la bandera: solo el video cambia (entrada de 250 MB). */
export function limiteDe(formato: FormatoMedio, opts: OpcionesFormato = {}): number {
  return opts.optimizarVideo && formato.tipo === "video" ? MAX_VIDEO_ENTRADA_BYTES : formato.maxBytes;
}

/**
 * Tope de una subida `multipart/form-data`, que el servidor tiene que cargar
 * entera en memoria. Lo más grande va por cuerpo directo (en flujo, a disco).
 */
export const MAX_SUBIDA_MULTIPART_BYTES = 50 * MB + 64 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0).replace(".", ",")} GB`;
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
export function resumenDeLimites(optimizarVideo?: boolean): string {
  return optimizarVideo
    ? "JPG y PNG hasta 3 MB · WEBP y AVIF hasta 1,5 MB · MP4 y MOV hasta 250 MB · PDF hasta 16 MB"
    : "JPG y PNG hasta 3 MB · WEBP y AVIF hasta 1,5 MB · MP4 y PDF hasta 16 MB";
}

function extensionDe(nombre: string): string {
  const i = nombre.lastIndexOf(".");
  return i < 0 ? "" : nombre.slice(i + 1).toLowerCase();
}

/** Busca el formato por MIME y, si el navegador no lo declara, por extensión. */
export function formatoDe(nombre: string, mime: string, opts: OpcionesFormato = {}): FormatoMedio | null {
  const m = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const admitidos = FORMATOS_MEDIO.filter((f) => (!f.soloIcono || opts.svg) && (!f.soloOptimizar || opts.optimizarVideo));
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
      message: `«${nombre}» no es un formato válido. Se aceptan JPG, PNG, WEBP, AVIF${opts.svg ? ", SVG" : ""}, MP4${opts.optimizarVideo ? ", MOV" : ""} y PDF.`,
    };
  }
  if (bytes <= 0) {
    return { ok: false, code: "empty", message: `«${nombre}» está vacío.` };
  }
  const tope = limiteDe(formato, opts);
  if (bytes > tope) {
    return {
      ok: false,
      code: "too_large",
      message: `«${nombre}» pesa ${formatBytes(bytes)} y el máximo para ${formato.etiqueta} es ${formatBytes(tope)}.`,
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

export type EstadoVariante = "none" | "processing" | "ready" | "failed";

/** Cómo viaja un medio por la API. */
export type MedioDto = {
  id: string;
  nombre: string;
  tipo: MedioTipo;
  mime: string;
  bytes: number;
  origen: "archivo" | "url";
  /** 048: WhatsApp no lo puede enviar (AVIF, o un video antiguo de más de 16 MB). */
  noEnviable: boolean;
  /**
   * Variante optimizada para WhatsApp: `none` (sin variante), `processing`, `ready` o `failed`. El original sigue siendo lo
   * que se ve y se descarga; la variante solo sirve para enviar por WhatsApp.
   */
  varianteEstado: EstadoVariante;
  /** Peso de la variante lista (null mientras no la haya). */
  varianteBytes: number | null;
  /** Por qué falló la variante (null si no falló). */
  varianteError: string | null;
  /** La URL de origen, cuando se trajo de un enlace. */
  urlOrigen: string | null;
  /** Ruta (relativa al origen) del archivo servido: `/api/medios/<id>/archivo`. */
  ruta: string;
  /** 048: con R2, una URL firmada de lectura (vence; estable durante la hora) para la galería. Sin R2, null. */
  urlFirmada: string | null;
  creadoEn: string;
};

/** 048: ¿este medio se puede mandar por WhatsApp? (formato que Meta no admite o video antiguo de más de 16 MB). */
export function esEnviablePorWhatsapp(mime: string, bytes: number): boolean {
  const f = FORMATOS_MEDIO.find((x) => x.mime === mime);
  if (!f || f.noWhatsapp) return false;
  if (f.tipo === "video" && bytes > MAX_VIDEO_BYTES) return false;
  return true;
}
