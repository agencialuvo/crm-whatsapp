import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { graphRequest, MetaApiError } from "@/lib/meta/client";
import {
  getCredentialsByOrg,
  type Credentials,
} from "@/server/whatsapp/credentials";
import { isForbiddenUploadMime } from "@/server/whatsapp/media-headers";
import { claveDeMedio, objectStore } from "@/server/storage";

/**
 * 008 — Única frontera de media con la Graph API (constitución II: todo el
 * tráfico a Meta pasa por adaptadores dedicados) + persistencia en el volumen
 * local `MEDIA_DIR`. Meta expira sus archivos (~30 días, URLs de minutos):
 * el disco propio es la copia durable que la UI previsualiza.
 */

export type MediaKind = (typeof schema.mediaAsset.$inferSelect)["kind"];

/** Límites de la Cloud API por tipo (validados ANTES de tocar red, FR-007). */
export const MEDIA_LIMITS: Record<
  Exclude<MediaKind, "location" | "contacts">,
  { maxBytes: number; mimes: RegExp; label: string }
> = {
  image: {
    maxBytes: 5 * 1024 * 1024,
    mimes: /^image\/(jpeg|png|webp)$/,
    label: "imagen (jpeg/png/webp, máx. 5 MB)",
  },
  sticker: {
    maxBytes: 100 * 1024,
    mimes: /^image\/webp$/,
    label: "sticker (webp, máx. 100 KB)",
  },
  audio: {
    maxBytes: 16 * 1024 * 1024,
    mimes: /^audio\/(aac|mp4|mpeg|amr|ogg|opus)/,
    label: "audio (aac/mp4/mpeg/amr/ogg, máx. 16 MB)",
  },
  video: {
    maxBytes: 16 * 1024 * 1024,
    mimes: /^video\/(mp4|3gpp)$/,
    label: "video (mp4/3gpp, máx. 16 MB)",
  },
  document: {
    maxBytes: 100 * 1024 * 1024,
    mimes: /^[\w.-]+\/[\w.+-]+$/,
    label: "documento (máx. 100 MB)",
  },
};

/** Clasifica un MIME de archivo saliente al tipo de mensaje de la Cloud API. */
export function kindFromMime(mime: string): "image" | "audio" | "video" | "document" {
  if (MEDIA_LIMITS.image.mimes.test(mime)) return "image";
  if (MEDIA_LIMITS.audio.mimes.test(mime)) return "audio";
  if (MEDIA_LIMITS.video.mimes.test(mime)) return "video";
  return "document";
}

export class MediaValidationError extends Error {
  code: "too_large" | "unsupported_type";
  constructor(code: MediaValidationError["code"], message: string) {
    super(message);
    this.name = "MediaValidationError";
    this.code = code;
  }
}

/**
 * Valida MIME y tamaño para envío; devuelve el kind resuelto. Los formatos
 * que WhatsApp no acepta como su tipo nativo (p. ej. image/bmp) van como
 * documento — igual que hace la app de WhatsApp. HTML y SVG no van ni como
 * documento (#78): el navegador de quien los abra los trataría como una
 * página, y se servirían desde el origen del CRM.
 */
export function validateOutgoing(mime: string, sizeBytes: number) {
  if (!/^[\w.-]+\/[\w.+-]+$/.test(mime)) {
    throw new MediaValidationError("unsupported_type", "Tipo de archivo no reconocido");
  }
  if (isForbiddenUploadMime(mime)) {
    throw new MediaValidationError(
      "unsupported_type",
      "Los archivos HTML y SVG no se pueden enviar como adjunto: un navegador los abriría como página. Conviértelo a PDF o a imagen"
    );
  }
  const kind = kindFromMime(mime);
  const limit = MEDIA_LIMITS[kind];
  if (sizeBytes > limit.maxBytes) {
    throw new MediaValidationError(
      "too_large",
      `El archivo excede el límite de ${limit.label}`
    );
  }
  return kind;
}

/* ---------- Disco local ---------- */

function assertSafeSegment(s: string): void {
  if (!/^[\w.-]+$/.test(s)) throw new Error(`segmento de ruta inválido: ${s}`);
}

