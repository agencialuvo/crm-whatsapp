import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { eq, inArray, and, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { FAVICON_ASSET } from "@/lib/favicon";
import { objectStore, type ObjectStore } from "@/server/storage";

/**
 * Hallazgo H — reconciliación de archivos huérfanos entre la base de datos, R2 y el disco local (`MEDIA_DIR`).
 *
 * Qué se desincroniza hoy: los borrados de binarios son «mejor esfuerzo» (`.catch(() => {})`), así que si R2 o el disco
 * fallan en ese instante, la fila ya no existe pero el archivo se queda; lo mismo con un archivo que se escribió y cuyo
 * `INSERT` falló después de que también falló su limpieza, con restos `.part` de una escritura interrumpida, y con todo
 * lo de una organización borrada (sus filas se van en cascada, sus archivos no).
 *
 * Qué es un huérfano: un archivo cuyo id (el último tramo del nombre) no existe NI en `media_asset` NI en
 * `media_library_item`, o un temporal `.part` / `.dedup` abandonado. Las filas `pending` de subidas en curso SÍ cuentan
 * como referencia (existen en la tabla), así que una subida a medias nunca se confunde con un huérfano.
 *
 * Garantías de seguridad, todas probadas:
 *  1. **Dry-run por defecto**: sin `aplicar: true` solo informa, no borra nada.
 *  2. **Edad mínima** (24 h por defecto): lo más reciente ni se considera (una escritura en curso, una fila que aún no
 *     se confirmó). Se mide por `LastModified` en R2 y por `mtime` en disco.
 *  3. **Se consulta la base DESPUÉS de listar** y otra vez justo antes de borrar: si una fila apareció, el archivo se salva.
 *  4. **Tope por corrida** (`maxBorrar`, 200 por defecto): un error inesperado no puede vaciar el bucket.
 *  5. **Nunca toca** el icono de la marca (`favicon`), claves que no tienen la forma de este sistema, enlaces simbólicos
 *     ni nada fuera de `MEDIA_DIR/<org>/…`.
 *  6. Si la consulta a la base o el listado fallan, la corrida se aborta ANTES de borrar nada.
 *  7. **Freno de «base equivocada»**: si las tablas de medios están VACÍAS, o si de 20 o más archivos viejos revisados NINGUNO
 *     tiene fila, no se borra nada (`abortado`): casi seguro la base no es la de este bucket (un entorno de pruebas
 *     apuntando al bucket de producción, o una restauración a medias).
 *  8. **Nunca borra filas**: las filas sin archivo solo se informan (`filasSinArchivo`).
 */

const HORA = 3600_000;
export const EDAD_MINIMA_MS = 24 * HORA;
export const MAX_BORRAR = 200;
export const MAX_ESCANEO = 20_000;
const LOTE = 500;
const SEGMENTO = /^[\w.-]+$/;
const TEMPORAL = /\.(part|dedup)$/;

export type OpcionesDeReconciliacion = {
  /** Sin `true`, solo informa. */
  aplicar?: boolean;
  now?: Date;
  edadMinimaMs?: number;
  maxBorrar?: number;
  /** Objetos de R2 / archivos de disco que se miran como máximo en una corrida. */
  maxEscaneo?: number;
  /** Dónde retomar el listado de R2 (la corrida anterior lo devolvió en `siguienteCursorR2`). */
  cursorR2?: string | null;
  /** Solo pruebas. */
  r2?: ObjectStore | null;
  mediaDir?: string;
};

export type Huerfano = {
  origen: "r2" | "disco";
  /** Clave en R2 o ruta absoluta en disco. */
  ubicacion: string;
  id: string;
  bytes: number;
  edadMs: number;
  motivo: "sin_fila" | "temporal";
};

export type ResultadoDeReconciliacion = {
  aplicado: boolean;
  escaneados: { r2: number; disco: number };
  /** Hasta `maxBorrar`: lo que se borra (o se borraría) en esta corrida. */
  huerfanos: Huerfano[];
  borrados: number;
  fallidos: number;
  /** Bytes de los `huerfanos`. */
  bytes: number;
  protegidos: { recientes: number; favicon: number; reaparecidos: number };
  /** Hay más por revisar o por borrar que lo que cupo en esta corrida. */
  truncado: boolean;
  /** Para retomar el listado de R2 en la siguiente corrida (null = se llegó al final). */
  siguienteCursorR2: string | null;
  /** Archivos viejos revisados contra la base, y cuántos de ellos tenían fila (para el freno de «base equivocada»). */
  revisados: { total: number; conFila: number };
  /** Si se pidió `aplicar` pero se frenó por seguridad, el motivo. No se borró nada. */
  abortado: string | null;
};

/** `org/<org>/medios/<id>` o `pending/<org>/<id>`; cualquier otra forma no es de este sistema y no se toca. */
export function idDeClave(key: string): { org: string; id: string } | null {
  const p = key.split("/");
  if (p.length === 4 && p[0] === "org" && p[2] === "medios" && SEGMENTO.test(p[1]!) && SEGMENTO.test(p[3]!)) return { org: p[1]!, id: p[3]! };
  if (p.length === 3 && p[0] === "pending" && SEGMENTO.test(p[1]!) && SEGMENTO.test(p[2]!)) return { org: p[1]!, id: p[2]! };
  return null;
}

/** De los `ids`, los que existen en alguna de las dos tablas de medios (de cualquier organización: ante la duda, se conserva). */
async function conocidos(ids: string[]): Promise<Set<string>> {
  const db = getDb();
  const out = new Set<string>();
  const unicos = [...new Set(ids)];
  for (let i = 0; i < unicos.length; i += LOTE) {
    const lote = unicos.slice(i, i + LOTE);
    const [assets, medios] = await Promise.all([
      db.select({ id: schema.mediaAsset.id }).from(schema.mediaAsset).where(inArray(schema.mediaAsset.id, lote)),
      db.select({ id: schema.mediaLibraryItem.id }).from(schema.mediaLibraryItem).where(inArray(schema.mediaLibraryItem.id, lote)),
    ]);
    for (const r of [...assets, ...medios]) out.add(r.id);
  }
  return out;
}

async function hayAlgunMedio(): Promise<boolean> {
  const db = getDb();
  const [a, m] = await Promise.all([
    db.select({ id: schema.mediaAsset.id }).from(schema.mediaAsset).limit(1),
    db.select({ id: schema.mediaLibraryItem.id }).from(schema.mediaLibraryItem).limit(1),
  ]);
  return a.length + m.length > 0;
}

type Candidato = Omit<Huerfano, "motivo"> & { temporal: boolean };

export async function reconciliarMedios(opts: OpcionesDeReconciliacion = {}): Promise<ResultadoDeReconciliacion> {
  const now = opts.now ?? new Date();
  const edadMin = opts.edadMinimaMs ?? EDAD_MINIMA_MS;
  const maxBorrar = opts.maxBorrar ?? MAX_BORRAR;
  const maxEscaneo = opts.maxEscaneo ?? MAX_ESCANEO;
  const r2 = opts.r2 === undefined ? objectStore() : opts.r2;
  const dir = path.resolve(opts.mediaDir ?? getEnv().MEDIA_DIR);

  const res: ResultadoDeReconciliacion = {
    aplicado: opts.aplicar === true,
    escaneados: { r2: 0, disco: 0 },
    huerfanos: [],
    borrados: 0,
    fallidos: 0,
    bytes: 0,
    protegidos: { recientes: 0, favicon: 0, reaparecidos: 0 },
    truncado: false,
    siguienteCursorR2: null,
    revisados: { total: 0, conFila: 0 },
    abortado: null,
  };

  /** Clasifica los candidatos viejos de un lote contra la base y anota los huérfanos (hasta el tope). */
  const clasificar = async (lote: Candidato[]): Promise<void> => {
    if (lote.length === 0) return;
    const existen = await conocidos(lote.map((c) => c.id));
    for (const c of lote) {
      if (!c.temporal) {
        res.revisados.total++;
        if (existen.has(c.id)) res.revisados.conFila++;
      }
      if (!c.temporal && existen.has(c.id)) continue;
      if (res.huerfanos.length >= maxBorrar) {
        res.truncado = true;
        continue;
      }
      res.huerfanos.push({ origen: c.origen, ubicacion: c.ubicacion, id: c.id, bytes: c.bytes, edadMs: c.edadMs, motivo: c.temporal ? "temporal" : "sin_fila" });
    }
  };

  /* ---------- R2 ---------- */
  if (r2) {
    let cursor: string | null = opts.cursorR2 ?? null;
    for (;;) {
      const cursorDePagina = cursor;
      const pagina = await r2.list("", { cursor: cursor ?? undefined, limit: 1000 });
      const lote: Candidato[] = [];
      for (const o of pagina.objects) {
        res.escaneados.r2++;
        const k = idDeClave(o.key);
        if (!k) continue;
        if (k.id === FAVICON_ASSET) {
          res.protegidos.favicon++;
          continue;
        }
        const edadMs = now.getTime() - o.lastModified.getTime();
        if (edadMs < edadMin) {
          res.protegidos.recientes++;
          continue;
        }
        lote.push({ origen: "r2", ubicacion: o.key, id: k.id, bytes: o.size, edadMs, temporal: false });
      }
      await clasificar(lote);
      if (res.truncado) {
        res.siguienteCursorR2 = cursorDePagina; // se vuelve a esta página: lo ya borrado no estará, lo demás sí
        break;
      }
      if (!pagina.next) break;
      cursor = pagina.next;
      if (res.escaneados.r2 >= maxEscaneo) {
        res.truncado = true;
        res.siguienteCursorR2 = cursor;
        break;
      }
    }
  }

  /* ---------- Disco local ---------- */
  await escanearDisco(dir, now, edadMin, maxEscaneo, res, clasificar);

  /* ---------- Aplicar ---------- */
  res.bytes = res.huerfanos.reduce((t, h) => t + h.bytes, 0);
  if (opts.aplicar !== true || res.huerfanos.length === 0) return res;

  // Freno de «base equivocada»: ver la garantía 7. Se informa lo encontrado pero no se borra nada.
  const hayMedios = await hayAlgunMedio();
  if (!hayMedios) res.abortado = "las tablas de medios están vacías: no se borra nada (¿es esta la base de datos de este bucket?)";
  else if (res.revisados.total >= 20 && res.revisados.conFila === 0) {
    res.abortado = `ninguno de los ${res.revisados.total} archivos revisados tiene fila en la base: no se borra nada (¿es esta la base de datos de este bucket?)`;
  }
  if (res.abortado) return res;

  // Última comprobación contra la base justo antes de borrar: lo que haya aparecido mientras tanto se salva.
  const todavia = await conocidos(res.huerfanos.filter((h) => h.motivo === "sin_fila").map((h) => h.id));
  const aBorrar = res.huerfanos.filter((h) => {
    if (h.motivo === "sin_fila" && todavia.has(h.id)) {
      res.protegidos.reaparecidos++;
      return false;
    }
    return true;
  });
  res.huerfanos = aBorrar;
  res.bytes = aBorrar.reduce((t, h) => t + h.bytes, 0);

  for (const h of aBorrar) {
    try {
      if (h.origen === "r2") await r2!.delete(h.ubicacion);
      else await rm(h.ubicacion, { force: true });
      res.borrados++;
    } catch {
      res.fallidos++;
    }
  }
  return res;
}

async function escanearDisco(
  dir: string,
  now: Date,
  edadMin: number,
  maxEscaneo: number,
  res: ResultadoDeReconciliacion,
  clasificar: (lote: Candidato[]) => Promise<void>
): Promise<void> {
  let orgs: string[];
  try {
    orgs = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && SEGMENTO.test(e.name)).map((e) => e.name);
  } catch {
    return; // sin MEDIA_DIR (o sin volumen): no hay nada que reconciliar en disco
  }
  for (const org of orgs) {
    for (const sub of ["", "medios"]) {
      const carpeta = sub ? path.join(dir, org, sub) : path.join(dir, org);
      let nombres: string[];
      try {
        nombres = (await readdir(carpeta, { withFileTypes: true })).filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name);
      } catch {
        continue;
      }
      const lote: Candidato[] = [];
      for (const nombre of nombres) {
        if (res.escaneados.disco >= maxEscaneo) {
          res.truncado = true;
          break;
        }
        res.escaneados.disco++;
        if (!SEGMENTO.test(nombre)) continue;
        const temporal = TEMPORAL.test(nombre);
        const id = temporal ? nombre.replace(TEMPORAL, "") : nombre;
        if (id === FAVICON_ASSET) {
          res.protegidos.favicon++;
          continue;
        }
        const ruta = path.join(carpeta, nombre);
        let st;
        try {
          st = await lstat(ruta);
        } catch {
          continue;
        }
        if (!st.isFile()) continue; // enlaces simbólicos y demás: no se tocan
        const edadMs = now.getTime() - st.mtimeMs;
        if (edadMs < edadMin) {
          res.protegidos.recientes++;
          continue;
        }
        lote.push({ origen: "disco", ubicacion: ruta, id, bytes: st.size, edadMs, temporal });
      }
      await clasificar(lote);
    }
  }
}

