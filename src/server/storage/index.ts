import { r2Config } from "@/server/storage/config";
import { createR2Store } from "@/server/storage/r2";
import type { ObjectStore } from "@/server/storage/types";

export { r2Enabled } from "@/server/storage/config";
export { claveDeMedio, claveDeVariante, clavePendiente } from "@/server/storage/keys";
export { StorageError, type ObjectStore } from "@/server/storage/types";

let reemplazo: ObjectStore | null = null;
let memo: { huella: string; store: ObjectStore } | null = null;

/** Solo pruebas: inyecta un almacén en memoria (null lo quita). */
export function __setObjectStoreForTests(store: ObjectStore | null): void {
  reemplazo = store;
}

/** El almacén de R2 (o el inyectado en pruebas); `null` cuando R2 está apagado: ahí manda el disco local. */
export function objectStore(): ObjectStore | null {
  if (reemplazo) return reemplazo;
  const cfg = r2Config();
  if (!cfg) return null;
  const huella = `${cfg.endpoint}|${cfg.bucket}|${cfg.accessKeyId}`;
  if (!memo || memo.huella !== huella) memo = { huella, store: createR2Store(cfg) };
  return memo.store;
}
