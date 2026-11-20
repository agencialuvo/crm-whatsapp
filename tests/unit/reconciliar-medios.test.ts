import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hallazgo H — la reconciliación de huérfanos entre la base, R2 y el disco: dry-run por defecto, edad mínima, tope por
 * corrida, nunca archivos activos ni el icono, y el freno de «base equivocada». Almacén de R2 en memoria, disco temporal y
 * una base en memoria que entiende `inArray` / `eq` / `and` / `isNotNull`.
 */

type Fila = Record<string, unknown>;
type Cond = { op: string; col?: string; val?: unknown; args?: Cond[] };

const bd = vi.hoisted(() => ({
  mediaAsset: [] as Record<string, unknown>[],
  mediaLibraryItem: [] as Record<string, unknown>[],
  consultasAssets: 0,
  /** Al llegar a esta consulta de `media_asset` por ids, aparece esta fila (simula una fila nueva a mitad de corrida). */
  inyectar: null as null | { enConsulta: number; fila: Record<string, unknown> },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...original,
    and: (...args: unknown[]) => ({ op: "and", args }),
    eq: (col: string, val: unknown) => ({ op: "eq", col, val }),
    inArray: (col: string, val: unknown[]) => ({ op: "in", col, val }),
    isNotNull: (col: string) => ({ op: "notnull", col }),
  };
});

vi.mock("@/lib/db", () => {
  const tabla = (t: string, cols: string[]) => ({ __t: t, ...Object.fromEntries(cols.map((c) => [c, `${t}.${c}`])) });
  return {
    getDb: () => db,
    schema: {
      mediaAsset: tabla("mediaAsset", ["id", "organizationId", "fetchStatus", "storagePath"]),
      mediaLibraryItem: tabla("mediaLibraryItem", ["id", "organizationId", "status", "storage", "storageKey"]),
    },
  };
});
vi.mock("@/lib/env", () => ({ getEnv: () => ({ MEDIA_DIR: "./.no-se-usa" }) }));

const campo = (c: string) => c.split(".")[1]!;
const ev = (w: Cond, r: Fila): boolean => {
  if (w.op === "and") return (w.args ?? []).every((a) => ev(a, r));
  if (w.op === "eq") return r[campo(w.col!)] === w.val;
  if (w.op === "in") return (w.val as unknown[]).includes(r[campo(w.col!)]);
  if (w.op === "notnull") return r[campo(w.col!)] != null;
  return true;
};

const db = {
  select: (shape?: Record<string, string>) => ({
    from: (t: { __t: "mediaAsset" | "mediaLibraryItem" }) => {
      const filas = () => bd[t.__t];
      const proyectar = (r: Fila) => (shape ? Object.fromEntries(Object.keys(shape).map((k) => [k, r[campo(shape[k]!)]])) : r);
      return {
        where: (w: Cond) => {
          if (t.__t === "mediaAsset" && w.op === "in") {
            bd.consultasAssets++;
            if (bd.inyectar && bd.consultasAssets === bd.inyectar.enConsulta) bd.mediaAsset.push(bd.inyectar.fila);
          }
          const r = filas().filter((x) => ev(w, x)).map(proyectar);
          return Object.assign(Promise.resolve(r), { limit: async (n: number) => r.slice(0, n) });
        },
        limit: async (n: number) => filas().slice(0, n).map(proyectar),
      };
    },
  }),
};

import type { ObjectStore } from "@/server/storage";
import { StorageError } from "@/server/storage";
import { filasSinArchivo, idDeClave, reconciliarMedios } from "@/server/medios/reconciliar";

const HORA = 3600_000;
const DIA = 24 * HORA;
const NOW = new Date("2026-11-20T12:00:00Z");
const vieja = new Date(NOW.getTime() - 5 * DIA);
const reciente = new Date(NOW.getTime() - 2 * HORA);

type Obj = { data: Buffer; lastModified: Date };

