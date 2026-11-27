import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Bloque 2 — El anuncio en `/api/bot/context` (cerebro externo) y la corrida «de anuncio» en
 * `POST /api/lab/runs`.
 */

// ---------------------------------------------------------------- mocks comunes
const getAttributionForConversation = vi.hoisted(() => vi.fn());
const getAdFlowContext = vi.hoisted(() => vi.fn());
vi.mock("@/server/attribution/store", () => ({ getAttributionForConversation }));
vi.mock("@/server/ai/ad-flow-context", () => ({ getAdFlowContext }));

// /api/bot/context
vi.mock("@/server/bot/auth", () => ({
  requireBotKey: () => null,
  resolveInstanceOrg: async () => "org_1",
}));
vi.mock("@/server/agenda/context", () => ({ citasParaContexto: async () => null }));
vi.mock("@/server/bot/ficha", () => ({ serializeFicha: () => ({}) }));
vi.mock("@/server/inbox/identity", () => ({ findContactByIdentity: async () => undefined }));

// /api/lab/runs
const session = vi.hoisted(() => ({ role: "owner", organizationId: "org_1", userId: "usr_1" }));
vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...session }),
  getSessionOrNull: async () => ({ ...session }),
}));
const startRun = vi.hoisted(() => vi.fn(async () => "run_1"));
vi.mock("@/server/lab/runner", () => ({
  RunConflictError: class RunConflictError extends Error {},
  RunLimitError: class RunLimitError extends Error {},
  startRun,
}));
vi.mock("@/lib/ai/provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/provider")>()),
  isAiConfiguredFor: async () => true,
}));
const findActiveAdFlowById = vi.hoisted(() => vi.fn());
vi.mock("@/server/attribution/ad-flow", () => ({ findActiveAdFlowById }));

const selectQueue: unknown[][] = [];
vi.mock("@/lib/db", () => ({
  getDb: () => {
    const chain = (rows: unknown[]) => {
      const c: Record<string, unknown> = {};
      for (const m of ["from", "innerJoin", "where", "orderBy", "limit"]) c[m] = () => c;
      (c as { then: unknown }).then = (r: (v: unknown) => void) => Promise.resolve(rows).then(r);
      return c;
    };
    return { select: () => chain(selectQueue.shift() ?? []) };
  },
  schema: new Proxy({}, { get: (_t, t) => new Proxy({}, { get: (_t2, c) => `${String(t)}.${String(c)}` }) }),
}));

const fila = {
  sourceId: "ad_123",
  sourceType: "ad",
  sourceUrl: "https://fb.me/x",
  headline: "2x1 en cortes",
  body: "Solo esta semana",
  mediaType: "image",
  ctwaClid: "SECRETO-CLID",
  createdAt: new Date("2026-11-20T15:00:00Z"),
};
const flujo = {
  flowId: "adf_1",
  sourceId: "ad_123",
  exclusive: true,
  promptRules: "Menciona la promo",
  target: { kind: "service", id: "svc_1", name: "Corte clásico", description: null, priceLabel: "S/ 25.00", durationMinutes: 30, providers: null },
};

const prevAtribucion = process.env.ATRIBUCION;
afterEach(() => {
  if (prevAtribucion === undefined) delete process.env.ATRIBUCION;
  else process.env.ATRIBUCION = prevAtribucion;
});
beforeEach(() => {
  selectQueue.length = 0;
  getAttributionForConversation.mockReset();
  getAdFlowContext.mockReset();
  findActiveAdFlowById.mockReset();
  startRun.mockClear();
  session.role = "owner";
});

// ---------------------------------------------------------------- adParaBot
describe("adParaBot", () => {
  let adParaBot: typeof import("@/server/bot/anuncio").adParaBot;
  beforeAll(async () => {
    ({ adParaBot } = await import("@/server/bot/anuncio"));
  }, 60_000);

  it("con ATRIBUCION apagada no va el campo (undefined) y no se consulta nada", async () => {
    delete process.env.ATRIBUCION;
    expect(await adParaBot("org_1", "cv_1")).toBeUndefined();
    expect(getAttributionForConversation).not.toHaveBeenCalled();
  });

  it("sin anuncio de origen → null", async () => {
    process.env.ATRIBUCION = "on";
    getAttributionForConversation.mockResolvedValue(null);
    expect(await adParaBot("org_1", "cv_1")).toBeNull();
  });

  it("con anuncio y flujo activo: datos del anuncio + flujo, SIN el ctwa_clid", async () => {
    process.env.ATRIBUCION = "on";
    getAttributionForConversation.mockResolvedValue(fila);
    getAdFlowContext.mockResolvedValue(flujo);
    const ad = await adParaBot("org_1", "cv_1");
    expect(getAttributionForConversation).toHaveBeenCalledWith("org_1", "cv_1");
    expect(getAdFlowContext).toHaveBeenCalledWith("org_1", "ad_123");
    expect(ad).toEqual({
      sourceId: "ad_123",
      sourceType: "ad",
      sourceUrl: "https://fb.me/x",
      headline: "2x1 en cortes",
      body: "Solo esta semana",
      mediaType: "image",
      attributedAt: "2026-11-20T15:00:00.000Z",
      flow: { id: "adf_1", exclusive: true, promptRules: "Menciona la promo", target: flujo.target },
    });
    expect(JSON.stringify(ad)).not.toContain("SECRETO-CLID");
  });

  it("anuncio sin flujo activo → flow: null", async () => {
    process.env.ATRIBUCION = "on";
    getAttributionForConversation.mockResolvedValue(fila);
    getAdFlowContext.mockResolvedValue(null);
    expect((await adParaBot("org_1", "cv_1"))?.flow).toBeNull();
  });

  it("si la lectura falla, el campo no va (no tumba el contexto)", async () => {
    process.env.ATRIBUCION = "on";
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    getAttributionForConversation.mockRejectedValue(new Error("base caída"));
    expect(await adParaBot("org_1", "cv_1")).toBeUndefined();
    consola.mockRestore();
  });
});

