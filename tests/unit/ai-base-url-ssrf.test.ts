import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * La base URL del proveedor de IA que escribe quien administra no puede apuntar a la red interna:
 * ni al GUARDARLA (PUT /api/settings/ai → 422 bad_url) ni al LLAMAR al proveedor (una fila guardada antes de la
 * guarda se revalida). La del entorno (la fija quien opera el servidor) no se restringe.
 */

const session = vi.hoisted(() => ({ role: "owner", organizationId: "org_a", userId: "usr_1" }));
vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...session }),
  getSessionOrNull: async () => ({ ...session }),
}));
const saveAiCredential = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/server/ai/credentials", () => ({
  AiCredentialError: class AiCredentialError extends Error {
    code = "x";
  },
  saveAiCredential,
  deleteAiCredential: vi.fn(),
  marcarEstadoPorRespuesta: vi.fn(async () => undefined),
}));
const resolved = vi.hoisted(() => ({ provider: null as unknown }));
vi.mock("@/lib/ai/provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/provider")>()),
  resolveAiProvider: async () => ({ ok: true, provider: resolved.provider }),
}));
vi.mock("@/server/ai/settings", async (orig) => ({
  ...(await orig<typeof import("@/server/ai/settings")>()),
  vistaAjustesIa: async () => ({ ok: true }),
}));

const put = async (body: unknown) => {
  const { PUT } = await import("@/app/api/settings/ai/route");
  return PUT(
    new Request("https://x/api/settings/ai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
};

beforeEach(() => {
  saveAiCredential.mockClear();
  vi.stubEnv("WA_MOCK_ENABLED", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("PUT /api/settings/ai", () => {
  const base = { provider: "openai_compatible", model: "m", token: "sk-12345678" };

  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:8080",
    "http://169.254.169.254/latest",
    "http://10.0.0.7/v1",
    "http://[::1]:8080",
    "http://2130706433/v1",
  ])("rechaza %s con 422 bad_url y no guarda nada", async (baseUrl) => {
    const res = await put({ ...base, baseUrl });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("bad_url");
    expect(saveAiCredential).not.toHaveBeenCalled();
  });

  it("acepta un proveedor público", async () => {
    const res = await put({ ...base, baseUrl: "https://api.proveedor.com/v1" });
    expect(res.status).toBe(200);
    expect(saveAiCredential).toHaveBeenCalledTimes(1);
  });

  it("OpenRouter (preset fijo) sigue guardándose", async () => {
    const res = await put({ provider: "openrouter", model: "m", token: "sk-12345678" });
    expect(res.status).toBe(200);
  });

  it("con los mocks habilitados (nunca en producción) una base local se permite, para los e2e", async () => {
    vi.stubEnv("WA_MOCK_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "test");
    const res = await put({ ...base, baseUrl: "http://localhost:3000/api/dev/ai-mock" });
    expect(res.status).toBe(200);
  });
});

describe("chatJson con un proveedor de organización", () => {
  const schemaOk = z.object({ a: z.number() });
  const mk = (source: "org" | "env", baseUrl: string) => ({ source, baseUrl, model: "m", judgeModel: "m", token: "sk-x" });

  it("una base interna guardada NO se llama: no hay fetch y el fallo vuelve tipado", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    resolved.provider = mk("org", "http://169.254.169.254/latest");
    const { chatJson } = await import("@/lib/ai");
    const r = await chatJson(schemaOk, [{ role: "user", content: "hola" }], { organizationId: "org_a" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/red interna o local/);
  });

  it("una base de organización pública sí se llama", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    resolved.provider = mk("org", "https://api.proveedor.com/v1");
    const { chatJson } = await import("@/lib/ai");
    const r = await chatJson(schemaOk, [{ role: "user", content: "hola" }], { organizationId: "org_a" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });

  it("una base del ENTORNO (local, la fija quien opera el servidor) sí se llama", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    resolved.provider = mk("env", "http://localhost:3000/api/dev/ai-mock");
    const { chatJson } = await import("@/lib/ai");
    const r = await chatJson(schemaOk, [{ role: "user", content: "hola" }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });
});