/** R2 en memoria con listado paginado (`pagina` objetos por página). */
function r2En(mem: Map<string, Obj>, opts: { pagina?: number; falloAlBorrar?: Set<string> } = {}) {
  const calls = { listados: 0, borrados: [] as string[] };
  const store = {
    async signUpload() { throw new Error("no se usa"); },
    async signRead() { throw new Error("no se usa"); },
    async head(k: string) { const o = mem.get(k); return o ? { size: o.data.byteLength, contentType: null } : null; },
    async readRange() { throw new Error("no se usa"); },
    async readAll() { throw new Error("no se usa"); },
    async put() { throw new Error("no se usa"); },
    async copy() { throw new Error("no se usa"); },
    async delete(k: string) {
      if (opts.falloAlBorrar?.has(k)) throw new StorageError("unavailable", "R2 caído");
      calls.borrados.push(k);
      mem.delete(k);
    },
    async list(_prefix: string, o: { cursor?: string; limit?: number } = {}) {
      calls.listados++;
      const claves = [...mem.keys()].sort();
      const desde = o.cursor ? claves.findIndex((k) => k > o.cursor!) : 0;
      const inicio = desde < 0 ? claves.length : desde;
      const n = opts.pagina ?? 1000;
      const trozo = claves.slice(inicio, inicio + n);
      return {
        objects: trozo.map((key) => ({ key, size: mem.get(key)!.data.byteLength, lastModified: mem.get(key)!.lastModified })),
        next: inicio + n < claves.length ? trozo.at(-1)! : null,
      };
    },
  } as ObjectStore;
  return { store, calls };
}

const obj = (lastModified = vieja, texto = "datos"): Obj => ({ data: Buffer.from(texto), lastModified });
const clave = (org: string, id: string) => `org/${org}/medios/${id}`;

let dir: string;
async function archivo(rel: string, edad: Date = vieja, texto = "x") {
  const p = path.join(dir, ...rel.split("/"));
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, texto);
  await utimes(p, edad, edad);
  return p;
}
const existe = (p: string) => stat(p).then(() => true, () => false);

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "vocero-reconciliar-"));
  bd.mediaAsset = [{ id: "ast_activo", organizationId: "org_1", fetchStatus: "available", storagePath: `r2:${clave("org_1", "ast_activo")}` }];
  bd.mediaLibraryItem = [{ id: "med_activo", organizationId: "org_1", status: "ready", storage: "r2", storageKey: clave("org_1", "med_activo") }];
  bd.consultasAssets = 0;
  bd.inyectar = null;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("idDeClave: solo las formas de este sistema", () => {
  it("reconoce org/<org>/medios/<id> y pending/<org>/<id>", () => {
    expect(idDeClave("org/org_1/medios/med_x")).toEqual({ org: "org_1", id: "med_x" });
    expect(idDeClave("pending/org_1/med_x")).toEqual({ org: "org_1", id: "med_x" });
  });
  it("lo demás no es suyo (ni __doctor__, ni __smoke__, ni rutas raras)", () => {
    for (const k of ["__doctor__/no-existe", "__smoke__/123/x", "org/org_1/otra/x", "org/org_1/medios/a/b", "org/ /medios/x", "otro/org_1/medios/x", "org/org_1/medios/"]) {
      expect(idDeClave(k), k).toBeNull();
    }
  });
});

