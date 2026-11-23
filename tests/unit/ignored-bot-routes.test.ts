import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cerebro externo que consulta por su cuenta: `/api/bot/messages` y `/api/bot/typing` también se callan con un
 * número ignorado (o si la lista no se pudo consultar). Responden con el código que un cerebro ya sabe tratar
 * (`ai_paused`), sin enviar nada ni tocar Meta. Sin ignorar, todo sigue como siempre.
 */

const isConversationSilenced = vi.fn();
const sendText = vi.fn();
const graphRequest = vi.fn();
const getCredentialsByOrg = vi.fn();

vi.mock("@/server/ai/ignored", () => ({ isConversationSilenced }));
vi.mock("@/server/bot/auth", () => ({
  requireBotKey: () => null,
  resolveInstanceOrg: async () => "org_1",
}));
vi.mock("@/server/inbox/send", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/inbox/send")>();
  return { ...original, sendText };
});
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest };
});
vi.mock("@/server/whatsapp/credentials", () => ({ getCredentialsByOrg }));

// BD simulada: cola de resultados de select.
const selectQueue: unknown[][] = [];
function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit"]) chain[m] = () => chain;
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => Promise.resolve(rows).then(resolve);
  return chain;
}
vi.mock("@/lib/db", () => ({
  getDb: () => ({ select: () => thenableChain(selectQueue.shift() ?? []) }),
  schema: new Proxy(
    {},
    { get: (_t, table) => new Proxy({}, { get: (_t2, col) => `${String(table)}.${String(col)}` }) }
  ),
}));

const call = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * Las rutas arrastran medio servidor (envío, canales, Meta). Importarlas dentro de la primera prueba se comía su
 * timeout de 5 s en una corrida cargada, y la prueba que expiraba seguía corriendo en segundo plano y se comía la
 * cola de selects de la siguiente. Se cargan UNA vez, con margen.
 */
let messagesRoute: typeof import("@/app/api/bot/messages/route");
let typingRoute: typeof import("@/app/api/bot/typing/route");
beforeAll(async () => {
  messagesRoute = await import("@/app/api/bot/messages/route");
  typingRoute = await import("@/app/api/bot/typing/route");
}, 60_000);

const messages = (body: unknown) => messagesRoute.POST(call("https://x/api/bot/messages", body));
const typing = (body: unknown) => typingRoute.POST(call("https://x/api/bot/typing", body));

const conv = (over: Record<string, unknown> = {}) => ({
  id: "cv_1",
  organizationId: "org_1",
  isTest: false,
  aiEnabled: true,
  handoffAt: null,
  ...over,
});

beforeEach(() => {
  selectQueue.length = 0;
  isConversationSilenced.mockReset();
  isConversationSilenced.mockResolvedValue(false);
  sendText.mockReset();
  sendText.mockResolvedValue({ messageId: "msg_out" });
  graphRequest.mockReset();
  graphRequest.mockResolvedValue({});
  getCredentialsByOrg.mockReset();
  getCredentialsByOrg.mockResolvedValue({ phoneNumberId: "pn_1", token: "tok" });
});

describe("POST /api/bot/messages con números ignorados", () => {
  it("un número ignorado: 409 ai_paused con el motivo, y NO se envía nada", async () => {
    isConversationSilenced.mockResolvedValue(true);
    selectQueue.push([conv()]);
    const res = await messages({ conversationId: "cv_1", text: "hola" });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "ai_paused", reason: "ignored_number" });
    expect(isConversationSilenced).toHaveBeenCalledWith("org_1", "cv_1");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("si la lista no se pudo consultar (`isConversationSilenced` dice «callar»): tampoco envía", async () => {
    isConversationSilenced.mockResolvedValue(true);
    selectQueue.push([conv()]);
    expect((await messages({ conversationId: "cv_1", text: "hola" })).status).toBe(409);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("sin ignorar: envía como siempre", async () => {
    selectQueue.push([conv()]);
    const res = await messages({ conversationId: "cv_1", text: "hola" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messageId: "msg_out" });
    expect(sendText).toHaveBeenCalledWith({ conversationId: "cv_1", organizationId: "org_1", text: "hola", aiGenerated: true });
  });

  it("una conversación ya pausada o traspasada sigue cortando antes, sin consultar la lista", async () => {
    selectQueue.push([conv({ aiEnabled: false })]);
    const res = await messages({ conversationId: "cv_1", text: "hola" });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "ai_paused", message: "La IA está en pausa en esta conversación" });
    expect(isConversationSilenced).not.toHaveBeenCalled();
  });

  it("una conversación inexistente sigue siendo 404", async () => {
    selectQueue.push([]);
    expect((await messages({ conversationId: "cv_x", text: "hola" })).status).toBe(404);
    expect(isConversationSilenced).not.toHaveBeenCalled();
  });
});

describe("POST /api/bot/typing con números ignorados", () => {
  it("un número ignorado: no muestra «escribiendo…» ni toca Meta", async () => {
    isConversationSilenced.mockResolvedValue(true);
    selectQueue.push([conv()]);
    const res = await typing({ conversationId: "cv_1" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "ai_paused", ignored: true });
    expect(isConversationSilenced).toHaveBeenCalledWith("org_1", "cv_1");
    expect(graphRequest).not.toHaveBeenCalled();
    expect(getCredentialsByOrg).not.toHaveBeenCalled();
  });

  it("sin ignorar: llama a Meta como siempre", async () => {
    selectQueue.push([conv()], [{ waMessageId: "wamid.1" }]);
    const res = await typing({ conversationId: "cv_1" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(graphRequest).toHaveBeenCalledTimes(1);
  });

  it("el sandbox y la IA pausada siguen cortando antes, sin consultar la lista", async () => {
    selectQueue.push([conv({ isTest: true })]);
    expect(await (await typing({ conversationId: "cv_1" })).json()).toEqual({ ok: false, reason: "sandbox" });
    selectQueue.push([conv({ handoffAt: new Date() })]);
    expect(await (await typing({ conversationId: "cv_1" })).json()).toEqual({ ok: false, reason: "ai_paused" });
    expect(isConversationSilenced).not.toHaveBeenCalled();
  });
});