/** Ruta absoluta del archivo de un asset dentro de MEDIA_DIR. */
export function mediaFilePath(organizationId: string, assetId: string): string {
  assertSafeSegment(organizationId);
  assertSafeSegment(assetId);
  return path.join(getEnv().MEDIA_DIR, organizationId, assetId);
}

export async function saveMediaFile(
  organizationId: string,
  assetId: string,
  data: Buffer | Uint8Array,
  contentType?: string | null
): Promise<string> {
  // Con R2 activo los adjuntos viven en Cloudflare y el disco de Render no se usa (se llenaba). Si R2 falla NO se cae al
  // disco: el que llama falla y se reintenta (un entrante se vuelve a bajar de Meta al abrirlo). Sin R2, disco local.
  const store = objectStore();
  if (store) {
    const clave = claveDeMedio(organizationId, assetId);
    await store.put(clave, data, contentType || "application/octet-stream");
    return `r2:${clave}`;
  }
  const file = mediaFilePath(organizationId, assetId);
  await mkdir(path.dirname(file), { recursive: true });
  // Se escribe aparte y se renombra: si `file` fuera un enlace duro compartido (dedupe), escribir encima lo truncaria
  // para todos los que lo comparten; y con el disco lleno ya no deja un archivo de 0 bytes.
  const tmp = `${file}.part`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return path.join(organizationId, assetId); // ruta relativa persistida en BD
}

/** Por debajo de esto no vale la pena comparar contenido. */
const MIN_DEDUPE_BYTES = 1024 * 1024;

function sha256File(file: string): Promise<string> {
  return new Promise((ok, no) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => ok(h.digest("hex")))
      .on("error", no);
  });
}

/**
 * Si ya hay en la misma organizacion un archivo IDENTICO (mismo tamano y mismo SHA-256), el recien guardado pasa a ser
 * un enlace duro a ese: dos ids, un solo archivo fisico. Nada cambia para la app (cada id sigue teniendo su ruta) y el
 * disco no se llena de copias del mismo video. Mejor esfuerzo: nunca lanza y, si algo falla, el archivo queda como estaba.
 */
export async function dedupeMediaFile(
  organizationId: string,
  assetId: string,
  data: Buffer | Uint8Array
): Promise<boolean> {
  if (data.byteLength < MIN_DEDUPE_BYTES) return false;
  try {
    const a = schema.mediaAsset;
    const candidatos = await getDb()
      .select({ id: a.id })
      .from(a)
      .where(
        and(
          eq(a.organizationId, organizationId),
          eq(a.fileSize, data.byteLength),
          ne(a.id, assetId),
          isNotNull(a.storagePath)
        )
      )
      .limit(5);
    if (!candidatos.length) return false;
    const hash = createHash("sha256").update(data).digest("hex");
    const destino = mediaFilePath(organizationId, assetId);
    for (const c of candidatos) {
      const origen = mediaFilePath(organizationId, c.id);
      const tmp = `${destino}.dedup`;
      try {
        if ((await stat(origen)).size !== data.byteLength) continue;
        if ((await sha256File(origen)) !== hash) continue;
        await link(origen, tmp);
        await rename(tmp, destino);
        return true;
      } catch {
        await rm(tmp, { force: true }).catch(() => {});
      }
    }
  } catch (err) {
    console.warn(`[media] dedupe de ${assetId} omitido:`, err instanceof Error ? err.message : err);
  }
  return false;
}

export async function readMediaFile(
  organizationId: string,
  assetId: string
): Promise<Buffer> {
  try {
    return await readFile(mediaFilePath(organizationId, assetId));
  } catch (err) {
    // No esta en el disco: puede estar en R2 (adjuntos nuevos).
    const store = objectStore();
    if (!store) throw err;
    return store.readAll(claveDeMedio(organizationId, assetId), MEDIA_LIMITS.document.maxBytes);
  }
}

/**
 * 018 — Borra el archivo de un asset. Sin error si ya no estaba: quien lo
 * llama está deshaciendo una copia que sobró, y un archivo que no existe es
 * justo el estado al que quiere llegar.
 */
export async function deleteMediaFile(
  organizationId: string,
  assetId: string
): Promise<void> {
  await rm(mediaFilePath(organizationId, assetId), { force: true });
  await objectStore()?.delete(claveDeMedio(organizationId, assetId)).catch(() => {});
}

