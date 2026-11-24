import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { getEnv } from "@/lib/env";
import {
  esEnviablePorWhatsapp,
  formatBytes,
  formatoDe,
  limiteDe,
  MAX_VIDEO_BYTES,
  nombreLegible,
  validarMedio,
  type MedioDto,
  type MedioTipo,
} from "@/lib/medios";
import { BYTES_PARA_RECONOCER, detectarFormato, revisarCodecsMp4, revisarSvg } from "@/server/medios/sniff";
import { colaDeOptimizacionActiva, videoOptimizeEnabled } from "@/server/medios/flag";
import { despertarOptimizador } from "@/server/medios/optimizar/despertar";
import { claveDeMedio, claveDeVariante, clavePendiente, objectStore, StorageError } from "@/server/storage";

/**
 * Módulo Medios — la biblioteca de imágenes, videos y PDF del negocio.
 *
 * El binario vive donde diga la fila (`storage`): en el volumen local (`MEDIA_DIR/<org>/medios/<id>`, el camino por
 * defecto, sin terceros: constitución II) o, con el conector opcional `R2_STORAGE` encendido (048), en Cloudflare R2.
 * Conviven: lo anterior sigue en disco y lo nuevo va a R2. La fila en BD lleva el nombre, el tipo real y el peso.
 */

export class MedioError extends Error {
  constructor(
    readonly code: "empty" | "unsupported_type" | "too_large" | "not_found" | "forbidden" | "in_use" | "unavailable",
    message: string,
    /** Solo en `in_use`: dónde se usa el medio, para que la UI y la API lo muestren con detalle. */
    readonly usos?: UsoDeMedio[]
  ) {
    super(message);
    this.name = "MedioError";
  }
}

/**
 * Hallazgo E — dónde se usa un medio de la biblioteca: los pasos de automatización que lo envían (dejarían de funcionar)
 * y las referencias con clave foránea `set null` (servicio, oferta, equipo, fidelidad), que de otro modo se quedarían
 * sin imagen en silencio.
 */
export type UsoDeMedio = {
  tipo: "automatizacion" | "servicio" | "combo" | "personal" | "fidelidad";
  id: string;
  nombre: string;
  /** Qué parte lo usa cuando hay varias posibilidades (fidelidad: «logo» o «icono de los sellos»). */
  detalle?: string;
};

/**
 * Lo que NO se puede comprobar: el enlace «Copiar URL» (`/api/medios/<id>/archivo`) que alguien pegó a mano en una
 * plantilla, un anuncio o su sitio web no deja rastro en la base. Borrar el medio rompe esos enlaces (responden 404).
 */
export const AVISO_ENLACES_PEGADOS =
  "Si pegaste el enlace de un archivo («Copiar URL») en una plantilla, un anuncio o tu sitio web, ese enlace dejará de funcionar al borrarlo: el sistema no puede comprobarlo.";

type Fila = typeof schema.mediaLibraryItem.$inferSelect;

function segmentoSeguro(s: string): string {
  if (!/^[\w.-]+$/.test(s)) throw new Error(`segmento de ruta inválido: ${s}`);
  return s;
}

/** Ruta absoluta del archivo de un medio. */
export function rutaDeMedio(organizationId: string, id: string): string {
  return path.join(
    getEnv().MEDIA_DIR,
    segmentoSeguro(organizationId),
    "medios",
    segmentoSeguro(id)
  );
}

/**
 * Dónde vive en disco la variante optimizada para WhatsApp (`MEDIA_DIR/<org>/medios-wa/<id>`): una carpeta aparte de la
 * del original, porque la reconciliación compara `medios` por nombre. En R2 la clave es `claveDeVariante`.
 */
export function rutaDeVariante(organizationId: string, id: string): string {
  return path.join(getEnv().MEDIA_DIR, segmentoSeguro(organizationId), "medios-wa", segmentoSeguro(id));
}

/** La carpeta de temporales de una organización (subidas en curso y trabajo de la optimización de video). */
export function carpetaTemporal(organizationId: string): string {
  return path.join(getEnv().MEDIA_DIR, segmentoSeguro(organizationId), "medios-tmp");
}

/**
 * Un archivo temporal (otra carpeta, en el mismo volumen: el `rename` final es atómico). Sin sufijo es el de una subida en
 * curso; la optimización usa `.src` (el original bajado de R2) y `.wa.mp4` (la salida de ffmpeg). El id va primero: la
 * limpieza de temporales lo recupera con `nombre.split(".")[0]`.
 */
export function rutaTemporalDeMedio(organizationId: string, id: string, sufijo = ""): string {
  return path.join(carpetaTemporal(organizationId), `${segmentoSeguro(id)}${sufijo}`);
}

