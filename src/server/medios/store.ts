import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { getEnv } from "@/lib/env";
import { formatBytes, nombreLegible, validarMedio, type MedioDto, type MedioTipo } from "@/lib/medios";
import { BYTES_PARA_RECONOCER, detectarFormato, revisarSvg } from "@/server/medios/sniff";

/**
 * Módulo Medios — la biblioteca de imágenes y videos del negocio.
 *
 * El binario vive en el volumen local (`MEDIA_DIR/<org>/medios/<id>`), igual
 * que los adjuntos: sin S3 ni terceros (constitución II). La fila en BD lleva
 * el nombre, el tipo real y el peso.
 */

export class MedioError extends Error {
  constructor(
    readonly code: "empty" | "unsupported_type" | "too_large" | "not_found" | "forbidden" | "in_use",
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

export function medioToDto(f: Fila): MedioDto {
  return {
    id: f.id,
    nombre: f.name,
    tipo: f.kind,
    mime: f.mimeType,
    bytes: f.sizeBytes,
    origen: f.source === "upload" ? "archivo" : "url",
    urlOrigen: f.sourceUrl,
    ruta: `/api/medios/${f.id}/archivo`,
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
  const archivo = rutaDeMedio(input.organizationId, id);
  await mkdir(path.dirname(archivo), { recursive: true });
  await writeFile(archivo, input.data);

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
      })
      .returning();
    return medioToDto(fila!);
  } catch (err) {
    // Sin fila, el archivo sería un huérfano que nadie podría borrar.
    await rm(archivo, { force: true }).catch(() => {});
    throw err;
  }
}

/** Hasta este peso un medio se arma en memoria (las imágenes); lo mayor se escribe a disco en flujo. */
const MAX_EN_MEMORIA = 8 * 1024 * 1024;

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
 * Guarda un medio que llega como FLUJO de bytes (cuerpo directo de la subida).
 * Reconoce el formato con los primeros bytes y a partir de ahí corta en cuanto
 * se pasa del límite de ESE formato, sin esperar a que termine. Las imágenes
 * (chicas) se arman en memoria y siguen el camino de `crearMedio`; el video se
 * escribe a disco trozo a trozo, así 5 GB no pasan por la memoria del servidor.
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
    // 1) Lo mínimo para reconocer el formato.
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
    const grande = formato !== null && formato.maxBytes > MAX_EN_MEMORIA;

    if (!grande) {
      // Imagen (o algo que no es un formato válido): el límite es chico, se arma entero y valida `crearMedio`.
      const tope = formato?.maxBytes ?? MAX_EN_MEMORIA;
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
    }

    // 2) Video: a disco en flujo.
    if (input.soloTipo && formato.tipo !== input.soloTipo) {
      throw new MedioError("unsupported_type", `«${input.nombre}» es un video. Aquí solo se aceptan imágenes (JPG, PNG, WEBP o AVIF).`);
    }
    const id = newId("mediaLibraryItem");
    const archivo = rutaDeMedio(input.organizationId, id);
    const parcial = `${archivo}.parcial`;
    await mkdir(path.dirname(archivo), { recursive: true });
    const fh = await open(parcial, "w");
    let escritos = 0;
    try {
      const escribir = async (t: Uint8Array) => {
        escritos += t.byteLength;
        if (escritos > formato.maxBytes) {
          throw new MedioError(
            "too_large",
            `«${input.nombre}» pesa más de ${formatBytes(formato.maxBytes)}, el máximo para ${formato.etiqueta}.`
          );
        }
        await fh.write(t);
      };
      for (const t of trozos) await escribir(t);
      while (!terminado) {
        const r = await reader.read();
        if (r.done) terminado = true;
        else await escribir(r.value);
      }
    } catch (err) {
      await fh.close().catch(() => {});
      await rm(parcial, { force: true }).catch(() => {});
      throw err;
    }
    await fh.close();
    const valido = validarMedio(input.nombre, formato.mime, escritos, opts);
    if (!valido.ok) {
      await rm(parcial, { force: true }).catch(() => {});
      throw new MedioError(valido.code, valido.message);
    }
    await rename(parcial, archivo);
    try {
      const [fila] = await getDb()
        .insert(schema.mediaLibraryItem)
        .values({
          id,
          organizationId: input.organizationId,
          name: nombreLegible(input.nombre),
          kind: formato.tipo,
          mimeType: formato.mime,
          sizeBytes: escritos,
          source: "upload",
          sourceUrl: null,
          createdBy: input.userId,
        })
        .returning();
      return medioToDto(fila!);
    } catch (err) {
      await rm(archivo, { force: true }).catch(() => {});
      throw err;
    }
  } finally {
    // Si se rechazó antes de leerlo todo, se descarta (sin guardar) lo poco que falte: cortar la conexión a media
    // subida hace que el cliente no vea la respuesta. Lo mucho se corta: no se reciben GB solo para decir que no.
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
        tipo ? eq(schema.mediaLibraryItem.kind, tipo) : undefined
      )
    )
    .orderBy(desc(schema.mediaLibraryItem.createdAt));
  return filas.map(medioToDto);
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
    .where(eq(schema.mediaLibraryItem.id, id))
    .limit(1);
  return fila ?? null;
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
  await rm(rutaDeMedio(input.organizationId, input.id), { force: true }).catch(() => {});
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
