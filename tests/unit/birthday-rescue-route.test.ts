import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Cumpleaños — Paso 3: `POST /api/negocio/cumpleanos/rescate` (permisos, banderas y validación). */
const session = vi.hoisted(() => ({ role: "owner", organizationId: "org_1", userId: "usr_1" }));
vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...session }),
  getSessionOrNull: async () => ({ ...session }),
}));
vi.mock("@/server/business/saas-guard", () => ({ moduleGate: async () => null }));
const launch = vi.hoisted(() => vi.fn());
vi.mock("@/server/business/birthday-rescue", () => ({ launchBirthdayRescue: launch, RESCUE_MAX_PER_LAUNCH: 300 }));

const prev = { SALON: process.env.SALON, AUTOMATIONS: process.env.AUTOMATIONS };
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("POST /api/negocio/cumpleanos/rescate", () => {
  let POST: typeof import("@/app/api/negocio/cumpleanos/rescate/route").POST;
  beforeAll(async () => {
    ({ POST } = await import("@/app/api/negocio/cumpleanos/rescate/route"));
  }, 60_000);
  beforeEach(() => {
    process.env.SALON = "on";
    process.env.AUTOMATIONS = "on";
    session.role = "owner";
    launch.mockReset().mockResolvedValue({ period: "2026-11", flowId: "aut_m", attempted: 1, enqueued: 1, skipped: [], remaining: 0 });
  });
  const req = (body: unknown) =>
    POST(new Request("https://x/api/negocio/cumpleanos/rescate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  it("dueño: lanza con quién lo pidió → 201", async () => {
    const res = await req({ flowId: "aut_m" });
    expect(res.status).toBe(201);
    expect(launch).toHaveBeenCalledWith({ organizationId: "org_1", flowId: "aut_m", triggeredBy: "usr_1" });
  });

  it("nada encolado → 200 (no es un error)", async () => {
    launch.mockResolvedValue({ period: "2026-11", flowId: "aut_m", attempted: 0, enqueued: 0, skipped: [], remaining: 0 });
    expect((await req({ flowId: "aut_m" })).status).toBe(200);
  });

  it("un miembro → 403; sin Automatizaciones → 404; sin SALON → 404 (nada se lanza)", async () => {
    session.role = "member";
    expect((await req({ flowId: "aut_m" })).status).toBe(403);
    session.role = "owner";
    delete process.env.AUTOMATIONS;
    const off = await req({ flowId: "aut_m" });
    expect(off.status).toBe(404);
    expect((await off.json()).error.code).toBe("automations_off");
    process.env.AUTOMATIONS = "on";
    delete process.env.SALON;
    expect((await req({ flowId: "aut_m" })).status).toBe(404);
    expect(launch).not.toHaveBeenCalled();
  });

  it("cuerpo inválido → 422", async () => {
    expect((await req({})).status).toBe(422);
    expect((await req({ flowId: "aut_m", contactIds: [] })).status).toBe(422);
    expect((await req({ flowId: "aut_m", extra: 1 })).status).toBe(422);
    expect(launch).not.toHaveBeenCalled();
  });

  it("errores esperados del flujo con su código", async () => {
    const { AutomationError } = await import("@/server/automation/http");
    launch.mockRejectedValue(new AutomationError("not_manual_flow", 422, "no"));
    const res = await req({ flowId: "aut_b" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("not_manual_flow");
  });
});

