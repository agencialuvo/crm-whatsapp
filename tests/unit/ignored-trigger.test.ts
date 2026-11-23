import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Números ignorados — el enganche de `maybeRunAgentTurn`: es lo PRIMERO que se mira, antes de elegir entre el
 * cerebro externo y el agente incluido. Un número de la lista no programa turno ni despacha; el resto, sigue igual.
 */

const isConversationSilenced = vi.fn();
const scheduleAgentTurn = vi.fn();
const despacharAlCerebro = vi.fn();
const isAiConfiguredFor = vi.fn();
const despachoActivo = vi.fn();

vi.mock("@/server/ai/ignored", () => ({ isConversationSilenced }));
vi.mock("@/server/ai/pipeline", () => ({ scheduleAgentTurn }));
vi.mock("@/lib/ai/provider", () => ({ isAiConfiguredFor }));
vi.mock("@/server/brains/config", () => ({ despachoActivo }));
vi.mock("@/server/dispatch/encolar", () => ({ despacharAlCerebro }));

let maybeRunAgentTurn: (conversationId: string, organizationId: string, messageId: string) => Promise<void>;

describe("números ignorados: maybeRunAgentTurn", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    isConversationSilenced.mockResolvedValue(false);
    isAiConfiguredFor.mockResolvedValue(true);
    despachoActivo.mockReturnValue(false);
    despacharAlCerebro.mockResolvedValue(undefined);
    ({ maybeRunAgentTurn } = await import("@/server/ai/trigger"));
  });

  it("un número ignorado no programa turno del agente incluido", async () => {
    isConversationSilenced.mockResolvedValue(true);
    await maybeRunAgentTurn("cv_1", "org_1", "msg_1");

    expect(isConversationSilenced).toHaveBeenCalledWith("org_1", "cv_1");
    expect(scheduleAgentTurn).not.toHaveBeenCalled();
    expect(despacharAlCerebro).not.toHaveBeenCalled();
  });

  it("un número ignorado no se despacha al cerebro externo, con el despacho activo", async () => {
    isConversationSilenced.mockResolvedValue(true);
    despachoActivo.mockReturnValue(true);
    await maybeRunAgentTurn("cv_1", "org_1", "msg_1");

    expect(despacharAlCerebro).not.toHaveBeenCalled();
    expect(scheduleAgentTurn).not.toHaveBeenCalled();
  });

  it("se decide ANTES de mirar el despacho o la IA: no gasta ni esas consultas", async () => {
    isConversationSilenced.mockResolvedValue(true);
    await maybeRunAgentTurn("cv_1", "org_1", "msg_1");

    expect(despachoActivo).not.toHaveBeenCalled();
    expect(isAiConfiguredFor).not.toHaveBeenCalled();
  });

  it("si la lista no se pudo consultar, `isConversationSilenced` ya dice «callar»: nada se programa", async () => {
    // El contrato de `isConversationSilenced` (probado en ignored-silenced.test.ts) es devolver true ante un fallo.
    isConversationSilenced.mockResolvedValue(true);
    await expect(maybeRunAgentTurn("cv_1", "org_1", "msg_1")).resolves.toBeUndefined();
    expect(scheduleAgentTurn).not.toHaveBeenCalled();
  });

  it("sin ignorar, con el agente incluido: programa el turno como siempre", async () => {
    await maybeRunAgentTurn("cv_1", "org_1", "msg_1");

    expect(scheduleAgentTurn).toHaveBeenCalledTimes(1);
    expect(scheduleAgentTurn).toHaveBeenCalledWith("cv_1", "msg_1");
    expect(despacharAlCerebro).not.toHaveBeenCalled();
  });

  it("sin ignorar, con cerebro externo: despacha como siempre y el agente incluido no entra", async () => {
    despachoActivo.mockReturnValue(true);
    await maybeRunAgentTurn("cv_1", "org_1", "msg_1");

    expect(despacharAlCerebro).toHaveBeenCalledWith("cv_1", "org_1", "msg_1");
    expect(scheduleAgentTurn).not.toHaveBeenCalled();
  });

  it("sin ignorar y sin IA configurada: no programa nada (comportamiento de siempre)", async () => {
    isAiConfiguredFor.mockResolvedValue(false);
    await maybeRunAgentTurn("cv_1", "org_1", "msg_1");

    expect(scheduleAgentTurn).not.toHaveBeenCalled();
  });
});
