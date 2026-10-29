import { FORMATOS_MEDIO, type FormatoMedio } from "@/lib/medios";

/**
 * Módulo Medios — qué es DE VERDAD un archivo, mirando sus primeros bytes.
 *
 * El nombre y el `Content-Type` los pone quien sube: un `.jpg` puede ser un
 * HTML. Lo que se guarda y se sirve desde nuestro origen se decide por la firma
 * del contenido, no por lo que el archivo dice ser. Módulo puro, sin disco.
 */

/** Cuántos bytes hacen falta para reconocer cualquier formato de la lista. */
export const BYTES_PARA_RECONOCER = 32;

const MARCAS_MP4 = new Set([
  "isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "m4v ", "msnv", "f4v ",
]);

function ascii(buf: Uint8Array, desde: number, hasta: number): string {
  let s = "";
  for (let i = desde; i < hasta && i < buf.length; i++) s += String.fromCharCode(buf[i]!);
  return s;
}

function formato(ext: string): FormatoMedio {
  return FORMATOS_MEDIO.find((f) => f.ext === ext)!;
}

/** ¿Empieza como un SVG? (tras BOM, prólogo XML, comentarios y DOCTYPE opcionales). */
function pareceSvg(buf: Uint8Array): boolean {
  const cabeza = new TextDecoder("utf-8").decode(buf.subarray(0, 4096)).replace(/^﻿/, "");
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(
    cabeza
  );
}

/**
 * Un SVG se sirve desde nuestro origen, así que se revisa por dentro: nada de
 * guiones, manejadores de eventos, objetos incrustados, entidades ni referencias
 * a recursos de fuera (solo `#ancla` interna). Devuelve el motivo del rechazo o
 * `null` si es seguro. Se rechaza en vez de "limpiar": reescribir el archivo del
 * negocio sin avisar es peor que pedirle otro.
 */
export function revisarSvg(buf: Uint8Array): string | null {
  const texto = new TextDecoder("utf-8").decode(buf);
  if (/<script|<foreignObject|<iframe|<embed|<object|<audio|<video|<animate|<set\b|<handler|<listener/i.test(texto)) {
    return "contiene elementos activos (scripts, animaciones o contenido incrustado)";
  }
  if (/\son[a-z]+\s*=/i.test(texto)) return "contiene manejadores de eventos (onclick, onload…)";
  if (/javascript:|data:text\/html|vbscript:/i.test(texto)) return "contiene enlaces de código";
  if (/<!ENTITY/i.test(texto)) return "define entidades XML";
  if (/<image\b/i.test(texto)) return "incrusta otras imágenes";
  if (/(?:xlink:)?href\s*=\s*["'](?!#)/i.test(texto)) return "apunta a recursos externos";
  if (/url\(\s*["']?(?!#)/i.test(texto) || /@import/i.test(texto)) return "carga recursos externos desde sus estilos";
  return null;
}

/**
 * El formato que dicen los bytes, o `null` si no es ninguno de los admitidos.
 * El SVG solo se reconoce con `svg: true` (selector de iconos).
 */
export function detectarFormato(buf: Uint8Array, opts: { svg?: boolean } = {}): FormatoMedio | null {
  if (opts.svg && pareceSvg(buf)) return formato("svg");
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return formato("jpg");
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return formato("png");
  }
  if (buf.length >= 12 && ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WEBP") {
    return formato("webp");
  }
  if (buf.length >= 12 && ascii(buf, 4, 8) === "ftyp") {
    const marca = ascii(buf, 8, 12).toLowerCase();
    if (marca === "avif" || marca === "avis") return formato("avif");
    if (MARCAS_MP4.has(marca)) return formato("mp4");
  }
  return null;
}
