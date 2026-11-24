import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Medios — video optimizado para WhatsApp, Paso 1, contra PostgreSQL REAL (`pnpm test:db`): la migración y sus CHECK, que la
 * limpieza de subidas sin confirmar no vea una variante, la subida en flujo a disco (sin pasar por la memoria, sin temporales
 * huérfanos), la confirmación de una subida directa a R2 (sin leer un video grande entero) y que el envío siga exigiendo ≤ 16 MB.
 * Crea y borra lo suyo; el volumen es una carpeta temporal y R2 es un almacén en memoria.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

// El volumen de la prueba (antes de que nada lea el entorno): nunca el de desarrollo.
const VOLUMEN = live ? mkdtempSync(path.join(tmpdir(), "medios-wa-")) : "";
if (live) process.env.MEDIA_DIR = VOLUMEN;

const MB = 1024 * 1024;
const FTYP = (marca: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from(`ftyp${marca}`, "latin1"), Buffer.alloc(20, 0x78)]);
const MP4 = FTYP("isom");
const MOV = FTYP("qt  ");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** Un video falso de `total` bytes: la cabecera y relleno, entregado en trozos de 1 MB (nunca entero en memoria). */
function flujo(cabeza: Buffer, total: number): ReadableStream<Uint8Array> {
  let enviado = 0;
  const trozo = Buffer.alloc(MB, 0x61);
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (enviado === 0) {
        c.enqueue(cabeza);
        enviado = cabeza.byteLength;
        return;
      }
      if (enviado >= total) return c.close();
      const n = Math.min(MB, total - enviado);
      c.enqueue(n === MB ? trozo : trozo.subarray(0, n));
      enviado += n;
    },
  });
}

/** Un archivo grande para la subida directa: cabecera + relleno (solo las pruebas que lo necesitan). */
const archivo = (cabeza: Buffer, total: number) => Buffer.concat([cabeza, Buffer.alloc(Math.max(0, total - cabeza.byteLength), 0x61)]);

type Mem = Map<string, { data: Buffer; contentType: string }>;

function memoryStore(mem: Mem, contador: { readAll: number; readRange: number }, StorageError: typeof import("@/server/storage").StorageError) {
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
      contador.readRange++;
      const o = mem.get(key);
      if (!o) throw faltan();
      return o.data.subarray(from, to + 1);
    },
    async readAll(key: string) {
      contador.readAll++;
      const o = mem.get(key);
      if (!o) throw faltan();
      return o.data;
    },
    async put(key: string, body: Buffer | Uint8Array, contentType: string) {
      mem.set(key, { data: Buffer.from(body), contentType });
    },
    async copy(from: string, to: string) {
      const o = mem.get(from);
      if (!o) throw faltan();
      mem.set(to, o);
    },
    async delete(key: string) {
      mem.delete(key);
    },
    async list() {
      return { objects: [], next: null };
    },
  };
}

