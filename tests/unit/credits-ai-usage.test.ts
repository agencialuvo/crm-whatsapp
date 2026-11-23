import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Monedas — la medición de la IA en `chatJson`: tokens del proveedor o estimados, un registro por intento (los
 * reintentos también cuestan), el cobro anotado solo en la respuesta válida con llave del ENTORNO, y que medir
 * jamás rompa ni cambie el resultado. La base y el proveedor son simulados.
 */

const recordUsage = vi.fn(async (_input: Record<string, unknown>) => ({ status: "recorded", id: "cru_1" }));
vi.mock("@/server/credits", () => ({ recordUsage }));

type Source = "org" | "env";
let source: Source = "env";
vi.mock("@/lib/ai/provider", () => ({
  resolveAiProvider: async () => ({
    ok: true,
    provider: { source, baseUrl: source === "org" ? "https://api.example.com/v1" : "http://localhost:4010/v1", model: "m", judgeModel: "m", token: "t" },
  }),
}));
vi.mock("@/server/ai/credentials", () => ({ marcarEstadoPorRespuesta: async () => false }));

const schema = z.object({ ok: z.literal(true) });
const MSG = [{ role: "user" as const, content: "hola mundo" }];

function reply(content: string, usage?: Record<string, number>): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }), { status: 200 });
}

let chatJson: typeof import("@/lib/ai").chatJson;

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  recordUsage.mockClear();
  recordUsage.mockImplementation(async (_i: Record<string, unknown>) => ({ status: "recorded", id: "cru_1" }));
  source = "env";
  vi.stubEnv("OPENROUTER_API_TOKEN", "t");
  ({ chatJson } = await import("@/lib/ai"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const fetchSeq = (...rs: Response[]) => {
  const f = vi.fn();
  for (const r of rs) f.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", f);
  return f;
};
const calls = () => recordUsage.mock.calls.map((c) => c[0]);

describe("tokens: los del proveedor o una estimación marcada como tal", () => {
  it("usa lo que informa el proveedor y no marca estimación", async () => {
    fetchSeq(reply('{"ok":true}', { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }));
    const r = await chatJson(schema, MSG, { organizationId: "o1", usage: { service: "ai" } });
    expect(r.ok).toBe(true);
    expect(r.meta).toEqual({ source: "env", model: "m", tokensIn: 120, tokensOut: 30, estimated: false, attempts: 1 });
    expect(calls()[0]).toMatchObject({ tokensIn: 120, tokensOut: 30, estimated: false, source: "env", service: "ai" });
  });

  it("sin `usage` del proveedor estima por longitud y lo marca", async () => {
    fetchSeq(reply('{"ok":true}'));
    const r = await chatJson(schema, MSG, { organizationId: "o1", usage: { service: "ai" } });
    expect(r.meta?.estimated).toBe(true);
    expect(r.meta?.tokensIn).toBeGreaterThan(0);
    expect(r.meta?.tokensOut).toBeGreaterThan(0);
    expect(calls()[0]).toMatchObject({ estimated: true });
  });

  it("un `usage` a medias o no numérico también se estima (no se inventan ceros)", async () => {
    fetchSeq(reply('{"ok":true}', { prompt_tokens: 0, completion_tokens: 0 }));
    const r = await chatJson(schema, MSG, { organizationId: "o1", usage: { service: "ai" } });
    expect(r.meta?.estimated).toBe(true);
  });
});

describe("reintentos: cada llamada que devolvió respuesta se mide", () => {
  it("un intento inválido y uno válido: dos registros, suma de tokens, cobro SOLO en el válido", async () => {
    fetchSeq(
      reply("esto no es json", { prompt_tokens: 100, completion_tokens: 10 }),
      reply('{"ok":true}', { prompt_tokens: 110, completion_tokens: 12 })
    );
    const p = chatJson(schema, MSG, {
      organizationId: "o1",
      usage: { service: "ai", key: "ai:c1:m1", chargeUnits: 100, conversationId: "c1", refType: "message", refId: "m1" },
    });
    await vi.advanceTimersByTimeAsync(2000);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.meta).toMatchObject({ attempts: 2, tokensIn: 210, tokensOut: 22 });
    const [a, b] = calls();
    expect(a).toMatchObject({ idempotencyKey: "ai:c1:m1#1", chargedUnits: 0, conversationId: "c1", refId: "m1" });
    expect(b).toMatchObject({ idempotencyKey: "ai:c1:m1#2", chargedUnits: 100 });
  });

  it("si todos los intentos fallan se miden igual y no se anota ningún cobro; el error trae el uso", async () => {
    fetchSeq(reply("no"), reply("no"), reply("no"));
    const p = chatJson(schema, MSG, { organizationId: "o1", usage: { service: "ai", key: "k", chargeUnits: 100 } });
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.meta?.attempts).toBe(3);
    expect(calls()).toHaveLength(3);
    expect(calls().every((c) => c.chargedUnits === 0)).toBe(true);
  });

  it("un error HTTP no devolvió tokens: no se mide ese intento", async () => {
    fetchSeq(new Response("boom", { status: 500 }), reply('{"ok":true}', { prompt_tokens: 5, completion_tokens: 5 }));
    const p = chatJson(schema, MSG, { organizationId: "o1", usage: { service: "ai", key: "k" } });
    await vi.advanceTimersByTimeAsync(2000);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ idempotencyKey: "k#2" });
  });
});

