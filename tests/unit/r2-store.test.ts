import { describe, expect, it } from "vitest";
import { createR2Store } from "@/server/storage/r2";
import { r2Config, r2Enabled, r2Incompleto } from "@/server/storage/config";

/** 048 — El adaptador de R2: las URLs firmadas se calculan localmente (sin red) y llevan lo que deben. */

const CFG = { endpoint: "https://acc123.r2.cloudflarestorage.com", bucket: "sistema-lia-media", accessKeyId: "AKIATEST", secretAccessKey: "secret-test-0123456789" };
const NOW = new Date("2026-11-18T12:34:56Z");

describe("subida firmada", () => {
  it("firma tipo y tamaño (R2 rechaza un cuerpo distinto), vence en 15 min y apunta al bucket", async () => {
    const r = await createR2Store(CFG).signUpload("pending/org_1/med_a", { contentType: "image/png", contentLength: 1234, now: NOW });
    const u = new URL(r.url);
    expect(u.host).toBe("acc123.r2.cloudflarestorage.com");
    expect(u.pathname).toBe("/sistema-lia-media/pending/org_1/med_a");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    const firmadas = (u.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");
    expect(firmadas).toEqual(expect.arrayContaining(["content-type", "content-length"]));
    expect(r.headers).toEqual({ "Content-Type": "image/png" });
    expect(r.expiresAt.getTime() - NOW.getTime()).toBe(900_000);
    // El secreto jamás viaja en la URL.
    expect(r.url).not.toContain("secret-test");
  });
});

describe("lectura firmada", () => {
  it("la URL es ESTABLE durante la hora (el navegador la cachea) y cambia a la siguiente", async () => {
    const s = createR2Store(CFG);
    const a = await s.signRead("org/o/medios/m", { now: new Date("2026-11-18T12:01:00Z") });
    const b = await s.signRead("org/o/medios/m", { now: new Date("2026-11-18T12:59:00Z") });
    const c = await s.signRead("org/o/medios/m", { now: new Date("2026-11-18T13:01:00Z") });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
  it("la descarga lleva su disposición y el vencimiento corto de la ruta pública se respeta", async () => {
    const u = new URL(await createR2Store(CFG).signRead("k", { now: NOW, download: true, fileName: "Ficha técnica.pdf", ttlSeconds: 600 }));
    expect(u.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(u.searchParams.get("response-content-disposition")).toBe('attachment; filename="Ficha_t_cnica.pdf"');
  });
});

describe("la bandera", () => {
  const con = (env: Record<string, string | undefined>, fn: () => void) => {
    const antes = { ...process.env };
    Object.assign(process.env, { R2_STORAGE: undefined, R2_ENDPOINT: undefined, R2_BUCKET_NAME: undefined, R2_ACCESS_KEY_ID: undefined, R2_SECRET_ACCESS_KEY: undefined }, env);
    try {
      fn();
    } finally {
      for (const k of ["R2_STORAGE", "R2_ENDPOINT", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
        if (antes[k] === undefined) delete process.env[k];
        else process.env[k] = antes[k];
      }
    }
  };
  const todo = { R2_ENDPOINT: CFG.endpoint, R2_BUCKET_NAME: CFG.bucket, R2_ACCESS_KEY_ID: CFG.accessKeyId, R2_SECRET_ACCESS_KEY: CFG.secretAccessKey };

  it("apagado por defecto, aunque estén las variables", () => {
    con({ ...todo }, () => expect(r2Enabled()).toBe(false));
  });
  it("encendido con las cuatro variables", () => {
    con({ R2_STORAGE: "on", ...todo }, () => expect(r2Config()).toMatchObject({ bucket: "sistema-lia-media" }));
  });
  it("encendido con una variable faltante o de relleno → degrada a local y se avisa", () => {
    con({ R2_STORAGE: "on", ...todo, R2_SECRET_ACCESS_KEY: "" }, () => {
      expect(r2Enabled()).toBe(false);
      expect(r2Incompleto()).toBe(true);
    });
    con({ R2_STORAGE: "on", ...todo, R2_ENDPOINT: "REEMPLAZA_ENDPOINT" }, () => expect(r2Enabled()).toBe(false));
  });
});

describe("listado (Hallazgo H: reconciliación de huérfanos)", () => {
  type Enviado = { input: Record<string, unknown> };
  const clienteFalso = (respuestas: (Record<string, unknown> | Error)[], enviados: Enviado[] = []) => {
    let i = 0;
    return {
      enviados,
      cliente: {
        send: async (cmd: Enviado) => {
          enviados.push(cmd);
          const r = respuestas[i++];
          if (r instanceof Error) throw r;
          return r;
        },
      } as never,
    };
  };

  it("pagina con el cursor, acota MaxKeys a 1000 y devuelve clave, peso y fecha", async () => {
    const f = new Date("2026-01-02T03:04:05Z");
    const { cliente, enviados } = clienteFalso([
      { Contents: [{ Key: "org/o/medios/a", Size: 10, LastModified: f }, { Key: "org/o/medios/b", Size: 20, LastModified: f }], IsTruncated: true, NextContinuationToken: "tok" },
      { Contents: [{ Key: "org/o/medios/c", Size: 30, LastModified: f }], IsTruncated: false },
    ]);
    const s = createR2Store(CFG, cliente);
    const p1 = await s.list("org/", { limit: 5000 });
    expect(p1.objects).toEqual([
      { key: "org/o/medios/a", size: 10, lastModified: f },
      { key: "org/o/medios/b", size: 20, lastModified: f },
    ]);
    expect(p1.next).toBe("tok");
    const p2 = await s.list("org/", { cursor: p1.next! });
    expect(p2.objects.map((o) => o.key)).toEqual(["org/o/medios/c"]);
    expect(p2.next).toBeNull();
    expect(enviados[0]!.input).toMatchObject({ Bucket: "sistema-lia-media", Prefix: "org/", MaxKeys: 1000 });
    expect(enviados[1]!.input).toMatchObject({ ContinuationToken: "tok" });
  });

  it("un bucket vacío devuelve una lista vacía, y un fallo es StorageError unavailable (sin filtrar el detalle)", async () => {
    const vacio = clienteFalso([{ IsTruncated: false }]);
    expect(await createR2Store(CFG, vacio.cliente).list("")).toEqual({ objects: [], next: null });
    const roto = clienteFalso([new Error("403 AccessDenied secret-test-0123456789")]);
    const err = await createR2Store(CFG, roto.cliente).list("").catch((e) => e);
    expect(err).toMatchObject({ name: "StorageError", code: "unavailable" });
    expect(String(err.message)).not.toContain("secret-test");
  });
});
