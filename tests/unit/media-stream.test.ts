import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseByteRange, serveFileStream } from "@/server/whatsapp/media-stream";

/** El visor de video pide tramos (Range): se sirven sin leer el archivo entero en memoria. */

describe("parseByteRange", () => {
  it("sin cabecera, o con un formato que no se soporta, se sirve completo (null)", () => {
    expect(parseByteRange(null, 10)).toBeNull();
    expect(parseByteRange("items=0-3", 10)).toBeNull();
    expect(parseByteRange("bytes=0-1,3-4", 10)).toBeNull();
    expect(parseByteRange("bytes=-", 10)).toBeNull();
  });

  it("rango cerrado, abierto y de cola", () => {
    expect(parseByteRange("bytes=0-3", 10)).toEqual({ start: 0, end: 3 });
    expect(parseByteRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(parseByteRange("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
  });

  it("un final pasado del tamaño se recorta al ultimo byte", () => {
    expect(parseByteRange("bytes=2-999", 10)).toEqual({ start: 2, end: 9 });
    expect(parseByteRange("bytes=-999", 10)).toEqual({ start: 0, end: 9 });
  });

  it("lo que no se puede satisfacer es invalid (416)", () => {
    expect(parseByteRange("bytes=10-", 10)).toBe("invalid");
    expect(parseByteRange("bytes=5-2", 10)).toBe("invalid");
    expect(parseByteRange("bytes=-0", 10)).toBe("invalid");
    expect(parseByteRange("bytes=0-3", 0)).toBe("invalid");
  });
});

describe("serveFileStream", () => {
  const BASE = { "content-type": "video/mp4", "x-content-type-options": "nosniff" };

  async function conArchivo(contenido: string, fn: (file: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(tmpdir(), "media-stream-"));
    const file = path.join(dir, "asset");
    await writeFile(file, contenido);
    try {
      await fn(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("sin Range responde 200 con el archivo completo y conserva las cabeceras", async () => {
    await conArchivo("0123456789", async (file) => {
      const res = await serveFileStream(new Request("http://x/"), file, BASE);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe("10");
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe("0123456789");
    });
  });

  it("con Range responde 206 solo con ese tramo", async () => {
    await conArchivo("0123456789", async (file) => {
      const req = new Request("http://x/", { headers: { range: "bytes=2-5" } });
      const res = await serveFileStream(req, file, BASE);
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
      expect(res.headers.get("content-length")).toBe("4");
      expect(await res.text()).toBe("2345");
    });
  });

  it("un Range fuera del archivo responde 416", async () => {
    await conArchivo("0123456789", async (file) => {
      const req = new Request("http://x/", { headers: { range: "bytes=50-" } });
      const res = await serveFileStream(req, file, BASE);
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe("bytes */10");
    });
  });

  it("un archivo vacio responde 200 sin cuerpo", async () => {
    await conArchivo("", async (file) => {
      const res = await serveFileStream(new Request("http://x/"), file, BASE);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe("0");
    });
  });

  it("un archivo que no existe lanza (la ruta lo traduce a 410)", async () => {
    await expect(
      serveFileStream(new Request("http://x/"), "/ruta/que/no/existe", BASE)
    ).rejects.toThrow();
  });
});
