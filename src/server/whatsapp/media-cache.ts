import { randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { cacheExpiry, decideMediaSource, LEASE_MS, leaseId } from "@/lib/media-cache";
import { nombreDeEnvio, resolverEnvio, type Envio } from "@/server/medios/envio";
import { leerBytesDeMedio, leerBytesDeVariante } from "@/server/medios/store";
import { uploadGraphMedia } from "@/server/whatsapp/media";
import type { Credentials } from "@/server/whatsapp/credentials";

/**
 * 048 — El `media_id` de WhatsApp de un medio de la biblioteca, con caché por número.
 *
 * Antes cada envío leía el archivo a memoria, lo subía otra vez a Meta y dejaba una copia en disco. Ahora el archivo se
 * sube UNA vez por número y los envíos siguientes mandan `{ id }` (0 bytes). Si hay que subir, 50 envíos simultáneos
 * del mismo medio suben una sola vez: los demás esperan y reutilizan.
 *
 * Hallazgo G — la coordinación NO mantiene una transacción abierta durante la E/S de red. La lectura de R2 y la subida a
 * Meta (segundos, hasta 16 MB) ocurren sin ninguna conexión de Postgres retenida (el pool es de 10). Se coordina así:
 *  - en el proceso: `enVuelo` junta las llamadas simultáneas en una sola;
 *  - entre instancias: un ARRENDAMIENTO en la propia fila de la caché (`pending:<token>`, ver `lib/media-cache.ts`),
 *    reclamado en una transacción de milisegundos (candado de Postgres + lectura + escritura, sin red). Quien no lo gana
 *    espera con consultas cortas hasta que aparece el `media_id` real o vence el arrendamiento (instancia caída).
 */

type Item = typeof schema.mediaLibraryItem.$inferSelect;

export class MediaArchivoAusente extends Error {
  constructor() {
    super("El archivo del medio no está en el almacenamiento");
    this.name = "MediaArchivoAusente";
  }
}

/** El medio no tiene nada que enviar ahora (variante pendiente o fallida, o el original no sirve): no se sube nada a Meta. */
export class MediaNoEnviable extends Error {
  constructor(readonly razon: Extract<Envio, { ok: false }>["razon"], readonly detalle?: string) {
    super(`El medio no se puede enviar por WhatsApp (${razon})`);
    this.name = "MediaNoEnviable";
  }
}

/** Lo que se sube y se cachea: el MIME y el peso de la FUENTE (variante u original), no los del original a secas. */
type Fuente = { mimeType: string; sizeBytes: number; esVariante: boolean };

function fuenteDe(item: Item): Fuente {
  const e = resolverEnvio(item);
  if (!e.ok) throw new MediaNoEnviable(e.razon, e.detalle);
  return { mimeType: e.mimeType, sizeBytes: e.sizeBytes, esVariante: e.fuente === "variante" };
}

export type ResolvedMedia = { waMediaId: string; reused: boolean };

export type ResolveDeps = {
  now?: () => Date;
  upload?: (credentials: Credentials, file: { data: Buffer; mimeType: string; fileName?: string }) => Promise<string>;
};

const enVuelo = new Map<string, Promise<ResolvedMedia>>();

async function vigente(item: Item, fuente: Fuente, phoneNumberId: string, now: Date) {
  const c = schema.whatsappMediaCache;
  const [fila] = await getDb()
    .select()
    .from(c)
    .where(scoped(c.organizationId, item.organizationId, eq(c.mediaItemId, item.id), eq(c.phoneNumberId, phoneNumberId)))
    .limit(1);
  const d = decideMediaSource(fila ?? null, fuente, phoneNumberId, now);
  return { fila, decision: d };
}

/**
 * Devuelve el `media_id` a usar para mandar `item` desde el número de `credentials`.
 *
 * `forceRefresh` es el reintento tras un rechazo de Meta por media vencido: ignora lo guardado y renueva. Si se pasa
 * `rejectedWaMediaId` (el id que Meta rechazó), la renovación es SEGURA ante la concurrencia:
 *  - si la caché ya trae otro id vigente (otro envío lo renovó mientras tanto), se reutiliza ese en vez de subir otra vez;
 *  - todas las renovaciones simultáneas del mismo (medio, número) comparten UNA sola subida (en el proceso por `enVuelo`,
 *    entre instancias por el arrendamiento de la fila de la caché, reclamado en una transacción corta y sin red).
 * Sin `rejectedWaMediaId`, `forceRefresh` sube siempre (a lo sumo una vez por ráfaga en el proceso).
 */
export async function resolveWaMediaId(
  item: Item,
  credentials: Credentials,
  opts: { forceRefresh?: boolean; rejectedWaMediaId?: string; pollMs?: number } & ResolveDeps = {}
): Promise<ResolvedMedia> {
  const now = (opts.now ?? (() => new Date()))();
  const fuente = fuenteDe(item);
  const rechazado = opts.forceRefresh ? opts.rejectedWaMediaId : undefined;
  // Sin forceRefresh, o con un id rechazado concreto: lo vigente SOLO sirve si no es el id que falló.
  if (!opts.forceRefresh || rechazado) {
    const { decision } = await vigente(item, fuente, credentials.phoneNumberId, now);
    if (decision.action === "reuse" && decision.waMediaId !== rechazado) return { waMediaId: decision.waMediaId, reused: true };
  }

  const clave = `${item.id}:${credentials.phoneNumberId}`;
  const previo = enVuelo.get(clave);
  if (previo) {
    const r = await previo;
    // La subida en curso puede haber devuelto justo el id rechazado (si empezó antes de invalidarlo): ese no sirve.
    if (!rechazado || r.waMediaId !== rechazado) return { waMediaId: r.waMediaId, reused: true };
  }
  const trabajo = subirUnaVez(item, fuente, credentials, { ...opts, rejectedWaMediaId: rechazado }).finally(() => {
    if (enVuelo.get(clave) === trabajo) enVuelo.delete(clave);
  });
  enVuelo.set(clave, trabajo);
  return trabajo;
}

/** Cada cuánto mira quien espera si ya terminó la subida de otra instancia. */
const POLL_MS = 250;

type ReclamoDeSubida = { tipo: "reuse"; waMediaId: string } | { tipo: "owner" } | { tipo: "wait" };

type OpcionesDeSubida = { forceRefresh?: boolean; rejectedWaMediaId?: string; pollMs?: number } & ResolveDeps;

/**
 * Decide quién sube, en UNA transacción corta y SIN red: con el candado de Postgres por (medio, número) relee la fila y
 *  - `reuse`: hay un id vigente que no es el rechazado (otro envío u otra instancia lo renovó): se usa ese;
 *  - `wait`: otra subida tiene el arrendamiento vigente: se espera;
 *  - `owner`: se escribe el arrendamiento propio y esta llamada sube.
 * Con `forceRefresh` sin id rechazado (uso anterior) lo vigente no se reutiliza, salvo tras haber esperado a otra subida:
 * ese id es justo el renovado.
 */
async function reclamar(item: Item, fuente: Fuente, credentials: Credentials, token: string, opts: OpcionesDeSubida, now: Date, yaEspero: boolean): Promise<ReclamoDeSubida> {
  const c = schema.whatsappMediaCache;
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wmc:${item.id}:${credentials.phoneNumberId}`}))`);
    const [fila] = await tx
      .select()
      .from(c)
      .where(and(eq(c.mediaItemId, item.id), eq(c.phoneNumberId, credentials.phoneNumberId)))
      .limit(1);
    const d = decideMediaSource(fila ?? null, fuente, credentials.phoneNumberId, now);
    const puedeReutilizar = !opts.forceRefresh || !!opts.rejectedWaMediaId || yaEspero;
    if (puedeReutilizar && d.action === "reuse" && d.waMediaId !== opts.rejectedWaMediaId) return { tipo: "reuse", waMediaId: d.waMediaId };
    if (d.action === "upload" && d.reason === "in_progress") return { tipo: "wait" };
    const arriendo = { waMediaId: leaseId(token), mimeType: fuente.mimeType, sizeBytes: fuente.sizeBytes, uploadedAt: now, expiresAt: new Date(now.getTime() + LEASE_MS) };
    await tx
      .insert(c)
      .values({
        id: newId("whatsappMediaCache"),
        organizationId: item.organizationId,
        mediaItemId: item.id,
        phoneNumberId: credentials.phoneNumberId,
        ...arriendo,
      })
      .onConflictDoUpdate({ target: [c.mediaItemId, c.phoneNumberId], set: arriendo });
    return { tipo: "owner" };
  });
}