describe("quién paga y qué servicio es", () => {
  it("llave del cliente (org): se mide con source=org y NUNCA lleva cobro", async () => {
    source = "org";
    fetchSeq(reply('{"ok":true}', { prompt_tokens: 5, completion_tokens: 5 }));
    const r = await chatJson(schema, MSG, { organizationId: "o1", usage: { service: "ai", chargeUnits: 100 } });
    expect(r.meta?.source).toBe("org");
    expect(calls()[0]).toMatchObject({ source: "org", chargedUnits: 0 });
  });

  it("Laboratorio y juez (ai_lab): se miden y nunca llevan cobro, aunque la llave sea del entorno", async () => {
    fetchSeq(reply('{"ok":true}', { prompt_tokens: 5, completion_tokens: 5 }));
    await chatJson(schema, MSG, { organizationId: "o1", usage: { service: "ai_lab", chargeUnits: 100 } });
    expect(calls()[0]).toMatchObject({ service: "ai_lab", source: "env", chargedUnits: 0 });
  });

  it("el modo sombra se anota en la medición", async () => {
    fetchSeq(reply('{"ok":true}', { prompt_tokens: 5, completion_tokens: 5 }));
    await chatJson(schema, MSG, { organizationId: "o1", usage: { service: "ai", chargeUnits: 100, wouldCut: true } });
    expect(calls()[0]).toMatchObject({ wouldCut: true });
  });
});

describe("medir nunca rompe ni cambia el resultado", () => {
  it("sin `usage` en las opciones no se registra nada (y el resultado sigue siendo el de siempre)", async () => {
    fetchSeq(reply('{"ok":true}'));
    const r = await chatJson(schema, MSG, { organizationId: "o1" });
    expect(r.ok).toBe(true);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("sin organización tampoco (no hay a quién atribuirlo)", async () => {
    fetchSeq(reply('{"ok":true}'));
    await chatJson(schema, MSG, { usage: { service: "ai" } });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("si registrar falla, la respuesta válida se devuelve igual", async () => {
    recordUsage.mockRejectedValue(new Error("base caída"));
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSeq(reply('{"ok":true}', { prompt_tokens: 5, completion_tokens: 5 }));
    const r = await chatJson(schema, MSG, { organizationId: "o1", usage: { service: "ai" } });
    expect(r.ok).toBe(true);
    expect(consola).toHaveBeenCalled();
    consola.mockRestore();
  });
});

describe("valores provisionales de modo sombra", () => {
  it("cuotas por plan: Demo 200, Emprendedor 1000, Pro 3500 monedas y Enterprise sin tope", async () => {
    const { quotaForPlan, UNLIMITED } = await import("@/lib/credits");
    expect(quotaForPlan({ slug: "demo" })).toBe(20_000);
    expect(quotaForPlan({ slug: "emprendedor" })).toBe(100_000);
    expect(quotaForPlan({ slug: "pro" })).toBe(350_000);
    expect(quotaForPlan({ slug: "enterprise" })).toBe(UNLIMITED);
  });

  it("lo explícito del plan manda sobre el valor provisional; un plan desconocido no mide", async () => {
    const { quotaForPlan, UNLIMITED } = await import("@/lib/credits");
    expect(quotaForPlan({ slug: "pro", features: { monthlyCoins: 5000 } })).toBe(5000);
    expect(quotaForPlan({ slug: "pro", features: { monthlyCoins: UNLIMITED } })).toBe(UNLIMITED);
    expect(quotaForPlan({ slug: "pro", features: { monthlyCoins: -7 } })).toBe(350_000); // inválido → provisional
    expect(quotaForPlan({ slug: "personalizado" })).toBe(0);
  });

  it("hay una tarifa por cada categoría de plantilla, el mensaje libre a 0 y el turno de IA", async () => {
    const { DEFAULT_RATES, RATE_KEYS, templateRateKey } = await import("@/lib/credits");
    const por = new Map(DEFAULT_RATES.map((r) => [r.key, r]));
    for (const cat of ["marketing", "utility", "authentication", "otra"]) expect(por.has(templateRateKey(cat)), cat).toBe(true);
    expect(por.get(RATE_KEYS.waText)?.amount).toBe(0);
    expect(por.get(RATE_KEYS.aiTurn)).toMatchObject({ unitKind: "per_turn", amount: 100 });
    expect(por.get("wa.template.marketing")!.amount).toBeGreaterThan(por.get("wa.template.utility")!.amount);
    expect(new Set(DEFAULT_RATES.map((r) => r.key)).size).toBe(DEFAULT_RATES.length);
  });
});
