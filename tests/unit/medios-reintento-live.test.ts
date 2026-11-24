import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Medios — Paso 3b contra PostgreSQL REAL (`pnpm test:db`): el reintento manual (`POST /api/medios/[id]/optimizar`: permisos,
 * transiciones, idempotencia, caché del `media_id`, despertar al trabajador y errores 401/403/404/409/410) y las rutas que
 * sirven la variante (`?version=whatsapp` con `Range`, y el adjunto de un mensaje enviado). Sesión simulada; volumen temporal.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const VOLUMEN = live ? mkdtempSync(path.join(tmpdir(), "medios-reintento-")) : "";
if (live) process.env.MEDIA_DIR = VOLUMEN;

const sesion = vi.hoisted(() => ({ actual: null as null | { userId: string; organizationId: string; role: string } }));
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...original,
    requireSession: async () => {
      if (!sesion.actual) throw new original.UnauthorizedError();
      return sesion.actual;
    },
  };
});

const MB = 1024 * 1024;

describe.skipIf(!live)("reintento de optimización y variante servida (Paso 3b) contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let drizzle: typeof import("drizzle-orm");
  let store: typeof import("@/server/medios/store");
  let flag: typeof import("@/server/medios/flag");
  let despertar: typeof import("@/server/medios/optimizar/despertar");
  let rutaOptimizar: typeof import("@/app/api/medios/[id]/optimizar/route");
  let rutaArchivo: typeof import("@/app/api/medios/[id]/archivo/route");
  let rutaAdjunto: typeof import("@/app/api/media/[assetId]/route");
  const org = `org_reint_${Date.now().toString(36)}`;
  const otraOrg = `org_reintb_${Date.now().toString(36)}`;
  const ids: string[] = [];
  const assets: string[] = [];
  const despertares = { n: 0 };
  const flagInicial = process.env.MEDIA_VIDEO_OPTIMIZE;

  const admin = { userId: "usr_admin", organizationId: org, role: "owner" };
  const creador = { userId: "usr_creador", organizationId: org, role: "member" };
  const ajeno = { userId: "usr_ajeno", organizationId: org, role: "member" };

  const fila = async (id: string) => (await db.select().from(schema.mediaLibraryItem).where(drizzle.eq(schema.mediaLibraryItem.id, id)))[0]!;
  const nuevoId = () => `med_${randomBytes(10).toString("hex")}`;
  const post = (id: string) => rutaOptimizar.POST(new Request("http://x/api/medios/" + id + "/optimizar", { method: "POST" }), { params: Promise.resolve({ id }) });

  async function video(extra: Partial<typeof import("@/lib/db").schema.mediaLibraryItem.$inferInsert> = {}, opts: { original?: number; sinArchivo?: boolean; variante?: Buffer } = {}) {
    const id = nuevoId();
    ids.push(id);
    const original = opts.original ?? 40 * MB;
    await db.insert(schema.mediaLibraryItem).values({
      id,
      organizationId: org,
      createdBy: creador.userId,
      name: "promo",
      kind: "video",
      mimeType: "video/mp4",
      sizeBytes: original,
      source: "upload",
      ...extra,
    });
    if (!opts.sinArchivo) {
      const ruta = store.rutaDeMedio(org, id);
      mkdirSync(path.dirname(ruta), { recursive: true });
      writeFileSync(ruta, Buffer.alloc(64, 0x61));
    }
    if (opts.variante) {
      const ruta = store.rutaDeVariante(org, id);
      mkdirSync(path.dirname(ruta), { recursive: true });
      writeFileSync(ruta, opts.variante);
    }
    return id;
  }

  const fallido = (e: Partial<typeof import("@/lib/db").schema.mediaLibraryItem.$inferInsert> = {}) => ({
    variantStatus: "failed" as const,
    variantError: "El video dura más de 3 minutos",
    variantAttempts: 3,
    variantProcessedAt: new Date("2026-06-01T00:00:00Z"),
    ...e,
  });

  beforeAll(async () => {
    drizzle = await import("drizzle-orm");
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    store = await import("@/server/medios/store");
    flag = await import("@/server/medios/flag");
    despertar = await import("@/server/medios/optimizar/despertar");
    rutaOptimizar = await import("@/app/api/medios/[id]/optimizar/route");
    rutaArchivo = await import("@/app/api/medios/[id]/archivo/route");
    rutaAdjunto = await import("@/app/api/media/[assetId]/route");
    await db.insert(schema.organization).values([
      { id: org, name: "Reintento 3b" },
      { id: otraOrg, name: "Otra 3b" },
    ]);
  });

  beforeEach(() => {
    sesion.actual = admin;
    despertares.n = 0;
    despertar.registrarDespertar(() => void despertares.n++);
    process.env.MEDIA_VIDEO_OPTIMIZE = "on";
    flag.fijarEstadoFfmpeg({ ok: true });
  });

  afterEach(() => {
    despertar.registrarDespertar(null);
    flag.fijarEstadoFfmpeg(null);
    if (flagInicial === undefined) delete process.env.MEDIA_VIDEO_OPTIMIZE;
    else process.env.MEDIA_VIDEO_OPTIMIZE = flagInicial;
  });

  afterAll(async () => {
    if (!db) return;
    if (assets.length) await db.delete(schema.mediaAsset).where(drizzle.inArray(schema.mediaAsset.id, assets));
    if (ids.length) {
      await db.delete(schema.whatsappMediaCache).where(drizzle.inArray(schema.whatsappMediaCache.mediaItemId, ids));
      await db.delete(schema.mediaLibraryItem).where(drizzle.inArray(schema.mediaLibraryItem.id, ids));
    }
    await db.delete(schema.organization).where(drizzle.inArray(schema.organization.id, [org, otraOrg]));
    await rm(VOLUMEN, { recursive: true, force: true }).catch(() => {});
  });

  /* ---------- El endpoint ---------- */

  describe("POST /api/medios/[id]/optimizar", () => {
    it("desde failed: reencola con el estado exacto, olvida los media_id, despierta al trabajador y devuelve el medio", async () => {
      const id = await video(fallido());
      await db.insert(schema.whatsappMediaCache).values({ id: `wmc_${randomBytes(8).toString("hex")}`, organizationId: org, mediaItemId: id, phoneNumberId: "pn_1", waMediaId: "viejo", mimeType: "video/mp4", sizeBytes: 9 * MB, uploadedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) });
      const antes = Date.now();
      const r = await post(id);
      expect(r.status).toBe(200);
      const { medio } = await r.json();
      expect(medio).toMatchObject({ id, varianteEstado: "processing", envio: "optimizando", noEnviable: false, varianteError: null });
      const f = await fila(id);
      expect(f).toMatchObject({ variantStatus: "processing", variantAttempts: 0, variantLeaseUntil: null, variantError: null, variantProcessedAt: null });
      expect(f.variantNextAttemptAt!.getTime()).toBeGreaterThanOrEqual(antes - 2000);
      expect(f.variantNextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now() + 2000);
      expect(await db.select().from(schema.whatsappMediaCache).where(drizzle.eq(schema.whatsappMediaCache.mediaItemId, id))).toHaveLength(0);
      expect(despertares.n).toBe(1);
    });

    it("desde none con un original que no se puede enviar (grande o MOV): reencola", async () => {
      const grande = await video({}, { original: 60 * MB });
      expect((await post(grande)).status).toBe(200);
      expect((await fila(grande)).variantStatus).toBe("processing");
      const mov = await video({ mimeType: "video/quicktime" }, { original: 3 * MB });
      expect((await post(mov)).status).toBe(200);
      expect((await fila(mov)).variantStatus).toBe("processing");
    });

    it("idempotente: si ya está en processing responde 200 sin reiniciar nada ni despertar", async () => {
      const id = await video({ variantStatus: "processing", variantAttempts: 2, variantNextAttemptAt: new Date("2026-06-01T00:00:00Z") });
      const r = await post(id);
      expect(r.status).toBe(200);
      expect((await r.json()).medio).toMatchObject({ varianteEstado: "processing" });
      expect(await fila(id)).toMatchObject({ variantAttempts: 2 });
      expect((await fila(id)).variantNextAttemptAt!.toISOString()).toBe("2026-06-01T00:00:00.000Z");
      expect(despertares.n).toBe(0);
    });

    it("doble clic simultáneo: las dos respuestas son 200 y la transición ocurre UNA vez", async () => {
      const id = await video(fallido());
      const [a, b] = await Promise.all([post(id), post(id)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect((await fila(id)).variantStatus).toBe("processing");
      expect(despertares.n).toBe(1);
    });

    it("409 si ya está lista, si el original ya se envía tal cual, o si no es un video", async () => {
      const lista = await video({ variantStatus: "ready", variantStorageKey: "k", variantSizeBytes: 9 * MB, variantMimeType: "video/mp4" });
      const ligero = await video({}, { original: 5 * MB });
      const imagen = await video({ kind: "image", mimeType: "image/png", sizeBytes: MB }, {});
      for (const id of [lista, ligero, imagen]) {
        const r = await post(id);
        expect(r.status, id).toBe(409);
        expect((await r.json()).error.code).toBe("conflict");
      }
      expect((await fila(lista)).variantStatus).toBe("ready");
      expect(despertares.n).toBe(0);
    });

    it("409 con la cola de optimización inactiva (sin bandera o sin ffmpeg), sin tocar el estado", async () => {
      const id = await video(fallido());
      flag.fijarEstadoFfmpeg({ ok: false, motivo: "sin ffmpeg" });
      const r = await post(id);
      expect(r.status).toBe(409);
      expect((await r.json()).error.message).toMatch(/no está disponible/);
      expect((await fila(id)).variantStatus).toBe("failed");
      delete process.env.MEDIA_VIDEO_OPTIMIZE;
      flag.fijarEstadoFfmpeg({ ok: true });
      expect((await post(id)).status).toBe(409);
    });

    it("410 si falta el archivo original, y el estado queda como estaba", async () => {
      const id = await video(fallido(), { sinArchivo: true });
      const r = await post(id);
      expect(r.status).toBe(410);
      expect((await fila(id)).variantStatus).toBe("failed");
      expect(despertares.n).toBe(0);
    });

    it("401 sin sesión; 404 de otra organización, inexistente o con un id mal formado", async () => {
      const id = await video(fallido());
      sesion.actual = null;
      expect((await post(id)).status).toBe(401);
      sesion.actual = { userId: "u", organizationId: otraOrg, role: "owner" };
      expect((await post(id)).status).toBe(404);
      sesion.actual = admin;
      expect((await post("med_noexiste0000000000000")).status).toBe(404);
      expect((await post("raro")).status).toBe(404);
      expect((await fila(id)).variantStatus).toBe("failed");
    });

    it("403 para quien no lo subió y no administra; sí puede quien lo subió, el dueño o un administrador", async () => {
      const id = await video(fallido());
      sesion.actual = ajeno;
      const r = await post(id);
      expect(r.status).toBe(403);
      expect((await fila(id)).variantStatus).toBe("failed");
      sesion.actual = creador;
      expect((await post(id)).status).toBe(200);
      const otro = await video(fallido());
      sesion.actual = { ...ajeno, role: "admin" };
      expect((await post(otro)).status).toBe(200);
    });
  });

  /* ---------- Servir la variante ---------- */

  describe("?version=whatsapp en la ruta del archivo", () => {
    const get = (id: string, query: string, headers: Record<string, string> = {}) =>
      rutaArchivo.GET(new Request(`http://x/api/medios/${id}/archivo${query}`, { headers }), { params: Promise.resolve({ id }) });
    const VARIANTE = Buffer.from("0123456789abcdefghij");
    const lista = { variantStatus: "ready" as const, variantStorageKey: "k", variantSizeBytes: VARIANTE.length, variantMimeType: "video/webm" };

    it("sirve la variante con su MIME y soporta Range; el original sigue intacto sin el parámetro y en la descarga", async () => {
      const id = await video(lista, { variante: VARIANTE });
      const v = await get(id, "?version=whatsapp");
      expect(v.status).toBe(200);
      expect(v.headers.get("content-type")).toBe("video/webm");
      expect(v.headers.get("content-length")).toBe(String(VARIANTE.length));
      expect(v.headers.get("cache-control")).not.toMatch(/immutable/);
      expect(Buffer.from(await v.arrayBuffer()).equals(VARIANTE)).toBe(true);

      const r = await get(id, "?version=whatsapp", { range: "bytes=2-5" });
      expect(r.status).toBe(206);
      expect(r.headers.get("content-range")).toBe(`bytes 2-5/${VARIANTE.length}`);
      expect(Buffer.from(await r.arrayBuffer()).toString()).toBe("2345");

      const original = await get(id, "");
      expect(original.headers.get("content-type")).toBe("video/mp4");
      expect(original.headers.get("content-length")).toBe("64");
      expect(original.headers.get("cache-control")).toMatch(/immutable/);
      const desc = await get(id, "?descargar=1");
      expect(desc.headers.get("content-disposition")).toMatch(/^attachment; filename="promo\.mp4"$/);
      expect(desc.headers.get("content-length")).toBe("64");
    });

    it("sin variante lista, 404 (no se sirve el original disfrazado)", async () => {
      expect((await get(await video({}, {}), "?version=whatsapp")).status).toBe(404);
      expect((await get(await video({ variantStatus: "processing" }, {}), "?version=whatsapp")).status).toBe(404);
    });

    it("variante lista pero sin archivo en el volumen: 410", async () => {
      expect((await get(await video(lista, {}), "?version=whatsapp")).status).toBe(410);
    });
  });

  describe("el adjunto de un mensaje enviado (/api/media/[assetId])", () => {
    const VARIANTE = Buffer.from("VARIANTE-ENVIADA");
    const lista = { variantStatus: "ready" as const, variantStorageKey: "k", variantSizeBytes: VARIANTE.length, variantMimeType: "video/mp4" };
    const sacar = (assetId: string) => rutaAdjunto.GET(new Request("http://x/api/media/" + assetId), { params: Promise.resolve({ assetId }) });

    async function adjunto(id: string, mime: string, size: number) {
      const a = `ast_${randomBytes(8).toString("hex")}`;
      assets.push(a);
      await db.insert(schema.mediaAsset).values({ id: a, organizationId: org, kind: "video", mimeType: mime, fileName: "promo.mp4", fileSize: size, libraryItemId: id, fetchStatus: "available" });
      return a;
    }

    it("si lo enviado fue la variante (su MIME y peso), se ve la variante", async () => {
      const id = await video(lista, { original: 40 * MB, variante: VARIANTE });
      const r = await sacar(await adjunto(id, "video/mp4", VARIANTE.length));
      expect(r.status).toBe(200);
      expect(Buffer.from(await r.arrayBuffer()).equals(VARIANTE)).toBe(true);
    });

    it("si lo enviado fue el original (otro peso), se sigue viendo el original", async () => {
      const id = await video(lista, { original: 5 * MB, variante: VARIANTE });
      const r = await sacar(await adjunto(id, "video/mp4", 5 * MB));
      expect(r.status).toBe(200);
      expect((await r.arrayBuffer()).byteLength).toBe(64);
    });
  });
});