/* ---------- Descarga desde Graph (entrantes y echoes) ---------- */

type GraphMediaMeta = { url?: string; mime_type?: string; file_size?: number };

export class MediaFetchError extends Error {
  /** true si Meta ya no tiene el archivo (expirado/borrado) — no reintentar. */
  gone: boolean;
  constructor(message: string, gone = false) {
    super(message);
    this.name = "MediaFetchError";
    this.gone = gone;
  }
}

/**
 * Descarga un media de Graph: GET {mediaId} → url efímera → GET con Bearer.
 * El token JAMÁS sale del servidor.
 */
export async function downloadGraphMedia(
  token: string,
  waMediaId: string,
  maxBytes: number = MEDIA_LIMITS.document.maxBytes
): Promise<{ data: Buffer; mimeType: string | null; fileSize: number }> {
  let meta: GraphMediaMeta;
  try {
    meta = await graphRequest<GraphMediaMeta>(waMediaId, { token });
  } catch (err) {
    const gone = err instanceof MetaApiError && err.status === 404;
    throw new MediaFetchError("Meta no entregó la metadata del adjunto", gone);
  }
  if (!meta.url) throw new MediaFetchError("Meta no entregó URL del adjunto");
  if (meta.file_size && meta.file_size > maxBytes) {
    throw new MediaFetchError("El adjunto excede el límite de tamaño", true);
  }

  let res: Response;
  try {
    res = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new MediaFetchError("No se pudo descargar el adjunto");
  }
  if (!res.ok) {
    throw new MediaFetchError(
      `La descarga devolvió ${res.status}`,
      res.status === 404 || res.status === 410
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new MediaFetchError("El adjunto excede el límite de tamaño", true);
  }
  return {
    data: buf,
    mimeType: meta.mime_type ?? res.headers.get("content-type"),
    fileSize: buf.byteLength,
  };
}

/**
 * Descarga un media de Graph y lo sube a R2 EN STREAMING: la memoria no depende del tamano del archivo (un video de
 * 76 MB leido entero tumbo la instancia de 512 MB). Devuelve null si no se puede (R2 apagado o Meta no dio el tamano):
 * el que llama usa entonces el camino con buffer.
 */
export async function streamGraphMediaToR2(
  token: string,
  waMediaId: string,
  clave: string,
  fallbackMime: string | null,
  maxBytes: number = MEDIA_LIMITS.document.maxBytes
): Promise<{ mimeType: string | null; fileSize: number } | null> {
  const store = objectStore();
  if (!store) return null;
  let meta: GraphMediaMeta;
  try {
    meta = await graphRequest<GraphMediaMeta>(waMediaId, { token });
  } catch (err) {
    const gone = err instanceof MetaApiError && err.status === 404;
    throw new MediaFetchError("Meta no entregó la metadata del adjunto", gone);
  }
  if (!meta.url) throw new MediaFetchError("Meta no entregó URL del adjunto");
  if (!meta.file_size) return null; // sin tamano no se puede firmar la subida
  if (meta.file_size > maxBytes) {
    throw new MediaFetchError("El adjunto excede el límite de tamaño", true);
  }
  let res: Response;
  try {
    res = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new MediaFetchError("No se pudo descargar el adjunto");
  }
  if (!res.ok || !res.body) {
    throw new MediaFetchError(
      `La descarga devolvió ${res.status}`,
      res.status === 404 || res.status === 410
    );
  }
  const mimeType = meta.mime_type ?? res.headers.get("content-type") ?? fallbackMime;
  const firmado = await store.signUpload(clave, {
    contentType: mimeType || "application/octet-stream",
    contentLength: meta.file_size,
  });
  let put: Response;
  try {
    put = await fetch(firmado.url, {
      method: "PUT",
      headers: { ...firmado.headers, "content-length": String(meta.file_size) },
      body: res.body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch (err) {
    throw new MediaFetchError(`No se pudo subir el adjunto a R2: ${err instanceof Error ? err.message : err}`);
  }
  if (!put.ok) throw new MediaFetchError(`R2 rechazó la subida (${put.status})`);
  const head = await store.head(clave);
  if (!head || head.size !== meta.file_size) {
    await store.delete(clave).catch(() => {});
    throw new MediaFetchError("La subida a R2 quedó incompleta");
  }
  return { mimeType: mimeType ?? null, fileSize: meta.file_size };
}

/**
 * Garantiza que el asset esté en disco (`fetchStatus=available`).
 * Se usa en la descarga in-process post-ingesta Y on-demand desde la ruta de
 * media. Nunca lanza hacia el webhook: el que llama decide qué hacer con el
 * resultado. Devuelve el asset actualizado o null si no se pudo.
 */
export async function ensureAssetAvailable(
  organizationId: string,
  assetId: string
): Promise<typeof schema.mediaAsset.$inferSelect | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.mediaAsset)
    .where(eq(schema.mediaAsset.id, assetId))
    .limit(1);
  const asset = rows[0];
  if (!asset || asset.organizationId !== organizationId) return null;
  if (asset.fetchStatus === "available") return asset;
  if (!asset.waMediaId) return null; // location/contacts no tienen binario

  const creds = await getCredentialsByOrg(organizationId);
  if (!creds) return null;

  try {
    // Con R2: Meta -> R2 en streaming, sin pasar el archivo por la memoria. Sin R2 (o sin tamano): camino con buffer y disco.
    const clave = claveDeMedio(organizationId, assetId);
    const directo = await streamGraphMediaToR2(creds.token, asset.waMediaId, clave, asset.mimeType);
    let storagePath: string;
    let mimeType: string | null;
    let fileSize: number;
    if (directo) {
      storagePath = `r2:${clave}`;
      mimeType = directo.mimeType;
      fileSize = directo.fileSize;
    } else {
      const d = await downloadGraphMedia(creds.token, asset.waMediaId);
      storagePath = await saveMediaFile(organizationId, assetId, d.data, asset.mimeType ?? d.mimeType);
      if (!storagePath.startsWith("r2:")) await dedupeMediaFile(organizationId, assetId, d.data);
      mimeType = d.mimeType;
      fileSize = d.fileSize;
    }
    const updated = await db
      .update(schema.mediaAsset)
      .set({
        storagePath,
        mimeType: asset.mimeType ?? mimeType,
        fileSize,
        fetchStatus: "available",
        fetchError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.mediaAsset.id, assetId))
      .returning();
    return updated[0] ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.mediaAsset)
      .set({ fetchStatus: "failed", fetchError: message, updatedAt: new Date() })
      .where(eq(schema.mediaAsset.id, assetId));
    console.warn(`[media] descarga del asset ${assetId} falló: ${message}`);
    return null;
  }
}

/* ---------- Subida a Graph (salientes) ---------- */

/**
 * Sube un archivo a Graph (`POST /{phone_number_id}/media`, multipart) y
 * devuelve el media id para usar en /messages. Errores → MetaApiError (la
 * capa de envío los traduce con las mismas reglas que el texto).
 */
export async function uploadGraphMedia(
  credentials: Credentials,
  file: { data: Buffer | Uint8Array; mimeType: string; fileName?: string }
): Promise<string> {
  const env = getEnv();
  const url = `${env.META_GRAPH_BASE_URL}/${env.META_GRAPH_API_VERSION}/${credentials.phoneNumberId}/media`;
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", file.mimeType);
  const bytes = new Uint8Array(file.data);
  form.set(
    "file",
    new Blob([bytes], { type: file.mimeType }),
    file.fileName ?? "adjunto"
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.token}` },
      body: form,
    });
  } catch (cause) {
    throw new MetaApiError("No se pudo contactar la API de Meta", {
      status: 0,
      details: cause,
    });
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const err = (json as { error?: { message?: string; code?: number; type?: string } })
      ?.error;
    throw new MetaApiError(err?.message ?? `Meta respondió ${res.status}`, {
      status: res.status,
      code: err?.code ?? null,
      type: err?.type ?? null,
      details: json ?? text,
    });
  }
  const id = (json as { id?: string })?.id;
  if (!id) {
    throw new MetaApiError("Meta no devolvió ID del media subido", {
      status: res.status,
    });
  }
  return id;
}
