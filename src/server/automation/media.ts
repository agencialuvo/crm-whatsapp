import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { nombreDeEnvio, resolverEnvio } from "@/server/medios/envio";
import { lecturaDe, rutaDeVariante } from "@/server/medios/store";
import { stat } from "node:fs/promises";
import type { MediaFile } from "@/server/automation/engine";

/**
 * Automatizaciones — el elemento de la biblioteca de un paso `send_media`. Desde 048 NO lee el archivo: devuelve solo
 * los metadatos (tipo, peso, nombre). Los bytes se leen únicamente si el `media_id` de WhatsApp de ese medio no está
 * en caché (`resolveWaMediaId`), así un envío repetido cuesta 0 de RAM y 0 de ancho de banda.
 * Distingue «el elemento ya no existe» de «existe pero no se puede enviar» para que el historial diga cuál. Un video
 * con variante optimizada lista devuelve el MIME, el peso y el nombre de la VARIANTE (lo que realmente se manda).
 */
export async function loadMediaFile(organizationId: string, mediaId: string): Promise<MediaFile> {
  const m = schema.mediaLibraryItem;
  const [item] = await getDb()
    .select()
    .from(m)
    .where(scoped(m.organizationId, organizationId, eq(m.id, mediaId), eq(m.status, "ready")))
    .limit(1);
  if (!item) return { ok: false, reason: "not_found" };
  // Qué se manda: la variante optimizada de un video, o el original si ya sirve (`resolverEnvio`).
  const envio = resolverEnvio(item);
  if (!envio.ok) {
    if (envio.razon === "processing") return { ok: false, reason: "processing" };
    if (envio.razon === "variant_failed") return { ok: false, reason: "variant_failed", detail: envio.detalle };
    return { ok: false, reason: envio.razon };
  }
  const l = lecturaDe(item);
  if (l.donde === "local") {
    try {
      await stat(envio.fuente === "variante" ? rutaDeVariante(item.organizationId, item.id) : l.ruta);
    } catch {
      return { ok: false, reason: "file_missing" };
    }
  }
  return { ok: true, mimeType: envio.mimeType, fileName: nombreDeEnvio(item.name, envio.mimeType), bytes: envio.sizeBytes };
}
