import { esEnviablePorWhatsapp, FORMATOS_MEDIO, type EstadoEnvio } from "@/lib/medios";

/**
 * Medios — QUÉ archivo se manda por WhatsApp cuando se envía un medio de la biblioteca. Una sola función pura que usan el
 * motor de automatizaciones (`loadMediaFile`), el envío (`sendLibraryMedia`) y la caché del `media_id` (`resolveWaMediaId`),
 * para que los tres decidan igual.
 *
 *  - Imagen y PDF: el original (`esEnviablePorWhatsapp`).
 *  - Video con variante lista (`variant_status = 'ready'`): la VARIANTE (MIME y peso de la variante, leída de `medios-wa`).
 *  - Video sin variante (`none`), con la optimización pendiente o fallida: el original SI ya es enviable (MP4 ≤ 16 MiB: el
 *    comportamiento de siempre, no se pierde un envío que ya funcionaba). Si no lo es:
 *      · `processing` → `processing` (todavía no se puede; el motor espera);
 *      · `failed` → `variant_failed` con el motivo;
 *      · `none` → `too_large` o `unsupported`.
 *
 * Con la variante lista GANA siempre, aunque el original también fuese enviable: es más ligera y es la que se verificó.
 */

export type ItemParaEnvio = {
  kind: string;
  mimeType: string;
  sizeBytes: number;
  variantStatus: "none" | "processing" | "ready" | "failed";
  variantMimeType: string | null;
  variantSizeBytes: number | null;
  variantStorageKey: string | null;
  variantError: string | null;
};

export type RazonNoEnviable = "processing" | "variant_failed" | "too_large" | "unsupported";

export type Envio =
  | { ok: true; fuente: "original" | "variante"; mimeType: string; sizeBytes: number }
  | { ok: false; razon: RazonNoEnviable; detalle?: string };

export function resolverEnvio(item: ItemParaEnvio): Envio {
  if (item.kind !== "video") {
    if (esEnviablePorWhatsapp(item.mimeType, item.sizeBytes)) return { ok: true, fuente: "original", mimeType: item.mimeType, sizeBytes: item.sizeBytes };
    return { ok: false, razon: sinFormato(item) ? "unsupported" : "too_large" };
  }

  if (item.variantStatus === "ready") {
    // El CHECK de la base garantiza estos tres datos; si faltaran, es un registro roto, no algo que enviar a ciegas.
    if (item.variantMimeType && item.variantSizeBytes && item.variantSizeBytes > 0 && item.variantStorageKey) {
      return { ok: true, fuente: "variante", mimeType: item.variantMimeType, sizeBytes: item.variantSizeBytes };
    }
    return { ok: false, razon: "variant_failed", detalle: "La versión optimizada del video está incompleta: reintenta la optimización." };
  }

  if (esEnviablePorWhatsapp(item.mimeType, item.sizeBytes)) return { ok: true, fuente: "original", mimeType: item.mimeType, sizeBytes: item.sizeBytes };

  if (item.variantStatus === "processing") return { ok: false, razon: "processing" };
  if (item.variantStatus === "failed") return { ok: false, razon: "variant_failed", detalle: item.variantError ?? undefined };
  return { ok: false, razon: sinFormato(item) ? "unsupported" : "too_large" };
}

/**
 * El estado de un medio para WhatsApp, para el DTO. `noEnviable` = no se puede enviar y no podrá sin hacer algo (un video
 * que se está optimizando NO cuenta: estará listo cuando el flujo se ejecute). `puedeReintentar` solo mira el estado; el
 * DTO lo cruza además con que la cola de optimización esté activa.
 */
export function estadoDeEnvio(item: ItemParaEnvio): { envio: EstadoEnvio; noEnviable: boolean; puedeReintentar: boolean } {
  const e = resolverEnvio(item);
  const noEnviable = !e.ok && e.razon !== "processing";
  if (item.kind !== "video") return { envio: e.ok ? "original" : "no_enviable", noEnviable, puedeReintentar: false };
  switch (item.variantStatus) {
    case "ready":
      return { envio: e.ok && e.fuente === "variante" ? "listo" : "fallo", noEnviable, puedeReintentar: false };
    case "processing":
      return { envio: "optimizando", noEnviable, puedeReintentar: false };
    case "failed":
      return { envio: "fallo", noEnviable, puedeReintentar: true };
    default:
      return { envio: e.ok ? "original" : "no_enviable", noEnviable, puedeReintentar: !e.ok };
  }
}

/** ¿El original no se puede enviar por su FORMATO (MOV, AVIF…)? Distingue «formato» de «peso» al explicar el motivo. */
function sinFormato(item: Pick<ItemParaEnvio, "mimeType" | "sizeBytes">): boolean {
  const f = FORMATOS_MEDIO.find((x) => x.mime === item.mimeType);
  // Con formato admitido y sin `noWhatsapp`, lo único que lo hace no enviable es el peso.
  return !f || !!f.noWhatsapp;
}

/** Nombre del archivo con su extensión según el MIME enviado (el de la variante es `<nombre>.mp4`). */
export function nombreDeEnvio(nombre: string, mimeType: string): string {
  const ext = FORMATOS_MEDIO.find((f) => f.mime === mimeType)?.ext ?? mimeType.split("/")[1]?.replace("jpeg", "jpg");
  return ext ? `${nombre}.${ext}` : nombre;
}
