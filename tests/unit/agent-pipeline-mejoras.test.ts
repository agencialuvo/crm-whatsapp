import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integración del turno del agente (`runAgentTurn`) con la base y el modelo simulados:
 *  - Mejora 10: una nota de voz o una foto llegan al modelo como marcador, con el pie de foto.
 *  - Mejora 11: si al volver del modelo la conversación ya no está para el agente, no se envía ni se cobra.
 *  - Mejora 7: una respuesta larga se parte para WhatsApp; un fallo de envío traspasa por «error» y no se cobra.
 *  - Mejora 2: una nota `[IA]` repetida no se vuelve a escribir.
 */

const sendText = vi.fn();
const chatJson = vi.fn();
const settle = vi.fn(async () => {});
const revalidarTurno = vi.fn();

vi.mock("@/server/inbox/send", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/inbox/send")>();
  return { ...original, sendText };
});
vi.mock("@/lib/ai", () => ({ chatJson }));
vi.mock("@/server/ai/ignored", () => ({ isConversationSilenced: async () => false }));
vi.mock("@/server/ai/metering", () => ({
  beginAiTurnMeter: async () => ({ blocked: false, usage: { service: "ai" }, settle }),
}));
vi.mock("@/server/ai/credentials", () => ({
  getAiCredentialPublic: async () => null,
  getAiCredentialSecret: async () => null,
}));
vi.mock("@/server/attribution/store", () => ({ getAttributionForConversation: async () => null }));
vi.mock("@/server/ai/turn-context", () => ({ loadTemporalContext: async () => "FECHA Y HORA ACTUAL DEL NEGOCIO: prueba" }));
vi.mock("@/server/ai/turn-guard", () => ({ revalidarTurno }));
vi.mock("@/server/notifications/service", () => ({ notifyHandoff: async () => {} }));

const selectQueue: unknown[][] = [];
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
  schema: new Proxy({}, { get: (_t, table) => new Proxy({}, { get: (_t2, col) => `${String(table)}.${String(col)}` }) }),
}));

const conversacion = {
  id: "cv_1",
  organizationId: "org_1",
  contactId: "ct_1",
  channel: "whatsapp",
  isTest: false,
  aiEnabled: true,
  handoffAt: null,
  handoffReason: null,
  lastInboundAt: new Date(),
};
const perfil = { id: "agp_1", organizationId: "org_1", enabled: true, name: "Asistente", tone: null, instructions: null, escalationRules: null, greeting: null };
type Msg = { id: string; direction: "in" | "out"; type?: string; text: string | null; mediaAssetId?: string | null };
/** conversación, perfil, historial, kb, etapas (y lo que siga en `extra`). */
const turno = (historial: Msg[], ...extra: unknown[][]) =>
  selectQueue.push(
    [conversacion],
    [perfil],
    historial.map((m, i) => ({ type: "text", mediaAssetId: null, aiGenerated: false, createdAt: new Date(Date.now() + i), ...m })),
    [],
    [],
    ...extra
  );
const mensajesAlModelo = () => (chatJson.mock.calls[0]![1] as { role: string; content: string }[]).map((m) => m.content);

let runAgentTurn: (conversationId: string) => Promise<unknown>;
let SendError: typeof import("@/server/inbox/send").SendError;

beforeAll(async () => {
  ({ runAgentTurn } = await import("@/server/ai/pipeline"));
  ({ SendError } = await import("@/server/inbox/send"));
}, 60_000);

beforeEach(() => {
  selectQueue.length = 0;
  updates.length = 0;
  sendText.mockReset();
  sendText.mockResolvedValue({ messageId: "msg_out" });
  chatJson.mockReset();
  chatJson.mockResolvedValue({ ok: true, data: { action: "reply", text: "¡Hola!" }, raw: "{}" });
  settle.mockClear();
  revalidarTurno.mockReset();
  revalidarTurno.mockResolvedValue({ ok: true });
  vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
});

