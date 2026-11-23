import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/bot/messages` con monedas: con el corte activo y sin saldo responde 409 `ai_paused` con `reason: "no_credit"`
 * (el código que un cerebro externo ya sabe tratar) y NO envía nada. Sin corte, o con las monedas apagadas, todo
 * sigue como siempre. El módulo de medición se simula: aquí se prueba el cableado de la ruta.
 */

const aiBlockedByCredit = vi.fn();
const isConversationSilenced = vi.fn();
const sendText = vi.fn();

vi.mock("@/server/ai/metering", () => ({ aiBlockedByCredit }));
vi.mock("@/server/ai/ignored", () => ({ isConversationSilenced }));
vi.mock("@/server/bot/auth", () => ({ requireBotKey: () => null, resolveInstanceOrg: async () => "org_1" }));
vi.mock("@/server/inbox/send", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/inbox/send")>();
  return { ...original, sendText };
});

const selectQueue: unknown[][] = [];
function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit"]) chain[m] = () => chain;
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => Promise.resolve(rows).then(resolve);
  return chain;
}
vi.mock("@/lib/db", () => ({
  getDb: () => ({ select: () => thenableChain(selectQueue.shift() ?? []) }),
  schema: new Proxy({}, { get: (_t, table) => new Proxy({}, { get: (_t2, col) => `${String(table)}.${String(col)}` }) }),
}));

let route: typeof import("@/app/api/bot/messages/route");
beforeAll(async () => {
  route = await import("@/app/api/bot/messages/route");
}, 60_000);

const post = () =>
  route.POST(
    new Request("https://x/api/bot/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "cv_1", text: "hola" }),
    })
  );
const conv = (over: Record<string, unknown> = {}) => ({ id: "cv_1", organizationId: "org_1", isTest: false, aiEnabled: true, handoffAt: null, ...over });

beforeEach(() => {
  selectQueue.length = 0;
  aiBlockedByCredit.mockReset();
  aiBlockedByCredit.mockResolvedValue(false);
  isConversationSilenced.mockReset();
  isConversationSilenced.mockResolvedValue(false);
  sendText.mockReset();
  sendText.mockResolvedValue({ messageId: "msg_out" });
});

describe("POST /api/bot/messages sin monedas", () => {
  it("corte activo y sin saldo: 409 ai_paused con reason no_credit, y no envía nada", async () => {
    aiBlockedByCredit.mockResolvedValue(true);
    selectQueue.push([conv()]);
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "ai_paused", reason: "no_credit" });
    expect(aiBlockedByCredit).toHaveBeenCalledWith("org_1");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("con saldo (o en modo sombra, o con las monedas apagadas): envía como siempre", async () => {
    selectQueue.push([conv()]);
    const res = await post();
    expect(res.status).toBe(200);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("la pausa de la conversación y el número ignorado mandan ANTES: no se consulta el saldo", async () => {
    selectQueue.push([conv({ aiEnabled: false })]);
    expect((await post()).status).toBe(409);
    isConversationSilenced.mockResolvedValue(true);
    selectQueue.push([conv()]);
    expect((await (await post()).json()).error).toMatchObject({ reason: "ignored_number" });
    expect(aiBlockedByCredit).not.toHaveBeenCalled();
  });
});
