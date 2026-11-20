import { and, asc, gt, inArray, isNotNull, isNull, like, lt, not, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { decidirReintento, PENDIENTE_MIN_EDAD_MS, REINTENTO_VENTANA_DIAS } from "@/lib/media-retry";
import { ensureAssetAvailable } from "@/server/whatsapp/media";

/**
 * Hallazgo J — reintento proactivo de los adjuntos ENTRANTES que quedaron `pending` o `failed`.
 *
 * Antes solo se reintentaba al abrir la conversación: si R2 estaba caído (o la instancia se reinició a media descarga)
 * cuando llegó el webhook y nadie abría ese chat en 30 días, Meta borraba el archivo y se perdía. Ahora un barrido
 * periódico (`mantenimiento.ts`) vuelve a bajar de Meta los adjuntos pendientes o fallidos que aún estén dentro de su
 * vigencia (< 28 días), con estos frenos para no ser un bucle ni una sobrecarga:
 *  - espera creciente entre intentos por adjunto (15 min, 30, 1 h… tope 12 h) y un máximo de intentos (`lib/media-retry.ts`);
 *  - no reintenta lo que Meta ya dio por borrado (`[gone]`) ni lo vencido;
 *  - a lo sumo `LIMITE_POR_TANDA` descargas por tanda, de la más antigua (más cerca de caducar) a la más nueva;
 *  - un cortacircuitos: tras `FALLAS_SEGUIDAS_MAX` fallas seguidas (R2 o Meta siguen caídos) la tanda se detiene.
 */

export const LIMITE_POR_TANDA = 10;
const ESCANEO_POR_TANDA = 100;
export const FALLAS_SEGUIDAS_MAX = 3;

export type ResumenDeReintento = { revisados: number; reintentados: number; recuperados: number; fallidos: number; detenido: boolean };

export async function reintentarAdjuntosPendientes(
  opts: {
    now?: Date;
    limite?: number;
    escaneo?: number;
    /** Solo pruebas: la descarga real es `ensureAssetAvailable`. */
    descargar?: (organizationId: string, assetId: string) => Promise<{ fetchStatus: string } | null>;
  } = {}
): Promise<ResumenDeReintento> {
  const now = opts.now ?? new Date();
  const limite = opts.limite ?? LIMITE_POR_TANDA;
  const descargar = opts.descargar ?? ensureAssetAvailable;
  const a = schema.mediaAsset;

  // Lo más barato se filtra en SQL; la espera creciente (que depende del número de intentos) se decide en código. Orden por
  // `updated_at`: lo menos recientemente intentado primero, así lo que está en espera no deja sin turno a lo demás.
  const candidatos = await getDb()
    .select({
      id: a.id,
      organizationId: a.organizationId,
      kind: a.kind,
      fetchStatus: a.fetchStatus,
      waMediaId: a.waMediaId,
      libraryItemId: a.libraryItemId,
      fetchError: a.fetchError,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })
    .from(a)
    .where(
      and(
        inArray(a.fetchStatus, ["pending", "failed"]),
        isNotNull(a.waMediaId),
        isNull(a.libraryItemId),
        gt(a.createdAt, new Date(now.getTime() - REINTENTO_VENTANA_DIAS * 86_400_000)),
        lt(a.updatedAt, new Date(now.getTime() - PENDIENTE_MIN_EDAD_MS)),
        or(isNull(a.fetchError), not(like(a.fetchError, "[gone]%")))
      )
    )
    .orderBy(asc(a.updatedAt))
    .limit(opts.escaneo ?? ESCANEO_POR_TANDA);

  const resumen: ResumenDeReintento = { revisados: candidatos.length, reintentados: 0, recuperados: 0, fallidos: 0, detenido: false };
  let seguidas = 0;
  for (const c of candidatos) {
    if (resumen.reintentados >= limite) break;
    if (!decidirReintento(c, now).reintentar) continue;
    resumen.reintentados++;
    let ok = false;
    try {
      const r = await descargar(c.organizationId, c.id);
      ok = r?.fetchStatus === "available";
    } catch {
      ok = false; // ensureAssetAvailable no lanza; por si acaso, una falla más
    }
    if (ok) {
      resumen.recuperados++;
      seguidas = 0;
    } else {
      resumen.fallidos++;
      if (++seguidas >= FALLAS_SEGUIDAS_MAX) {
        resumen.detenido = true;
        break;
      }
    }
  }
  return resumen;
}
