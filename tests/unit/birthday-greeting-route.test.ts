import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Panel → Cumpleaños: `POST/DELETE /api/negocio/cumpleanos/saludo` registra o quita el saludo manual. Mismo acceso
 * que el Panel (dueño o administrador), el año es el de HOY en la zona del negocio y un cliente ajeno es 404.
 */
const session = vi.hoisted(() => ({ role: "owner", organizationId: "org_1", userId: "usr_1" }));
vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...session }),
  getSessionOrNull: async () => ({ ...session }),
}));
vi.mock("@/server/business/saas-guard", () => ({ moduleGate: async () => null }));
vi.mock("@/server/analytics/period", () => ({ businessTimezone: async () => "America/Lima" }));
const svc = vi.hoisted(() => ({ record: vi.fn(), remove: vi.fn() }));
vi.mock("@/server/business/birthday-campaign", () => {
  class BirthdayGreetingError extends Error {
    constructor(public readonly code: "not_found") {
      super("Ese cliente no existe en este negocio");
    }
  }
  return { BirthdayGreetingError, recordManualGreeting: svc.record, removeManualGreeting: svc.remove };
});

const prevSalon = process.env.SALON;
afterEach(() => {
  vi.useRealTimers();
  if (prevSalon === undefined) delete process.env.SALON;
  else process.env.SALON = prevSalon;
});
beforeEach(() => {
  process.env.SALON = "on";
  session.role = "owner";
  svc.record.mockReset().mockResolvedValue(undefined);
  svc.remove.mockReset().mockResolvedValue(undefined);
});

describe("/api/negocio/cumpleanos/saludo", () => {
  let route: typeof import("@/app/api/negocio/cumpleanos/saludo/route");
  beforeAll(async () => {
    route = await import("@/app/api/negocio/cumpleanos/saludo/route");
  }, 60_000);
  const req = (method: string, body: unknown) =>
    new Request("https://x/api/negocio/cumpleanos/saludo", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("POST registra con el año del negocio y quién saludó", async () => {
    // 31 de dic. a las 23:30 en Lima = 1 de ene. en UTC: el año es el del negocio (2026), no el del servidor.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-01T04:30:00Z"));
    const res = await route.POST(req("POST", { contactId: "ct_1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, year: 2026 });
    expect(svc.record).toHaveBeenCalledWith({ organizationId: "org_1", contactId: "ct_1", year: 2026, userId: "usr_1" });
  });

  it("DELETE quita la marca", async () => {
    const res = await route.DELETE(req("DELETE", { contactId: "ct_1" }));
    expect(res.status).toBe(200);
    expect(svc.remove).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org_1", contactId: "ct_1" }));
  });

  it("un miembro del equipo → 403 sin tocar nada", async () => {
    session.role = "member";
    expect((await route.POST(req("POST", { contactId: "ct_1" }))).status).toBe(403);
    expect((await route.DELETE(req("DELETE", { contactId: "ct_1" }))).status).toBe(403);
    expect(svc.record).not.toHaveBeenCalled();
    expect(svc.remove).not.toHaveBeenCalled();
  });

  it("sin el módulo SALON → la superficie no existe", async () => {
    delete process.env.SALON;
    const res = await route.POST(req("POST", { contactId: "ct_1" }));
    expect(res.status).toBe(404);
    expect(svc.record).not.toHaveBeenCalled();
  });

  it("cuerpo inválido → 422; cliente de otra organización → 404", async () => {
    expect((await route.POST(req("POST", { contactId: "" }))).status).toBe(422);
    const { BirthdayGreetingError } = await import("@/server/business/birthday-campaign");
    svc.record.mockRejectedValue(new BirthdayGreetingError("not_found"));
    const res = await route.POST(req("POST", { contactId: "ct_ajeno" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
});
