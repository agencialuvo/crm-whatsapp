import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mejora 9 — Cambiar el conocimiento del agente o correr/aplicar el Laboratorio es de quien configura (dueño o
 * administrador): un miembro del equipo recibe 403 antes de tocar nada. Mejoras 5 y 8 — con permiso, el tope del
 * conocimiento (422 `kb_limit`) y el cupo del Laboratorio (429 `lab_daily_limit`) responden con su mensaje.
 */

const session = vi.hoisted(() => ({ role: "member", organizationId: "org_a", userId: "usr_1" }));
vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...session }),
  getSessionOrNull: async () => ({ ...session }),
}));

const kbChangeError = vi.hoisted(() => vi.fn(async () => "El conocimiento quedaría en 41.000 caracteres"));
vi.mock("@/server/ai/kb-limit", () => ({ kbChangeError }));

const startRun = vi.hoisted(() => vi.fn());
vi.mock("@/server/lab/runner", () => {
  class RunConflictError extends Error {}
  class RunLimitError extends Error {
    constructor(readonly limit: number) {
      super(`Llegaste al máximo de ${limit} corridas del Laboratorio en 24 horas.`);
    }
  }
  return { RunConflictError, RunLimitError, startRun };
});
vi.mock("@/lib/ai/provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/provider")>()),
  isAiConfiguredFor: async () => true,
}));

// Nadie debería llegar a la base sin permiso; con permiso, lo mínimo para encontrar el caso del Laboratorio.
const dbTocada = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => {
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit", "returning", "values", "set"]) c[m] = () => c;
    (c as { then: unknown }).then = (r: (v: unknown) => void) => Promise.resolve(rows).then(r);
    return c;
  };
  return {
    getDb: () => {
      dbTocada();
      return {
        select: () => chain([{ id: "case_1" }]),
        insert: () => chain([{ id: "kb_1" }]),
        update: () => chain([{ id: "kb_1" }]),
        delete: () => chain([{ id: "kb_1" }]),
      };
    },
    schema: new Proxy({}, { get: (_t, t) => new Proxy({}, { get: (_t2, c) => `${String(t)}.${String(c)}` }) }),
  };
});

const json = (method: string, body?: unknown) =>
  new Request("https://x/api", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = { params: Promise.resolve({ id: "kb_1" }) };

let kb: typeof import("@/app/api/kb/route");
let kbId: typeof import("@/app/api/kb/[id]/route");
let runs: typeof import("@/app/api/lab/runs/route");
let apply: typeof import("@/app/api/lab/suggestions/apply/route");

beforeAll(async () => {
  kb = await import("@/app/api/kb/route");
  kbId = await import("@/app/api/kb/[id]/route");
  runs = await import("@/app/api/lab/runs/route");
  apply = await import("@/app/api/lab/suggestions/apply/route");
}, 60_000);

beforeEach(() => {
  dbTocada.mockClear();
  kbChangeError.mockClear();
  startRun.mockReset();
});

const sugerencia = { caseId: "case_1", hallazgoIndex: 0, pregunta: "¿Envíos?", respuesta: "Sí, a todo el país." };

describe("un miembro del equipo (sin rol de configuración) → 403", () => {
  beforeEach(() => {
    session.role = "member";
  });

  it.each([
    ["POST /api/kb", () => kb.POST(json("POST", { kind: "qa", question: "¿Envíos?", answer: "Sí" }))],
    ["PATCH /api/kb/[id]", () => kbId.PATCH(json("PATCH", { answer: "No" }), params)],
    ["DELETE /api/kb/[id]", () => kbId.DELETE(json("DELETE"), params)],
    ["POST /api/lab/runs", () => runs.POST()],
    ["POST /api/lab/suggestions/apply", () => apply.POST(json("POST", sugerencia))],
  ])("%s", async (_ruta, llamar) => {
    const res = await (llamar as () => Promise<Response>)();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
    expect(dbTocada).not.toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
  });

  it("leer el conocimiento sigue abierto (lo usa quien atiende)", async () => {
    const res = await kb.GET();
    expect(res.status).toBe(200);
  });
});

describe("dueño o administrador: pasa el permiso y aplica los topes", () => {
  beforeEach(() => {
    session.role = "owner";
  });

  it("crear o editar por encima del tope del conocimiento → 422 kb_limit con el mensaje", async () => {
    for (const res of [
      await kb.POST(json("POST", { kind: "block", content: "Horario de 9 a 6" })),
      await kbId.PATCH(json("PATCH", { content: "x".repeat(10) }), params),
      await apply.POST(json("POST", sugerencia)),
    ]) {
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe("kb_limit");
      expect(body.error.message).toContain("41.000");
    }
    expect(kbChangeError).toHaveBeenCalledTimes(3);
  });

  it("dentro del tope, crear funciona", async () => {
    kbChangeError.mockResolvedValueOnce(null as never);
    const res = await kb.POST(json("POST", { kind: "qa", question: "¿Envíos?", answer: "Sí" }));
    expect(res.status).toBe(201);
  });

  it("el administrador también puede", async () => {
    session.role = "admin";
    kbChangeError.mockResolvedValueOnce(null as never);
    const res = await kbId.DELETE(json("DELETE"), params);
    expect(res.status).toBe(200);
  });

  it("Laboratorio sin cupo → 429 lab_daily_limit con el mensaje", async () => {
    const { RunLimitError } = await import("@/server/lab/runner");
    startRun.mockRejectedValueOnce(new RunLimitError(5));
    const res = await runs.POST();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("lab_daily_limit");
    expect(body.error.message).toContain("5 corridas");
  });

  it("Laboratorio con cupo → 202", async () => {
    startRun.mockResolvedValueOnce("run_1");
    const res = await runs.POST();
    expect(res.status).toBe(202);
  });
});