/**
 * Los valores de una fila de video recién confirmada: con la bandera encendida y ffmpeg comprobado, nace en cola
 * (`processing`, en la misma sentencia que la deja `ready`: sin hueco). Sin ellas, sin variante.
 */
function encolado(kind: string) {
  return kind === "video" && colaDeOptimizacionActiva()
    ? { variantStatus: "processing" as const, variantAttempts: 0, variantNextAttemptAt: new Date(), variantError: null }
    : {};
}

export function medioToDto(f: Fila, urlFirmada: string | null = null): MedioDto {
  return {
    id: f.id,
    nombre: f.name,
    tipo: f.kind,
    mime: f.mimeType,
    bytes: f.sizeBytes,
    origen: f.source === "upload" ? "archivo" : "url",
    urlOrigen: f.sourceUrl,
    ruta: `/api/medios/${f.id}/archivo`,
    urlFirmada,
    noEnviable: !esEnviablePorWhatsapp(f.mimeType, f.sizeBytes),
    varianteEstado: f.variantStatus,
    varianteBytes: f.variantStatus === "ready" ? f.variantSizeBytes : null,
    varianteError: f.variantStatus === "failed" ? f.variantError : null,
    creadoEn: f.createdAt.toISOString(),
  };
}

/**
 * Guarda un archivo en la biblioteca. El formato se decide por los bytes, no
 * por el nombre ni el `Content-Type`, y el peso se mide contra el límite de ESE
 * formato: es la validación que cuenta (la del navegador es solo cortesía).
 */
export async function crearMedio(input: {
  organizationId: string;
  userId: string;
  data: Buffer;
  nombre: string;
  source: "upload" | "url";
  sourceUrl?: string | null;
  /** Si se da, solo se acepta ese tipo (p. ej. la foto de un servicio no puede ser un video). */
  soloTipo?: MedioTipo;
  /** Admite SVG (solo el selector de iconos); se revisa por dentro antes de guardarlo. */
  permitirSvg?: boolean;
}): Promise<MedioDto> {
  const opts = { svg: input.permitirSvg === true, optimizarVideo: videoOptimizeEnabled() };
  const formato = detectarFormato(input.data, opts);
  if (!formato) {
    throw new MedioError(
      "unsupported_type",
      `«${input.nombre}» no es una imagen o video válido. Se aceptan JPG, PNG, WEBP, AVIF${opts.svg ? ", SVG" : ""}, MP4${opts.optimizarVideo ? " y MOV" : ""}.`
    );
  }
  if (formato.ext === "svg") {
    const motivo = revisarSvg(input.data);
    if (motivo) {
      throw new MedioError("unsupported_type", `«${input.nombre}» no se puede usar como SVG: ${motivo}.`);
    }
  }
  if (input.soloTipo && formato.tipo !== input.soloTipo) {
    throw new MedioError(
      "unsupported_type",
      input.soloTipo === "image"
        ? `«${input.nombre}» es un video. Aquí solo se aceptan imágenes (JPG, PNG, WEBP o AVIF).`
        : `«${input.nombre}» es una imagen. Aquí solo se aceptan videos (MP4).`
    );
  }
  const valido = validarMedio(input.nombre, formato.mime, input.data.byteLength, opts);
  if (!valido.ok) throw new MedioError(valido.code, valido.message);

  const id = newId("mediaLibraryItem");
  const r2 = objectStore();
  const archivo = rutaDeMedio(input.organizationId, id);
  const clave = r2 ? claveDeMedio(input.organizationId, id) : null;
  if (r2 && clave) {
    try {
      await r2.put(clave, input.data, formato.mime);
    } catch {
      throw new MedioError("unavailable", "No se pudo guardar el archivo en el almacenamiento. Inténtalo de nuevo.");
    }
  } else {
    await mkdir(path.dirname(archivo), { recursive: true });
    await writeFile(archivo, input.data);
  }

  try {
    const [fila] = await getDb()
      .insert(schema.mediaLibraryItem)
      .values({
        id,
        organizationId: input.organizationId,
        name: nombreLegible(input.nombre),
        kind: formato.tipo,
        mimeType: formato.mime,
        sizeBytes: input.data.byteLength,
        source: input.source,
        sourceUrl: input.sourceUrl ?? null,
        createdBy: input.userId,
        storage: r2 ? "r2" : "local",
        storageKey: clave,
        ...encolado(formato.tipo),
      })
      .returning();
    if (fila!.variantStatus === "processing") despertarOptimizador();
    return medioToDto(fila!);
  } catch (err) {
    // Sin fila, el archivo sería un huérfano que nadie podría borrar.
    if (r2 && clave) await r2.delete(clave).catch(() => {});
    else await rm(archivo, { force: true }).catch(() => {});
    throw err;
  }
}