describe("Mejora 10 — adjuntos en el historial", () => {
  it("una nota de voz sola llega al modelo como marcador y se le contesta", async () => {
    turno([
      { id: "m1", direction: "in", text: "hola" },
      { id: "m2", direction: "out", text: "¡Hola! ¿En qué te ayudo?" },
      { id: "m3", direction: "in", type: "audio", text: null, mediaAssetId: "ma_audio" },
    ], []);
    await runAgentTurn("cv_1");
    expect(mensajesAlModelo()).toContain("[El cliente envió una nota de voz o audio sin texto]");
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("una foto con pie de foto lleva el pie (leído del adjunto)", async () => {
    turno(
      [{ id: "m1", direction: "in", type: "image", text: null, mediaAssetId: "ma_1" }],
      [{ id: "ma_1", caption: "mi comprobante de pago" }]
    );
    await runAgentTurn("cv_1");
    expect(mensajesAlModelo()).toContain('[El cliente envió una imagen con este texto: "mi comprobante de pago"]');
  });
});

describe("Mejora 11 — revalidación antes de enviar", () => {
  it("si una persona contestó mientras el modelo pensaba: no envía, no cobra, no traspasa", async () => {
    revalidarTurno.mockResolvedValue({ ok: false, motivo: "persona_respondio" });
    turno([{ id: "m1", direction: "in", text: "¿precio?" }]);
    const leido = (await runAgentTurn("cv_1")) as { vistos: string[] };
    expect(chatJson).toHaveBeenCalledTimes(1);
    expect(revalidarTurno).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org_1", conversationId: "cv_1" }));
    expect(sendText).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(leido.vistos).toEqual(["m1"]); // cuenta como leído: no se repite el turno
  });

  it("la revalidación va DESPUÉS del modelo y antes del envío", async () => {
    turno([{ id: "m1", direction: "in", text: "¿precio?" }]);
    await runAgentTurn("cv_1");
    expect(chatJson.mock.invocationCallOrder[0]!).toBeLessThan(revalidarTurno.mock.invocationCallOrder[0]!);
    expect(revalidarTurno.mock.invocationCallOrder[0]!).toBeLessThan(sendText.mock.invocationCallOrder[0]!);
    expect(settle).toHaveBeenCalledTimes(1);
  });
});

describe("Mejora 7 — largo del mensaje y fallos de envío", () => {
  it("una respuesta de más de 4096 caracteres sale en varios mensajes que caben", async () => {
    const parrafo = "Te cuento los detalles del servicio. ".repeat(50).trim();
    chatJson.mockResolvedValue({ ok: true, data: { action: "reply", text: [parrafo, parrafo, parrafo].join("\n\n") }, raw: "{}" });
    turno([{ id: "m1", direction: "in", text: "cuéntame todo" }]);
    await runAgentTurn("cv_1");
    expect(sendText.mock.calls.length).toBeGreaterThan(1);
    for (const [arg] of sendText.mock.calls) expect([...(arg as { text: string }).text].length).toBeLessThanOrEqual(4096);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("un error de Meta al enviar: se registra, traspasa por «error» (avisa al equipo) y NO se cobra", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    sendText.mockRejectedValue(new SendError("meta_error", "(#131000) Something went wrong"));
    turno([{ id: "m1", direction: "in", text: "hola" }]);
    await expect(runAgentTurn("cv_1")).resolves.toBeDefined();
    expect(updates.some((u) => u.handoffReason === "error")).toBe(true);
    expect(settle).not.toHaveBeenCalled();
    expect(consola.mock.calls.some((c) => String(c[0]).includes("meta_error"))).toBe(true);
    consola.mockRestore();
  });

  it("si falla la despedida de un handoff, se traspasa UNA vez (por el modelo), no dos", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    chatJson.mockResolvedValue({ ok: true, data: { action: "handoff", farewell: "Te paso con el equipo" }, raw: "{}" });
    sendText.mockRejectedValue(new SendError("meta_error", "caído"));
    turno([{ id: "m1", direction: "in", text: "esto no sirve" }]);
    await runAgentTurn("cv_1");
    const traspasos = updates.filter((u) => u.handoffReason);
    expect(traspasos.map((u) => u.handoffReason)).toEqual(["modelo"]);
    consola.mockRestore();
  });
});

describe("Mejora 2 — notas [IA] sin repetir", () => {
  it("una nota igual a una que ya existe no se vuelve a escribir", async () => {
    chatJson.mockResolvedValue({ ok: true, data: { action: "update_lead", note: "Quiere   CORTE", reply: "¡Perfecto!" }, raw: "{}" });
    turno([{ id: "m1", direction: "in", text: "quiero un corte" }], [{ id: "ct_1", notes: "[IA] quiere corte" }]);
    await runAgentTurn("cv_1");
    expect(updates.some((u) => "notes" in u)).toBe(false);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("una nota nueva se agrega con el prefijo", async () => {
    chatJson.mockResolvedValue({ ok: true, data: { action: "update_lead", note: "Prefiere sábados" }, raw: "{}" });
    turno([{ id: "m1", direction: "in", text: "solo puedo sábados" }], [{ id: "ct_1", notes: "[IA] quiere corte" }]);
    await runAgentTurn("cv_1");
    expect(updates.find((u) => "notes" in u)?.notes).toBe("[IA] quiere corte\n[IA] Prefiere sábados");
  });
});
