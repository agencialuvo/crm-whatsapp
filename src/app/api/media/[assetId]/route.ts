import { eq } from "drizzle-orm";
import { apiError, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  ensureAssetAvailable,
  mediaFilePath,
} from "@/server/whatsapp/media";
import { serveFileStream } from "@/server/whatsapp/media-stream";
import { lecturaDe } from "@/server/medios/store";
import { objectStore } from "@/server/storage";
import { mediaResponseHeaders } from "@/server/whatsapp/media-headers";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ assetId: string }> };

/**
 * 008 — Sirve el binario de un adjunto desde el volumen local. Solo con
 * sesión y dentro de la organización (un asset ajeno responde 404: jamás se
 * filtra existencia entre tenants). Si el archivo aún no se descargó,
 * intenta on-demand contra Graph; si Meta ya lo expiró → 410.
 */
export const GET = withAuth(async (session, req: Request, ctx: Params) => {
  const { assetId } = await ctx.params;
  if (!/^[\w.-]{1,64}$/.test(assetId)) {
    return apiError(422, "invalid", "assetId inválido");
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(schema.mediaAsset)
    .where(
      scoped(
        schema.mediaAsset.organizationId,
        session.organizationId,
        eq(schema.mediaAsset.id, assetId)
      )
    )
    .limit(1);
  let asset = rows[0];
  if (!asset) return apiError(404, "not_found", "Adjunto no encontrado");

  if (asset.kind === "location" || asset.kind === "contacts") {
    // Sin binario: el payload viaja en el DTO del mensaje.
    return apiError(404, "no_binary", "Este adjunto no tiene archivo");
  }

  // 048: un adjunto que ES un medio de la biblioteca no tiene copia propia: se sirve desde el medio (R2 → redirección
  // firmada de 10 min, los bytes no pasan por aquí; disco → el archivo de la biblioteca).
  if (asset.libraryItemId) {
    const m = schema.mediaLibraryItem;
    const [item] = await db
      .select()
      .from(m)
      .where(scoped(m.organizationId, session.organizationId, eq(m.id, asset.libraryItemId)))
      .limit(1);
    if (!item) return apiError(410, "gone", "Ese archivo se eliminó de la biblioteca de Medios");
    const l = lecturaDe(item);
    if (l.donde === "r2") {
      const url = await objectStore()
        ?.signRead(l.clave, { contentType: item.mimeType, ttlSeconds: 600 })
        .catch(() => null);
      if (!url) return apiError(503, "unavailable", "El almacenamiento no está disponible");
      return new Response(null, { status: 302, headers: { location: url, "cache-control": "private, max-age=300" } });
    }
    try {
      return await serveFileStream(req, l.ruta, mediaResponseHeaders(asset, 0));
    } catch {
      return apiError(410, "gone", "El archivo no está en el volumen");
    }
  }

  if (asset.fetchStatus !== "available") {
    // On-demand: reintenta la descarga en el momento (pending o failed).
    asset = (await ensureAssetAvailable(session.organizationId, assetId)) ?? asset;
  }
  if (asset.fetchStatus !== "available" || !asset.storagePath) {
    return apiError(
      410,
      "gone",
      "El contenido ya no está disponible (expiró en WhatsApp antes de poder copiarse)"
    );
  }

  try {
    // #78: nosniff + CSP sandbox siempre; inline solo para lo previsualizable.
    return await serveFileStream(
      req,
      mediaFilePath(session.organizationId, assetId),
      mediaResponseHeaders(asset, 0)
    );
  } catch {
    return apiError(410, "gone", "El archivo del adjunto no está en el volumen");
  }
});