function unir(trozos: Uint8Array[], total: number): Buffer {
  const out = Buffer.allocUnsafe(total);
  let pos = 0;
  for (const t of trozos) {
    out.set(t, pos);
    pos += t.byteLength;
  }
  return out;
}

async function escribirTodo(fh: FileHandle, buf: Uint8Array): Promise<void> {
  let desde = 0;
  while (desde < buf.byteLength) {
    const { bytesWritten } = await fh.write(buf, desde, buf.byteLength - desde);
    desde += bytesWritten;
  }
}

/**
 * Guarda un medio que llega como FLUJO de bytes (cuerpo directo de la subida o la descarga de un enlace).
 *
 * - Sin `MEDIA_VIDEO_OPTIMIZE` el tope de todo es 16 MB: se arma en memoria cortando EN CUANTO se pasa del límite del formato
 *   reconocido con los primeros bytes (nunca se reciben GB solo para decir que no) y valida `crearMedio`.
 * - Con la bandera, un VIDEO (hasta 250 MB) NO pasa por la memoria: se escribe a un archivo temporal (`medios-tmp`) contando
 *   los bytes, y solo si cuadra se mueve a su sitio. Si se pasa del tope, falla o el formato no es el admitido, el temporal se
 *   borra. Con R2 encendido esa vía no existe en el servidor (los bytes no se guardan en disco): un video de más de 16 MB debe
 *   subir directo al bucket (`prepararSubida` / `confirmarSubida`), que es lo que usa la pantalla.
 */
export async function crearMedioDesdeFlujo(input: {
  organizationId: string;
  userId: string;
  flujo: ReadableStream<Uint8Array>;
  nombre: string;
  soloTipo?: MedioTipo;
  permitirSvg?: boolean;
}): Promise<MedioDto> {
  const opts = { svg: input.permitirSvg === true, optimizarVideo: videoOptimizeEnabled() };
  const reader = input.flujo.getReader();
  const trozos: Uint8Array[] = [];
  let total = 0;
  let terminado = false;
  let temporal: string | null = null;
  try {
    while (total < BYTES_PARA_RECONOCER && !terminado) {
      const r = await reader.read();
      if (r.done) terminado = true;
      else if (r.value.byteLength > 0) {
        trozos.push(r.value);
        total += r.value.byteLength;
      }
    }
    const cabeza = unir(trozos, total);
    const formato = detectarFormato(cabeza, opts);
    // Un formato que los bytes reconocen pero esta instancia no admite (p. ej. MOV con la bandera apagada) se rechaza ya.
    if (formato && !formatoDe(input.nombre, formato.mime, opts)) {
      throw new MedioError("unsupported_type", `«${input.nombre}» no es una imagen o video válido. Se aceptan JPG, PNG, WEBP, AVIF${opts.svg ? ", SVG" : ""} y MP4.`);
    }

    const r2 = objectStore();
    const esVideoGrande = formato?.tipo === "video" && opts.optimizarVideo === true;
    const aDisco = esVideoGrande && !r2;
    const tope = aDisco ? limiteDe(formato!, opts) : formato ? formato.maxBytes : MAX_VIDEO_BYTES;
    const mensajeExceso =
      esVideoGrande && r2
        ? `«${input.nombre}» pesa más de ${formatBytes(MAX_VIDEO_BYTES)}. Con el almacenamiento en la nube, los videos más grandes se suben con la subida directa (la de la pantalla de Medios).`
        : `«${input.nombre}» pesa más de ${formatBytes(tope)}, el máximo para ${formato?.etiqueta ?? "este formato"}.`;

    if (aDisco && formato) {
      if (input.soloTipo && formato.tipo !== input.soloTipo) {
        throw new MedioError("unsupported_type", `«${input.nombre}» es un video. Aquí solo se aceptan imágenes (JPG, PNG, WEBP o AVIF).`);
      }
      const id = newId("mediaLibraryItem");
      temporal = rutaTemporalDeMedio(input.organizationId, id);
      await mkdir(path.dirname(temporal), { recursive: true });
      const fh = await open(temporal, "w");
      try {
        await escribirTodo(fh, cabeza);
        while (!terminado) {
          const r = await reader.read();
          if (r.done) {
            terminado = true;
            break;
          }
          total += r.value.byteLength;
          if (total > tope) throw new MedioError("too_large", mensajeExceso);
          await escribirTodo(fh, r.value);
        }
      } finally {
        await fh.close();
      }
      const valido = validarMedio(input.nombre, formato.mime, total, opts);
      if (!valido.ok) throw new MedioError(valido.code, valido.message);

      const destino = rutaDeMedio(input.organizationId, id);
      await mkdir(path.dirname(destino), { recursive: true });
      await rename(temporal, destino);
      temporal = null;
      try {
        const [fila] = await getDb()
          .insert(schema.mediaLibraryItem)
          .values({
            id,
            organizationId: input.organizationId,
            name: nombreLegible(input.nombre),
            kind: formato.tipo,
            mimeType: formato.mime,
            sizeBytes: total,
            source: "upload",
            createdBy: input.userId,
            storage: "local",
            storageKey: null,
            ...encolado(formato.tipo),
          })
          .returning();
        if (fila!.variantStatus === "processing") despertarOptimizador();
        return medioToDto(fila!);
      } catch (err) {
        // Sin fila, el archivo sería un huérfano que nadie podría borrar.
        await rm(destino, { force: true }).catch(() => {});
        throw err;
      }
    }

    while (!terminado) {
      const r = await reader.read();
      if (r.done) {
        terminado = true;
        break;
      }
      trozos.push(r.value);
      total += r.value.byteLength;
      if (total > tope) throw new MedioError("too_large", mensajeExceso);
    }
    return await crearMedio({
      organizationId: input.organizationId,
      userId: input.userId,
      data: unir(trozos, total),
      nombre: input.nombre,
      source: "upload",
      soloTipo: input.soloTipo,
      permitirSvg: input.permitirSvg,
    });
  } finally {
    if (temporal) await rm(temporal, { force: true }).catch(() => {});
    // Si se rechazó antes de leerlo todo, se descarta lo poco que falte (cortar la conexión a media subida hace que
    // el cliente no vea la respuesta); lo mucho se corta.
    if (!terminado) {
      try {
        let descartado = 0;
        while (descartado < 16 * 1024 * 1024) {
          const r = await reader.read();
          if (r.done) break;
          descartado += r.value.byteLength;
        }
      } catch {
        // El cliente ya cortó: nada que descartar.
      }
    }
    await reader.cancel().catch(() => {});
  }
}

