import { rm } from "node:fs/promises";
import { FAVICON_ASSET } from "@/lib/favicon";
import { claveDeMedio, objectStore } from "@/server/storage";
import { mediaFilePath, saveMediaFile } from "@/server/whatsapp/media";

/**
 * Hallazgo C — dónde vive el icono de la pestaña y cómo se guarda y se quita sin dejar versiones viejas.
 *
 * Un solo archivo por organización (`FAVICON_ASSET`). Con R2 activo va a R2 (`org/<org>/medios/favicon`); sin R2, a
 * `MEDIA_DIR/<org>/favicon`. La lectura (`readMediaFile`) prefiere R2 y usa el disco de respaldo, así que:
 * - al GUARDAR en R2 se borra la copia de disco, si la había: si no, una subida anterior a encender R2 quedaría de
 *   respaldo y reaparecería si R2 dejara de responder;
 * - al QUITAR se borran las dos: el objeto de R2 y el archivo local. Cada borrado es independiente y nunca lanza: la
 *   marca ya no referencia el icono, un huérfano es inofensivo y no debe romper la respuesta al dueño.
 */

function avisar(donde: string, err: unknown): void {
  console.warn(`[favicon] no se pudo borrar el icono de ${donde}:`, err instanceof Error ? err.message : err);
}

/** Guarda el icono. Devuelve dónde quedó (`r2` o `local`). */
export async function guardarFavicon(organizationId: string, data: Uint8Array, mime: string): Promise<"r2" | "local"> {
  const ruta = await saveMediaFile(organizationId, FAVICON_ASSET, data, mime);
  if (!ruta.startsWith("r2:")) return "local";
  await rm(mediaFilePath(organizationId, FAVICON_ASSET), { force: true }).catch((e) => avisar("disco (copia anterior)", e));
  return "r2";
}

/** Quita el icono de R2 y del disco. Nunca lanza. */
export async function quitarFavicon(organizationId: string): Promise<void> {
  await rm(mediaFilePath(organizationId, FAVICON_ASSET), { force: true }).catch((e) => avisar("disco", e));
  const r2 = objectStore();
  if (r2) await r2.delete(claveDeMedio(organizationId, FAVICON_ASSET)).catch((e) => avisar("R2", e));
}
