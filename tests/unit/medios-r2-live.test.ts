import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";

/**
 * 048 contra PostgreSQL REAL (`pnpm test:db`) con un almacén de objetos EN MEMORIA (nada toca Cloudflare) y la subida a
 * Meta simulada: subida directa firmar → confirmar, rechazos, limpieza de huérfanos, borrado en cascada, y la caché del
 * `media_id` (reutilizar, vencer, otro número, concurrencia, invalidar). Crea y borra lo suyo.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
const DAY = 86_400_000;

type Mem = Map<string, { data: Buffer; contentType: string }>;

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
  };
}

describe.skipIf(!live)("Medios en R2 y caché del media_id contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let drizzle: typeof import("drizzle-orm");
  let medios: typeof import("@/server/medios/store");
  let cache: typeof import("@/server/whatsapp/media-cache");
  let storage: typeof import("@/server/storage");
  let org = "";
  let otherOrg = "";
  const mem: Mem = new Map();
  const ids: string[] = [];

  const creds = (phoneNumberId: string) =>
    ({ id: "c", organizationId: org, wabaId: "w", phoneNumberId, displayPhoneNumber: null, verifiedName: null, status: "connected", token: "t" }) as never;

  beforeAll(async () => {
    drizzle = await import("drizzle-orm");
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    medios = await import("@/server/medios/store");
    cache = await import("@/server/whatsapp/media-cache");
    storage = await import("@/server/storage");
    storage.__setObjectStoreForTests(memoryStore(mem, storage.StorageError) as never);
    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    org = orgs[0]!.id;
    otherOrg = orgs[1]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    storage?.__setObjectStoreForTests(null);
    if (ids.length) await db.delete(schema.mediaLibraryItem).where(drizzle.inArray(schema.mediaLibraryItem.id, ids));
    for (const id of ids) await rm(medios.rutaDeMedio(org, id), { force: true }).catch(() => {});
  });

  async function subirYConfirmar(data: Buffer, nombre: string, mime: string) {
    const f = await medios.prepararSubida({ organizationId: org, userId: "usr_t", nombre, mime, bytes: data.byteLength });
    ids.push(f.medio.id);
    // El «navegador» hace el PUT directo al bucket (aquí: a la memoria), con la clave que firmó el servidor.
    const fila = (await db.select().from(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.id, f.medio.id)))[0]!;
    mem.set(fila.storageKey!, { data, contentType: mime });
    return { f, fila };
  }

  describe("subida directa", () => {
    it("firmar deja la fila pending (no se lista ni se sirve); confirmar la deja ready en su clave definitiva", async () => {
      const { f, fila } = await subirYConfirmar(PNG, `foto-${Date.now()}.png`, "image/png");
      expect(fila).toMatchObject({ status: "pending", storage: "r2" });
      expect(fila.storageKey).toBe(`pending/${org}/${f.medio.id}`);
      expect((await medios.listarMedios(org)).some((m) => m.id === f.medio.id)).toBe(false);
      expect(await medios.medioPublico(f.medio.id)).toBeNull();

      const ok = await medios.confirmarSubida({ organizationId: org, userId: "usr_t", id: f.medio.id });
      expect(ok.medio).toMatchObject({ id: f.medio.id, tipo: "image", noEnviable: false });
      const [listo] = await db.select().from(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.id, f.medio.id));
      expect(listo).toMatchObject({ status: "ready", storageKey: `org/${org}/medios/${f.medio.id}` });
      expect(mem.has(`pending/${org}/${f.medio.id}`)).toBe(false);
      expect(mem.has(`org/${org}/medios/${f.medio.id}`)).toBe(true);
      // La galería trae una URL firmada de lectura (nunca la clave ni credenciales).
      const listado = (await medios.listarMedios(org)).find((m) => m.id === f.medio.id)!;
      expect(listado.urlFirmada).toMatch(/^https:\/\/r2\.test\//);
      // Idempotente.
      const otra = await medios.confirmarSubida({ organizationId: org, userId: "usr_t", id: f.medio.id });
      expect(otra.medio.id).toBe(f.medio.id);
    });

    it("un PDF es un documento enviable", async () => {
      const { f } = await subirYConfirmar(PDF, `ficha-${Date.now()}.pdf`, "application/pdf");
      const ok = await medios.confirmarSubida({ organizationId: org, userId: "usr_t", id: f.medio.id });
      expect(ok.medio).toMatchObject({ tipo: "document", noEnviable: false });
    });

    it("el servidor valida al firmar: video de más de 16 MB, formato raro y tipo equivocado", async () => {
      await expect(medios.prepararSubida({ organizationId: org, userId: "u", nombre: "v.mp4", mime: "video/mp4", bytes: 16 * 1024 * 1024 + 1 })).rejects.toMatchObject({ code: "too_large" });
      await expect(medios.prepararSubida({ organizationId: org, userId: "u", nombre: "x.exe", mime: "application/x-msdownload", bytes: 10 })).rejects.toMatchObject({ code: "unsupported_type" });
      await expect(medios.prepararSubida({ organizationId: org, userId: "u", nombre: "a.pdf", mime: "application/pdf", bytes: 10, soloTipo: "image" })).rejects.toMatchObject({ code: "unsupported_type" });
    });

    it("tamaño distinto al declarado → se rechaza y se borran fila y objeto", async () => {
      const { f, fila } = await subirYConfirmar(PNG, `corto-${Date.now()}.png`, "image/png");
      mem.set(fila.storageKey!, { data: Buffer.concat([PNG, Buffer.from("extra")]), contentType: "image/png" });
      await expect(medios.confirmarSubida({ organizationId: org, userId: "usr_t", id: f.medio.id })).rejects.toMatchObject({ code: "too_large" });
      expect(mem.has(fila.storageKey!)).toBe(false);
      expect(await db.select().from(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.id, f.medio.id))).toHaveLength(0);
    });

    it("el formato lo deciden los bytes: un .png que es otra cosa se rechaza", async () => {
      const falso = Buffer.alloc(PNG.byteLength, 0x41);
      const { f, fila } = await subirYConfirmar(falso, `falso-${Date.now()}.png`, "image/png");
      await expect(medios.confirmarSubida({ organizationId: org, userId: "usr_t", id: f.medio.id })).rejects.toMatchObject({ code: "unsupported_type" });
      expect(mem.has(fila.storageKey!)).toBe(false);
    });

    it("confirmar sin que el archivo haya llegado → not_found; solo quien lo firmó puede confirmar", async () => {
      const f = await medios.prepararSubida({ organizationId: org, userId: "usr_t", nombre: "nada.png", mime: "image/png", bytes: 100 });
      ids.push(f.medio.id);
      await expect(medios.confirmarSubida({ organizationId: org, userId: "usr_t", id: f.medio.id })).rejects.toMatchObject({ code: "not_found" });
      await expect(medios.confirmarSubida({ organizationId: org, userId: "otro", id: f.medio.id })).rejects.toMatchObject({ code: "not_found" });
      await expect(medios.confirmarSubida({ organizationId: otherOrg, userId: "usr_t", id: f.medio.id })).rejects.toMatchObject({ code: "not_found" });
    });

    it("el barredor borra lo firmado y nunca confirmado (más de 1 h) con su objeto", async () => {
      const f = await medios.prepararSubida({ organizationId: org, userId: "usr_t", nombre: "huerfano.png", mime: "image/png", bytes: PNG.byteLength });
      ids.push(f.medio.id);
      const fila = (await db.select().from(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.id, f.medio.id)))[0]!;
      mem.set(fila.storageKey!, { data: PNG, contentType: "image/png" });
      expect(await medios.limpiarSubidasPendientes(new Date())).toBeGreaterThanOrEqual(0);
      expect(mem.has(fila.storageKey!)).toBe(true); // aún reciente: no se toca
      await medios.limpiarSubidasPendientes(new Date(Date.now() + 2 * 3600_000));
      expect(mem.has(fila.storageKey!)).toBe(false);
      expect(await db.select().from(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.id, f.medio.id))).toHaveLength(0);
    });
  });

  describe("caché del media_id", () => {
    async function nuevoMedio() {
      const { f } = await subirYConfirmar(PNG, `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`, "image/png");
      await medios.confirmarSubida({ organizationId: org, userId: "usr_t", id: f.medio.id });
      return (await db.select().from(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.id, f.medio.id)))[0]!;
    }
    const uploader = () => {
      const calls: { phone: string; bytes: number }[] = [];
      const fn = async (c: { phoneNumberId: string }, file: { data: Buffer }) => {
        calls.push({ phone: c.phoneNumberId, bytes: file.data.byteLength });
        await new Promise((r) => setTimeout(r, 25));
        return `wa_${calls.length}_${c.phoneNumberId}`;
      };
      return { calls, fn: fn as never };
    };

    it("la primera vez sube UNA vez; las siguientes reutilizan sin tocar el archivo (0 bytes)", async () => {
      const item = await nuevoMedio();
      const up = uploader();
      const a = await cache.resolveWaMediaId(item, creds("pn_A"), { upload: up.fn });
      expect(a.reused).toBe(false);
      mem.delete(item.storageKey!); // si se intentara leer el archivo, fallaría: la caché no lo necesita
      const b = await cache.resolveWaMediaId(item, creds("pn_A"), { upload: up.fn });
      expect(b).toEqual({ waMediaId: a.waMediaId, reused: true });
      expect(up.calls).toHaveLength(1);
      const [fila] = await db.select().from(schema.whatsappMediaCache).where(drizzle.eq(schema.whatsappMediaCache.mediaItemId, item.id));
      expect(fila!.expiresAt.getTime() - fila!.uploadedAt.getTime()).toBe(25 * DAY);
    });

    it("50 envíos simultáneos del mismo medio suben UNA sola vez", async () => {
      const item = await nuevoMedio();
      const up = uploader();
      const r = await Promise.all(Array.from({ length: 50 }, () => cache.resolveWaMediaId(item, creds("pn_B"), { upload: up.fn })));
      expect(up.calls).toHaveLength(1);
      expect(new Set(r.map((x) => x.waMediaId)).size).toBe(1);
    });

    it("otro número sube de nuevo (un media_id es de UN número)", async () => {
      const item = await nuevoMedio();
      const up = uploader();
      const a = await cache.resolveWaMediaId(item, creds("pn_C"), { upload: up.fn });
      const b = await cache.resolveWaMediaId(item, creds("pn_D"), { upload: up.fn });
      expect(a.waMediaId).not.toBe(b.waMediaId);
      expect(up.calls.map((c) => c.phone)).toEqual(["pn_C", "pn_D"]);
    });

    it("vencida (a los 25 días) → sube de nuevo y reemplaza la fila (una sola por par)", async () => {
      const item = await nuevoMedio();
      const up = uploader();
      const t0 = new Date();
      await cache.resolveWaMediaId(item, creds("pn_E"), { upload: up.fn, now: () => t0 });
      const casiVence = await cache.resolveWaMediaId(item, creds("pn_E"), { upload: up.fn, now: () => new Date(t0.getTime() + 24 * DAY) });
      expect(casiVence.reused).toBe(true);
      const vencida = await cache.resolveWaMediaId(item, creds("pn_E"), { upload: up.fn, now: () => new Date(t0.getTime() + 25 * DAY + 1000) });
      expect(vencida.reused).toBe(false);
      expect(up.calls).toHaveLength(2);
      expect(await db.select().from(schema.whatsappMediaCache).where(drizzle.eq(schema.whatsappMediaCache.mediaItemId, item.id))).toHaveLength(1);
    });

    it("invalidar (Meta rechazó el id) y forceRefresh vuelven a subir", async () => {
      const item = await nuevoMedio();
      const up = uploader();
      await cache.resolveWaMediaId(item, creds("pn_F"), { upload: up.fn });
      await cache.invalidateWaMediaId(item, "pn_F");
      expect((await cache.resolveWaMediaId(item, creds("pn_F"), { upload: up.fn })).reused).toBe(false);
      expect((await cache.resolveWaMediaId(item, creds("pn_F"), { upload: up.fn, forceRefresh: true })).reused).toBe(false);
      expect(up.calls).toHaveLength(3);
    });

    it("si el archivo ya no está y no hay caché, falla claro (no sube nada)", async () => {
      const item = await nuevoMedio();
      mem.delete(item.storageKey!);
      const up = uploader();
      await expect(cache.resolveWaMediaId(item, creds("pn_G"), { upload: up.fn })).rejects.toBeInstanceOf(cache.MediaArchivoAusente);
      expect(up.calls).toHaveLength(0);
    });

    it("borrar el medio borra su objeto Y su caché (cascada)", async () => {
      const item = await nuevoMedio();
      const up = uploader();
      await cache.resolveWaMediaId(item, creds("pn_H"), { upload: up.fn });
      await medios.borrarMedio({ organizationId: org, userId: "usr_t", puedeAdministrar: true, id: item.id });
      expect(mem.has(item.storageKey!)).toBe(false);
      expect(await db.select().from(schema.whatsappMediaCache).where(drizzle.eq(schema.whatsappMediaCache.mediaItemId, item.id))).toHaveLength(0);
    });

    it("la poda quita lo vencido hace más de un día", async () => {
      const item = await nuevoMedio();
      const up = uploader();
      const t0 = new Date();
      await cache.resolveWaMediaId(item, creds("pn_I"), { upload: up.fn, now: () => t0 });
      await cache.pruneWaMediaCache(new Date(t0.getTime() + 26 * DAY + 3600_000));
      expect(await db.select().from(schema.whatsappMediaCache).where(drizzle.eq(schema.whatsappMediaCache.mediaItemId, item.id))).toHaveLength(0);
    });
  });

  describe("convivencia con lo anterior (disco)", () => {
    it("un medio local sigue sirviéndose del disco y también usa la caché", async () => {
      storage.__setObjectStoreForTests(null); // R2 apagado: crearMedio escribe en MEDIA_DIR
      const m = await medios.crearMedio({ organizationId: org, userId: "usr_t", data: PNG, nombre: `local-${Date.now()}.png`, source: "upload" });
      ids.push(m.id);
      storage.__setObjectStoreForTests(memoryStore(mem, storage.StorageError) as never); // R2 encendido otra vez: lo local sigue legible
      const fila = (await db.select().from(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.id, m.id)))[0]!;
      expect(fila).toMatchObject({ storage: "local", status: "ready", storageKey: null });
      let subidas = 0;
      const fn = (async () => `wa_local_${++subidas}`) as never;
      await cache.resolveWaMediaId(fila, creds("pn_L"), { upload: fn });
      await cache.resolveWaMediaId(fila, creds("pn_L"), { upload: fn });
      expect(subidas).toBe(1);
    });
  });
});
