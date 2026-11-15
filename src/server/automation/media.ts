import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { FORMATOS_MEDIO } from "@/lib/medios";
import { rutaDeMedio } from "@/server/medios/store";
import { MEDIA_LIMITS } from "@/server/whatsapp/media";
import type { MediaFile } from "@/server/automation/engine";

/**
 * Automatizaciones — el archivo de un paso `send_media`: un elemento de la biblioteca de Medios, leído del volumen
 * local. Distingue «el elemento ya no existe» de «existe pero su archivo no está» para que el historial diga cuál.
 */
export async function loadMediaFile(organizationId: string, mediaId: string): Promise<MediaFile> {
  const m = schema.mediaLibraryItem;
  const [item] = await getDb()
    .select()
    .from(m)
    .where(scoped(m.organizationId, organizationId, eq(m.id, mediaId)))
    .limit(1);
  if (!item) return { ok: false, reason: "not_found" };
  // La biblioteca admite videos de hasta 5 GB, pero WhatsApp no manda más de 16 MB: se corta ANTES de leerlo a memoria.
  if (item.kind === "video" && item.sizeBytes > MEDIA_LIMITS.video.maxBytes) {
    return { ok: false, reason: "too_large" };
  }
  let data: Buffer;
  try {
    data = await readFile(rutaDeMedio(organizationId, item.id));
  } catch {
    return { ok: false, reason: "file_missing" };
  }
  const ext = FORMATOS_MEDIO.find((f) => f.mime === item.mimeType)?.ext;
  return { ok: true, data, mimeType: item.mimeType, fileName: ext ? `${item.name}.${ext}` : item.name };
}