describe.skipIf(!live)("video optimizado para WhatsApp (Paso 1) contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let drizzle: typeof import("drizzle-orm");
  let medios: typeof import("@/server/medios/store");
  let storage: typeof import("@/server/storage");
  let automationMedia: typeof import("@/server/automation/media");
  let org = "";
  const ids: string[] = [];
  const mem: Mem = new Map();
  const contador = { readAll: 0, readRange: 0 };
  const flagInicial = process.env.MEDIA_VIDEO_OPTIMIZE;

  const flag = (on: boolean) => {
    if (on) process.env.MEDIA_VIDEO_OPTIMIZE = "on";
    else delete process.env.MEDIA_VIDEO_OPTIMIZE;
  };
  const fila = async (id: string) => (await db.select().from(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.id, id)))[0];
  /** El mensaje de Postgres detrás de un error de Drizzle (el nombre del CHECK que saltó). */
  const motivo = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "ok";
    } catch (e) {
      const c = e as { cause?: { message?: string; constraint_name?: string }; message?: string };
      return `${c.cause?.constraint_name ?? ""} ${c.cause?.message ?? c.message ?? ""}`;
    }
  };
  const insertar = async (extra: Partial<typeof import("@/lib/db").schema.mediaLibraryItem.$inferInsert> = {}) => {
    const id = `med_v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 24);
    ids.push(id);
    await db.insert(schema.mediaLibraryItem).values({
      id,
      organizationId: org,
      name: "prueba",
      kind: "video",
      mimeType: "video/mp4",
      sizeBytes: 1000,
      source: "upload",
      ...extra,
    });
    return id;
  };

  beforeAll(async () => {
    drizzle = await import("drizzle-orm");
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    medios = await import("@/server/medios/store");
    storage = await import("@/server/storage");
    automationMedia = await import("@/server/automation/media");
    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    org = orgs[0]!.id;
  });

  afterAll(async () => {
    if (flagInicial === undefined) delete process.env.MEDIA_VIDEO_OPTIMIZE;
    else process.env.MEDIA_VIDEO_OPTIMIZE = flagInicial;
    if (!db) return;
    storage?.__setObjectStoreForTests(null);
    if (ids.length) await db.delete(schema.mediaLibraryItem).where(drizzle.inArray(schema.mediaLibraryItem.id, ids));
    await rm(VOLUMEN, { recursive: true, force: true }).catch(() => {});
  });

  describe("la migración y sus restricciones", () => {
    it("las columnas existen y un medio nuevo nace sin variante", async () => {
      const cols = await db.execute(
        drizzle.sql`select column_name from information_schema.columns where table_name = 'media_library_item' and column_name in ('duration_ms','width','height','variant_status','variant_error','variant_storage_key','variant_size_bytes','variant_mime_type','variant_width','variant_height','variant_processed_at')`
      );
      expect(cols.length).toBe(11);
      const id = await insertar();
      expect(await fila(id)).toMatchObject({
        variantStatus: "none",
        variantError: null,
        variantStorageKey: null,
        variantSizeBytes: null,
        variantMimeType: null,
        durationMs: null,
        width: null,
        height: null,
        status: "ready",
      });
    });

    it("el índice parcial de «en proceso» existe", async () => {
      const r = await db.execute(drizzle.sql`select indexdef from pg_indexes where indexname = 'media_library_item_variant_processing_idx'`);
      expect(r.length).toBe(1);
      expect(String(r[0]!.indexdef)).toContain("processing");
    });

    it("admite una variante en proceso, fallida y lista con sus datos", async () => {
      expect(await motivo(insertar({ variantStatus: "processing" }))).toBe("ok");
      expect(await motivo(insertar({ variantStatus: "failed", variantError: "ffmpeg falló" }))).toBe("ok");
      expect(
        await motivo(
          insertar({ variantStatus: "ready", variantStorageKey: "org/o/medios-wa/x", variantSizeBytes: 16 * MB, variantMimeType: "video/mp4", variantWidth: 720, variantHeight: 404, variantProcessedAt: new Date() })
        )
      ).toBe("ok");
    });

    it("rechaza un estado de variante inventado", async () => {
      expect(await motivo(insertar({ variantStatus: "casi" as never }))).toContain("media_library_item_variant_status_ck");
    });

    it("rechaza una variante de más de 16 MB, o de 0 bytes", async () => {
      expect(await motivo(insertar({ variantStatus: "processing", variantSizeBytes: 16 * MB + 1 }))).toContain("media_library_item_variant_size_ck");
      expect(await motivo(insertar({ variantStatus: "processing", variantSizeBytes: 0 }))).toContain("media_library_item_variant_size_ck");
    });

    it("una variante `ready` exige clave, peso y MIME", async () => {
      const completa = { variantStatus: "ready" as const, variantStorageKey: "k", variantSizeBytes: 1000, variantMimeType: "video/mp4" };
      expect(await motivo(insertar({ ...completa, variantStorageKey: null }))).toContain("media_library_item_variant_ready_ck");
      expect(await motivo(insertar({ ...completa, variantSizeBytes: null }))).toContain("media_library_item_variant_ready_ck");
      expect(await motivo(insertar({ ...completa, variantMimeType: null }))).toContain("media_library_item_variant_ready_ck");
    });

    it("solo un medio confirmado (`ready`) puede tener variante", async () => {
      expect(await motivo(insertar({ status: "pending", variantStatus: "processing" }))).toContain("media_library_item_variant_needs_ready_ck");
      expect(await motivo(insertar({ status: "pending", variantStatus: "none" }))).toBe("ok");
    });
  });

  describe("la limpieza de subidas sin confirmar", () => {
    it("borra la subida `pending` vieja y NO toca un medio `ready`, aunque tenga una variante en proceso", async () => {
      const vieja = new Date(Date.now() - 3 * 3600_000);
      const pendiente = await insertar({ status: "pending", createdAt: vieja });
      const conVariante = await insertar({ status: "ready", variantStatus: "processing", createdAt: vieja });
      const listo = await insertar({ status: "ready", createdAt: vieja });
      await medios.limpiarSubidasPendientes(new Date());
      expect(await fila(pendiente)).toBeUndefined();
      expect(await fila(conVariante)).toMatchObject({ status: "ready", variantStatus: "processing" });
      expect(await fila(listo)).toBeDefined();
    });
  });

  describe("subida en flujo a disco (bandera encendida, sin R2)", () => {
    const sinTemporales = async () => {
      const carpeta = path.join(VOLUMEN, org, "medios-tmp");
      return (await readdir(carpeta).catch(() => [])).length;
    };

    beforeAll(() => {
      storage.__setObjectStoreForTests(null);
    });

    it("un MP4 de varios MB se guarda con su peso exacto, en su sitio, y no queda temporal", async () => {
      flag(true);
      const total = 40 * MB;
      const dto = await medios.crearMedioDesdeFlujo({ organizationId: org, userId: "usr_t", flujo: flujo(MP4, total), nombre: "promo.mp4" });
      ids.push(dto.id);
      expect(dto).toMatchObject({ tipo: "video", mime: "video/mp4", bytes: total, noEnviable: true, varianteEstado: "none" });
      expect((await stat(medios.rutaDeMedio(org, dto.id))).size).toBe(total);
      expect(await fila(dto.id)).toMatchObject({ storage: "local", storageKey: null, status: "ready", sizeBytes: total });
      expect(await sinTemporales()).toBe(0);
    });

    it("un MOV (QuickTime) se acepta y se guarda con su MIME real", async () => {
      flag(true);
      const dto = await medios.crearMedioDesdeFlujo({ organizationId: org, userId: "usr_t", flujo: flujo(MOV, 20 * MB), nombre: "iphone.mov" });
      ids.push(dto.id);
      expect(dto).toMatchObject({ mime: "video/quicktime", tipo: "video", noEnviable: true });
      expect((await fila(dto.id))?.mimeType).toBe("video/quicktime");
    });

    it("un MP4 llamado .mov se guarda como MP4 (deciden los bytes)", async () => {
      flag(true);
      const dto = await medios.crearMedioDesdeFlujo({ organizationId: org, userId: "usr_t", flujo: flujo(MP4, 2 * MB), nombre: "raro.mov" });
      ids.push(dto.id);
      expect(dto.mime).toBe("video/mp4");
    });

    it("pasarse de 250 MB corta la subida, no deja fila ni archivo ni temporal", async () => {
      flag(true);
      const antes = (await db.select().from(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.organizationId, org))).length;
      await expect(
        medios.crearMedioDesdeFlujo({ organizationId: org, userId: "usr_t", flujo: flujo(MP4, 251 * MB), nombre: "enorme.mp4" })
      ).rejects.toMatchObject({ code: "too_large" });
      const despues = (await db.select().from(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.organizationId, org))).length;
      expect(despues).toBe(antes);
      expect(await sinTemporales()).toBe(0);
    }, 60_000);

    it("bytes que no son un video admitido se rechazan sin escribir nada", async () => {
      flag(true);
      await expect(
        medios.crearMedioDesdeFlujo({ organizationId: org, userId: "usr_t", flujo: flujo(Buffer.from("<!DOCTYPE html><html></html>padding-padding"), 3 * MB), nombre: "falso.mp4" })
      ).rejects.toMatchObject({ code: "unsupported_type" });
      expect(await sinTemporales()).toBe(0);
    });

    it("una imagen sigue con su tope (3 MB) aunque la bandera esté encendida", async () => {
      flag(true);
      await expect(
        medios.crearMedioDesdeFlujo({ organizationId: org, userId: "usr_t", flujo: flujo(PNG, 4 * MB), nombre: "grande.png" })
      ).rejects.toMatchObject({ code: "too_large" });
    });

    it("solo-imagen: un video por esta vía se rechaza y no deja temporal", async () => {
      flag(true);
      await expect(
        medios.crearMedioDesdeFlujo({ organizationId: org, userId: "usr_t", flujo: flujo(MP4, 2 * MB), nombre: "v.mp4", soloTipo: "image" })
      ).rejects.toMatchObject({ code: "unsupported_type" });
      expect(await sinTemporales()).toBe(0);
    });

    it("con la bandera APAGADA todo sigue como antes: 17 MB es demasiado y un MOV no se admite", async () => {
      flag(false);
      await expect(
        medios.crearMedioDesdeFlujo({ organizationId: org, userId: "usr_t", flujo: flujo(MP4, 17 * MB), nombre: "v.mp4" })
      ).rejects.toMatchObject({ code: "too_large" });
      await expect(
        medios.crearMedioDesdeFlujo({ organizationId: org, userId: "usr_t", flujo: flujo(MOV, 2 * MB), nombre: "v.mov" })
      ).rejects.toMatchObject({ code: "unsupported_type" });
      const ok = await medios.crearMedioDesdeFlujo({ organizationId: org, userId: "usr_t", flujo: flujo(MP4, 3 * MB), nombre: "chico.mp4" });
      ids.push(ok.id);
      expect(ok).toMatchObject({ bytes: 3 * MB, noEnviable: false });
      expect(await sinTemporales()).toBe(0);
    });

    it("con R2 encendido, un video de más de 16 MB por esta vía se rechaza con el camino a seguir (subida directa)", async () => {
      flag(true);
      storage.__setObjectStoreForTests(memoryStore(new Map(), { readAll: 0, readRange: 0 }, storage.StorageError) as never);
      try {
        await expect(
          medios.crearMedioDesdeFlujo({ organizationId: org, userId: "usr_t", flujo: flujo(MP4, 20 * MB), nombre: "v.mp4" })
        ).rejects.toMatchObject({ code: "too_large", message: expect.stringContaining("subida directa") });
      } finally {
        storage.__setObjectStoreForTests(null);
      }
    });
  });

  describe("subida directa a R2: confirmar sin leer un video grande entero", () => {
    beforeAll(() => {
      storage.__setObjectStoreForTests(memoryStore(mem, contador, storage.StorageError) as never);
    });
    afterAll(() => {
      storage.__setObjectStoreForTests(null);
    });

    async function subir(data: Buffer, nombre: string, mime: string) {
      const f = await medios.prepararSubida({ organizationId: org, userId: "usr_t", nombre, mime, bytes: data.byteLength });
      ids.push(f.medio.id);
      const row = (await fila(f.medio.id))!;
      mem.set(row.storageKey!, { data, contentType: mime });
      return { f, row };
    }

    it("un MP4 de 30 MB se confirma leyendo solo la cabecera (nunca `readAll`) y queda sin variante", async () => {
      flag(true);
      const { f } = await subir(archivo(MP4, 30 * MB), "grande.mp4", "video/mp4");
      contador.readAll = 0;
      contador.readRange = 0;
      const ok = await medios.confirmarSubida({ organizationId: org, userId: "usr_t", id: f.medio.id });
      expect(contador.readAll).toBe(0);
      expect(contador.readRange).toBeGreaterThan(0);
      expect(ok.aviso).toBeNull();
      expect(ok.medio).toMatchObject({ bytes: 30 * MB, noEnviable: true, varianteEstado: "none" });
      expect(await fila(f.medio.id)).toMatchObject({ status: "ready", storageKey: `org/${org}/medios/${f.medio.id}` });
    });

    it("un MOV se confirma con su MIME; si el navegador lo declaró como MP4, se guarda el MIME REAL", async () => {
      flag(true);
      const a = await subir(archivo(MOV, 20 * MB), "a.mov", "video/quicktime");
      expect((await medios.confirmarSubida({ organizationId: org, userId: "usr_t", id: a.f.medio.id })).medio.mime).toBe("video/quicktime");
      const b = await subir(archivo(MOV, 20 * MB), "b.mov", "video/mp4");
      const ok = await medios.confirmarSubida({ organizationId: org, userId: "usr_t", id: b.f.medio.id });
      expect(ok.medio.mime).toBe("video/quicktime");
      expect((await fila(b.f.medio.id))?.mimeType).toBe("video/quicktime");
    });

    it("el tamaño real distinto del declarado se rechaza (con `head()`) y se borran fila y objeto", async () => {
      flag(true);
      const { f, row } = await subir(archivo(MP4, 20 * MB), "corto.mp4", "video/mp4");
      mem.set(row.storageKey!, { data: archivo(MP4, 20 * MB + 5), contentType: "video/mp4" });
      await expect(medios.confirmarSubida({ organizationId: org, userId: "usr_t", id: f.medio.id })).rejects.toMatchObject({ code: "too_large" });
      expect(mem.has(row.storageKey!)).toBe(false);
      expect(await fila(f.medio.id)).toBeUndefined();
    });

    it("bytes que no son video se rechazan aunque se llamen .mp4, y se limpian", async () => {
      flag(true);
      const falso = Buffer.alloc(20 * MB, 0x41);
      const { f, row } = await subir(falso, "falso.mp4", "video/mp4");
      await expect(medios.confirmarSubida({ organizationId: org, userId: "usr_t", id: f.medio.id })).rejects.toMatchObject({ code: "unsupported_type" });
      expect(mem.has(row.storageKey!)).toBe(false);
    });

    it("un video que dice ser otra cosa (un PNG declarado video) no se acepta", async () => {
      flag(true);
      const { f } = await subir(Buffer.concat([PNG, Buffer.alloc(100)]), "x.mp4", "video/mp4");
      await expect(medios.confirmarSubida({ organizationId: org, userId: "usr_t", id: f.medio.id })).rejects.toMatchObject({ code: "unsupported_type" });
    });

    it("el servidor valida al firmar con los límites vigentes: 250 MB sí, 251 MB no, MOV solo con la bandera", async () => {
      flag(true);
      const grande = await medios.prepararSubida({ organizationId: org, userId: "u", nombre: "v.mp4", mime: "video/mp4", bytes: 250 * MB });
      ids.push(grande.medio.id);
      await expect(medios.prepararSubida({ organizationId: org, userId: "u", nombre: "v.mp4", mime: "video/mp4", bytes: 250 * MB + 1 })).rejects.toMatchObject({ code: "too_large" });
      flag(false);
      await expect(medios.prepararSubida({ organizationId: org, userId: "u", nombre: "v.mp4", mime: "video/mp4", bytes: 16 * MB + 1 })).rejects.toMatchObject({ code: "too_large" });
      await expect(medios.prepararSubida({ organizationId: org, userId: "u", nombre: "v.mov", mime: "video/quicktime", bytes: 1 * MB })).rejects.toMatchObject({ code: "unsupported_type" });
    });

    it("con la bandera apagada, un MP4 de hasta 16 MB se sigue leyendo entero y avisa si no parece H.264", async () => {
      flag(false);
      const { f } = await subir(archivo(MP4, 2 * MB), "chico.mp4", "video/mp4");
      contador.readAll = 0;
      const ok = await medios.confirmarSubida({ organizationId: org, userId: "usr_t", id: f.medio.id });
      expect(contador.readAll).toBe(1);
      expect(ok.aviso).toContain("H.264");
    });
  });

  describe("el envío por WhatsApp sigue exigiendo ≤ 16 MB", () => {
    it("un video original de más de 16 MB da `too_large`; un MOV, `unsupported`; un MP4 de 5 MB con archivo, ok; con variante lista sin su archivo, `file_missing`", async () => {
      const grande = await insertar({ sizeBytes: 20 * MB });
      expect(await automationMedia.loadMediaFile(org, grande)).toEqual({ ok: false, reason: "too_large" });

      const mov = await insertar({ mimeType: "video/quicktime", sizeBytes: 2 * MB });
      expect(await automationMedia.loadMediaFile(org, mov)).toEqual({ ok: false, reason: "unsupported" });

      // Desde el Paso 3a, con la variante lista el envío la USA (su peso y MIME); si falta su archivo en `medios-wa`, no se
      // manda el original grande ni se sube a ciegas: `file_missing`. El caso feliz está en `medios-envio-live.test.ts`.
      const conVariante = await insertar({
        sizeBytes: 20 * MB,
        variantStatus: "ready",
        variantStorageKey: "k",
        variantSizeBytes: 9 * MB,
        variantMimeType: "video/mp4",
      });
      expect(await automationMedia.loadMediaFile(org, conVariante)).toEqual({ ok: false, reason: "file_missing" });
    });
  });
});
