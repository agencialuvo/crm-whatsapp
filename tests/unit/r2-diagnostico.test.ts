import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hallazgo D — con `R2_STORAGE=on` y la configuración incompleta o mal puesta, el sistema degrada a disco local, pero
 * ya no en silencio: el diagnóstico es único (`diagnosticarR2`) y lo reflejan el arranque, `/api/health` y el doctor.
 * Siempre por NOMBRE de variable, nunca con valores.
 */

const { getEnv, getDb } = vi.hoisted(() => ({ getEnv: vi.fn(), getDb: vi.fn() }));
vi.mock("@/lib/env", () => ({ getEnv }));
vi.mock("@/lib/db", () => ({ getDb, schema: {} }));

import { GET } from "@/app/api/health/route";
import { checkR2Config } from "@/instrumentation-node";
import { checkR2 } from "@/server/doctor/checks";
import { checkHealth, healthR2 } from "@/server/health";
import { diagnosticarR2, r2Config, r2Enabled, r2Incompleto } from "@/server/storage/config";

const ENV_ORIGINAL = { ...process.env };

const COMPLETO = {
  R2_STORAGE: "on",
  R2_ENDPOINT: "https://abc123.r2.cloudflarestorage.com",
  R2_BUCKET_NAME: "sistema-lia-media",
  R2_ACCESS_KEY_ID: "AKIA-SECRETO-ID",
  R2_SECRET_ACCESS_KEY: "superSecretaClave123",
};
const SECRETOS = [COMPLETO.R2_ACCESS_KEY_ID, COMPLETO.R2_SECRET_ACCESS_KEY];

function ponerEnv(vars: Record<string, string | undefined>) {
  for (const k of Object.keys(process.env).filter((k) => k.startsWith("R2_"))) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
}

beforeEach(() => {
  getDb.mockReturnValue({ execute: async () => [] });
  getEnv.mockReturnValue({ MEDIA_DIR: "./.dev-media" });
});
afterEach(() => {
  process.env = { ...ENV_ORIGINAL };
  vi.restoreAllMocks();
});

