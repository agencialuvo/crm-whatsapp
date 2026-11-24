import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Medios — Paso 3a contra PostgreSQL REAL (`pnpm test:db`): `loadMediaFile` con la variante, la caché del `media_id`
 * (qué se sube, qué MIME y peso se guardan, cuándo se reutiliza y cuándo se invalida) y el olvido de los `media_id` al publicar
 * una variante. El volumen es una carpeta temporal, R2 un almacén en memoria y Meta una función falsa: nada sale a la red.
 * Crea su propia organización y borra lo suyo.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const VOLUMEN = live ? mkdtempSync(path.join(tmpdir(), "medios-envio-")) : "";
if (live) process.env.MEDIA_DIR = VOLUMEN;

const MB = 1024 * 1024;

describe.skipIf(!live)("envío de medios con variante (Paso 3a) contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let drizzle: typeof import("drizzle-orm");
  let store: typeof import("@/server/medios/store");
  let cola: typeof import("@/server/medios/optimizar/cola");
  let cache: typeof import("@/server/whatsapp/media-cache");
  let media: typeof import("@/server/automation/media");
  let storage: typeof import("@/server/storage");
  const org = `org_envio_${Date.now().toString(36)}`;
  const ids: string[] = [];
  const mem = new Map<string, Buffer>();
  const AHORA = new Date("2026-06-01T12:00:00.000Z");
  const cred = { organizationId: org, phoneNumberId: "pn_1" } as never;

  const fila = async (id: string) => (await db.select().from(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.id, id)))[0]!;
  const filasDeCache = (id: string) => db.select().from(schema.whatsappMediaCache).where(drizzle.eq(schema.whatsappMediaCache.mediaItemId, id));
  const nuevoId = () => `med_e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`.slice(0, 24);

  /** Un video `ready` en disco, con o sin variante. */
  async function video(extra: Partial<typeof import("@/lib/db").schema.mediaLibraryItem.$inferInsert> = {}, opts: { original?: number; variante?: number | null } = {}) {
    const id = nuevoId();
    ids.push(id);
    const original = opts.original ?? 5 * MB;
    await db.insert(schema.mediaLibraryItem).values({
      id,
      organizationId: org,
      name: "promo",
      kind: "video",
      mimeType: "video/mp4",
      sizeBytes: original,
      source: "upload",
      ...extra,
    });
    const rutaO = store.rutaDeMedio(org, id);
    mkdirSync(path.dirname(rutaO), { recursive: true });
    writeFileSync(rutaO, Buffer.alloc(Math.min(original, 64), 0x61));
    if (opts.variante) {
      const rutaV = store.rutaDeVariante(org, id);
      mkdirSync(path.dirname(rutaV), { recursive: true });
      writeFileSync(rutaV, Buffer.alloc(Math.min(opts.variante, 64), 0x62));
    }
    return id;
  }

  const conVariante = (bytes = 9 * MB) => ({ variantStatus: "ready" as const, variantStorageKey: "k", variantSizeBytes: bytes, variantMimeType: "video/mp4" });

  /** Un `upload` falso: anota lo que se le pasó y devuelve un id nuevo cada vez. */
  const subidas: { mimeType: string; fileName?: string; bytes: number; primero: number }[] = [];
  const upload = async (_c: unknown, f: { data: Buffer; mimeType: string; fileName?: string }) => {
    subidas.push({ mimeType: f.mimeType, fileName: f.fileName, bytes: f.data.byteLength, primero: f.data[0]! });
    return `wa_${subidas.length}`;
  };
  const resolver = async (id: string, o: object = {}) => cache.resolveWaMediaId(await fila(id), cred, { upload: upload as never, now: () => AHORA, ...o });

  beforeAll(async () => {
    drizzle = await import("drizzle-orm");
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    store = await import("@/server/medios/store");
    cola = await import("@/server/medios/optimizar/cola");
    cache = await import("@/server/whatsapp/media-cache");
    media = await import("@/server/automation/media");
    storage = await import("@/server/storage");
    await db.insert(schema.organization).values({ id: org, name: "Envio 3a" });
  });

  afterEach(() => {
    storage.__setObjectStoreForTests(null);
    subidas.length = 0;
    mem.clear();
  });

  afterAll(async () => {
    if (!db) return;
    if (ids.length) {
      await db.delete(schema.whatsappMediaCache).where(drizzle.inArray(schema.whatsappMediaCache.mediaItemId, ids));
      await db.delete(schema.mediaLibraryItem).where(drizzle.inArray(schema.mediaLibraryItem.id, ids));
    }
    await db.delete(schema.organization).where(drizzle.eq(schema.organization.id, org));
    await rm(VOLUMEN, { recursive: true, force: true }).catch(() => {});
  });

  /* ---------- loadMediaFile ---------- */

  describe("loadMediaFile", () => {
    it("variante lista (local): devuelve el MIME, el peso y el nombre de la VARIANTE aunque el original sea un MOV grande", async () => {
      const id = await video({ ...conVariante(9 * MB), mimeType: "video/quicktime" }, { original: 120 * MB, variante: 9 * MB });
      expect(await media.loadMediaFile(org, id)).toEqual({ ok: true, mimeType: "video/mp4", fileName: "promo.mp4", bytes: 9 * MB });
    });

    it("variante lista pero SIN archivo en medios-wa: file_missing (no se manda el original grande ni se sube a ciegas)", async () => {
      const id = await video(conVariante(), { original: 120 * MB });
      expect(await media.loadMediaFile(org, id)).toEqual({ ok: false, reason: "file_missing" });
    });

    it("variante lista en R2: no pregunta por el archivo (como el original en R2)", async () => {
      const id = await video({ ...conVariante(), storage: "r2", storageKey: "org/x/medios/y" }, { original: 120 * MB });
      expect(await media.loadMediaFile(org, id)).toMatchObject({ ok: true, bytes: 9 * MB });
    });

    it("sin variante y con el original enviable (video de siempre): el original", async () => {
      const id = await video({}, { original: 5 * MB });
      expect(await media.loadMediaFile(org, id)).toEqual({ ok: true, mimeType: "video/mp4", fileName: "promo.mp4", bytes: 5 * MB });
    });

    it("sin variante y de más de 16 MiB: too_large; MOV: unsupported", async () => {
      expect(await media.loadMediaFile(org, await video({}, { original: 40 * MB }))).toEqual({ ok: false, reason: "too_large" });
      expect(await media.loadMediaFile(org, await video({ mimeType: "video/quicktime" }, { original: 40 * MB }))).toEqual({ ok: false, reason: "unsupported" });
    });

    it("processing sin original enviable: processing; con original enviable: se manda el original", async () => {
      expect(await media.loadMediaFile(org, await video({ variantStatus: "processing" }, { original: 40 * MB }))).toEqual({ ok: false, reason: "processing" });
      expect(await media.loadMediaFile(org, await video({ variantStatus: "processing" }, { original: 5 * MB }))).toMatchObject({ ok: true, bytes: 5 * MB });
    });

    it("failed sin original enviable: variant_failed con el motivo; con original enviable: el original", async () => {
      const malo = await video({ variantStatus: "failed", variantError: "El video dura más de 3 minutos" }, { original: 40 * MB });
      expect(await media.loadMediaFile(org, malo)).toEqual({ ok: false, reason: "variant_failed", detail: "El video dura más de 3 minutos" });
      const bueno = await video({ variantStatus: "failed", variantError: "x" }, { original: 5 * MB });
      expect(await media.loadMediaFile(org, bueno)).toMatchObject({ ok: true, bytes: 5 * MB });
    });

    it("un medio de otra organización o inexistente: not_found", async () => {
      const id = await video({}, {});
      expect(await media.loadMediaFile("org_otra", id)).toEqual({ ok: false, reason: "not_found" });
      expect(await media.loadMediaFile(org, "med_noexiste")).toEqual({ ok: false, reason: "not_found" });
    });
  });

  /* ---------- La caché del media_id ---------- */

  describe("resolveWaMediaId con la variante", () => {
    it("sube los bytes de la VARIANTE (no del original) con su MIME y su nombre, y guarda SU MIME y peso", async () => {
      const id = await video({ ...conVariante(9 * MB), mimeType: "video/quicktime" }, { original: 120 * MB, variante: 9 * MB });
      const r = await resolver(id);
      expect(r).toEqual({ waMediaId: "wa_1", reused: false });
      expect(subidas).toEqual([{ mimeType: "video/mp4", fileName: "promo.mp4", bytes: 64, primero: 0x62 }]);
      const [c] = await filasDeCache(id);
      expect(c).toMatchObject({ waMediaId: "wa_1", mimeType: "video/mp4", sizeBytes: 9 * MB });
    });

    it("el segundo envío reutiliza el media_id sin subir nada", async () => {
      const id = await video(conVariante(), { variante: 9 * MB });
      await resolver(id);
      expect(await resolver(id)).toEqual({ waMediaId: "wa_1", reused: true });
      expect(subidas).toHaveLength(1);
    });

    it("variante en R2: lee variant_storage_key (nunca la clave del original)", async () => {
      const id = await video({ ...conVariante(), storage: "r2", storageKey: "org/x/medios/orig", variantStorageKey: "org/x/medios-wa/var" }, { original: 120 * MB });
      const pedidas: string[] = [];
      storage.__setObjectStoreForTests({
        async readAll(key: string) {
          pedidas.push(key);
          return mem.get(key) ?? Promise.reject(new storage.StorageError("not_found", "no está"));
        },
      } as never);
      mem.set("org/x/medios-wa/var", Buffer.alloc(32, 0x63));
      await resolver(id);
      expect(pedidas).toEqual(["org/x/medios-wa/var"]);
      expect(subidas[0]).toMatchObject({ mimeType: "video/mp4", bytes: 32, primero: 0x63 });
    });

    it("variante ausente en el almacenamiento: MediaArchivoAusente y no deja un arrendamiento colgado", async () => {
      const id = await video(conVariante(), { original: 5 * MB });
      await expect(resolver(id)).rejects.toBeInstanceOf(cache.MediaArchivoAusente);
      expect(await filasDeCache(id)).toHaveLength(0);
    });

    it("un original ≤ 16 MiB sin variante conserva su media_id (se sigue reutilizando)", async () => {
      const id = await video({}, { original: 5 * MB });
      await resolver(id);
      expect(await resolver(id)).toMatchObject({ waMediaId: "wa_1", reused: true });
      expect(subidas[0]).toMatchObject({ mimeType: "video/mp4", primero: 0x61 });
    });

    it("video en processing sin original enviable: MediaNoEnviable y no se sube NADA ni se escribe la caché", async () => {
      const id = await video({ variantStatus: "processing" }, { original: 40 * MB });
      await expect(resolver(id)).rejects.toMatchObject({ name: "MediaNoEnviable", razon: "processing" });
      expect(subidas).toHaveLength(0);
      expect(await filasDeCache(id)).toHaveLength(0);
    });

    it("el original ya subido y luego una variante de OTRO peso: el id viejo no se reutiliza (changed → se vuelve a subir)", async () => {
      const id = await video({}, { original: 5 * MB });
      await resolver(id);
      const ruta = store.rutaDeVariante(org, id);
      mkdirSync(path.dirname(ruta), { recursive: true });
      writeFileSync(ruta, Buffer.alloc(16, 0x62));
      await db.update(schema.mediaLibraryItem).set(conVariante(3 * MB)).where(drizzle.eq(schema.mediaLibraryItem.id, id));
      expect(await resolver(id)).toEqual({ waMediaId: "wa_2", reused: false });
      expect(subidas[1]).toMatchObject({ primero: 0x62 });
    });
  });

  /* ---------- Invalidación al publicar ---------- */

  describe("publicar una variante olvida los media_id del medio", () => {
    const variante = { clave: "org/x/medios-wa/m", bytes: 9 * MB, mime: "video/mp4", ancho: 1280, alto: 720 };

    async function enCola(extra: Partial<typeof import("@/lib/db").schema.mediaLibraryItem.$inferInsert> = {}) {
      const id = await video({ variantStatus: "processing", variantAttempts: 1, variantLeaseUntil: new Date(AHORA.getTime() + 300_000), ...extra }, { original: 40 * MB });
      return id;
    }
    async function guardarId(id: string, phone: string, wa: string, mime = "video/mp4", bytes = 9 * MB) {
      await db.insert(schema.whatsappMediaCache).values({ id: `wmc_${Math.random().toString(36).slice(2, 12)}`, organizationId: org, mediaItemId: id, phoneNumberId: phone, waMediaId: wa, mimeType: mime, sizeBytes: bytes, uploadedAt: AHORA, expiresAt: new Date(AHORA.getTime() + 25 * 86_400_000) });
    }

    it("borra las filas de TODOS los números en la misma operación que deja la variante lista, aunque MIME y peso coincidan", async () => {
      const id = await enCola();
      await guardarId(id, "pn_1", "viejo_1");
      await guardarId(id, "pn_2", "viejo_2");
      expect(await cola.publicar(id, 1, variante, AHORA)).toBe(true);
      expect((await fila(id)).variantStatus).toBe("ready");
      expect(await filasDeCache(id)).toHaveLength(0);
    });

    it("no toca la caché de OTROS medios", async () => {
      const a = await enCola();
      const b = await video({}, { original: 5 * MB });
      await guardarId(b, "pn_1", "de_b", "video/mp4", 5 * MB);
      await cola.publicar(a, 1, variante, AHORA);
      expect(await filasDeCache(b)).toHaveLength(1);
    });

    it("si el trabajo ya no era suyo (ficha vieja) no publica NI borra la caché", async () => {
      const id = await enCola();
      await guardarId(id, "pn_1", "vigente");
      expect(await cola.publicar(id, 2, variante, AHORA)).toBe(false);
      expect((await fila(id)).variantStatus).toBe("processing");
      expect(await filasDeCache(id)).toHaveLength(1);
    });

    it("tras publicar, el siguiente envío sube la variante nueva en vez de reutilizar el id viejo", async () => {
      const id = await enCola({ sizeBytes: 5 * MB });
      // El original (5 MiB) ya se subió antes; la variante publicada pesa 9 MiB, pero aquí el caso difícil es el MISMO peso.
      await guardarId(id, "pn_1", "viejo", "video/mp4", 9 * MB);
      const ruta = store.rutaDeVariante(org, id);
      mkdirSync(path.dirname(ruta), { recursive: true });
      writeFileSync(ruta, Buffer.alloc(16, 0x62));
      await cola.publicar(id, 1, variante, AHORA);
      expect(await resolver(id)).toEqual({ waMediaId: "wa_1", reused: false });
      expect(subidas[0]).toMatchObject({ primero: 0x62 });
    });

    it("olvidarMediaIds (lo que usará el reencolado) borra solo los de ese medio y organización", async () => {
      const id = await video({}, {});
      const otro = await video({}, {});
      await guardarId(id, "pn_1", "a");
      await guardarId(otro, "pn_1", "b");
      await cola.olvidarMediaIds(db, "org_otra", id);
      expect(await filasDeCache(id)).toHaveLength(1);
      await cola.olvidarMediaIds(db, org, id);
      expect(await filasDeCache(id)).toHaveLength(0);
      expect(await filasDeCache(otro)).toHaveLength(1);
    });
  });
});