describe("R2", () => {
  it("DRY-RUN (por defecto): informa los huérfanos y NO borra nada", async () => {
    const mem = new Map([
      [clave("org_1", "ast_activo"), obj()],
      [clave("org_1", "med_activo"), obj()],
      [clave("org_1", "ast_huerfano"), obj(vieja, "abcdef")],
      [clave("org_9", "med_de_org_borrada"), obj()],
    ]);
    const { store, calls } = r2En(mem);
    const r = await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW });
    expect(r.aplicado).toBe(false);
    expect(r.huerfanos.map((h) => h.ubicacion).sort()).toEqual([clave("org_1", "ast_huerfano"), clave("org_9", "med_de_org_borrada")]);
    expect(r.huerfanos.every((h) => h.origen === "r2" && h.motivo === "sin_fila")).toBe(true);
    expect(r.bytes).toBe(6 + 5);
    expect(r.borrados).toBe(0);
    expect(calls.borrados).toEqual([]);
    expect(mem.size).toBe(4);
  });

  it("APLICAR: borra solo los huérfanos; lo activo, el icono, lo reciente y lo ajeno quedan", async () => {
    const mem = new Map([
      [clave("org_1", "ast_activo"), obj()],
      [clave("org_1", "med_activo"), obj()],
      [clave("org_1", "favicon"), obj()], // el icono de la marca: jamás
      [clave("org_1", "ast_nuevo_sin_fila"), obj(reciente)], // reciente: aún puede estar escribiéndose
      [clave("org_1", "ast_huerfano"), obj()],
      ["__doctor__/no-existe", obj()],
      ["org/org_1/otra-cosa/x", obj()],
    ]);
    const { store } = r2En(mem);
    const r = await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW, aplicar: true });
    expect(r.borrados).toBe(1);
    expect([...mem.keys()].sort()).toEqual(
      [clave("org_1", "ast_activo"), clave("org_1", "med_activo"), clave("org_1", "favicon"), clave("org_1", "ast_nuevo_sin_fila"), "__doctor__/no-existe", "org/org_1/otra-cosa/x"].sort()
    );
    expect(r.protegidos).toMatchObject({ recientes: 1, favicon: 1 });
  });

  it("una subida directa a medias (fila pending, objeto en pending/) NO es huérfana", async () => {
    bd.mediaLibraryItem.push({ id: "med_subiendo", organizationId: "org_1", status: "pending", storage: "r2", storageKey: "pending/org_1/med_subiendo" });
    const mem = new Map([["pending/org_1/med_subiendo", obj()], ["pending/org_1/med_abandonada", obj()]]);
    const { store } = r2En(mem);
    const r = await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW, aplicar: true });
    expect([...mem.keys()]).toEqual(["pending/org_1/med_subiendo"]);
    expect(r.borrados).toBe(1);
  });

  it("un adjunto cuya descarga aún no termina (fila sin storagePath) NO es huérfano: se reconoce por el id", async () => {
    bd.mediaAsset.push({ id: "ast_bajando", organizationId: "org_1", fetchStatus: "pending", storagePath: null });
    const mem = new Map([[clave("org_1", "ast_bajando"), obj()]]);
    const { store } = r2En(mem);
    await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW, aplicar: true });
    expect(mem.size).toBe(1);
  });

  it("tope por corrida: borra a lo sumo maxBorrar, marca truncado y la siguiente corrida sigue", async () => {
    const mem = new Map<string, Obj>();
    for (let i = 0; i < 10; i++) mem.set(clave("org_1", `ast_h${String(i).padStart(2, "0")}`), obj());
    const { store } = r2En(mem, { pagina: 4 });
    const a = await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW, aplicar: true, maxBorrar: 3 });
    expect(a.borrados).toBe(3);
    expect(a.truncado).toBe(true);
    expect(mem.size).toBe(7);
    const b = await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW, aplicar: true, maxBorrar: 100, cursorR2: a.siguienteCursorR2 });
    expect(b.truncado).toBe(false);
    expect(mem.size).toBe(0 + 0); // los 10 se fueron en dos corridas
  });

  it("el dry-run respeta el mismo tope (lo que informa es lo que se borraría)", async () => {
    const mem = new Map<string, Obj>();
    for (let i = 0; i < 6; i++) mem.set(clave("org_1", `ast_h${i}`), obj());
    const { store } = r2En(mem);
    const r = await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW, maxBorrar: 2 });
    expect(r.huerfanos).toHaveLength(2);
    expect(r.truncado).toBe(true);
    expect(mem.size).toBe(6);
  });

  it("límite de escaneo: se detiene, devuelve el cursor y lo marca truncado", async () => {
    const mem = new Map<string, Obj>();
    for (let i = 0; i < 9; i++) mem.set(clave("org_1", `ast_h${i}`), obj());
    const { store } = r2En(mem, { pagina: 3 });
    const r = await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW, maxEscaneo: 3 });
    expect(r.escaneados.r2).toBe(3);
    expect(r.truncado).toBe(true);
    expect(r.siguienteCursorR2).not.toBeNull();
  });

  it("si un borrado falla, se cuenta y se sigue con los demás", async () => {
    const mem = new Map([[clave("org_1", "ast_a"), obj()], [clave("org_1", "ast_b"), obj()], [clave("org_1", "ast_c"), obj()]]);
    const { store } = r2En(mem, { falloAlBorrar: new Set([clave("org_1", "ast_b")]) });
    const r = await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW, aplicar: true });
    expect(r).toMatchObject({ borrados: 2, fallidos: 1 });
    expect([...mem.keys()]).toEqual([clave("org_1", "ast_b")]);
  });

  it("una fila que aparece entre la detección y el borrado SALVA su archivo", async () => {
    const mem = new Map([[clave("org_1", "ast_aparece"), obj()], [clave("org_1", "ast_huerfano"), obj()]]);
    const { store } = r2En(mem);
    // Consulta 1 = clasificación; la 2 = la comprobación final antes de borrar.
    bd.inyectar = { enConsulta: 2, fila: { id: "ast_aparece", organizationId: "org_1", fetchStatus: "pending", storagePath: null } };
    const r = await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW, aplicar: true });
    expect(r.protegidos.reaparecidos).toBe(1);
    expect(r.borrados).toBe(1);
    expect([...mem.keys()]).toEqual([clave("org_1", "ast_aparece")]);
  });
});

