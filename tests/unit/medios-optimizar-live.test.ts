import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Medios — optimización de video (Paso 2) contra PostgreSQL REAL (`pnpm test:db`): la cola (reclamo atómico, arrendamientos,
 * ficha, reintentos), el trabajador con un optimizador simulado (sin ffmpeg), el encolado al confirmar una subida, el borrado de
 * la variante, la limpieza de temporales y la reconciliación de `medios-wa` / `medios-tmp`.
 *
 * Usa la cola GLOBAL de la base (`variant_status = 'processing'`): córrela en una base de pruebas. El volumen es una carpeta
 * temporal y R2 es un almacén en memoria; nada toca ffmpeg ni Cloudflare. Crea y borra lo suyo.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const VOLUMEN = live ? mkdtempSync(path.join(tmpdir(), "medios-cola-")) : "";
if (live) process.env.MEDIA_DIR = VOLUMEN;

const MB = 1024 * 1024;
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(20, 0x78)]);

type Mem = Map<string, { data: Buffer; contentType: string; lastModified: Date }>;

function memoryStore(mem: Mem, StorageError: typeof import("@/server/storage").StorageError) {
  const faltan = () => new StorageError("not_found", "no está");
  return {
    async signUpload(key: string, o: { contentType: string; contentLength: number }) {
      return { url: `https://r2.test/${key}?len=${o.contentLength}`, headers: { "Content-Type": o.contentType }, expiresAt: new Date(Date.now() + 900_000) };
    },
    async signRead(key: string) {
      return `https://r2.test/${key}?sig=1`;
    },
    async head(key: string) {
      const o = mem.get(key);
      return o ? { size: o.data.byteLength, contentType: o.contentType } : null;
    },
    async readRange(key: string, from: number, to: number) {
      const o = mem.get(key);
      if (!o) throw faltan();
      return o.data.subarray(from, to + 1);
    },
    async readAll(key: string) {
      const o = mem.get(key);
      if (!o) throw faltan();
      return o.data;
    },
    async put(key: string, body: Buffer | Uint8Array, contentType: string) {
      mem.set(key, { data: Buffer.from(body), contentType, lastModified: new Date() });
    },
    async copy(from: string, to: string) {
      const o = mem.get(from);
      if (!o) throw faltan();
      mem.set(to, o);
    },
    async delete(key: string) {
      mem.delete(key);
    },
    async list(prefix: string) {
      return { objects: [...mem].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.data.byteLength, lastModified: o.lastModified })), next: null };
    },
  };
}

