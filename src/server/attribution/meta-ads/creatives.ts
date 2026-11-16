import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { descargarConReintento, type Descarga } from "@/server/attribution/creativo";
import { deleteMediaFile, saveMediaFile } from "@/server/whatsapp/media";

/**
 * 040 — La imagen del creativo de cada anuncio de la cuenta, copiada al volumen local.
 *
 * Las URL del CDN de Meta caducan y el CSP del CRM no admite hosts externos, así que la imagen se copia (con la
 * descarga acotada de la 018: solo hosts de Meta, con tope de tamaño y de tiempo) y se guarda como un adjunto más,
 * servido con sesión por `/api/media/{id}`. Corre en el worker, después del listado de la cuenta: nada de lo que falle
 * aquí toca la sincronización, Resultados ni la ingesta.
 */

/** Anuncios por pasada: la copia es red + disco, no se hace de golpe para cuentas grandes. */
export const CREATIVES_PER_PASS = 25;

export type Descargador = (url: string) => Promise<Descarga>;

const EXTENSION: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

export type CreativesSummary = { downloaded: number; failed: number; replaced: number };

/** Guarda los bytes como `media_asset` de la organización y devuelve su id. Limpia lo que alcanzó a crear si falla. */
async function guardarCopia(organizationId: string, adId: string, data: Buffer, mimeType: string): Promise<string> {
  const db = getDb();
  const assetId = newId("mediaAsset");
  let archivo = false;
  try {
    await db.insert(schema.mediaAsset).values({
      id: assetId,
      organizationId,
      kind: "image",
      mimeType,
      fileName: `creativo-${adId.replace(/[^\w.-]/g, "_").slice(0, 64)}.${EXTENSION[mimeType] ?? "jpg"}`,
      payload: { origen: "catalogo", adId },
      fetchStatus: "pending",
    });
    const storagePath = await saveMediaFile(organizationId, assetId, data);
    archivo = true;
    await db
      .update(schema.mediaAsset)
      .set({ storagePath, fileSize: data.byteLength, fetchStatus: "available", updatedAt: new Date() })
      .where(eq(schema.mediaAsset.id, assetId));
    return assetId;
  } catch (err) {
    if (archivo) await deleteMediaFile(organizationId, assetId).catch(() => {});
    await db.delete(schema.mediaAsset).where(eq(schema.mediaAsset.id, assetId)).catch(() => {});
    throw err;
  }
}

/** Borra una copia que se reemplazó (el archivo y su fila). Nunca lanza. */
async function borrarCopia(organizationId: string, assetId: string): Promise<void> {
  await deleteMediaFile(organizationId, assetId).catch(() => {});
  await getDb()
    .delete(schema.mediaAsset)
    .where(scoped(schema.mediaAsset.organizationId, organizationId, eq(schema.mediaAsset.id, assetId)))
    .catch(() => {});
}

/**
 * Anuncios del listado cuya copia falta o cuya imagen cambió, los listados más recientemente primero. Una copia que
 * salió de la imagen o de la miniatura vigentes está al día; una descarga fallida de forma permanente también se anota
 * (con su URL) para no reintentarla hasta que el siguiente listado traiga otra.
 */
export async function adsNeedingCreative(organizationId: string, limit = CREATIVES_PER_PASS) {
  const m = schema.metaAd;
  return getDb()
    .select({
      adId: m.adId,
      imageUrl: m.creativeImageUrl,
      thumbUrl: m.creativeThumbUrl,
      assetId: m.creativeAssetId,
    })
    .from(m)
    .where(
      scoped(
        m.organizationId,
        organizationId,
        isNotNull(m.listedAt),
        or(isNotNull(m.creativeImageUrl), isNotNull(m.creativeThumbUrl)),
        sql`(${m.creativeSourceUrl} is null or (${m.creativeSourceUrl} is distinct from ${m.creativeImageUrl} and ${m.creativeSourceUrl} is distinct from ${m.creativeThumbUrl}))`
      )
    )
    .orderBy(desc(m.listedAt))
    .limit(limit);
}

export async function syncCreatives(
  organizationId: string,
  deps: { descargar?: Descargador; limit?: number } = {}
): Promise<CreativesSummary> {
  const descargar = deps.descargar ?? ((u: string) => descargarConReintento(u));
  const out: CreativesSummary = { downloaded: 0, failed: 0, replaced: 0 };
  let pendientes: Awaited<ReturnType<typeof adsNeedingCreative>> = [];
  try {
    pendientes = await adsNeedingCreative(organizationId, deps.limit);
  } catch (err) {
    console.warn("[meta-ads] no se pudieron buscar creativos pendientes:", err instanceof Error ? err.message : err);
    return out;
  }

  for (const ad of pendientes) {
    // La imagen completa primero; si no baja de forma permanente (p. ej. pasa del tope), la miniatura.
    const candidatas = [ad.imageUrl, ad.thumbUrl].filter((u, i, a): u is string => !!u && a.indexOf(u) === i);
    let copia: { url: string; data: Buffer; mimeType: string } | null = null;
    let transitoria = false;
    for (const url of candidatas) {
      const d = await descargar(url);
      if (d.ok) {
        copia = { url, data: d.data, mimeType: d.mimeType };
        break;
      }
      if (d.falla === "transitoria") transitoria = true;
    }

    const where = scoped(schema.metaAd.organizationId, organizationId, eq(schema.metaAd.adId, ad.adId));
    if (!copia) {
      out.failed += 1;
      // Un fallo permanente se anota con la URL elegida: no se reintenta hasta que el listado traiga otra. Uno
      // transitorio (red, 5xx) se deja tal cual para la siguiente pasada.
      if (!transitoria && candidatas[0]) {
        await getDb().update(schema.metaAd).set({ creativeSourceUrl: candidatas[0], updatedAt: new Date() }).where(where).catch(() => {});
      }
      continue;
    }

    try {
      const assetId = await guardarCopia(organizationId, ad.adId, copia.data, copia.mimeType);
      await getDb()
        .update(schema.metaAd)
        .set({ creativeAssetId: assetId, creativeSourceUrl: copia.url, updatedAt: new Date() })
        .where(and(where));
      out.downloaded += 1;
      if (ad.assetId) {
        await borrarCopia(organizationId, ad.assetId);
        out.replaced += 1;
      }
    } catch (err) {
      out.failed += 1;
      console.warn(`[meta-ads] no se pudo guardar el creativo del anuncio ${ad.adId}:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}