describe("freno de «base equivocada»", () => {
  it("tablas de medios vacías → no se borra nada, aunque se pida aplicar", async () => {
    bd.mediaAsset = [];
    bd.mediaLibraryItem = [];
    const mem = new Map([[clave("org_1", "ast_x"), obj()]]);
    const { store, calls } = r2En(mem);
    const r = await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW, aplicar: true });
    expect(r.abortado).toMatch(/vacías/);
    expect(r.borrados).toBe(0);
    expect(calls.borrados).toEqual([]);
    expect(mem.size).toBe(1);
  });

  it("20 o más archivos viejos y NINGUNO con fila → no se borra nada", async () => {
    const mem = new Map<string, Obj>();
    for (let i = 0; i < 25; i++) mem.set(clave("org_1", `ast_ajeno${String(i).padStart(2, "0")}`), obj());
    const { store } = r2En(mem);
    const r = await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW, aplicar: true });
    expect(r.abortado).toMatch(/ninguno de los 25/);
    expect(r.borrados).toBe(0);
    expect(mem.size).toBe(25);
  });

  it("con huérfanos pero también archivos con fila (base correcta) sí procede", async () => {
    const mem = new Map<string, Obj>([[clave("org_1", "ast_activo"), obj()]]);
    for (let i = 0; i < 25; i++) mem.set(clave("org_1", `ast_h${String(i).padStart(2, "0")}`), obj());
    const { store } = r2En(mem);
    const r = await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW, aplicar: true });
    expect(r.abortado).toBeNull();
    expect(r.borrados).toBe(25);
    expect([...mem.keys()]).toEqual([clave("org_1", "ast_activo")]);
  });

  it("en dry-run el freno no hace falta: solo informa", async () => {
    bd.mediaAsset = [];
    bd.mediaLibraryItem = [];
    const { store } = r2En(new Map([[clave("org_1", "ast_x"), obj()]]));
    const r = await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW });
    expect(r.abortado).toBeNull();
    expect(r.huerfanos).toHaveLength(1);
  });
});

describe("disco local", () => {
  it("APLICAR: borra el huérfano y el temporal abandonado; conserva lo activo, lo reciente y el icono", async () => {
    const activo = await archivo("org_1/ast_activo");
    const biblioteca = await archivo("org_1/medios/med_activo");
    const favicon = await archivo("org_1/favicon");
    const recienteSinFila = await archivo("org_1/ast_reciente", reciente);
    const huerfano = await archivo("org_1/ast_huerfano");
    const huerfanoMedio = await archivo("org_1/medios/med_huerfano");
    const parteVieja = await archivo("org_1/ast_activo.part"); // escritura interrumpida, aunque su asset exista
    const parteReciente = await archivo("org_1/ast_otro.part", reciente);
    const dedupVieja = await archivo("org_1/ast_dup.dedup");
    const r = await reconciliarMedios({ r2: null, mediaDir: dir, now: NOW, aplicar: true });
    expect(await existe(activo)).toBe(true);
    expect(await existe(biblioteca)).toBe(true);
    expect(await existe(favicon)).toBe(true);
    expect(await existe(recienteSinFila)).toBe(true);
    expect(await existe(parteReciente)).toBe(true);
    for (const p of [huerfano, huerfanoMedio, parteVieja, dedupVieja]) expect(await existe(p), p).toBe(false);
    expect(r.borrados).toBe(4);
    expect(r.huerfanos.filter((h) => h.motivo === "temporal")).toHaveLength(2);
  });

  it("DRY-RUN: no borra nada en disco", async () => {
    const huerfano = await archivo("org_1/ast_huerfano");
    const r = await reconciliarMedios({ r2: null, mediaDir: dir, now: NOW });
    expect(r.huerfanos).toHaveLength(1);
    expect(await existe(huerfano)).toBe(true);
  });

  it("no toca enlaces simbólicos ni nombres raros, y los archivos sueltos fuera de <org>/ no se miran", async () => {
    await archivo(".prueba-escritura-1234"); // el sondeo de MEDIA_DIR, en la raíz
    const raro = await archivo("org_1/nombre raro.bin");
    const destino = await archivo("org_1/ast_activo");
    let enlace: string | null = path.join(dir, "org_1", "ast_enlace");
    try {
      await symlink(destino, enlace);
    } catch {
      enlace = null; // Windows sin permiso para enlaces: se omite esa parte
    }
    await reconciliarMedios({ r2: null, mediaDir: dir, now: NOW, aplicar: true });
    expect(await existe(path.join(dir, ".prueba-escritura-1234"))).toBe(true);
    expect(await existe(raro)).toBe(true);
    expect(await existe(destino)).toBe(true);
    if (enlace) expect((await readdir(path.join(dir, "org_1"))).includes("ast_enlace")).toBe(true);
  });

  it("sin MEDIA_DIR no hay nada que reconciliar en disco (y no falla)", async () => {
    const r = await reconciliarMedios({ r2: null, mediaDir: path.join(dir, "no-existe"), now: NOW, aplicar: true });
    expect(r.escaneados.disco).toBe(0);
    expect(r.borrados).toBe(0);
  });

  it("R2 y disco a la vez en una corrida, con un solo tope", async () => {
    await archivo("org_1/ast_h_disco1");
    await archivo("org_1/ast_h_disco2");
    const mem = new Map([[clave("org_1", "ast_h_r2")], ].map(([k]) => [k as string, obj()] as [string, Obj]));
    const { store } = r2En(mem);
    const r = await reconciliarMedios({ r2: store, mediaDir: dir, now: NOW, aplicar: true, maxBorrar: 2 });
    expect(r.huerfanos).toHaveLength(2);
    expect(r.truncado).toBe(true);
    expect(r.borrados).toBe(2);
  });
});

