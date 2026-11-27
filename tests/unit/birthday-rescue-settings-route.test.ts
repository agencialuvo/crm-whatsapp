import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Cumpleaños — `GET/PUT /api/negocio/cumpleanos/rescate/ajustes` (permisos, banderas, validación y errores). */
const session = vi.hoisted(() => ({ role: "owner", organizationId: "org_1", userId: "usr_1" }));
vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...session }),
  getSessionOrNull: async () => ({ ...session }),
}));
vi.mock("@/server/business/saas-guard", () => ({ moduleGate: async () => null }));
const store = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock("@/server/business/birthday-rescue-settings", () => ({ getRescueSettings: store.get, saveRescueSettings: store.save }));

const prev = { SALON: process.env.SALON, AUTOMATIONS: process.env.AUTOMATIONS };
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const VALID = { autoEnabled: true, flowId: "aut_m", windowDays: 5, minGapDays: 7, sendHour: 9, benefitText: "un postre de cortesía" };

describe("ajustes del rescate de cumpleaños", () => {
  let route: typeof import("@/app/api/negocio/cumpleanos/rescate/ajustes/route");
  beforeAll(async () => {
    route = await import("@/app/api/negocio/cumpleanos/rescate/ajustes/route");
  }, 60_000);
  beforeEach(() => {
    process.env.SALON = "on";
    process.env.AUTOMATIONS = "on";
    session.role = "owner";
    store.get.mockReset().mockResolvedValue({ ...VALID, lastAutoRunOn: "2026-11-26" });
    store.save.mockReset().mockImplementation(async (_org: string, s: unknown) => s);
  });
  const put = (body: unknown) =>
    route.PUT(
      new Request("https://x/api/negocio/cumpleanos/rescate/ajustes", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );

  it("GET devuelve los ajustes y el último día del automático", async () => {
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: VALID, lastAutoRunOn: "2026-11-26" });
  });

  it("PUT guarda lo validado en la organización de la sesión", async () => {
    const res = await put({ ...VALID, benefitText: "   " });
    expect(res.status).toBe(200);
    expect(store.save).toHaveBeenCalledWith("org_1", { ...VALID, benefitText: null });
  });

  it("validación: automático sin flujo, rangos fuera de límite o campos extra → 422", async () => {
    for (const body of [
      { ...VALID, flowId: null },
      { ...VALID, windowDays: 16 },
      { ...VALID, minGapDays: -1 },
      { ...VALID, sendHour: 25 },
      { ...VALID, otro: true },
    ]) {
      expect((await put(body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(store.save).not.toHaveBeenCalled();
  });

  it("errores del flujo con su código (no existe / no es manual)", async () => {
    const { AutomationError } = await import("@/server/automation/http");
    store.save.mockRejectedValueOnce(new AutomationError("not_manual_flow", 422, "no"));
    const res = await put(VALID);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("not_manual_flow");
    store.save.mockRejectedValueOnce(new AutomationError("not_found", 404, "no"));
    expect((await put(VALID)).status).toBe(404);
  });

  it("un miembro → 403; sin Automatizaciones o sin SALON → 404", async () => {
    session.role = "member";
    expect((await put(VALID)).status).toBe(403);
    session.role = "owner";
    delete process.env.AUTOMATIONS;
    expect((await put(VALID)).status).toBe(404);
    process.env.AUTOMATIONS = "on";
    delete process.env.SALON;
    expect((await route.GET()).status).toBe(404);
    expect(store.save).not.toHaveBeenCalled();
  });
});