describe("diagnosticarR2", () => {
  it("apagado: sin la bandera (aunque haya variables sueltas) → off", () => {
    expect(diagnosticarR2({})).toEqual({ estado: "off" });
    expect(diagnosticarR2({ ...COMPLETO, R2_STORAGE: "off" })).toEqual({ estado: "off" });
    expect(diagnosticarR2({ R2_BUCKET_NAME: "x" })).toEqual({ estado: "off" });
  });

  it("completo: bandera y cuatro variables → ok (la bandera acepta on/1/true/si/yes)", () => {
    for (const on of ["on", "ON", " 1 ", "true", "si", "sí", "yes"]) {
      expect(diagnosticarR2({ ...COMPLETO, R2_STORAGE: on }), on).toEqual({ estado: "ok" });
    }
  });

  it("incompleto: lista exactamente qué falta, por nombre", () => {
    const d = diagnosticarR2({ ...COMPLETO, R2_SECRET_ACCESS_KEY: undefined, R2_BUCKET_NAME: "   " });
    expect(d).toMatchObject({ estado: "incompleto", faltan: ["R2_BUCKET_NAME", "R2_SECRET_ACCESS_KEY"], invalidas: [] });
    if (d.estado === "incompleto") {
      expect(d.mensaje).toContain("R2_STORAGE=on");
      expect(d.mensaje).toContain("R2_BUCKET_NAME, R2_SECRET_ACCESS_KEY");
      expect(d.mensaje).toContain("MEDIA_DIR");
    }
  });

  it("solo la bandera: faltan las cuatro", () => {
    expect(diagnosticarR2({ R2_STORAGE: "on" })).toMatchObject({
      estado: "incompleto",
      faltan: ["R2_ENDPOINT", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"],
    });
  });

  it("el valor de ejemplo de .env.example (REEMPLAZA_…) cuenta como no configurado", () => {
    expect(diagnosticarR2({ ...COMPLETO, R2_ENDPOINT: "REEMPLAZA_ENDPOINT", R2_ACCESS_KEY_ID: "REEMPLAZA_ACCESS_KEY_ID" })).toMatchObject({
      estado: "incompleto",
      faltan: ["R2_ENDPOINT", "R2_ACCESS_KEY_ID"],
    });
  });

  it("un R2_ENDPOINT que no es una URL http(s) está mal puesto (inválida), no ausente", () => {
    for (const malo of ["abc123.r2.cloudflarestorage.com", "ftp://x.example.com", "no es url"]) {
      expect(diagnosticarR2({ ...COMPLETO, R2_ENDPOINT: malo }), malo).toMatchObject({
        estado: "incompleto",
        faltan: [],
        invalidas: ["R2_ENDPOINT"],
      });
    }
  });

  it("el diagnóstico nunca contiene los valores de las credenciales", () => {
    const d = diagnosticarR2({ ...COMPLETO, R2_BUCKET_NAME: "", R2_ENDPOINT: "mal endpoint" });
    const texto = JSON.stringify(d);
    for (const s of SECRETOS) expect(texto).not.toContain(s);
    expect(texto).not.toContain("mal endpoint");
  });
});

describe("r2Config / r2Incompleto / r2Enabled siguen el diagnóstico", () => {
  it("completo: hay config, activo, no incompleto", () => {
    ponerEnv({ ...COMPLETO, R2_ENDPOINT: "https://abc123.r2.cloudflarestorage.com/" });
    expect(r2Config()).toEqual({
      endpoint: "https://abc123.r2.cloudflarestorage.com",
      bucket: "sistema-lia-media",
      accessKeyId: COMPLETO.R2_ACCESS_KEY_ID,
      secretAccessKey: COMPLETO.R2_SECRET_ACCESS_KEY,
    });
    expect(r2Enabled()).toBe(true);
    expect(r2Incompleto()).toBe(false);
  });
  it("incompleto: sin config (degrada a disco), no activo, incompleto", () => {
    ponerEnv({ ...COMPLETO, R2_BUCKET_NAME: undefined });
    expect(r2Config()).toBeNull();
    expect(r2Enabled()).toBe(false);
    expect(r2Incompleto()).toBe(true);
  });
  it("apagado: sin config y NO incompleto", () => {
    ponerEnv({});
    expect(r2Config()).toBeNull();
    expect(r2Incompleto()).toBe(false);
  });
});

describe("aviso al arranque (checkR2Config)", () => {
  it("incompleto: un error visible en el log que dice qué falta, sin secretos", () => {
    ponerEnv({ ...COMPLETO, R2_ENDPOINT: undefined });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    checkR2Config();
    expect(err).toHaveBeenCalledTimes(1);
    const linea = String(err.mock.calls[0]![0]);
    expect(linea).toContain("[boot]");
    expect(linea).toContain("R2_ENDPOINT");
    expect(linea).toContain("MEDIA_DIR");
    for (const s of SECRETOS) expect(linea).not.toContain(s);
  });
  it("apagado: no escribe nada", () => {
    ponerEnv({});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkR2Config();
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
  it("completo: no escribe nada", () => {
    ponerEnv(COMPLETO);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    checkR2Config();
    expect(err).not.toHaveBeenCalled();
  });
});

describe("/api/health refleja el estado de R2", () => {
  it("apagado → r2.status=off, 200 y ok=true", async () => {
    ponerEnv({});
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, r2: { status: "off" } });
  });

  it("completo → r2.status=ok, sin más campos y sin credenciales en el cuerpo", async () => {
    ponerEnv(COMPLETO);
    const res = await GET();
    const cuerpo = await res.json();
    expect(res.status).toBe(200);
    expect(cuerpo.r2).toEqual({ status: "ok" });
    const texto = JSON.stringify(cuerpo);
    for (const s of SECRETOS) expect(texto).not.toContain(s);
  });

  it("incompleto → r2.status=incomplete con los nombres y el aviso, pero ok=true y 200 (no reinicia el contenedor)", async () => {
    ponerEnv({ ...COMPLETO, R2_SECRET_ACCESS_KEY: undefined, R2_ENDPOINT: "no es url" });
    const res = await GET();
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.r2.status).toBe("incomplete");
    expect(cuerpo.r2.missing).toEqual(["R2_SECRET_ACCESS_KEY", "R2_ENDPOINT"]);
    expect(cuerpo.r2.warning).toContain("R2_STORAGE=on");
    const texto = JSON.stringify(cuerpo);
    for (const s of [...SECRETOS, "no es url"]) expect(texto).not.toContain(s);
  });

  it("compatibilidad: los campos de siempre siguen delante y mediaWritable sigue ahí", async () => {
    ponerEnv({ R2_STORAGE: "on" });
    const cuerpo = await (await GET()).json();
    expect(Object.keys(cuerpo).slice(0, 2)).toEqual(["ok", "version"]);
    expect(cuerpo).toHaveProperty("features");
    expect(cuerpo).toHaveProperty("mediaWritable");
  });

  it("BD caída: la respuesta 503 de antes, sin r2", async () => {
    ponerEnv({ R2_STORAGE: "on" });
    getDb.mockReturnValue({
      execute: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const r = await checkHealth();
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ ok: false, error: { code: "db_unavailable", message: "Base de datos no disponible" } });
  });

  it("healthR2 es puro y toma el entorno que se le pasa", () => {
    expect(healthR2({})).toEqual({ status: "off" });
    expect(healthR2(COMPLETO)).toEqual({ status: "ok" });
    expect(healthR2({ R2_STORAGE: "on" })).toMatchObject({ status: "incomplete", missing: ["R2_ENDPOINT", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] });
  });
});

describe("pnpm doctor usa el mismo diagnóstico", () => {
  it("apagado → skip", async () => {
    const [r] = await checkR2({});
    expect(r).toMatchObject({ status: "skip", label: "R2_STORAGE" });
  });
  it("incompleto → fail con el mensaje compartido, sin consultar el bucket", async () => {
    const probe = vi.fn();
    const [r] = await checkR2({ ...COMPLETO, R2_BUCKET_NAME: "" }, { probe });
    expect(r).toMatchObject({ status: "fail", label: "R2" });
    expect(r!.detail).toContain("R2_BUCKET_NAME");
    expect(probe).not.toHaveBeenCalled();
  });
  it("completo → consulta el bucket", async () => {
    const probe = vi.fn().mockResolvedValue({ status: "ok", bucket: "sistema-lia-media" });
    const [r] = await checkR2(COMPLETO, { probe });
    expect(r).toMatchObject({ status: "ok", label: "R2" });
    expect(probe).toHaveBeenCalledOnce();
  });
});
