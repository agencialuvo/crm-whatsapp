import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2Config, type R2Config } from "@/server/storage/config";
import { StorageError, type ObjectStore } from "@/server/storage/types";

/**
 * 048 — Cloudflare R2 (API compatible con S3). ÚNICO archivo, con `config.ts`, que importa `@aws-sdk/*`.
 * Las URLs firmadas se calculan en el proceso (sin ir a R2).
 */

const HORA = 3600_000;

function cliente(c: R2Config): S3Client {
  // R2 no soporta los checksums opcionales que el SDK agrega por defecto a las URLs firmadas (devuelven 403):
  // solo se calculan cuando la operación los exige. Variable aparte: las versiones viejas del SDK ignoran estas claves.
  const opciones = {
    region: "auto",
    endpoint: c.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };
  return new S3Client(opciones as S3ClientConfig);
}

async function aBuffer(body: unknown): Promise<Buffer> {
  const b = body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!b?.transformToByteArray) throw new StorageError("unavailable", "R2 devolvió un cuerpo vacío");
  return Buffer.from(await b.transformToByteArray());
}

function esNoExiste(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

export function createR2Store(config: R2Config | null = r2Config(), injected?: S3Client): ObjectStore {
  if (!config) throw new StorageError("unavailable", "R2 no está configurado");
  const s3 = injected ?? cliente(config);
  const Bucket = config.bucket;

  const store: ObjectStore = {
    async signUpload(key, { contentType, contentLength, now }) {
      const ttl = 15 * 60;
      // Tipo y tamaño FIRMADOS: R2 rechaza un cuerpo distinto del que se validó.
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ContentLength: contentLength }),
        { expiresIn: ttl, signingDate: now, signableHeaders: new Set(["content-type", "content-length"]), unhoistableHeaders: new Set(["content-type", "content-length"]) }
      );
      return {
        url,
        headers: { "Content-Type": contentType },
        expiresAt: new Date((now ?? new Date()).getTime() + ttl * 1000),
      };
    },
    async signRead(key, opts = {}) {
      const ttl = opts.ttlSeconds ?? 2 * 3600;
      const ahora = (opts.now ?? new Date()).getTime();
      // Fecha de firma redondeada a la hora: la misma URL toda la hora (cachéable); el vencimiento cuenta desde ahí.
      const firma = new Date(Math.floor(ahora / HORA) * HORA);
      const nombre = opts.fileName?.replace(/[^\w.-]+/g, "_");
      return getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
          ResponseContentDisposition: `${opts.download ? "attachment" : "inline"}${nombre ? `; filename="${nombre}"` : ""}`,
        }),
        { expiresIn: ttl, signingDate: firma }
      );
    },
    async head(key) {
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType ?? null };
      } catch (err) {
        if (esNoExiste(err)) return null;
        throw new StorageError("unavailable", "No se pudo consultar el almacenamiento");
      }
    },
    async readRange(key, from, to) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket, Key: key, Range: `bytes=${from}-${to}` }));
        return await aBuffer(r.Body);
      } catch (err) {
        if (esNoExiste(err)) throw new StorageError("not_found", "El archivo no está en el almacenamiento");
        throw new StorageError("unavailable", "No se pudo leer el almacenamiento");
      }
    },
    async readAll(key, maxBytes) {
      const h = await store.head(key);
      if (!h) throw new StorageError("not_found", "El archivo no está en el almacenamiento");
      if (h.size > maxBytes) throw new StorageError("too_large", "El archivo supera el límite");
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
        return await aBuffer(r.Body);
      } catch (err) {
        if (esNoExiste(err)) throw new StorageError("not_found", "El archivo no está en el almacenamiento");
        throw new StorageError("unavailable", "No se pudo leer el almacenamiento");
      }
    },
    async put(key, body, contentType) {
      try {
        await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
      } catch {
        throw new StorageError("unavailable", "No se pudo guardar en el almacenamiento");
      }
    },
    async copy(from, to) {
      try {
        await s3.send(new CopyObjectCommand({ Bucket, Key: to, CopySource: `${Bucket}/${from}` }));
      } catch {
        throw new StorageError("unavailable", "No se pudo copiar dentro del almacenamiento");
      }
    },
    async delete(key) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
      } catch {
        throw new StorageError("unavailable", "No se pudo borrar del almacenamiento");
      }
    },
  };
  return store;
}