export async function listarMedios(
  organizationId: string,
  tipo?: MedioTipo
): Promise<MedioDto[]> {
  const filas = await getDb()
    .select()
    .from(schema.mediaLibraryItem)
    .where(
      scoped(
        schema.mediaLibraryItem.organizationId,
        organizationId,
        eq(schema.mediaLibraryItem.status, "ready"),
        tipo ? eq(schema.mediaLibraryItem.kind, tipo) : undefined
      )
    )
    .orderBy(desc(schema.mediaLibraryItem.createdAt));
  const r2 = objectStore();
  // Firmar es solo criptografía local (sin ir a R2): una URL por medio, estable durante la hora.
  return Promise.all(
    filas.map(async (f) => {
      const firmada =
        r2 && f.storage === "r2" && f.storageKey
          ? await r2.signRead(f.storageKey, { contentType: f.mimeType }).catch(() => null)
          : null;
      return medioToDto(f, firmada);
    })
  );
}

/**
 * Un medio por su id, SIN organización: lo usa la ruta pública del archivo
 * (`/api/medios/<id>/archivo`), que es lo que se copia y se pega en otras
 * partes. El id son 20 caracteres al azar: no se adivina, y no hay forma de
 * listar medios sin sesión.
 */
export async function medioPublico(id: string): Promise<Fila | null> {
  if (!/^med_[a-z0-9]{20}$/.test(id)) return null;
  const [fila] = await getDb()
    .select()
    .from(schema.mediaLibraryItem)
    .where(and(eq(schema.mediaLibraryItem.id, id), eq(schema.mediaLibraryItem.status, "ready")))
    .limit(1);
  return fila ?? null;
}

/** Dónde está el binario de un medio. */
export type Lectura = { donde: "local"; ruta: string } | { donde: "r2"; clave: string };

export function lecturaDe(f: Fila): Lectura {
  if (f.storage === "r2" && f.storageKey) return { donde: "r2", clave: f.storageKey };
  return { donde: "local", ruta: rutaDeMedio(f.organizationId, f.id) };
}

/**
 * Lee el medio ENTERO a memoria (≤ `max`) para subirlo a Meta. Solo se llama cuando la caché del `media_id` no sirve.
 * Devuelve `null` si el archivo no está.
 */
export async function leerBytesDeMedio(f: Fila, max: number): Promise<Buffer | null> {
  const l = lecturaDe(f);
  if (l.donde === "local") {
    try {
      return await readFile(l.ruta);
    } catch {
      return null;
    }
  }
  const r2 = objectStore();
  if (!r2) return null;
  try {
    return await r2.readAll(l.clave, max);
  } catch (err) {
    if (err instanceof StorageError && err.code === "not_found") return null;
    throw err;
  }
}

/**
 * Quita la variante optimizada de un video (disco y R2). Va por la ubicación DERIVADA (`medios-wa/<id>`), no solo por la
 * columna: si el trabajo la publicó justo cuando se borraba el medio, la columna aún no la anotaba. Nunca lanza.
 */
