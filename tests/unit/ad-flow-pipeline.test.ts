import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdFlowContext } from "@/lib/ad-flow";

/**
 * Bloque 2 — En el turno del agente (`runAgentTurn`), con la base y el modelo simulados:
 *  - el anuncio SIMULADO del Laboratorio solo vale en conversaciones `is_test` (producción lee la atribución
 *    real y nunca la simulada);
 *  - un flujo EXCLUSIVO revisa lo que sale: una fuga se corrige con un reintento y, si persiste, sale la
 *    respuesta segura; un flujo no exclusivo no se toca.
 */

const sendText = vi.fn();
const chatJson = vi.fn();
const settle = vi.fn(async () => {});
const getAttributionForConversation = vi.fn();
const getAdFlowContext = vi.fn();
const loadRivalOfferNames = vi.fn();
const inserts: Record<string, unknown>[] = [];

vi.mock("@/server/inbox/send", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/inbox/send")>();
  return { ...original, sendText };
});
vi.mock("@/lib/ai", () => ({ chatJson }));
vi.mock("@/server/ai/ignored", () => ({ isConversationSilenced: async () => false }));
vi.mock("@/server/ai/metering", () => ({
  beginAiTurnMeter: async () => ({ blocked: false, usage: { service: "ai", key: "ai:cv_1:m1", chargeUnits: 1 }, settle }),
}));
vi.mock("@/server/ai/credentials", () => ({
  getAiCredentialPublic: async () => null,
  getAiCredentialSecret: async () => null,
}));
vi.mock("@/server/attribution/store", () => ({ getAttributionForConversation }));
vi.mock("@/server/ai/ad-flow-context", () => ({ getAdFlowContext, loadRivalOfferNames }));
vi.mock("@/server/ai/turn-context", () => ({ loadTemporalContext: async () => "" }));
vi.mock("@/server/ai/turn-guard", () => ({ revalidarTurno: async () => ({ ok: true }) }));
vi.mock("@/server/notifications/service", () => ({ notifyHandoff: async () => {} }));

const selectQueue: unknown[][] = [];
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
      set: () => ({
        where: () => {
          const chain = {
            returning: () => Promise.resolve([{ id: "cv_1" }]),
            then: (resolve: (v: unknown) => void) => Promise.resolve([{ id: "cv_1" }]).then(resolve),
          };
          return chain;
        },
      }),
    }),
  }),
  schema: new Proxy({}, { get: (_t, table) => new Proxy({}, { get: (_t2, col) => `${String(table)}.${String(col)}` }) }),
}));

const conv = (isTest: boolean) => ({
  id: "cv_1",
  organizationId: "org_1",
  contactId: "ct_1",
  channel: "whatsapp",
  isTest,
  aiEnabled: true,
  handoffAt: null,
  handoffReason: null,
  lastInboundAt: new Date(),
});
const perfil = { id: "agp_1", organizationId: "org_1", enabled: true, name: "Asistente", tone: null, instructions: null, escalationRules: null, greeting: null };
const turno = (isTest: boolean, texto = "Hola, vi el anuncio") =>
  selectQueue.push(
    [conv(isTest)],
    [perfil],
    [{ id: "m1", direction: "in", type: "text", text: texto, mediaAssetId: null, aiGenerated: false, createdAt: new Date() }],
    [],
    []
  );

const flujo = (exclusive: boolean): AdFlowContext => ({
  flowId: "adf_1",
  sourceId: "ad_123",
  exclusive,
  promptRules: null,
  target: { kind: "service", id: "svc_1", name: "Corte clásico", description: null, priceLabel: "S/ 25.00", durationMinutes: 30, providers: null },
});
const ok = (text: string) => ({ ok: true, data: { action: "reply", text }, raw: JSON.stringify({ action: "reply", text }) });
const prompt = () => (chatJson.mock.calls[0]![1] as { content: string }[])[0]!.content;

let runAgentTurn: typeof import("@/server/ai/pipeline").runAgentTurn;
const prevAtribucion = process.env.ATRIBUCION;

beforeAll(async () => {
  process.env.ATRIBUCION = "on";
  ({ runAgentTurn } = await import("@/server/ai/pipeline"));
}, 60_000);
afterAll(() => {
  if (prevAtribucion === undefined) delete process.env.ATRIBUCION;
  else process.env.ATRIBUCION = prevAtribucion;
});

beforeEach(() => {
  selectQueue.length = 0;
  inserts.length = 0;
  sendText.mockReset();
  sendText.mockResolvedValue({ messageId: "out" });
  chatJson.mockReset();
  chatJson.mockResolvedValue(ok("¡Hola! El Corte clásico cuesta S/ 25. ¿Te agendo?"));
  settle.mockClear();
  getAttributionForConversation.mockReset();
  getAttributionForConversation.mockResolvedValue(null);
  getAdFlowContext.mockReset();
  getAdFlowContext.mockResolvedValue(flujo(true));
  loadRivalOfferNames.mockReset();
  loadRivalOfferNames.mockResolvedValue(["Tinte completo", "Manicure"]);
  vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
});

