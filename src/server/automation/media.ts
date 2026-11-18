import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { esEnviablePorWhatsapp, FORMATOS_MEDIO, MAX_VIDEO_BYTES } from "@/lib/medios";
import { lecturaDe } from "@/server/medios/store";
import { stat } from "node:fs/promises";
import type { MediaFile } from "@/server/automation/engine";

/**
 * Automatizaciones — el elemento de la biblioteca de un paso `send_media`. Desde 048 NO lee el archivo: devuelve solo
 * los metadatos (tipo, peso, nombre). Los bytes se leen únicamente si el `media_id` de WhatsApp de ese medio no está
 * en caché (`resolveWaMediaId`), así un envío repetido cuesta 0 de RAM y 0 de ancho de banda.
 * Distingue «el elemento ya no existe» de «existe pero no se puede enviar» para que el historial diga cuál.
 */
export async function loadMediaFile(organizationId: string, mediaId: string): Promise<MediaFile> {
  const m = schema.mediaLibraryItem;
  const [item] = await getDb()
    .select()
    .from(m)
    .where(scoped(m.organizationId, organizationId, eq(m.id, mediaId), eq(m.status, "ready")))
    .limit(1);
  if (!item) return { ok: false, reason: "not_found" };
  // WhatsApp no manda más de 16 MB de video (un video antiguo de la biblioteca puede pesar más) ni AVIF.
  if (item.kind === "video" && item.sizeBytes > MAX_VIDEO_BYTES) return { ok: false, reason: "too_large" };
  if (!esEnviablePorWhatsapp(item.mimeType, item.sizeBytes)) return { ok: false, reason: "unsupported" };
  // En disco, el archivo se comprueba con un stat (gratis). En R2 no se pregunta: casi siempre hay caché y un HEAD por
  // envío sería ancho de banda y latencia de más; si falta, falla al subirlo y queda en el historial.
  const l = lecturaDe(item);
  if (l.donde === "local") {
    try {
      await stat(l.ruta);
    } catch {
      return { ok: false, reason: "file_missing" };
    }
  }
  const ext = FORMATOS_MEDIO.find((f) => f.mime === item.mimeType)?.ext;
  return { ok: true, mimeType: item.mimeType, fileName: ext ? `${item.name}.${ext}` : item.name, bytes: item.sizeBytes };
}