async function quitarVariante(f: Fila): Promise<void> {
  if (f.kind !== "video") return;
  await rm(rutaDeVariante(f.organizationId, f.id), { force: true }).catch(() => {});
  const r2 = objectStore();
  if (r2) {
    const clave = f.variantStorageKey ?? claveDeVariante(f.organizationId, f.id);
    await r2.delete(clave).catch((e) => console.warn(`[medios] no se pudo borrar la variante ${clave} (queda huérfana hasta la reconciliación):`, e instanceof Error ? e.message : e));
  }
}

/** Quita el binario de un medio (disco o R2) y su variante optimizada. Nunca lanza: un huérfano lo barre el mantenimiento. */
async function quitarBinario(f: Fila): Promise<void> {
  await quitarVariante(f);
  const l = lecturaDe(f);
  if (l.donde === "local") {
    await rm(l.ruta, { force: true }).catch(() => {});
    return;
  }
  // Un borrado fallido deja un huérfano: se avisa y lo barre la reconciliación (`reconciliar.ts`).
  await objectStore()?.delete(l.clave).catch((e) => console.warn(`[medios] no se pudo borrar el objeto ${l.clave} (queda huérfano hasta la reconciliación):`, e instanceof Error ? e.message : e));
}

/* ---------- Subida directa a R2 (048) ---------- */

export type SubidaFirmada = {
  medio: MedioDto;
  /** Lo que el navegador hace: `PUT url` con estas cabeceras y el archivo como cuerpo. */
  subida: { url: string; headers: Record<string, string>; expiraEn: string };
};

/**
 * Paso 1: valida el archivo con las MISMAS reglas que la subida por el servidor y firma un `PUT` de 15 min cuyo tipo
 * y tamaño van firmados. La fila queda `pending` (no se lista ni se envía) hasta confirmarse.
 */
export async function prepararSubida(input: {
  organizationId: string;
  userId: string;
  nombre: string;
  mime: string;
  bytes: number;
  soloTipo?: MedioTipo;
  permitirSvg?: boolean;
}): Promise<SubidaFirmada> {
  const r2 = objectStore();
  if (!r2) throw new MedioError("unavailable", "La subida directa no está disponible en esta instancia.");
  const valido = validarMedio(input.nombre, input.mime, input.bytes, { svg: input.permitirSvg === true, optimizarVideo: videoOptimizeEnabled() });
  if (!valido.ok) throw new MedioError(valido.code, valido.message);
  const formato = valido.formato;
  if (input.soloTipo && formato.tipo !== input.soloTipo) {
    throw new MedioError(
      "unsupported_type",
      input.soloTipo === "image"
        ? `«${input.nombre}» no es una imagen. Aquí solo se aceptan imágenes (JPG, PNG, WEBP o AVIF).`
        : `«${input.nombre}» no es del tipo que se pide aquí.`
    );
  }
  const id = newId("mediaLibraryItem");
  const clave = clavePendiente(input.organizationId, id);
  const firmada = await r2.signUpload(clave, { contentType: formato.mime, contentLength: input.bytes }).catch(() => {
    throw new MedioError("unavailable", "No se pudo preparar la subida. Inténtalo de nuevo.");
  });
  const [fila] = await getDb()
    .insert(schema.mediaLibraryItem)
    .values({
      id,
      organizationId: input.organizationId,
      name: nombreLegible(input.nombre),
      kind: formato.tipo,
      mimeType: formato.mime,
      sizeBytes: input.bytes,
      source: "upload",
      createdBy: input.userId,
      storage: "r2",
      storageKey: clave,
      status: "pending",
    })
    .returning();
  return {
    medio: medioToDto(fila!),
    subida: { url: firmada.url, headers: firmada.headers, expiraEn: firmada.expiresAt.toISOString() },
  };
}

/**
 * Paso 3: comprueba en el servidor lo que el navegador dice haber subido (tamaño real, formato por los bytes) y,
 * solo si cuadra, lo pasa a su clave definitiva y lo deja `ready`. Idempotente. Un archivo que no cuadra se borra.
 */