/** Suelta el arrendamiento propio (la subida falló): solo borra la fila si todavía lleva NUESTRO marcador. */
async function liberar(item: Item, phoneNumberId: string, token: string): Promise<void> {
  const c = schema.whatsappMediaCache;
  await getDb()
    .delete(c)
    .where(and(eq(c.organizationId, item.organizationId), eq(c.mediaItemId, item.id), eq(c.phoneNumberId, phoneNumberId), eq(c.waMediaId, leaseId(token))));
}

async function subirUnaVez(item: Item, fuente: Fuente, credentials: Credentials, opts: OpcionesDeSubida): Promise<ResolvedMedia> {
  const subir = opts.upload ?? uploadGraphMedia;
  const reloj = opts.now ?? (() => new Date());
  const c = schema.whatsappMediaCache;
  const token = randomUUID();
  // Un arrendamiento vive LEASE_MS: pasado eso se puede retomar, así que esperar más que eso no tiene sentido.
  const limite = Date.now() + LEASE_MS + 10_000;
  let yaEspero = false;

  for (;;) {
    const r = await reclamar(item, fuente, credentials, token, opts, reloj(), yaEspero);
    if (r.tipo === "reuse") return { waMediaId: r.waMediaId, reused: true };
    if (r.tipo === "owner") break;
    if (Date.now() > limite) throw new Error("La subida del medio por otra instancia no terminó a tiempo");
    yaEspero = true;
    await new Promise((ok) => setTimeout(ok, opts.pollMs ?? POLL_MS));
  }

  // De aquí hasta guardar el id NO hay transacción ni conexión retenida: es E/S de red pura.
  let waMediaId: string;
  try {
    const max = Math.max(fuente.sizeBytes, 1) + 1024;
    const data = fuente.esVariante ? await leerBytesDeVariante(item, max) : await leerBytesDeMedio(item, max);
    if (!data) throw new MediaArchivoAusente();
    waMediaId = await subir(credentials, { data, mimeType: fuente.mimeType, fileName: nombreDeEnvio(item.name, fuente.mimeType) });
  } catch (err) {
    await liberar(item, credentials.phoneNumberId, token).catch(() => {});
    throw err;
  }

  const ahora = reloj();
  const real = { waMediaId, mimeType: fuente.mimeType, sizeBytes: fuente.sizeBytes, uploadedAt: ahora, expiresAt: cacheExpiry(ahora) };
  try {
    // Una sola sentencia: reemplaza el arrendamiento por el id real (y, si el arrendamiento venció y otro lo retomó, el
    // último en escribir gana: ambos ids son válidos en Meta).
    await getDb()
      .insert(c)
      .values({
        id: newId("whatsappMediaCache"),
        organizationId: item.organizationId,
        mediaItemId: item.id,
        phoneNumberId: credentials.phoneNumberId,
        ...real,
      })
      .onConflictDoUpdate({ target: [c.mediaItemId, c.phoneNumberId], set: real });
  } catch (err) {
    // Sin guardar el id, el arrendamiento bloquearía a los demás hasta vencer: se suelta.
    await liberar(item, credentials.phoneNumberId, token).catch(() => {});
    throw err;
  }
  return { waMediaId, reused: false };
}