/* ---------- Filas sin archivo (solo informa) ---------- */

export type FilaSinArchivo = { tipo: "medio" | "adjunto"; id: string; organizationId: string; donde: "r2" | "disco" };

/**
 * Las filas que apuntan a un archivo que ya no está (R2: un HEAD; disco: `lstat`). **Solo informa, nunca borra ni modifica
 * filas**: una fila sin archivo puede ser historial que alguien quiere conservar. Revisa como mucho `limite` filas (las más
 * recientes) para no hacer miles de consultas.
 */
export async function filasSinArchivo(opts: { limite?: number; r2?: ObjectStore | null; mediaDir?: string } = {}): Promise<FilaSinArchivo[]> {
  const limite = opts.limite ?? 200;
  const r2 = opts.r2 === undefined ? objectStore() : opts.r2;
  const dir = path.resolve(opts.mediaDir ?? getEnv().MEDIA_DIR);
  const db = getDb();
  const falta: FilaSinArchivo[] = [];

  const existeEnR2 = async (key: string) => (r2 ? (await r2.head(key)) !== null : false);
  const existeEnDisco = (ruta: string) => lstat(ruta).then(() => true, () => false);

  const m = schema.mediaLibraryItem;
  const medios = await db.select().from(m).where(eq(m.status, "ready")).limit(limite);
  for (const f of medios) {
    const enR2 = f.storage === "r2" && !!f.storageKey;
    const ok = enR2 ? await existeEnR2(f.storageKey!) : await existeEnDisco(path.join(dir, f.organizationId, "medios", f.id));
    if (!ok) falta.push({ tipo: "medio", id: f.id, organizationId: f.organizationId, donde: enR2 ? "r2" : "disco" });
  }

  const a = schema.mediaAsset;
  const adjuntos = await db.select().from(a).where(and(eq(a.fetchStatus, "available"), isNotNull(a.storagePath))).limit(limite);
  for (const f of adjuntos) {
    const ruta = f.storagePath ?? "";
    const enR2 = ruta.startsWith("r2:");
    const ok = enR2 ? await existeEnR2(ruta.slice(3)) : await existeEnDisco(path.join(dir, f.organizationId, f.id));
    if (!ok) falta.push({ tipo: "adjunto", id: f.id, organizationId: f.organizationId, donde: enR2 ? "r2" : "disco" });
  }
  return falta;
}
