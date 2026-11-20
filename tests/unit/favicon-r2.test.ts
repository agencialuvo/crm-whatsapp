import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hallazgo C — el favicon con R2 activo o apagado: se lee de R2 antes que del disco (no se sirve una copia vieja), al
 * guardarlo en R2 se quita la copia de disco y al eliminarlo se borra de los dos sitios sin romper nada si uno falla.
 */

const { getEnv } = vi.hoisted(() => ({ getEnv: vi.fn() }));
vi.mock("@/lib/env", () => ({ getEnv }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(), schema: {} }));

import { FAVICON_ASSET } from "@/lib/favicon";
import { guardarFavicon, quitarFavicon } from "@/server/favicon-store";
import { __setObjectStoreForTests, claveDeMedio, StorageError, type ObjectStore } from "@/server/storage";
import { mediaFilePath, readMediaFile } from "@/server/whatsapp/media";

const ORG = "org_1";
const CLAVE = claveDeMedio(ORG, FAVICON_ASSET);
const VIEJO = Buffer.from("icono-viejo-en-disco");
const NUEVO = Buffer.from("icono-nuevo-en-r2");

type Obj = { data: Buffer; contentType: string };

function memoria(mem: Map<string, Obj>, opts: { caeLectura?: boolean; caeBorrado?: boolean } = {}): ObjectStore {
  return {
    async signUpload() {
      throw new Error("no se usa");
    },
    async signRead() {
      throw new Error("no se usa");
    },
    async head(k) {
      const o = mem.get(k);
      return o ? { size: o.data.byteLength, contentType: o.contentType } : null;
    },
    async readRange() {
      throw new Error("no se usa");
    },
    async readAll(k) {
      if (opts.caeLectura) throw new StorageError("unavailable", "R2 caído");
      const o = mem.get(k);
      if (!o) throw new StorageError("not_found", "no está");
      return o.data;
    },
    async put(k, body, contentType) {
      mem.set(k, { data: Buffer.from(body), contentType });
    },
    async copy() {
      throw new Error("no se usa");
    },
    async delete(k) {
      if (opts.caeBorrado) throw new StorageError("unavailable", "R2 caído");
      mem.delete(k);
    },
    async list() {
      return { objects: [], next: null };
    },
  } as ObjectStore;
}

let dir: string;
const existe = (p: string) => stat(p).then(() => true, () => false);

async function ponerEnDisco(data: Buffer) {
  const f = mediaFilePath(ORG, FAVICON_ASSET);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, data);
  return f;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "vocero-favicon-"));
  getEnv.mockReturnValue({ MEDIA_DIR: dir });
  __setObjectStoreForTests(null);
});
afterEach(async () => {
  __setObjectStoreForTests(null);
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("R2 apagado: todo sigue en disco", () => {
  it("guardar escribe en disco y se lee de disco", async () => {
    expect(await guardarFavicon(ORG, NUEVO, "image/png")).toBe("local");
    expect(await readFile(mediaFilePath(ORG, FAVICON_ASSET))).toEqual(NUEVO);
    expect(await readMediaFile(ORG, FAVICON_ASSET)).toEqual(NUEVO);
  });

  it("quitar borra el archivo local y no falla si ya no estaba", async () => {
    await guardarFavicon(ORG, NUEVO, "image/png");
    await quitarFavicon(ORG);
    expect(await existe(mediaFilePath(ORG, FAVICON_ASSET))).toBe(false);
    await expect(quitarFavicon(ORG)).resolves.toBeUndefined();
  });

  it("sin archivo, leer falla (la ruta cae al icono generado)", async () => {
    await expect(readMediaFile(ORG, FAVICON_ASSET)).rejects.toThrow();
  });
});

describe("R2 activo", () => {
  it("guardar va a R2 con su tipo, y quita la copia vieja de disco", async () => {
    const mem = new Map<string, Obj>();
    __setObjectStoreForTests(memoria(mem));
    const f = await ponerEnDisco(VIEJO);

    expect(await guardarFavicon(ORG, NUEVO, "image/png")).toBe("r2");
    expect(mem.get(CLAVE)).toEqual({ data: NUEVO, contentType: "image/png" });
    expect(await existe(f)).toBe(false);
  });

  it("se sirve el de R2 aunque quede una copia vieja en disco (no gana la versión anterior)", async () => {
    const mem = new Map<string, Obj>([[CLAVE, { data: NUEVO, contentType: "image/png" }]]);
    __setObjectStoreForTests(memoria(mem));
    await ponerEnDisco(VIEJO);
    expect(await readMediaFile(ORG, FAVICON_ASSET)).toEqual(NUEVO);
  });

  it("un icono anterior a R2 (solo en disco) se sigue sirviendo hasta que se reemplace", async () => {
    __setObjectStoreForTests(memoria(new Map()));
    await ponerEnDisco(VIEJO);
    expect(await readMediaFile(ORG, FAVICON_ASSET)).toEqual(VIEJO);
  });

  it("R2 sin responder: se usa el disco de respaldo en vez de romper la pestaña", async () => {
    __setObjectStoreForTests(memoria(new Map([[CLAVE, { data: NUEVO, contentType: "image/png" }]]), { caeLectura: true }));
    await ponerEnDisco(VIEJO);
    expect(await readMediaFile(ORG, FAVICON_ASSET)).toEqual(VIEJO);
  });

  it("quitar borra el objeto de R2 Y el archivo local si existiera", async () => {
    const mem = new Map<string, Obj>([[CLAVE, { data: NUEVO, contentType: "image/png" }]]);
    __setObjectStoreForTests(memoria(mem));
    const f = await ponerEnDisco(VIEJO);

    await quitarFavicon(ORG);
    expect(mem.has(CLAVE)).toBe(false);
    expect(await existe(f)).toBe(false);
    await expect(readMediaFile(ORG, FAVICON_ASSET)).rejects.toThrow();
  });

  it("quitar solo toca el icono de ESA organización", async () => {
    const otra = claveDeMedio("org_2", FAVICON_ASSET);
    const mem = new Map<string, Obj>([
      [CLAVE, { data: NUEVO, contentType: "image/png" }],
      [otra, { data: VIEJO, contentType: "image/png" }],
    ]);
    __setObjectStoreForTests(memoria(mem));
    await quitarFavicon(ORG);
    expect(mem.has(CLAVE)).toBe(false);
    expect(mem.has(otra)).toBe(true);
  });

  it("si R2 falla al borrar, no lanza (avisa) y el archivo local igual se quita", async () => {
    const mem = new Map<string, Obj>([[CLAVE, { data: NUEVO, contentType: "image/png" }]]);
    __setObjectStoreForTests(memoria(mem, { caeBorrado: true }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await ponerEnDisco(VIEJO);

    await expect(quitarFavicon(ORG)).resolves.toBeUndefined();
    expect(await existe(f)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("R2");
  });

  it("reemplazar: subir otro icono deja solo el nuevo en R2 y nada en disco", async () => {
    const mem = new Map<string, Obj>();
    __setObjectStoreForTests(memoria(mem));
    await ponerEnDisco(VIEJO);
    await guardarFavicon(ORG, Buffer.from("primero"), "image/png");
    await guardarFavicon(ORG, NUEVO, "image/webp");
    expect(mem.get(CLAVE)).toEqual({ data: NUEVO, contentType: "image/webp" });
    expect(await existe(mediaFilePath(ORG, FAVICON_ASSET))).toBe(false);
    expect(await readMediaFile(ORG, FAVICON_ASSET)).toEqual(NUEVO);
  });
});
