import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { getEnv } from "@/lib/env";
import {
  esEnviablePorWhatsapp,
  formatBytes,
  MAX_VIDEO_BYTES,
  nombreLegible,
  validarMedio,
  type MedioDto,
  type MedioTipo,
} from "@/lib/medios";
import { BYTES_PARA_RECONOCER, detectarFormato, revisarCodecsMp4, revisarSvg } from "@/server/medios/sniff";
import { claveDeMedio, clavePendiente, objectStore, StorageError } from "@/server/storage";

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
    message: string
  ) {
    super(message);
    this.name = "MedioError";
  }
}

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
  const opts = { svg: input.permitirSvg === true };
  const formato = detectarFormato(input.data, opts);
  if (!formato) {
    throw new MedioError(
      "unsupported_type",
      `«${input.nombre}» no es una imagen o video válido. Se aceptan JPG, PNG, WEBP, AVIF${opts.svg ? ", SVG" : ""} y MP4.`
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
      })
      .returning();
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

/**
 * Guarda un medio que llega como FLUJO de bytes (cuerpo directo de la subida o la descarga de un enlace). Desde 048 el
 * tope de todo es 16 MB, así que se arma en memoria cortando EN CUANTO se pasa del límite del formato reconocido con los
 * primeros bytes (nunca se reciben GB solo para decir que no) y valida `crearMedio`. Con R2 encendido la pantalla no
 * usa esta vía: sube directo al bucket (`prepararSubida` / `confirmarSubida`).
 */
export async function crearMedioDesdeFlujo(input: {
  organizationId: string;
  userId: string;
  flujo: ReadableStream<Uint8Array>;
  nombre: string;
  soloTipo?: MedioTipo;
  permitirSvg?: boolean;
}): Promise<MedioDto> {
  const opts = { svg: input.permitirSvg === true };
  const reader = input.flujo.getReader();
  const trozos: Uint8Array[] = [];
  let total = 0;
  let terminado = false;
  try {
    while (total < BYTES_PARA_RECONOCER && !terminado) {
      const r = await reader.read();
      if (r.done) terminado = true;
      else if (r.value.byteLength > 0) {
        trozos.push(r.value);
        total += r.value.byteLength;
      }
    }
    const formato = detectarFormato(unir(trozos, total), opts);
    const tope = formato?.maxBytes ?? MAX_VIDEO_BYTES;
    while (!terminado) {
      const r = await reader.read();
      if (r.done) {
        terminado = true;
        break;
      }
      trozos.push(r.value);
      total += r.value.byteLength;
      if (total > tope) {
        throw new MedioError(
          "too_large",
          `«${input.nombre}» pesa más de ${formatBytes(tope)}, el máximo para ${formato?.etiqueta ?? "este formato"}.`
        );
      }
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

/** ¿Está el archivo? (R2: un HEAD; local: stat). Distingue «no existe el elemento» de «no hay archivo». */
export async function existeArchivoDeMedio(f: Fila): Promise<boolean> {
  const l = lecturaDe(f);
  if (l.donde === "local") {
    try {
      await stat(l.ruta);
      return true;
    } catch {
      return false;
    }
  }
  const r2 = objectStore();
  if (!r2) return false;
  return (await r2.head(l.clave)) !== null;
}

/** Quita el binario de un medio (disco o R2). Nunca lanza: un huérfano lo barre el mantenimiento. */
async function quitarBinario(f: Fila): Promise<void> {
  const l = lecturaDe(f);
  if (l.donde === "local") {
    await rm(l.ruta, { force: true }).catch(() => {});
    return;
  }
  await objectStore()?.delete(l.clave).catch(() => {});
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
  const valido = validarMedio(input.nombre, input.mime, input.bytes, { svg: input.permitirSvg === true });
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

  let datos: Buffer;
  try {
    // El MP4 y el SVG se leen enteros (≤16 MB) para revisarlos por dentro; del resto basta la cabeza para reconocerlos.
    datos =
      fila.kind === "video" || fila.mimeType === "image/svg+xml"
        ? await r2.readAll(pendiente, MAX_VIDEO_BYTES)
        : await r2.readRange(pendiente, 0, BYTES_PARA_RECONOCER - 1);
  } catch {
    throw new MedioError("unavailable", "No se pudo leer el archivo para comprobarlo. Inténtalo de nuevo.");
  }
  const formato = detectarFormato(datos, { svg: fila.mimeType === "image/svg+xml" });
  if (!formato || formato.mime !== fila.mimeType) {
    return rechazar("unsupported_type", `«${fila.name}» no es del formato que dice ser.`);
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
    .set({ status: "ready", storageKey: definitiva })
    .where(and(eq(m.organizationId, input.organizationId), eq(m.id, fila.id), eq(m.status, "pending")))
    .returning();
  await r2.delete(pendiente).catch(() => {});
  if (!listo) {
    // Otra confirmación ganó la carrera: devuelve lo que quedó.
    const [ya] = await db.select().from(m).where(scoped(m.organizationId, input.organizationId, eq(m.id, fila.id))).limit(1);
    return { medio: medioToDto(ya ?? fila), aviso: null };
  }
  return { medio: medioToDto(listo), aviso: formato.tipo === "video" ? revisarCodecsMp4(datos) : null };
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
  // 037: un flujo de automatización que lo envía dejaría de funcionar en silencio.
  const flujos = await flujosQueUsanMedio(input.organizationId, input.id);
  if (flujos.length > 0) {
    throw new MedioError(
      "in_use",
      `«${fila.name}» lo envía ${flujos.length === 1 ? "la automatización" : "las automatizaciones"} ${flujos
        .map((f) => `«${f.name}»`)
        .join(", ")}. Cambia ese paso antes de borrarlo.`
    );
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
}): Promise<{ borrados: string[]; omitidos: { id: string; motivo: string }[] }> {
  const borrados: string[] = [];
  const omitidos: { id: string; motivo: string }[] = [];
  for (const id of new Set(input.ids)) {
    try {
      await borrarMedio({ ...input, id });
      borrados.push(id);
    } catch (err) {
      if (err instanceof MedioError) omitidos.push({ id, motivo: err.message });
      else throw err;
    }
  }
  return { borrados, omitidos };
}
