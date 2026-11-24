import { readdir, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { inArray, sql, and } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";

/**
 * Medios — limpieza de `MEDIA_DIR/<org>/medios-tmp`: lo que dejó una subida a disco o una optimización interrumpida (un
 * proceso que se cayó a medias no limpia). Se borra lo de más de `edadMs` (2 h por defecto) cuyo medio NO tenga un
 * arrendamiento vigente (un trabajo vivo renueva el suyo cada 30 s, así que un temporal suyo nunca está viejo y sin
 * arrendamiento). Es seguro dejarla siempre activa: solo toca esa carpeta, nunca un original ni una variante.
 */

export const EDAD_TEMPORAL_MS = 2 * 3600_000;
const SEGMENTO = /^[\w.-]+$/;
const LOTE = 500;

/** El id del medio de un temporal: `<id>`, `<id>.src` o `<id>.wa.mp4`. */
export const idDeTemporal = (nombre: string): string => nombre.split(".")[0]!;

/** Entre `ids`, los medios con arrendamiento vigente (su temporal está en uso). */
export async function conArrendamiento(ids: string[], now: Date): Promise<Set<string>> {
  const m = schema.mediaLibraryItem;
  const out = new Set<string>();
  const unicos = [...new Set(ids)];
  for (let i = 0; i < unicos.length; i += LOTE) {
    const filas = await getDb()
      .select({ id: m.id })
      .from(m)
      .where(and(inArray(m.id, unicos.slice(i, i + LOTE)), sql`${m.variantLeaseUntil} > ${now.toISOString()}::timestamp`));
    for (const f of filas) out.add(f.id);
  }
  return out;
}

export type TemporalViejo = { ruta: string; id: string; bytes: number; edadMs: number };

/** Los temporales viejos y sin arrendamiento (lo que se borraría). */
export async function temporalesAbandonados(opts: { now?: Date; edadMs?: number; mediaDir?: string } = {}): Promise<TemporalViejo[]> {
  const now = opts.now ?? new Date();
  const edad = opts.edadMs ?? EDAD_TEMPORAL_MS;
  const dir = path.resolve(opts.mediaDir ?? getEnv().MEDIA_DIR);
  let orgs: string[];
  try {
    orgs = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && SEGMENTO.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  const viejos: TemporalViejo[] = [];
  for (const org of orgs) {
    const carpeta = path.join(dir, org, "medios-tmp");
    let nombres: string[];
    try {
      nombres = (await readdir(carpeta, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const nombre of nombres) {
      if (!SEGMENTO.test(nombre)) continue;
      const ruta = path.join(carpeta, nombre);
      let st;
      try {
        st = await lstat(ruta);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const edadMs = now.getTime() - st.mtimeMs;
      if (edadMs >= edad) viejos.push({ ruta, id: idDeTemporal(nombre), bytes: st.size, edadMs });
    }
  }
  if (viejos.length === 0) return viejos;
  const vivos = await conArrendamiento(viejos.map((v) => v.id), now);
  return viejos.filter((v) => !vivos.has(v.id));
}

/** Borra los temporales abandonados. Devuelve cuántos. Nunca lanza por un archivo que no se pudo borrar. */
export async function limpiarTemporales(opts: { now?: Date; edadMs?: number; mediaDir?: string } = {}): Promise<number> {
  let n = 0;
  for (const t of await temporalesAbandonados(opts)) {
    try {
      await rm(t.ruta, { force: true });
      n++;
    } catch {
      // se reintenta en la próxima ronda
    }
  }
  return n;
}
