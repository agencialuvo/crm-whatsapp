import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import type { InfoVideo } from "@/server/medios/optimizar/perfil";
import { MAX_INTENTOS } from "@/server/medios/optimizar/perfil";

/**
 * Medios — la cola de optimización de video en Postgres (sin broker): cada fila de `media_library_item` con
 * `variant_status = 'processing'` es un trabajo. Mismo patrón que `automation_queue`: se reclama en UNA sentencia con
 * `FOR UPDATE SKIP LOCKED`, el trabajo es de quien lo reclamó mientras dure su arrendamiento, y uno vencido (la instancia se
 * cayó) lo recoge otra.
 *
 * La «ficha» (fencing) es `variant_attempts`: cada reclamo la incrementa y toda escritura del trabajo la exige igual. Si el
 * medio se borró, o el arrendamiento venció y otro trabajo lo recogió, el viejo ya no puede pisar nada (devuelve `false`).
 *
 * Todas las horas las pone el servidor de la app (no `now()` de Postgres): `timestamp` sin zona guarda la hora UTC que escribe
 * Drizzle, y mezclarla con la del servidor de base de datos desfasaría los arrendamientos.
 */

export const ARRENDAMIENTO_MS = 5 * 60_000;

export type TrabajoDeVariante = {
  id: string;
  organizationId: string;
  name: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  storage: "local" | "r2";
  storageKey: string | null;
  /** El intento (1-3) que acaba de empezar: la ficha del trabajo. */
  intento: number;
};

const m = schema.mediaLibraryItem;
const iso = (d: Date) => d.toISOString();
const suyo = (id: string, intento: number) => and(eq(m.id, id), eq(m.variantStatus, "processing"), eq(m.variantAttempts, intento));

/** Los trabajos cuyo arrendamiento venció después del último intento permitido ya no se reintentan: quedan `failed`. */
export async function cerrarAgotados(now: Date): Promise<number> {
  const filas = await getDb()
    .update(m)
    .set({
      variantStatus: "failed",
      variantError: "La optimización se interrumpió demasiadas veces. Vuelve a subir el video.",
      variantLeaseUntil: null,
      variantProcessedAt: now,
    })
    .where(
      and(
        eq(m.variantStatus, "processing"),
        sql`${m.variantAttempts} >= ${MAX_INTENTOS}`,
        sql`(${m.variantLeaseUntil} is null or ${m.variantLeaseUntil} < ${iso(now)}::timestamp)`
      )
    )
    .returning({ id: m.id });
  return filas.length;
}

/** Toma el siguiente trabajo que toca (o `null`). Atómico: dos instancias nunca toman el mismo. */
export async function reclamar(now: Date, arrendamientoMs = ARRENDAMIENTO_MS): Promise<TrabajoDeVariante | null> {
  const hasta = new Date(now.getTime() + arrendamientoMs);
  const filas = await getDb().execute(sql`
    update media_library_item set
      variant_attempts = variant_attempts + 1,
      variant_lease_until = ${iso(hasta)}::timestamp
    where id = (
      select id from media_library_item
      where variant_status = 'processing'
        and status = 'ready'
        and variant_attempts < ${MAX_INTENTOS}
        and (variant_lease_until is null or variant_lease_until < ${iso(now)}::timestamp)
        and (variant_next_attempt_at is null or variant_next_attempt_at <= ${iso(now)}::timestamp)
      order by variant_next_attempt_at asc nulls first, created_at asc
      limit 1
      for update skip locked
    )
    returning id, organization_id, name, kind, mime_type, size_bytes, storage, storage_key, variant_attempts
  `);
  const r = filas[0] as
    | { id: string; organization_id: string; name: string; kind: string; mime_type: string; size_bytes: number; storage: "local" | "r2"; storage_key: string | null; variant_attempts: number }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    name: r.name,
    kind: r.kind,
    mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes),
    storage: r.storage,
    storageKey: r.storage_key,
    intento: Number(r.variant_attempts),
  };
}

/** Latido: alarga el arrendamiento. `false` = el medio se borró o el trabajo ya no es de este intento (hay que parar). */
export async function renovar(id: string, intento: number, now: Date, arrendamientoMs = ARRENDAMIENTO_MS): Promise<boolean> {
  const filas = await getDb()
    .update(m)
    .set({ variantLeaseUntil: new Date(now.getTime() + arrendamientoMs) })
    .where(suyo(id, intento))
    .returning({ id: m.id });
  return filas.length === 1;
}

/** Guarda las medidas del ORIGINAL en cuanto se inspeccionan (aunque la optimización falle después). */
export async function fijarMedidas(id: string, intento: number, info: Pick<InfoVideo, "duracionMs" | "ancho" | "alto">): Promise<boolean> {
  const filas = await getDb()
    .update(m)
    .set({ durationMs: info.duracionMs, width: info.ancho, height: info.alto })
    .where(suyo(id, intento))
    .returning({ id: m.id });
  return filas.length === 1;
}

export type VarianteLista = { clave: string; bytes: number; mime: string; ancho: number; alto: number };

/** La variante quedó publicada: pasa a `ready`. `false` = el trabajo ya no era suyo (el llamador borra lo que publicó). */
export async function publicar(id: string, intento: number, v: VarianteLista, now: Date): Promise<boolean> {
  const filas = await getDb()
    .update(m)
    .set({
      variantStatus: "ready",
      variantStorageKey: v.clave,
      variantSizeBytes: v.bytes,
      variantMimeType: v.mime,
      variantWidth: v.ancho,
      variantHeight: v.alto,
      variantError: null,
      variantLeaseUntil: null,
      variantNextAttemptAt: null,
      variantProcessedAt: now,
    })
    .where(suyo(id, intento))
    .returning({ id: m.id });
  return filas.length === 1;
}

/** Caso A: el original ya sirve, no hace falta variante. */
export async function sinVariante(id: string, intento: number, now: Date): Promise<boolean> {
  const filas = await getDb()
    .update(m)
    .set({ variantStatus: "none", variantError: null, variantLeaseUntil: null, variantNextAttemptAt: null, variantProcessedAt: now })
    .where(suyo(id, intento))
    .returning({ id: m.id });
  return filas.length === 1;
}

/** Fallo definitivo (o sin intentos): `failed` con el mensaje para mostrar. */
export async function fallar(id: string, intento: number, mensaje: string, now: Date): Promise<boolean> {
  const filas = await getDb()
    .update(m)
    .set({ variantStatus: "failed", variantError: mensaje.slice(0, 500), variantLeaseUntil: null, variantNextAttemptAt: null, variantProcessedAt: now })
    .where(suyo(id, intento))
    .returning({ id: m.id });
  return filas.length === 1;
}

/** Fallo transitorio con intentos por delante: se suelta el arrendamiento y vuelve a tocar a partir de `hasta`. */
export async function posponer(id: string, intento: number, mensaje: string, hasta: Date): Promise<boolean> {
  const filas = await getDb()
    .update(m)
    .set({ variantError: mensaje.slice(0, 500), variantLeaseUntil: null, variantNextAttemptAt: hasta })
    .where(suyo(id, intento))
    .returning({ id: m.id });
  return filas.length === 1;
}