export async function confirmarSubida(input: {
  organizationId: string;
  userId: string;
  id: string;
}): Promise<{ medio: MedioDto; aviso: string | null }> {
  const r2 = objectStore();
  if (!r2) throw new MedioError("unavailable", "La subida directa no está disponible en esta instancia.");
  const db = getDb();
  const m = schema.mediaLibraryItem;
  const [fila] = await db
    .select()
    .from(m)
    .where(scoped(m.organizationId, input.organizationId, eq(m.id, input.id)))
    .limit(1);
  if (!fila || fila.createdBy !== input.userId) throw new MedioError("not_found", "Esa subida ya no existe.");
  if (fila.status === "ready") return { medio: medioToDto(fila), aviso: null };
  if (fila.storage !== "r2" || !fila.storageKey) throw new MedioError("not_found", "Esa subida ya no existe.");
  const pendiente = fila.storageKey;

  const rechazar = async (code: "unsupported_type" | "too_large", message: string): Promise<never> => {
    await r2.delete(pendiente).catch(() => {});
    await db.delete(m).where(and(eq(m.organizationId, input.organizationId), eq(m.id, fila.id)));
    throw new MedioError(code, message);
  };

  let cabecera: { size: number } | null;
  try {
    cabecera = await r2.head(pendiente);
  } catch {
    throw new MedioError("unavailable", "No se pudo comprobar el archivo. Inténtalo de nuevo en un momento.");
  }
  if (!cabecera) throw new MedioError("not_found", "El archivo no llegó al almacenamiento. Vuelve a subirlo.");
  if (cabecera.size !== fila.sizeBytes) {
    return rechazar("too_large", `«${fila.name}» no llegó completo o su tamaño no coincide. Vuelve a subirlo.`);
  }

  const opts = { svg: fila.mimeType === "image/svg+xml", optimizarVideo: videoOptimizeEnabled() };
  // El SVG y un video de hasta 16 MB se leen enteros para revisarlos por dentro (como siempre); un video mayor (hasta 250 MB,
  // solo con la bandera) NO: basta su cabecera (32 bytes) para reconocer el formato, y el tamaño ya se comprobó con `head()`.
  const leerEntero = fila.mimeType === "image/svg+xml" || (fila.kind === "video" && fila.sizeBytes <= MAX_VIDEO_BYTES);
  let datos: Buffer;
  try {
    datos = leerEntero ? await r2.readAll(pendiente, MAX_VIDEO_BYTES) : await r2.readRange(pendiente, 0, BYTES_PARA_RECONOCER - 1);
  } catch {
    throw new MedioError("unavailable", "No se pudo leer el archivo para comprobarlo. Inténtalo de nuevo.");
  }
  const formato = detectarFormato(datos, opts);
  // El formato lo deciden los bytes. Un video que el navegador declaró con otro MIME de video (un .mov que dice video/mp4 o
  // al revés) se acepta con el MIME REAL; cualquier otra diferencia es un archivo que no es lo que dice ser.
  const mismoVideo = !!formato && formato.tipo === "video" && fila.kind === "video" && !!formatoDe(fila.name, formato.mime, opts);
  if (!formato || (formato.mime !== fila.mimeType && !mismoVideo)) {
    return rechazar("unsupported_type", `«${fila.name}» no es del formato que dice ser.`);
  }
  if (mismoVideo) {
    const v = validarMedio(fila.name, formato.mime, fila.sizeBytes, opts);
    if (!v.ok) return rechazar(v.code === "too_large" ? "too_large" : "unsupported_type", v.message);
  }
  if (formato.ext === "svg") {
    const motivo = revisarSvg(datos);
    if (motivo) return rechazar("unsupported_type", `«${fila.name}» no se puede usar como SVG: ${motivo}.`);
  }

  const definitiva = claveDeMedio(input.organizationId, fila.id);
  try {
    await r2.copy(pendiente, definitiva);
  } catch {
    throw new MedioError("unavailable", "No se pudo terminar de guardar el archivo. Inténtalo de nuevo.");
  }
  const [listo] = await db
    .update(m)
    .set({ status: "ready", storageKey: definitiva, mimeType: formato.mime, ...encolado(fila.kind) })
    .where(and(eq(m.organizationId, input.organizationId), eq(m.id, fila.id), eq(m.status, "pending")))
    .returning();
  await r2.delete(pendiente).catch(() => {});
  if (listo?.variantStatus === "processing") despertarOptimizador();
  if (!listo) {
    // Otra confirmación ganó la carrera: devuelve lo que quedó.
    const [ya] = await db.select().from(m).where(scoped(m.organizationId, input.organizationId, eq(m.id, fila.id))).limit(1);
    return { medio: medioToDto(ya ?? fila), aviso: null };
  }
  // El aviso de códec mira el archivo entero; en un video grande (solo cabecera leída) lo reemplazará `ffprobe`.
  return { medio: medioToDto(listo), aviso: formato.tipo === "video" && leerEntero ? revisarCodecsMp4(datos) : null };
}

/** Mantenimiento horario: las subidas firmadas que nunca se confirmaron (más de 1 h) y su objeto huérfano. */
export async function limpiarSubidasPendientes(now: Date = new Date()): Promise<number> {
  const db = getDb();
  const m = schema.mediaLibraryItem;
  const corte = new Date(now.getTime() - 60 * 60 * 1000);
  const filas = await db.select().from(m).where(and(eq(m.status, "pending"), lt(m.createdAt, corte))).limit(200);
  const r2 = objectStore();
  for (const f of filas) {
    if (r2 && f.storageKey) await r2.delete(f.storageKey).catch(() => {});
    await db.delete(m).where(and(eq(m.id, f.id), eq(m.status, "pending")));
  }
  return filas.length;
}

