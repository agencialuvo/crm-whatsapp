import { and, eq, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { cacheExpiry, decideMediaSource } from "@/lib/media-cache";
import { leerBytesDeMedio } from "@/server/medios/store";
import { uploadGraphMedia } from "@/server/whatsapp/media";
import type { Credentials } from "@/server/whatsapp/credentials";

/**
 * 048 — El `media_id` de WhatsApp de un medio de la biblioteca, con caché por número.
 *
 * Antes cada envío leía el archivo a memoria, lo subía otra vez a Meta y dejaba una copia en disco. Ahora el archivo se
 * sube UNA vez por número y los envíos siguientes mandan `{ id }` (0 bytes). Si hay que subir, 50 envíos simultáneos
 * del mismo medio suben una sola vez: los demás esperan y reutilizan (candado en el proceso y candado de Postgres, por
 * si hay varias instancias).
 */

type Item = typeof schema.mediaLibraryItem.$inferSelect;

export class MediaArchivoAusente extends Error {
  constructor() {
    super("El archivo del medio no está en el almacenamiento");
    this.name = "MediaArchivoAusente";
  }
}

export type ResolvedMedia = { waMediaId: string; reused: boolean };

export type ResolveDeps = {
  now?: () => Date;
  upload?: (credentials: Credentials, file: { data: Buffer; mimeType: string; fileName?: string }) => Promise<string>;
};

const enVuelo = new Map<string, Promise<ResolvedMedia>>();

function nombreDeArchivo(item: Item): string {
  const ext = item.mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "";
  return ext ? `${item.name}.${ext}` : item.name;
}

async function vigente(item: Item, phoneNumberId: string, now: Date) {
  const c = schema.whatsappMediaCache;
  const [fila] = await getDb()
    .select()
    .from(c)
    .where(scoped(c.organizationId, item.organizationId, eq(c.mediaItemId, item.id), eq(c.phoneNumberId, phoneNumberId)))
    .limit(1);
  const d = decideMediaSource(fila ?? null, item, phoneNumberId, now);
  return { fila, decision: d };
}

/**
 * Devuelve el `media_id` a usar para mandar `item` desde el número de `credentials`. `forceRefresh` ignora (y reemplaza)
 * lo guardado: es el reintento tras un rechazo de Meta por media vencido.
 */
export async function resolveWaMediaId(
  item: Item,
  credentials: Credentials,
  opts: { forceRefresh?: boolean } & ResolveDeps = {}
): Promise<ResolvedMedia> {
  const now = (opts.now ?? (() => new Date()))();
  if (!opts.forceRefresh) {
    const { decision } = await vigente(item, credentials.phoneNumberId, now);
    if (decision.action === "reuse") return { waMediaId: decision.waMediaId, reused: true };
  }

  const clave = `${item.id}:${credentials.phoneNumberId}`;
  const previo = enVuelo.get(clave);
  if (previo && !opts.forceRefresh) {
    const r = await previo;
    return { waMediaId: r.waMediaId, reused: true };
  }
  const trabajo = subirUnaVez(item, credentials, opts, now).finally(() => {
    if (enVuelo.get(clave) === trabajo) enVuelo.delete(clave);
  });
  enVuelo.set(clave, trabajo);
  return trabajo;
}

async function subirUnaVez(
  item: Item,
  credentials: Credentials,
  opts: { forceRefresh?: boolean } & ResolveDeps,
  now: Date
): Promise<ResolvedMedia> {
  const db = getDb();
  const subir = opts.upload ?? uploadGraphMedia;
  const c = schema.whatsappMediaCache;
  return db.transaction(async (tx) => {
    // Candado de Postgres por (medio, número): otra instancia que llegó a la vez espera y luego encuentra la fila.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wmc:${item.id}:${credentials.phoneNumberId}`}))`);
    if (!opts.forceRefresh) {
      const [fila] = await tx
        .select()
        .from(c)
        .where(and(eq(c.mediaItemId, item.id), eq(c.phoneNumberId, credentials.phoneNumberId)))
        .limit(1);
      const d = decideMediaSource(fila ?? null, item, credentials.phoneNumberId, now);
      if (d.action === "reuse") return { waMediaId: d.waMediaId, reused: true };
    }
    const data = await leerBytesDeMedio(item, Math.max(item.sizeBytes, 1) + 1024);
    if (!data) throw new MediaArchivoAusente();
    const waMediaId = await subir(credentials, { data, mimeType: item.mimeType, fileName: nombreDeArchivo(item) });
    await tx
      .insert(c)
      .values({
        id: newId("whatsappMediaCache"),
        organizationId: item.organizationId,
        mediaItemId: item.id,
        phoneNumberId: credentials.phoneNumberId,
        waMediaId,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        uploadedAt: now,
        expiresAt: cacheExpiry(now),
      })
      .onConflictDoUpdate({
        target: [c.mediaItemId, c.phoneNumberId],
        set: { waMediaId, mimeType: item.mimeType, sizeBytes: item.sizeBytes, uploadedAt: now, expiresAt: cacheExpiry(now) },
      });
    return { waMediaId, reused: false };
  });
}

/** Olvida lo guardado de un medio y un número (Meta dijo que ya no sirve). */
export async function invalidateWaMediaId(item: Pick<Item, "id" | "organizationId">, phoneNumberId: string): Promise<void> {
  const c = schema.whatsappMediaCache;
  await getDb()
    .delete(c)
    .where(and(eq(c.organizationId, item.organizationId), eq(c.mediaItemId, item.id), eq(c.phoneNumberId, phoneNumberId)));
}

/** Mantenimiento horario: filas vencidas hace más de un día (las de otro número también acaban aquí al vencer). */
export async function pruneWaMediaCache(now: Date = new Date()): Promise<void> {
  const c = schema.whatsappMediaCache;
  await getDb()
    .delete(c)
    .where(lt(c.expiresAt, new Date(now.getTime() - 24 * 3600_000)));
}
