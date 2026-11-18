import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 048 — Guardarraíles de Medios en R2 y de la caché del media_id. R2 es un conector OPCIONAL (constitución II): lo que
 * se rompería sin avisar es que otro archivo hable con el bucket, lea las llaves, o que un envío vuelva a copiar el
 * archivo a disco por mensaje. No los relajes: enruta tu cambio por el camino correcto.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const leer = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function archivos(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) archivos(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}
const SRC = archivos(path.join(ROOT, "src")).map((p) => path.relative(ROOT, p).split(path.sep).join("/"));

describe("el conector de R2 está aislado", () => {
  it("solo src/server/storage/r2.ts importa @aws-sdk", () => {
    const usan = SRC.filter((f) => /from\s+["']@aws-sdk\//.test(leer(f)));
    expect(usan).toEqual(["src/server/storage/r2.ts"]);
  });

  it("solo src/server/storage/config.ts lee las credenciales R2_*", () => {
    const lectores = SRC.filter((f) => /process\.env\.R2_/.test(leer(f)));
    expect(lectores).toEqual(["src/server/storage/config.ts"]);
  });

  it("las credenciales nunca llegan a un log ni a una respuesta", () => {
    for (const f of SRC.filter((x) => x.startsWith("src/server/storage/"))) {
      expect(leer(f), f).not.toMatch(/console\.(log|error|warn)\([^)]*(secretAccessKey|accessKeyId)/);
    }
    expect(leer("src/server/medios/store.ts")).not.toMatch(/secretAccessKey|accessKeyId|R2_SECRET/);
  });

  it("apagado, la subida directa da 404 (superficie oculta)", () => {
    for (const f of ["src/app/api/medios/subida/route.ts", "src/app/api/medios/subida/[id]/confirmar/route.ts"]) {
      const c = leer(f);
      expect(c, f).toContain("r2Enabled()");
      expect(c, f).toMatch(/apiError\(404/);
    }
  });
});

describe("lo que el cliente ve", () => {
  it("el DTO de un medio no lleva la clave del objeto ni el almacenamiento", () => {
    const store = leer("src/server/medios/store.ts");
    const dto = store.slice(store.indexOf("export function medioToDto"), store.indexOf("export async function crearMedio("));
    expect(dto).not.toMatch(/storageKey|storage:|organizationId/);
  });

  it("el archivo público de un medio en R2 se REDIRIGE (302 firmado de 10 min): los bytes no pasan por el servidor", () => {
    const r = leer("src/app/api/medios/[id]/archivo/route.ts");
    expect(r).toMatch(/status:\s*302/);
    expect(r).toContain("ttlSeconds: 600");
  });
});

describe("el envío de un medio de la biblioteca", () => {
  it("no copia el archivo a disco ni lo lee en el motor: solo metadatos y media_id", () => {
    const media = leer("src/server/automation/media.ts");
    expect(media).not.toMatch(/readFile/);
    const send = leer("src/server/inbox/send.ts");
    const lib = send.slice(send.indexOf("export async function sendLibraryMedia"), send.indexOf("export type LocationInput"));
    expect(lib).not.toContain("saveMediaFile");
    expect(lib).toContain("resolveWaMediaId(");
    expect(lib).toContain("withStaleMediaRetry(");
    expect(lib).toContain("libraryItemId: item.id");
  });

  it("el motor ya no recibe los bytes del archivo", () => {
    const engine = leer("src/server/automation/engine.ts");
    expect(engine).not.toMatch(/data:\s*Buffer/);
    expect(engine).not.toContain("mediaFile.data");
  });

  it("la caché es por medio Y por número, y el candado evita subir dos veces", () => {
    const c = leer("src/server/whatsapp/media-cache.ts");
    expect(c).toContain("pg_advisory_xact_lock");
    expect(c).toContain("phoneNumberId");
    const schema = leer("src/lib/db/schema.ts");
    expect(schema).toContain("whatsapp_media_cache_item_phone_uq");
  });

  it("borrar un medio borra su binario (disco o R2) y la caché cae por cascada", () => {
    const schema = leer("src/lib/db/schema.ts");
    const t = schema.slice(schema.indexOf('"whatsapp_media_cache"'), schema.indexOf("whatsapp_media_cache_item_phone_uq"));
    expect(t).toMatch(/media_item_id[\s\S]*onDelete: "cascade"/);
    expect(leer("src/server/medios/store.ts")).toContain("await quitarBinario(fila)");
  });
});
