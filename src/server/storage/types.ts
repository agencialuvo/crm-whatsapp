/** 048 — El contrato del almacenamiento de objetos de Medios: R2 (opcional) o el disco local (siempre disponible). */

export type SignedUpload = { url: string; headers: Record<string, string>; expiresAt: Date };

/** Un objeto de un listado: su clave, su peso y cuándo se modificó por última vez (la reconciliación de huérfanos lo usa para no tocar lo reciente). */
export type ListedObject = { key: string; size: number; lastModified: Date };

export interface ObjectStore {
  /** Subida directa del navegador: solo R2 (el disco local sube por el servidor). */
  signUpload(key: string, opts: { contentType: string; contentLength: number; now?: Date }): Promise<SignedUpload>;
  /** URL de lectura firmada. La fecha se redondea a la hora para que la URL sea estable y el navegador la cachee. */
  signRead(key: string, opts?: { fileName?: string; download?: boolean; contentType?: string; ttlSeconds?: number; now?: Date }): Promise<string>;
  head(key: string): Promise<{ size: number; contentType: string | null } | null>;
  readRange(key: string, from: number, to: number): Promise<Buffer>;
  readAll(key: string, maxBytes: number): Promise<Buffer>;
  put(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Hallazgo H — lista los objetos bajo un prefijo, una página por llamada (`next` es el cursor de la siguiente). */
  list(prefix: string, opts?: { cursor?: string; limit?: number }): Promise<{ objects: ListedObject[]; next: string | null }>;
}

export class StorageError extends Error {
  constructor(
    readonly code: "unavailable" | "not_found" | "too_large",
    message: string
  ) {
    super(message);
    this.name = "StorageError";
  }
}