/**
 * Borra un medio. Quien lo subió puede; el dueño o un administrador, también.
 * Un id de otra organización responde «no encontrado», no «prohibido»: no se
 * filtra qué existe en otro negocio.
 */
export async function borrarMedio(input: {
  organizationId: string;
  userId: string;
  puedeAdministrar: boolean;
  id: string;
}): Promise<void> {
  const db = getDb();
  const [fila] = await db
    .select()
    .from(schema.mediaLibraryItem)
    .where(
      scoped(
        schema.mediaLibraryItem.organizationId,
        input.organizationId,
        eq(schema.mediaLibraryItem.id, input.id)
      )
    )
    .limit(1);
  if (!fila) throw new MedioError("not_found", "Ese archivo ya no existe.");
  if (!input.puedeAdministrar && fila.createdBy !== input.userId) {
    throw new MedioError("forbidden", "Solo quien lo subió, el dueño o un administrador puede borrarlo.");
  }
  // 037 + Hallazgo E: un paso de automatización que lo envía dejaría de funcionar, y un servicio, oferta, integrante del
  // equipo o la tarjeta de fidelidad se quedarían sin imagen en silencio (la clave foránea los pone en null).
  const usos = await usosDeMedio(input.organizationId, input.id);
  if (usos.length > 0) {
    throw new MedioError("in_use", mensajeDeUsos(fila.name, usos), usos);
  }
  await db
    .delete(schema.mediaLibraryItem)
    .where(
      and(
        eq(schema.mediaLibraryItem.organizationId, input.organizationId),
        eq(schema.mediaLibraryItem.id, input.id)
      )
    );
  // Fila fuera (con su caché del media_id, por cascada) y luego el binario, en disco o en R2.
  await quitarBinario(fila);
}

/** Los flujos de automatización que envían un medio (por el `mediaId` de sus pasos `send_media`). */
export async function flujosQueUsanMedio(organizationId: string, id: string): Promise<{ id: string; name: string }[]> {
  const s = schema.automationStep;
  const f = schema.automationFlow;
  return getDb()
    .selectDistinct({ id: f.id, name: f.name })
    .from(s)
    .innerJoin(f, eq(f.id, s.flowId))
    .where(scoped(s.organizationId, organizationId, eq(s.stepType, "send_media"), sql`${s.config}->>'mediaId' = ${id}`));
}

/**
 * Todos los usos activos de un medio dentro de la organización: pasos `send_media` de automatizaciones, y las imágenes de
 * servicios, ofertas (combos), integrantes del equipo y la tarjeta de fidelidad (logo e icono de los sellos).
 * Una consulta por origen, todas acotadas por organización.
 */
export async function usosDeMedio(organizationId: string, id: string): Promise<UsoDeMedio[]> {
  const db = getDb();
  const l = schema.loyaltySettings;
  const [flujos, servicios, combos, personal, fidelidad] = await Promise.all([
    flujosQueUsanMedio(organizationId, id),
    db
      .select({ id: schema.service.id, name: schema.service.name })
      .from(schema.service)
      .where(scoped(schema.service.organizationId, organizationId, eq(schema.service.imageMediaId, id))),
    db
      .select({ id: schema.combo.id, name: schema.combo.name })
      .from(schema.combo)
      .where(scoped(schema.combo.organizationId, organizationId, eq(schema.combo.imageMediaId, id))),
    db
      .select({ id: schema.staff.id, name: schema.staff.name })
      .from(schema.staff)
      .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.imageMediaId, id))),
    db
      .select({ id: l.id, name: l.cardTitle, logo: l.logoMediaId, sello: l.stampIconMediaId })
      .from(l)
      .where(scoped(l.organizationId, organizationId, or(eq(l.logoMediaId, id), eq(l.stampIconMediaId, id)))),
  ]);
  const usos: UsoDeMedio[] = [
    ...flujos.map((f): UsoDeMedio => ({ tipo: "automatizacion", id: f.id, nombre: f.name })),
    ...servicios.map((x): UsoDeMedio => ({ tipo: "servicio", id: x.id, nombre: x.name })),
    ...combos.map((x): UsoDeMedio => ({ tipo: "combo", id: x.id, nombre: x.name })),
    ...personal.map((x): UsoDeMedio => ({ tipo: "personal", id: x.id, nombre: x.name })),
  ];
  for (const f of fidelidad) {
    if (f.logo === id) usos.push({ tipo: "fidelidad", id: f.id, nombre: f.name, detalle: "logo" });
    if (f.sello === id) usos.push({ tipo: "fidelidad", id: f.id, nombre: f.name, detalle: "icono de los sellos" });
  }
  return usos;
}