/**
 * Olvida lo guardado de un medio y un número (Meta dijo que ya no sirve). Con `failedWaMediaId` solo borra la fila si
 * SIGUE guardando ESE id: si otro envío ya lo renovó, el id nuevo se conserva. Devuelve si borró algo. Sin
 * `failedWaMediaId` borra incondicionalmente (mantenimiento manual).
 */
export async function invalidateWaMediaId(
  item: Pick<Item, "id" | "organizationId">,
  phoneNumberId: string,
  failedWaMediaId?: string
): Promise<boolean> {
  const c = schema.whatsappMediaCache;
  const borradas = await getDb()
    .delete(c)
    .where(
      and(
        eq(c.organizationId, item.organizationId),
        eq(c.mediaItemId, item.id),
        eq(c.phoneNumberId, phoneNumberId),
        failedWaMediaId ? eq(c.waMediaId, failedWaMediaId) : undefined
      )
    )
    .returning({ id: c.id });
  return borradas.length > 0;
}

/** Mantenimiento horario: filas vencidas hace más de un día (las de otro número también acaban aquí al vencer). */
export async function pruneWaMediaCache(now: Date = new Date()): Promise<void> {
  const c = schema.whatsappMediaCache;
  await getDb()
    .delete(c)
    .where(lt(c.expiresAt, new Date(now.getTime() - 24 * 3600_000)));
}
