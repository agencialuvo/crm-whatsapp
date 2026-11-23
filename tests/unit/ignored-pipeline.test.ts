import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Números ignorados — la red de seguridad de `runAgentTurn`: un turno que se programó (el debounce espera unos
 * segundos) ANTES de que el dueño agregara el número llega al pipeline; ahí también se calla, sin responder, sin
 * acuse y sin traspaso. Y con un número que NO está en la lista, el turno sigue exactamente igual que antes.
 */

const sendText = vi.fn();
const chatJson = vi.fn();
const isConversationSilenced = vi.fn();

vi.mock("@/server/inbox/send", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/inbox/send")>();
  return { ...original, sendText };
});
vi.mock("@/lib/ai", () => ({ chatJson }));
vi.mock("@/server/ai/ignored", () => ({ isConversationSilenced }));

// Sin fila de Ajustes → IA cae al entorno (`OPENROUTER_API_TOKEN`), sin tocar la cola de selects de la BD simulada.
vi.mock("@/server/ai/credentials", () => ({
  getAiCredentialPublic: async () => null,
  getAiCredentialSecret: async () => null,
}));
vi.mock("@/server/attribution/store", () => ({
  getAttributionForConversation: async () => null,
}));

// BD simulada: cola de resultados de select + capturas de insert/update.
const selectQueue: unknown[][] = [];
const inserts: Record<string, unknown>[] = [];
const updates: Record<string, unknown>[] = [];

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy", "limit"]) chain[m] = () => chain;
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => Promise.resolve(rows).then(resolve);
  return chain;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
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
  }),
  schema: new Proxy(
    {},
    { get: (_t, table) => new Proxy({}, { get: (_t2, col) => `${String(table)}.${String(col)}` }) }
  ),
}));

function conversacion(extra: Record<string, unknown> = {}) {
  return {
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
  };
}

const perfil = {
  id: "agp_1",
  organizationId: "org_1",
  enabled: true,
  name: "Asistente",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
};

/** Un turno donde el cliente escribe `text`: conversación, perfil, historial. */
function turno(text: string, conv = conversacion()) {
  selectQueue.push([conv], [perfil], [{ id: "msg_1", direction: "in", text, createdAt: new Date() }]);
}

let runAgentTurn: (conversationId: string) => Promise<unknown>;

describe("números ignorados: red de seguridad en runAgentTurn", () => {
  beforeAll(async () => {
    ({ runAgentTurn } = await import("@/server/ai/pipeline"));
  }, 60_000);

  beforeEach(() => {
    selectQueue.length = 0;
    inserts.length = 0;
    updates.length = 0;
    sendText.mockReset();
    sendText.mockResolvedValue({ messageId: "msg_out" });
    chatJson.mockReset();
    chatJson.mockResolvedValue({ ok: true, data: { action: "reply", text: "¡Hola! ¿En qué te ayudo?" }, raw: "{}" });
    isConversationSilenced.mockReset();
    isConversationSilenced.mockResolvedValue(false);
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
  });

  it("un número ignorado: no llama al modelo, no responde y no traspasa", async () => {
    isConversationSilenced.mockResolvedValue(true);
    turno("hola, ¿tienen disponible?");
    await runAgentTurn("cv_1");

    expect(isConversationSilenced).toHaveBeenCalledWith("org_1", "cv_1");
    expect(chatJson).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    // Ni traspaso (handoffAt/handoffReason), ni pausa, ni nada escrito: el chat queda libre.
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it("aunque pida un humano: ni acuse ni traspaso (el patrón de respaldo no se dispara)", async () => {
    isConversationSilenced.mockResolvedValue(true);
    turno("quiero hablar con un humano");
    await runAgentTurn("cv_1");

    expect(sendText).not.toHaveBeenCalled();
    expect(chatJson).not.toHaveBeenCalled();
    expect(updates.some((u) => "handoffAt" in u || "handoffReason" in u)).toBe(false);
  });

  it("aunque la ventana de 24 h esté cerrada: tampoco se traspasa por `ventana`", async () => {
    isConversationSilenced.mockResolvedValue(true);
    turno("hola", conversacion({ lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }));
    await runAgentTurn("cv_1");

    expect(updates).toEqual([]);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("el turno que se calla no revienta (resuelve sin lanzar)", async () => {
    isConversationSilenced.mockResolvedValue(true);
    turno("hola");
    await expect(runAgentTurn("cv_1")).resolves.toBeUndefined();
  });

  it("un número que NO está en la lista: el turno sigue igual que antes y responde", async () => {
    turno("hola, ¿tienen disponible?");
    await runAgentTurn("cv_1");

    expect(isConversationSilenced).toHaveBeenCalledTimes(1);
    expect(chatJson).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith({
      conversationId: "cv_1",
      organizationId: "org_1",
      text: "¡Hola! ¿En qué te ayudo?",
      aiGenerated: true,
    });
    expect(updates).toEqual([]);
  });

  it("sin ignorar y pidiendo un humano: el traspaso de siempre", async () => {
    turno("quiero hablar con un humano");
    await runAgentTurn("cv_1");

    expect(updates.some((u) => u.handoffReason === "cliente")).toBe(true);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it("el Laboratorio (is_test) no consulta la lista: sus contactos son sintéticos", async () => {
    isConversationSilenced.mockResolvedValue(true);
    turno("hola", conversacion({ isTest: true }));
    await runAgentTurn("cv_1");

    expect(isConversationSilenced).not.toHaveBeenCalled();
    expect(chatJson).toHaveBeenCalledTimes(1);
  });

  it("con el agente apagado, ni siquiera consulta la lista (corta antes)", async () => {
    selectQueue.push([conversacion()], [{ ...perfil, enabled: false }]);
    await runAgentTurn("cv_1");

    expect(isConversationSilenced).not.toHaveBeenCalled();
    expect(chatJson).not.toHaveBeenCalled();
  });
});