const anuncioSimulado = { sourceId: "ad_123", headline: "2x1 en cortes", body: null };

describe("anuncio simulado del Laboratorio", () => {
  it("en una conversación is_test se usa el anuncio simulado (sin leer ad_attribution) y el agente recibe el enrutamiento", async () => {
    turno(true);
    await runAgentTurn("cv_1", { anuncioSimulado });
    expect(getAttributionForConversation).not.toHaveBeenCalled();
    expect(getAdFlowContext).toHaveBeenCalledWith("org_1", "ad_123");
    expect(prompt()).toContain("ENRUTAMIENTO POR ANUNCIO");
    expect(prompt()).toContain("2x1 en cortes");
    expect(sendText).not.toHaveBeenCalled(); // sandbox: se persiste, no se envía
    expect(inserts.some((i) => i.direction === "out")).toBe(true);
  });

  it("en producción el anuncio simulado se IGNORA: manda la atribución real", async () => {
    turno(false);
    await runAgentTurn("cv_1", { anuncioSimulado });
    expect(getAttributionForConversation).toHaveBeenCalledWith("org_1", "cv_1");
    expect(getAdFlowContext).not.toHaveBeenCalled(); // sin atribución real, no hay flujo
    expect(prompt()).not.toContain("ENRUTAMIENTO POR ANUNCIO");
  });
});

describe("validación determinista del flujo exclusivo", () => {
  beforeEach(() => {
    getAttributionForConversation.mockResolvedValue({ sourceId: "ad_123", headline: "2x1 en cortes", body: null });
  });

  it("sin fuga: una sola llamada al modelo y sale tal cual", async () => {
    turno(false);
    await runAgentTurn("cv_1");
    expect(chatJson).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]![0].text).toBe("¡Hola! El Corte clásico cuesta S/ 25. ¿Te agendo?");
  });

  it("fuga corregida por el reintento: sale la versión corregida; el reintento se mide aparte y no se cobra", async () => {
    chatJson
      .mockResolvedValueOnce(ok("Claro, el corte sale S/ 25 y el Tinte completo S/ 120."))
      .mockResolvedValueOnce(ok("Por aquí te ayudo con el Corte clásico (S/ 25). ¿Te agendo?"));
    turno(false, "¿y el tinte completo?");
    await runAgentTurn("cv_1");
    expect(chatJson).toHaveBeenCalledTimes(2);
    const reintento = chatJson.mock.calls[1]!;
    expect((reintento[1] as { content: string }[]).at(-1)!.content).toContain("CORRECCIÓN DEL SISTEMA");
    expect(reintento[2].usage).toMatchObject({ key: "ai:cv_1:m1:exclusivo", chargeUnits: 0 });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]![0].text).toBe("Por aquí te ayudo con el Corte clásico (S/ 25). ¿Te agendo?");
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("si el reintento vuelve a fugarse: sale la respuesta segura del anuncio", async () => {
    const consola = vi.spyOn(console, "warn").mockImplementation(() => {});
    chatJson
      .mockResolvedValueOnce(ok("También hacemos manicure, te va a encantar."))
      .mockResolvedValueOnce(ok("Y tenemos manicure en promoción."));
    turno(false);
    await runAgentTurn("cv_1");
    expect(sendText.mock.calls[0]![0].text).toBe("Por aquí te ayudo con «Corte clásico» (S/ 25.00). ¿Quieres que lo agendemos?");
    consola.mockRestore();
  });

  it("un flujo NO exclusivo no se revisa (puede cotizar otros servicios si se los piden)", async () => {
    getAdFlowContext.mockResolvedValue(flujo(false));
    chatJson.mockResolvedValue(ok("El Tinte completo está en S/ 120."));
    turno(false, "¿y el tinte completo?");
    await runAgentTurn("cv_1");
    expect(chatJson).toHaveBeenCalledTimes(1);
    expect(loadRivalOfferNames).not.toHaveBeenCalled();
    expect(sendText.mock.calls[0]![0].text).toBe("El Tinte completo está en S/ 120.");
  });

  it("si leer el catálogo falla, sale la respuesta original (la validación nunca tumba el turno)", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    loadRivalOfferNames.mockRejectedValue(new Error("base caída"));
    chatJson.mockResolvedValue(ok("También hacemos manicure."));
    turno(false);
    await runAgentTurn("cv_1");
    expect(sendText.mock.calls[0]![0].text).toBe("También hacemos manicure.");
    consola.mockRestore();
  });
});