describe("filasSinArchivo (solo informa; nunca modifica filas)", () => {
  it("detecta medios y adjuntos cuyo archivo ya no está, en R2 y en disco", async () => {
    bd.mediaLibraryItem = [
      { id: "med_ok", organizationId: "org_1", status: "ready", storage: "r2", storageKey: clave("org_1", "med_ok") },
      { id: "med_falta_r2", organizationId: "org_1", status: "ready", storage: "r2", storageKey: clave("org_1", "med_falta_r2") },
      { id: "med_falta_disco", organizationId: "org_1", status: "ready", storage: "local", storageKey: null },
      { id: "med_ok_disco", organizationId: "org_1", status: "ready", storage: "local", storageKey: null },
    ];
    bd.mediaAsset = [
      { id: "ast_falta_r2", organizationId: "org_1", fetchStatus: "available", storagePath: `r2:${clave("org_1", "ast_falta_r2")}` },
      { id: "ast_falta_disco", organizationId: "org_1", fetchStatus: "available", storagePath: "org_1/ast_falta_disco" },
      { id: "ast_ok_disco", organizationId: "org_1", fetchStatus: "available", storagePath: "org_1/ast_ok_disco" },
      { id: "ast_sin_ruta", organizationId: "org_1", fetchStatus: "pending", storagePath: null },
    ];
    await archivo("org_1/medios/med_ok_disco");
    await archivo("org_1/ast_ok_disco");
    const { store } = r2En(new Map([[clave("org_1", "med_ok"), obj()]]));
    const antes = JSON.stringify([bd.mediaAsset, bd.mediaLibraryItem]);
    const falta = await filasSinArchivo({ r2: store, mediaDir: dir });
    expect(falta.map((f) => `${f.tipo}:${f.id}:${f.donde}`).sort()).toEqual([
      "adjunto:ast_falta_disco:disco",
      "adjunto:ast_falta_r2:r2",
      "medio:med_falta_disco:disco",
      "medio:med_falta_r2:r2",
    ]);
    expect(JSON.stringify([bd.mediaAsset, bd.mediaLibraryItem])).toBe(antes); // ninguna fila se tocó
  });

  it("respeta el límite de filas revisadas", async () => {
    bd.mediaLibraryItem = Array.from({ length: 10 }, (_, i) => ({ id: `med_${i}`, organizationId: "org_1", status: "ready", storage: "local", storageKey: null }));
    bd.mediaAsset = [];
    expect(await filasSinArchivo({ r2: null, mediaDir: dir, limite: 4 })).toHaveLength(4);
  });
});