// ---------------------------------------------------------------- /api/bot/context
describe("GET /api/bot/context", () => {
  let GET: typeof import("@/app/api/bot/context/route").GET;
  beforeAll(async () => {
    ({ GET } = await import("@/app/api/bot/context/route"));
  }, 60_000);

  const pedir = async () => {
    selectQueue.push(
      [
        {
          contact: { id: "ct_1", name: "Ana", waIdentity: "51999", channel: "whatsapp", phone: "51999" },
          conversation: { id: "cv_1", aiEnabled: true, handoffAt: null, lastInboundAt: new Date(), channel: "whatsapp" },
        },
      ],
      []
    );
    const res = await GET(new Request("https://x/api/bot/context?conversationId=cv_1"));
    return { status: res.status, body: await res.json() };
  };

  it("incluye `ad` con el anuncio y su flujo (aditivo: el resto del contrato sigue igual)", async () => {
    process.env.ATRIBUCION = "on";
    getAttributionForConversation.mockResolvedValue(fila);
    getAdFlowContext.mockResolvedValue(flujo);
    const { status, body } = await pedir();
    expect(status).toBe(200);
    expect(body.contact.waIdentity).toBe("51999");
    expect(body.conversation.id).toBe("cv_1");
    expect(body.ad.flow.target.name).toBe("Corte clásico");
    expect(body.ad.flow.exclusive).toBe(true);
  });

  it("con ATRIBUCION apagada el campo `ad` no existe", async () => {
    delete process.env.ATRIBUCION;
    const { body } = await pedir();
    expect("ad" in body).toBe(false);
  });

  it("sin anuncio de origen: `ad: null`", async () => {
    process.env.ATRIBUCION = "on";
    getAttributionForConversation.mockResolvedValue(null);
    const { body } = await pedir();
    expect(body.ad).toBeNull();
  });
});

// ---------------------------------------------------------------- POST /api/lab/runs
describe("POST /api/lab/runs — corrida de anuncio", () => {
  let POST: typeof import("@/app/api/lab/runs/route").POST;
  beforeAll(async () => {
    ({ POST } = await import("@/app/api/lab/runs/route"));
  }, 60_000);
  const lanzar = (body?: unknown) =>
    POST(
      new Request("https://x/api/lab/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    );

  it("sin cuerpo: corrida normal (compatibilidad con la pantalla anterior)", async () => {
    const res = await lanzar();
    expect(res.status).toBe(202);
    expect(startRun).toHaveBeenCalledWith("org_1", { anuncio: null });
  });

  it("con un flujo activo: la corrida lleva el anuncio", async () => {
    process.env.ATRIBUCION = "on";
    findActiveAdFlowById.mockResolvedValue({ id: "adf_1", sourceId: "ad_123", headline: "2x1 en cortes" });
    const res = await lanzar({ adFlowId: "adf_1" });
    expect(res.status).toBe(202);
    expect(findActiveAdFlowById).toHaveBeenCalledWith("org_1", "adf_1");
    expect(startRun).toHaveBeenCalledWith("org_1", {
      anuncio: { flowId: "adf_1", sourceId: "ad_123", headline: "2x1 en cortes" },
    });
  });

  it("flujo inexistente, pausado o de otra organización → 422 ad_flow_not_found", async () => {
    process.env.ATRIBUCION = "on";
    findActiveAdFlowById.mockResolvedValue(null);
    const res = await lanzar({ adFlowId: "adf_ajeno" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("ad_flow_not_found");
    expect(startRun).not.toHaveBeenCalled();
  });

  it("con ATRIBUCION apagada → 422 atribucion_off", async () => {
    delete process.env.ATRIBUCION;
    const res = await lanzar({ adFlowId: "adf_1" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("atribucion_off");
    expect(findActiveAdFlowById).not.toHaveBeenCalled();
  });

  it("cuerpo inválido → 422 y un miembro del equipo → 403 antes de validar nada", async () => {
    expect((await lanzar({ adFlowId: 7 })).status).toBe(422);
    session.role = "member";
    const res = await lanzar({ adFlowId: "adf_1" });
    expect(res.status).toBe(403);
    expect(findActiveAdFlowById).not.toHaveBeenCalled();
  });
});