describe.skipIf(!live)("optimización de video (Paso 2) contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let drizzle: typeof import("drizzle-orm");
  let store: typeof import("@/server/medios/store");
  let cola: typeof import("@/server/medios/optimizar/cola");
  let trabajador: typeof import("@/server/medios/optimizar/trabajador");
  let temporales: typeof import("@/server/medios/optimizar/temporales");
  let perfil: typeof import("@/server/medios/optimizar/perfil");
  let despertar: typeof import("@/server/medios/optimizar/despertar");
  let flag: typeof import("@/server/medios/flag");
  let reconciliar: typeof import("@/server/medios/reconciliar");
  let storage: typeof import("@/server/storage");
  let org = "";
  const ids: string[] = [];
  const mem: Mem = new Map();
  const flagInicial = process.env.MEDIA_VIDEO_OPTIMIZE;
  const AHORA = new Date("2026-06-01T12:00:00.000Z");

  const fila = async (id: string) => (await db.select().from(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.id, id)))[0];
  const nuevoId = () => `med_o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 24);

  /** Un video `ready` en la cola (los de la prueba van PRIMERO: muy viejos y sin espera). */
  async function encolar(extra: Partial<typeof import("@/lib/db").schema.mediaLibraryItem.$inferInsert> = {}) {
    const id = nuevoId();
    ids.push(id);
    await db.insert(schema.mediaLibraryItem).values({
      id,
      organizationId: org,
      name: "prueba",
      kind: "video",
      mimeType: "video/mp4",
      sizeBytes: 3 * MB,
      source: "upload",
      variantStatus: "processing",
      createdAt: new Date("2000-01-01T00:00:00Z"),
      ...extra,
    });
    return id;
  }

  /** El trabajo tal como lo devolvería `reclamar` en el intento `n`, sin competir con trabajos ajenos. */
  async function tomar(id: string, intento = 1) {
    await db
      .update(schema.mediaLibraryItem)
      .set({ variantAttempts: intento, variantLeaseUntil: new Date(AHORA.getTime() + 300_000) })
      .where(drizzle.eq(schema.mediaLibraryItem.id, id));
    const f = (await fila(id))!;
    return { id, organizationId: org, name: f.name, kind: f.kind, mimeType: f.mimeType, sizeBytes: f.sizeBytes, storage: f.storage, storageKey: f.storageKey, intento };
  }

  const escribirOriginal = (id: string, bytes = 3 * MB) => {
    const ruta = store.rutaDeMedio(org, id);
    mkdirSync(path.dirname(ruta), { recursive: true });
    writeFileSync(ruta, Buffer.alloc(bytes, 0x61));
    return ruta;
  };

  /** Un optimizador simulado: escribe una «salida» de `bytes` y la reporta como el pipeline real. */
  const optimizadorOk =
    (bytes = 2 * MB) =>
    async (o: { salida: string; onInfo?: (i: never) => void | Promise<void> }) => {
      await o.onInfo?.({ duracionMs: 12_345, ancho: 1920, alto: 1080 } as never);
      mkdirSync(path.dirname(o.salida), { recursive: true });
      writeFileSync(o.salida, Buffer.alloc(bytes, 0x62));
      return { plan: "transcodificar" as const, info: {} as never, salidaInfo: { ancho: 1280, alto: 720 } as never, bytes };
    };

  const deps = (optimizar: unknown, extra: object = {}) => ({ ahora: () => AHORA, optimizar: optimizar as never, ...extra });

  beforeAll(async () => {
    drizzle = await import("drizzle-orm");
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    store = await import("@/server/medios/store");
    cola = await import("@/server/medios/optimizar/cola");
    trabajador = await import("@/server/medios/optimizar/trabajador");
    temporales = await import("@/server/medios/optimizar/temporales");
    perfil = await import("@/server/medios/optimizar/perfil");
    despertar = await import("@/server/medios/optimizar/despertar");
    flag = await import("@/server/medios/flag");
    reconciliar = await import("@/server/medios/reconciliar");
    storage = await import("@/server/storage");
    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    org = orgs[0]!.id;
  });

  afterEach(() => {
    storage.__setObjectStoreForTests(null);
    despertar.registrarDespertar(null);
    flag.fijarEstadoFfmpeg(null);
    vi.unstubAllGlobals();
    if (flagInicial === undefined) delete process.env.MEDIA_VIDEO_OPTIMIZE;
    else process.env.MEDIA_VIDEO_OPTIMIZE = flagInicial;
    mem.clear();
  });

  afterAll(async () => {
    if (!db) return;
    if (ids.length) await db.delete(schema.mediaLibraryItem).where(drizzle.inArray(schema.mediaLibraryItem.id, ids));
    await rm(VOLUMEN, { recursive: true, force: true }).catch(() => {});
  });

  /* ---------- La cola ---------- */

  describe("la cola", () => {
    it("reclamar toma el trabajo, cuenta el intento y lo arrienda; un segundo reclamo no lo ve", async () => {
      const id = await encolar();
      const t = await cola.reclamar(AHORA);
      expect(t).toMatchObject({ id, organizationId: org, intento: 1, kind: "video", mimeType: "video/mp4", storage: "local" });
      const f = (await fila(id))!;
      expect(f.variantAttempts).toBe(1);
      expect(f.variantLeaseUntil!.getTime()).toBe(AHORA.getTime() + cola.ARRENDAMIENTO_MS);
      const otro = await cola.reclamar(AHORA);
      expect(otro?.id).not.toBe(id);
    });

    it("dos reclamos SIMULTÁNEOS del mismo trabajo: gana uno solo (FOR UPDATE SKIP LOCKED)", async () => {
      const id = await encolar();
      const resultados = await Promise.all(Array.from({ length: 6 }, () => cola.reclamar(AHORA)));
      expect(resultados.filter((r) => r?.id === id)).toHaveLength(1);
      expect((await fila(id))!.variantAttempts).toBe(1);
    });

    it("dos trabajos y dos reclamos simultáneos: cada uno toma uno distinto", async () => {
      const a = await encolar();
      const b = await encolar();
      const [x, y] = await Promise.all([cola.reclamar(AHORA), cola.reclamar(AHORA)]);
      expect(new Set([x?.id, y?.id])).toEqual(new Set([a, b]));
    });

    it("respeta la espera de un reintento: antes de `next_attempt_at` no se toma; después sí", async () => {
      const id = await encolar({ variantNextAttemptAt: new Date(AHORA.getTime() + 60_000), variantAttempts: 1 });
      const antes = await cola.reclamar(AHORA);
      expect(antes?.id).not.toBe(id);
      const despues = await cola.reclamar(new Date(AHORA.getTime() + 61_000));
      expect(despues?.id).toBe(id);
      expect(despues?.intento).toBe(2);
    });

    it("un arrendamiento vencido (la instancia se cayó) lo recoge otro intento; uno vigente no", async () => {
      const id = await encolar({ variantAttempts: 1, variantLeaseUntil: new Date(AHORA.getTime() - 1000) });
      const t = await cola.reclamar(AHORA);
      expect(t).toMatchObject({ id, intento: 2 });
      const vigente = await encolar({ variantAttempts: 1, variantLeaseUntil: new Date(AHORA.getTime() + 60_000) });
      expect((await cola.reclamar(AHORA))?.id).not.toBe(vigente);
    });

    it("tras el tercer intento un arrendamiento vencido ya no se reintenta: queda `failed` con el motivo", async () => {
      const id = await encolar({ variantAttempts: 3, variantLeaseUntil: new Date(AHORA.getTime() - 1000) });
      expect((await cola.reclamar(AHORA))?.id).not.toBe(id); // ni se reclama
      const cerrados = await cola.cerrarAgotados(AHORA);
      expect(cerrados).toBeGreaterThanOrEqual(1);
      expect(await fila(id)).toMatchObject({ variantStatus: "failed", variantLeaseUntil: null });
      expect((await fila(id))!.variantError).toContain("interrumpió");
    });

    it("la FICHA: un intento viejo no puede renovar ni publicar encima del nuevo", async () => {
      const id = await encolar({ variantAttempts: 1, variantLeaseUntil: new Date(AHORA.getTime() - 1000) });
      const nuevo = await cola.reclamar(AHORA); // intento 2
      expect(nuevo).toMatchObject({ id, intento: 2 });
      const v = { clave: "k", bytes: MB, mime: "video/mp4", ancho: 720, alto: 404 };
      expect(await cola.renovar(id, 1, AHORA)).toBe(false);
      expect(await cola.publicar(id, 1, v, AHORA)).toBe(false);
      expect(await cola.fallar(id, 1, "x", AHORA)).toBe(false);
      expect(await cola.sinVariante(id, 1, AHORA)).toBe(false);
      expect(await cola.posponer(id, 1, "x", AHORA)).toBe(false);
      expect(await fila(id)).toMatchObject({ variantStatus: "processing", variantStorageKey: null });
      expect(await cola.renovar(id, 2, AHORA)).toBe(true);
      expect(await cola.publicar(id, 2, v, AHORA)).toBe(true);
      expect(await fila(id)).toMatchObject({ variantStatus: "ready", variantStorageKey: "k", variantSizeBytes: MB, variantWidth: 720, variantHeight: 404, variantLeaseUntil: null, variantError: null });
    });

    it("si el medio se borra, renovar dice `false` (hay que parar)", async () => {
      const id = await encolar({ variantAttempts: 1 });
      await db.delete(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.id, id));
      expect(await cola.renovar(id, 1, AHORA)).toBe(false);
    });

    it("fijarMedidas guarda duración, ancho y alto del original", async () => {
      const id = await encolar({ variantAttempts: 1 });
      expect(await cola.fijarMedidas(id, 1, { duracionMs: 9_000, ancho: 1080, alto: 1920 })).toBe(true);
      expect(await fila(id)).toMatchObject({ durationMs: 9_000, width: 1080, height: 1920 });
    });

    it("sinVariante (caso A) deja `none`; posponer deja `processing` con la espera; fallar deja `failed`", async () => {
      const a = await encolar({ variantAttempts: 1, variantLeaseUntil: AHORA });
      expect(await cola.sinVariante(a, 1, AHORA)).toBe(true);
      expect(await fila(a)).toMatchObject({ variantStatus: "none", variantLeaseUntil: null });
      const b = await encolar({ variantAttempts: 1, variantLeaseUntil: AHORA });
      const hasta = new Date(AHORA.getTime() + 60_000);
      expect(await cola.posponer(b, 1, "falló", hasta)).toBe(true);
      expect(await fila(b)).toMatchObject({ variantStatus: "processing", variantLeaseUntil: null, variantError: "falló" });
      expect((await fila(b))!.variantNextAttemptAt!.getTime()).toBe(hasta.getTime());
      const c = await encolar({ variantAttempts: 1, variantLeaseUntil: AHORA });
      expect(await cola.fallar(c, 1, "mal", AHORA)).toBe(true);
      expect(await fila(c)).toMatchObject({ variantStatus: "failed", variantError: "mal", variantLeaseUntil: null });
    });
  });

  /* ---------- El trabajador ---------- */

  describe("el trabajador (optimizador simulado)", () => {
    it("éxito en disco: publica la variante en `medios-wa`, anota la fila, guarda las medidas y no deja temporales", async () => {
      const id = await encolar();
      escribirOriginal(id);
      await trabajador.procesar(await tomar(id), deps(optimizadorOk(2 * MB)));
      const f = (await fila(id))!;
      expect(f).toMatchObject({
        variantStatus: "ready",
        variantStorageKey: `org/${org}/medios-wa/${id}`,
        variantSizeBytes: 2 * MB,
        variantMimeType: "video/mp4",
        variantWidth: 1280,
        variantHeight: 720,
        variantLeaseUntil: null,
        durationMs: 12_345,
        width: 1920,
        height: 1080,
      });
      expect(readFileSync(store.rutaDeVariante(org, id)).byteLength).toBe(2 * MB);
      expect(existsSync(store.rutaTemporalDeMedio(org, id, ".wa.mp4"))).toBe(false);
      expect(existsSync(store.rutaTemporalDeMedio(org, id, ".src"))).toBe(false);
      // El original no se tocó.
      expect(existsSync(store.rutaDeMedio(org, id))).toBe(true);
    });

    it("éxito en R2: baja el original en flujo, sube la variante a `medios-wa` y no deja temporales", async () => {
      storage.__setObjectStoreForTests(memoryStore(mem, storage.StorageError) as never);
      const original = Buffer.alloc(3 * MB, 0x61);
      const id = await encolar({ storage: "r2", storageKey: `org/${org}/medios/__ID__` });
      await db.update(schema.mediaLibraryItem).set({ storageKey: `org/${org}/medios/${id}` }).where(drizzle.eq(schema.mediaLibraryItem.id, id));
      mem.set(`org/${org}/medios/${id}`, { data: original, contentType: "video/mp4", lastModified: new Date() });
      vi.stubGlobal("fetch", async (url: string) => (String(url).startsWith("https://r2.test/") ? new Response(original) : new Response("no", { status: 404 })));

      let entradaVista = 0;
      const opt = async (o: { entrada: string; salida: string; onInfo?: (i: never) => void }) => {
        entradaVista = readFileSync(o.entrada).byteLength; // el original bajado ya está en disco
        return optimizadorOk(MB)(o);
      };
      await trabajador.procesar(await tomar(id), deps(opt));
      expect(entradaVista).toBe(3 * MB);
      expect(await fila(id)).toMatchObject({ variantStatus: "ready", variantStorageKey: `org/${org}/medios-wa/${id}`, variantSizeBytes: MB });
      expect(mem.get(`org/${org}/medios-wa/${id}`)?.data.byteLength).toBe(MB);
      expect(existsSync(store.rutaTemporalDeMedio(org, id, ".src"))).toBe(false);
      expect(existsSync(store.rutaTemporalDeMedio(org, id, ".wa.mp4"))).toBe(false);
    });

    it("la descarga de R2 incompleta es un fallo transitorio (se reintenta), no una variante corrupta", async () => {
      storage.__setObjectStoreForTests(memoryStore(mem, storage.StorageError) as never);
      const id = await encolar({ storage: "r2" });
      await db.update(schema.mediaLibraryItem).set({ storageKey: `org/${org}/medios/${id}` }).where(drizzle.eq(schema.mediaLibraryItem.id, id));
      vi.stubGlobal("fetch", async () => new Response(Buffer.alloc(MB))); // pesa 3 MB, llegó 1
      await trabajador.procesar(await tomar(id), deps(optimizadorOk()));
      expect(await fila(id)).toMatchObject({ variantStatus: "processing", variantLeaseUntil: null });
      expect((await fila(id))!.variantError).toContain("completo");
    });

    it("caso A (el original ya sirve): queda `none`, sin variante, con las medidas del original", async () => {
      const id = await encolar();
      escribirOriginal(id);
      const opt = async (o: { onInfo?: (i: never) => void | Promise<void> }) => {
        await o.onInfo?.({ duracionMs: 7_000, ancho: 1280, alto: 720 } as never);
        return { plan: "ninguna" as const, info: {} as never };
      };
      await trabajador.procesar(await tomar(id), deps(opt));
      expect(await fila(id)).toMatchObject({ variantStatus: "none", variantStorageKey: null, durationMs: 7_000, width: 1280, height: 720 });
      expect(existsSync(store.rutaDeVariante(org, id))).toBe(false);
    });

    it("un error PERMANENTE no se reintenta: `failed` con el mensaje", async () => {
      const id = await encolar();
      escribirOriginal(id);
      const opt = async () => {
        throw perfil.permanente("demasiado_largo", "El video dura 4:10.");
      };
      await trabajador.procesar(await tomar(id), deps(opt));
      expect(await fila(id)).toMatchObject({ variantStatus: "failed", variantError: "El video dura 4:10.", variantLeaseUntil: null });
    });

    it("un error transitorio se reintenta con 1 min y 5 min de espera, y al tercer intento queda `failed`", async () => {
      const id = await encolar();
      escribirOriginal(id);
      const opt = async () => {
        throw perfil.transitorio("tiempo_agotado", "Tardó demasiado.");
      };
      await trabajador.procesar(await tomar(id, 1), deps(opt));
      let f = (await fila(id))!;
      expect(f).toMatchObject({ variantStatus: "processing", variantLeaseUntil: null, variantError: "Tardó demasiado." });
      expect(f.variantNextAttemptAt!.getTime()).toBe(AHORA.getTime() + 60_000);

      await trabajador.procesar(await tomar(id, 2), deps(opt));
      f = (await fila(id))!;
      expect(f.variantStatus).toBe("processing");
      expect(f.variantNextAttemptAt!.getTime()).toBe(AHORA.getTime() + 300_000);

      await trabajador.procesar(await tomar(id, 3), deps(opt));
      f = (await fila(id))!;
      expect(f).toMatchObject({ variantStatus: "failed", variantLeaseUntil: null });
      expect(f.variantError).toContain("varios intentos");
    });

    it("un error inesperado cuenta como transitorio (no tumba al trabajador)", async () => {
      const id = await encolar();
      escribirOriginal(id);
      const opt = async () => {
        throw new Error("bum");
      };
      await trabajador.procesar(await tomar(id, 1), deps(opt));
      expect(await fila(id)).toMatchObject({ variantStatus: "processing", variantError: "bum" });
    });

    it("el original que ya no está en disco es un fallo permanente", async () => {
      const id = await encolar();
      await trabajador.procesar(await tomar(id), deps(optimizadorOk()));
      expect(await fila(id)).toMatchObject({ variantStatus: "failed" });
      expect((await fila(id))!.variantError).toContain("ya no está");
    });

    it("si el medio se BORRA mientras se publica, la variante recién publicada se borra (no queda huérfana)", async () => {
      const id = await encolar();
      escribirOriginal(id);
      const opt = async (o: { salida: string; onInfo?: (i: never) => void }) => {
        const r = await optimizadorOk(MB)(o);
        await db.delete(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.id, id)); // se borra justo ahora
        return r;
      };
      await trabajador.procesar(await tomar(id), deps(opt));
      expect(await fila(id)).toBeUndefined();
      expect(existsSync(store.rutaDeVariante(org, id))).toBe(false);
      expect(existsSync(store.rutaTemporalDeMedio(org, id, ".wa.mp4"))).toBe(false);
    });

    it("el latido detecta el borrado a mitad de trabajo y cancela al optimizador", async () => {
      const id = await encolar();
      escribirOriginal(id);
      let cancelado = false;
      const opt = async (o: { signal?: AbortSignal }) => {
        await db.delete(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.id, id));
        await new Promise<void>((resolve) => {
          if (o.signal?.aborted) return resolve();
          o.signal?.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 5000);
        });
        cancelado = o.signal?.aborted === true;
        throw perfil.transitorio("cancelado", "cancelado");
      };
      await trabajador.procesar(await tomar(id), deps(opt, { latidoMs: 50 }));
      expect(cancelado).toBe(true);
      expect(await fila(id)).toBeUndefined();
    });

    it("el latido renueva el arrendamiento mientras dura el trabajo", async () => {
      const id = await encolar();
      escribirOriginal(id);
      const t = await tomar(id);
      await db.update(schema.mediaLibraryItem).set({ variantLeaseUntil: new Date(AHORA.getTime() + 1000) }).where(drizzle.eq(schema.mediaLibraryItem.id, id));
      let durante: Date | null = null;
      const opt = async (o: { salida: string; onInfo?: (i: never) => void }) => {
        await new Promise((r) => setTimeout(r, 200));
        durante = (await fila(id))!.variantLeaseUntil;
        return optimizadorOk(MB)(o);
      };
      await trabajador.procesar(t, deps(opt, { latidoMs: 40 }));
      expect(durante!.getTime()).toBe(AHORA.getTime() + cola.ARRENDAMIENTO_MS);
    });

    it("CONCURRENCIA 1: dos rondas a la vez no corren dos trabajos a la vez; la segunda no hace nada", async () => {
      const a = await encolar();
      const b = await encolar();
      escribirOriginal(a);
      escribirOriginal(b);
      let activos = 0;
      let maximo = 0;
      const opt = async (o: { salida: string; onInfo?: (i: never) => void }) => {
        activos++;
        maximo = Math.max(maximo, activos);
        await new Promise((r) => setTimeout(r, 80));
        const r = await optimizadorOk(MB)(o);
        activos--;
        return r;
      };
      const [x, y] = await Promise.all([trabajador.tickOptimizador(deps(opt)), trabajador.tickOptimizador(deps(opt))]);
      expect(maximo).toBe(1);
      expect([x, y].sort()[0]).toBe(0); // la ronda que llegó con otra en curso no procesó nada
      expect((await fila(a))!.variantStatus).toBe("ready");
      expect((await fila(b))!.variantStatus).toBe("ready");
    });
  });

  /* ---------- Encolado al subir ---------- */

  describe("encolar al confirmar el video", () => {
    const flujo = (cabeza: Buffer, total: number) => {
      let enviado = 0;
      return new ReadableStream<Uint8Array>({
        pull(c) {
          if (enviado === 0) {
            c.enqueue(cabeza);
            enviado = cabeza.byteLength;
          } else if (enviado >= total) c.close();
          else {
            const n = Math.min(MB, total - enviado);
            c.enqueue(Buffer.alloc(n, 0x61));
            enviado += n;
          }
        },
      });
    };

    it("con la bandera y ffmpeg comprobado, un video subido a disco nace `processing` y avisa al trabajador", async () => {
      process.env.MEDIA_VIDEO_OPTIMIZE = "on";
      flag.fijarEstadoFfmpeg({ ok: true });
      const avisos = vi.fn();
      despertar.registrarDespertar(avisos);
      const dto = await store.crearMedioDesdeFlujo({ organizationId: org, userId: "usr_t", flujo: flujo(MP4, 2 * MB), nombre: "promo.mp4" });
      ids.push(dto.id);
      expect(dto.varianteEstado).toBe("processing");
      const f = (await fila(dto.id))!;
      expect(f).toMatchObject({ variantStatus: "processing", variantAttempts: 0, status: "ready" });
      expect(f.variantNextAttemptAt).not.toBeNull();
      expect(avisos).toHaveBeenCalled();
    });

    it("una IMAGEN nunca se encola", async () => {
      process.env.MEDIA_VIDEO_OPTIMIZE = "on";
      flag.fijarEstadoFfmpeg({ ok: true });
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      const dto = await store.crearMedio({ organizationId: org, userId: "usr_t", data: png, nombre: "a.png", source: "upload" });
      ids.push(dto.id);
      expect(dto.varianteEstado).toBe("none");
    });

    it("sin la bandera, o con ffmpeg sin comprobar o inservible, no se encola (el video queda como antes)", async () => {
      for (const [bandera, estado] of [
        [undefined, { ok: true }],
        ["on", null],
        ["on", { ok: false, motivo: "no está" }],
      ] as const) {
        if (bandera) process.env.MEDIA_VIDEO_OPTIMIZE = bandera;
        else delete process.env.MEDIA_VIDEO_OPTIMIZE;
        flag.fijarEstadoFfmpeg(estado);
        const dto = await store.crearMedioDesdeFlujo({ organizationId: org, userId: "usr_t", flujo: flujo(MP4, 1 * MB), nombre: "v.mp4" });
        ids.push(dto.id);
        expect(dto.varianteEstado, JSON.stringify([bandera, estado])).toBe("none");
      }
    });

    it("la subida directa a R2: confirmar deja el video `ready` y `processing` en la MISMA sentencia", async () => {
      process.env.MEDIA_VIDEO_OPTIMIZE = "on";
      flag.fijarEstadoFfmpeg({ ok: true });
      storage.__setObjectStoreForTests(memoryStore(mem, storage.StorageError) as never);
      const data = Buffer.concat([MP4, Buffer.alloc(20 * MB, 0x61)]);
      const f = await store.prepararSubida({ organizationId: org, userId: "usr_t", nombre: "grande.mp4", mime: "video/mp4", bytes: data.byteLength });
      ids.push(f.medio.id);
      const pendiente = (await fila(f.medio.id))!;
      expect(pendiente).toMatchObject({ status: "pending", variantStatus: "none" }); // pendiente: nunca encolado
      mem.set(pendiente.storageKey!, { data, contentType: "video/mp4", lastModified: new Date() });
      const ok = await store.confirmarSubida({ organizationId: org, userId: "usr_t", id: f.medio.id });
      expect(ok.medio.varianteEstado).toBe("processing");
      expect(await fila(f.medio.id)).toMatchObject({ status: "ready", variantStatus: "processing", variantAttempts: 0 });
    });
  });

  /* ---------- Borrado ---------- */

  describe("borrar un medio borra su variante", () => {
    const borrar = (id: string) => store.borrarMedio({ organizationId: org, userId: "usr_t", puedeAdministrar: true, id });

    it("en disco: se van el original y la variante de `medios-wa`", async () => {
      const id = await encolar({ variantStatus: "ready", variantStorageKey: `org/${org}/medios-wa/__`, variantSizeBytes: MB, variantMimeType: "video/mp4" });
      const original = escribirOriginal(id, 1000);
      const variante = store.rutaDeVariante(org, id);
      mkdirSync(path.dirname(variante), { recursive: true });
      writeFileSync(variante, Buffer.alloc(500));
      await borrar(id);
      expect(existsSync(original)).toBe(false);
      expect(existsSync(variante)).toBe(false);
      expect(await fila(id)).toBeUndefined();
    });

    it("en disco: borra la variante aunque la fila aún no la anotara (publicada justo al borrar)", async () => {
      const id = await encolar();
      escribirOriginal(id, 1000);
      const variante = store.rutaDeVariante(org, id);
      mkdirSync(path.dirname(variante), { recursive: true });
      writeFileSync(variante, Buffer.alloc(500));
      await borrar(id);
      expect(existsSync(variante)).toBe(false);
    });

    it("en R2: se van el original y la variante", async () => {
      storage.__setObjectStoreForTests(memoryStore(mem, storage.StorageError) as never);
      const id = await encolar({ storage: "r2", variantStatus: "ready", variantStorageKey: "x", variantSizeBytes: MB, variantMimeType: "video/mp4" });
      const orig = `org/${org}/medios/${id}`;
      const vari = `org/${org}/medios-wa/${id}`;
      await db.update(schema.mediaLibraryItem).set({ storageKey: orig, variantStorageKey: vari }).where(drizzle.eq(schema.mediaLibraryItem.id, id));
      mem.set(orig, { data: Buffer.alloc(10), contentType: "video/mp4", lastModified: new Date() });
      mem.set(vari, { data: Buffer.alloc(5), contentType: "video/mp4", lastModified: new Date() });
      await borrar(id);
      expect(mem.has(orig)).toBe(false);
      expect(mem.has(vari)).toBe(false);
    });
  });

  /* ---------- Temporales ---------- */

  describe("limpieza de medios-tmp", () => {
    const viejo = (ruta: string, horas: number) => {
      const t = new Date(AHORA.getTime() - horas * 3600_000);
      utimesSync(ruta, t, t);
    };
    const tmp = (id: string, sufijo = "") => {
      const ruta = store.rutaTemporalDeMedio(org, id, sufijo);
      mkdirSync(path.dirname(ruta), { recursive: true });
      writeFileSync(ruta, Buffer.alloc(100));
      return ruta;
    };

    it("borra lo viejo SIN arrendamiento; deja lo reciente y lo de un trabajo vivo", async () => {
      const huerfano = tmp("med_sinfila", ".wa.mp4");
      viejo(huerfano, 5);
      const subida = tmp("med_subida");
      viejo(subida, 5);
      const reciente = tmp("med_reciente", ".src");
      viejo(reciente, 0.5);
      const vivoId = await encolar({ variantAttempts: 1, variantLeaseUntil: new Date(AHORA.getTime() + 60_000) });
      const vivo = tmp(vivoId, ".src");
      viejo(vivo, 5);
      const vencidoId = await encolar({ variantAttempts: 1, variantLeaseUntil: new Date(AHORA.getTime() - 60_000) });
      const vencido = tmp(vencidoId, ".wa.mp4");
      viejo(vencido, 5);

      const n = await temporales.limpiarTemporales({ now: AHORA, mediaDir: VOLUMEN });
      expect(n).toBeGreaterThanOrEqual(3);
      expect(existsSync(huerfano)).toBe(false);
      expect(existsSync(subida)).toBe(false);
      expect(existsSync(vencido)).toBe(false); // arrendamiento vencido: el trabajo murió
      expect(existsSync(reciente)).toBe(true);
      expect(existsSync(vivo)).toBe(true); // trabajo vivo: no se toca
    });
  });

  /* ---------- Reconciliación ---------- */

  describe("reconciliar medios-wa y medios-tmp", () => {
    const vieja = new Date(AHORA.getTime() - 100 * 3600_000);
    const opts = (extra: object = {}) => ({ now: AHORA, edadMinimaMs: 24 * 3600_000, mediaDir: VOLUMEN, r2: memoryStore(mem, storage.StorageError) as never, ...extra });
    const propios = (r: Awaited<ReturnType<typeof reconciliar.reconciliarMedios>>) => r.huerfanos.filter((h) => ids.includes(h.id) || h.id.startsWith("med_huer"));
    const envejecer = (ruta: string) => utimesSync(ruta, vieja, vieja);
    const enDisco = (ruta: string) => {
      mkdirSync(path.dirname(ruta), { recursive: true });
      writeFileSync(ruta, Buffer.alloc(50));
      envejecer(ruta);
      return ruta;
    };

    it("una variante cuya fila la anota NO es huérfana; sin fila, o con la fila sin anotarla, sí (R2)", async () => {
      const conClave = await encolar({ storage: "r2", variantStatus: "ready", variantStorageKey: "k", variantSizeBytes: MB, variantMimeType: "video/mp4" });
      const sinClave = await encolar({ storage: "r2" });
      const sinFila = "med_huerfanavariante";
      const claves = [conClave, sinClave, sinFila].map((i) => `org/${org}/medios-wa/${i}`);
      for (const k of claves) mem.set(k, { data: Buffer.alloc(10), contentType: "video/mp4", lastModified: vieja });
      const r = await reconciliar.reconciliarMedios(opts());
      const h = propios(r).filter((x) => x.origen === "r2");
      expect(h.map((x) => x.ubicacion).sort()).toEqual([claves[1], claves[2]].sort());
      expect(h.every((x) => x.variante === true && x.motivo === "sin_fila")).toBe(true);
      expect(mem.size).toBe(3); // modo informe: no borra nada
    });

    it("una variante en disco huérfana, y un temporal de `medios-tmp` abandonado, se informan; el de un trabajo vivo no", async () => {
      const vId = "med_huerdisco";
      const variante = enDisco(store.rutaDeVariante(org, vId));
      const tmpHuerfano = enDisco(store.rutaTemporalDeMedio(org, "med_huertmp", ".wa.mp4"));
      const vivoId = await encolar({ variantAttempts: 1, variantLeaseUntil: new Date(AHORA.getTime() + 600_000) });
      const tmpVivo = enDisco(store.rutaTemporalDeMedio(org, vivoId, ".src"));
      const r = await reconciliar.reconciliarMedios(opts({ r2: null }));
      const ubic = propios(r).map((x) => x.ubicacion);
      expect(ubic).toContain(variante);
      expect(ubic).toContain(tmpHuerfano);
      expect(ubic).not.toContain(tmpVivo);
      const hv = r.huerfanos.find((x) => x.ubicacion === variante)!;
      expect(hv).toMatchObject({ variante: true, origen: "disco" });
      expect(r.huerfanos.find((x) => x.ubicacion === tmpHuerfano)).toMatchObject({ enTmp: true, motivo: "temporal" });
      expect(r.protegidos.conArrendamiento).toBeGreaterThanOrEqual(1);
      expect(existsSync(variante) && existsSync(tmpHuerfano) && existsSync(tmpVivo)).toBe(true); // informe: nada se borró
    });

    it("lo reciente se protege (edad mínima) y, aplicando, solo se borra lo huérfano", async () => {
      const huerfana = enDisco(store.rutaDeVariante(org, "med_huerborrar"));
      const reciente = store.rutaDeVariante(org, "med_huerreciente");
      mkdirSync(path.dirname(reciente), { recursive: true });
      writeFileSync(reciente, Buffer.alloc(50)); // mtime = ahora real (más nuevo que AHORA − 24 h? no: AHORA es 2026-06-01)
      utimesSync(reciente, new Date(AHORA.getTime() - 3600_000), new Date(AHORA.getTime() - 3600_000));
      // una fila real con su variante anotada (no debe tocarse al aplicar)
      const buenoId = await encolar({ variantStatus: "ready", variantStorageKey: `org/${org}/medios-wa/x`, variantSizeBytes: MB, variantMimeType: "video/mp4" });
      const bueno = enDisco(store.rutaDeVariante(org, buenoId));
      const r = await reconciliar.reconciliarMedios(opts({ r2: null, aplicar: true }));
      expect(r.protegidos.recientes).toBeGreaterThanOrEqual(1);
      expect(existsSync(huerfana)).toBe(false);
      expect(existsSync(reciente)).toBe(true);
      expect(existsSync(bueno)).toBe(true);
    });

    it("`filasSinArchivo` también avisa de una variante `ready` cuyo archivo ya no está (solo informa)", async () => {
      const sinArchivo = await encolar({ variantStatus: "ready", variantStorageKey: `org/${org}/medios-wa/z`, variantSizeBytes: MB, variantMimeType: "video/mp4" });
      escribirOriginal(sinArchivo, 100);
      const conArchivo = await encolar({ variantStatus: "ready", variantStorageKey: `org/${org}/medios-wa/z`, variantSizeBytes: MB, variantMimeType: "video/mp4" });
      escribirOriginal(conArchivo, 100);
      enDisco(store.rutaDeVariante(org, conArchivo));
      const falta = await reconciliar.filasSinArchivo({ limite: 5000, r2: null, mediaDir: VOLUMEN });
      const mias = falta.filter((f) => f.id === sinArchivo || f.id === conArchivo);
      expect(mias).toEqual([{ tipo: "variante", id: sinArchivo, organizationId: org, donde: "disco" }]);
      expect(await fila(sinArchivo)).toBeDefined(); // nunca se tocan filas
    });
  });
});
