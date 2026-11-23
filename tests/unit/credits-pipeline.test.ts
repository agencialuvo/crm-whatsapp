import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Monedas en el turno del agente (`runAgentTurn`): el corte va ANTES del modelo y callado (sin llamar, sin
 * responder, sin traspaso, sin escribir nada), la medición viaja a `chatJson`, el cobro se asienta con el resultado,
 * y con las monedas apagadas el turno es exactamente el de siempre. La base y el modelo son simulados; el módulo de
 * medición se simula en los primeros casos (el cableado) y es el real en el último (apagado = no-op).
 */

const sendText = vi.fn();
const chatJson = vi.fn();
const isConversationSilenced = vi.fn();
const settle = vi.fn(async () => {});
const beginAiTurnMeter = vi.fn();
let usarMedidorReal = false;

vi.mock("@/server/inbox/send", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/inbox/send")>();
  return { ...original, sendText };
});
vi.mock("@/lib/ai", () => ({ chatJson }));
vi.mock("@/server/ai/ignored", () => ({ isConversationSilenced }));
vi.mock("@/server/ai/metering", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/ai/metering")>();
  return { ...real, beginAiTurnMeter: (...a: Parameters<typeof real.beginAiTurnMeter>) => (usarMedidorReal ? real.beginAiTurnMeter(...a) : beginAiTurnMeter(...a)) };
});
vi.mock("@/server/ai/credentials", () => ({
  getAiCredentialPublic: async () => null,
  getAiCredentialSecret: async () => null,
}));
vi.mock("@/server/attribution/store", () => ({ getAttributionForConversation: async () => null }));

const selectQueue: unknown[][] = [];
const inserts: Record<string, unknown>[] = [];
const updates: Record<string, unknown>[] = [];
const getDbCalls = vi.fn();

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy", "limit"]) chain[m] = () => chain;
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => Promise.resolve(rows).then(resolve);
  return chain;
}

vi.mock("@/lib/db", () => ({
  getDb: () => {
    getDbCalls();
    return {
      select: () => thenableChain(selectQueue.shift() ?? []),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserts.push(values);
          const chain = {
            onConflictDoNothing: () => chain,
            returning: () => Promise.resolve([values]),
            then: (resolve: (v: unknown) => void) => Promise.resolve([values]).then(resolve),
          };
          return chain;
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return {
            where: () => {
              const chain = {
                returning: () => Promise.resolve([{ id: "cv_1" }]),
                then: (resolve: (v: unknown) => void) => Promise.resolve([{ id: "cv_1" }]).then(resolve),
              };
              return chain;
            },
          };
        },
      }),
    };
  },
  schema: new Proxy({}, { get: (_t, table) => new Proxy({}, { get: (_t2, col) => `${String(table)}.${String(col)}` }) }),
}));

const conversacion = (extra: Record<string, unknown> = {}) => ({
  id: "cv_1",
  organizationId: "org_1",
  contactId: "ct_1",
  channel: "whatsapp",
  isTest: false,
  aiEnabled: true,
  handoffAt: null,
  handoffReason: null,
  lastInboundAt: new Date(),
  ...extra,
});
const perfil = { id: "agp_1", organizationId: "org_1", enabled: true, name: "Asistente", tone: null, instructions: null, escalationRules: null, greeting: null };
const turno = (conv = conversacion()) =>
  selectQueue.push([conv], [perfil], [{ id: "msg_1", direction: "in", text: "hola, ¿precio?", createdAt: new Date() }]);

let runAgentTurn: (conversationId: string) => Promise<unknown>;

describe("monedas en runAgentTurn", () => {
  beforeAll(async () => {
    ({ runAgentTurn } = await import("@/server/ai/pipeline"));
  }, 60_000);

  beforeEach(() => {
    selectQueue.length = 0;
    inserts.length = 0;
    updates.length = 0;
    getDbCalls.mockClear();
    sendText.mockReset();
    sendText.mockResolvedValue({ messageId: "msg_out" });
    chatJson.mockReset();
    chatJson.mockResolvedValue({ ok: true, data: { action: "reply", text: "¡Hola!" }, raw: "{}" });
    isConversationSilenced.mockReset();
    isConversationSilenced.mockResolvedValue(false);
    settle.mockClear();
    beginAiTurnMeter.mockReset();
    beginAiTurnMeter.mockResolvedValue({ blocked: false, usage: { service: "ai", key: "ai:cv_1:msg_1" }, settle });
    usarMedidorReal = false;
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("CREDITS", "");
  });

  it("pregunta por el saldo con la conversación y el último entrante, antes de llamar al modelo", async () => {
    turno();
    await runAgentTurn("cv_1");
    expect(beginAiTurnMeter).toHaveBeenCalledWith({ organizationId: "org_1", conversationId: "cv_1", lastInboundId: "msg_1", isTest: false });
    expect(beginAiTurnMeter.mock.invocationCallOrder[0]).toBeLessThan(chatJson.mock.invocationCallOrder[0]!);
  });

  it("sin saldo y con el corte activo: se calla — no llama al modelo, no responde, no traspasa, no escribe nada", async () => {
    beginAiTurnMeter.mockResolvedValue({ blocked: true, settle });
    turno();
    const leido = (await runAgentTurn("cv_1")) as { vistos: string[] } | undefined;

    expect(chatJson).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(updates).toEqual([]); // ni handoffAt ni handoffReason
    expect(inserts).toEqual([]);
    expect(settle).not.toHaveBeenCalled();
    // El turno cuenta como leído: sin esto el coalesce lo repetiría en bucle.
    expect(leido?.vistos).toEqual(["msg_1"]);
  });

  it("le pasa a chatJson la medición del turno y asienta el cobro con el resultado", async () => {
    turno();
    await runAgentTurn("cv_1");
    expect(chatJson).toHaveBeenCalledTimes(1);
    expect(chatJson.mock.calls[0]![2]).toMatchObject({ organizationId: "org_1", usage: { service: "ai", key: "ai:cv_1:msg_1" } });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(await chatJson.mock.results[0]!.value);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("si el proveedor falla, el cobro se asienta igual con el error (no cobra) y el traspaso sigue como antes", async () => {
    chatJson.mockResolvedValue({ ok: false, error: "provider_error", detail: "x" });
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    turno();
    await runAgentTurn("cv_1");
    expect(settle).toHaveBeenCalledWith({ ok: false, error: "provider_error", detail: "x" });
    expect(updates.some((u) => u.handoffReason === "error")).toBe(true);
    consola.mockRestore();
  });

  it("el Laboratorio se mide como ai_lab y nunca se corta", async () => {
    turno(conversacion({ isTest: true }));
    await runAgentTurn("cv_1");
    expect(beginAiTurnMeter).toHaveBeenCalledWith(expect.objectContaining({ isTest: true }));
  });

  it("con CREDITS apagada (medidor real): el turno es el de siempre y la medición ni siquiera se pide", async () => {
    usarMedidorReal = true;
    turno();
    await runAgentTurn("cv_1");
    expect(chatJson).toHaveBeenCalledTimes(1);
    expect(chatJson.mock.calls[0]![2].usage).toBeUndefined();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(inserts).toEqual([]); // nada de credit_* escrito
  });
});