const ETIQUETA_USO: Record<UsoDeMedio["tipo"], [singular: string, plural: string]> = {
  automatizacion: ["la automatización", "las automatizaciones"],
  servicio: ["el servicio", "los servicios"],
  combo: ["la oferta", "las ofertas"],
  personal: ["el integrante del equipo", "los integrantes del equipo"],
  fidelidad: ["la tarjeta de fidelidad", "la tarjeta de fidelidad"],
};

/** El mensaje que se le enseña a quien intenta borrar: qué archivo, dónde se usa y qué hacer. */
export function mensajeDeUsos(nombreMedio: string, usos: UsoDeMedio[]): string {
  const orden: UsoDeMedio["tipo"][] = ["automatizacion", "servicio", "combo", "personal", "fidelidad"];
  const partes: string[] = [];
  for (const tipo of orden) {
    const delTipo = usos.filter((u) => u.tipo === tipo);
    if (delTipo.length === 0) continue;
    const [singular, plural] = ETIQUETA_USO[tipo];
    const nombres = delTipo.map((u) => `«${u.nombre}»${u.detalle ? ` (${u.detalle})` : ""}`).join(", ");
    partes.push(`${delTipo.length === 1 ? singular : plural} ${nombres}`);
  }
  const accion = usos.some((u) => u.tipo === "automatizacion")
    ? "Cambia o quita ese uso (en las automatizaciones, ese paso) antes de borrarlo."
    : "Cámbialo o quítalo de ahí antes de borrarlo.";
  return `«${nombreMedio}» está en uso en ${partes.join("; ")}. ${accion}`;
}

/** El nombre de un archivo en la biblioteca: sin saltos ni caracteres de control, de 1 a 120. */
export function nombreDeMedioValido(crudo: string): string | null {
  const limpio = crudo.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return limpio.length >= 1 && limpio.length <= 120 ? limpio : null;
}

/**
 * Cambia el nombre de un medio. Mismo permiso que borrarlo: quien lo subió, el
 * dueño o un administrador. Solo es la etiqueta de la biblioteca: la URL del
 * archivo (su id) no cambia, así que lo ya pegado en otras partes sigue sirviendo.
 */
export async function renombrarMedio(input: {
  organizationId: string;
  userId: string;
  puedeAdministrar: boolean;
  id: string;
  nombre: string;
}): Promise<MedioDto> {
  const nombre = nombreDeMedioValido(input.nombre);
  if (!nombre) {
    throw new MedioError("empty", "Escribe un nombre de hasta 120 caracteres.");
  }
  const db = getDb();
  const [fila] = await db
    .select()
    .from(schema.mediaLibraryItem)
    .where(
      scoped(
        schema.mediaLibraryItem.organizationId,
        input.organizationId,
        eq(schema.mediaLibraryItem.id, input.id)
      )
    )
    .limit(1);
  if (!fila) throw new MedioError("not_found", "Ese archivo ya no existe.");
  if (!input.puedeAdministrar && fila.createdBy !== input.userId) {
    throw new MedioError("forbidden", "Solo quien lo subió, el dueño o un administrador puede renombrarlo.");
  }
  const [nuevo] = await db
    .update(schema.mediaLibraryItem)
    .set({ name: nombre })
    .where(
      and(
        eq(schema.mediaLibraryItem.organizationId, input.organizationId),
        eq(schema.mediaLibraryItem.id, input.id)
      )
    )
    .returning();
  return medioToDto(nuevo!);
}

/**
 * Borra varios medios a la vez. Cada uno sigue la regla de `borrarMedio`: los
 * que ya no existen o que esta persona no puede borrar se informan en `omitidos`
 * y no frenan a los demás.
 */
export async function borrarMedios(input: {
  organizationId: string;
  userId: string;
  puedeAdministrar: boolean;
  ids: string[];
}): Promise<{ borrados: string[]; omitidos: { id: string; motivo: string; usos?: UsoDeMedio[] }[]; aviso: string }> {
  const borrados: string[] = [];
  const omitidos: { id: string; motivo: string; usos?: UsoDeMedio[] }[] = [];
  for (const id of new Set(input.ids)) {
    try {
      await borrarMedio({ ...input, id });
      borrados.push(id);
    } catch (err) {
      if (err instanceof MedioError) omitidos.push({ id, motivo: err.message, ...(err.usos ? { usos: err.usos } : {}) });
      else throw err;
    }
  }
  return { borrados, omitidos, aviso: AVISO_ENLACES_PEGADOS };
}
