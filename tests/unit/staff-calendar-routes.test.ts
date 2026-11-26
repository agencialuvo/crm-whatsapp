import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mejora 3 — Las rutas del calendario por profesional, sin base ni Google:
 *  - Equipo (privadas): un miembro recibe 403 en TODAS sin tocar nada; con la bandera apagada, 404 (o
 *    `available: false` en el listado); el dueño genera el enlace (201, con su usuario).
 *  - Públicas (enlace y vuelta de Google): 404 con la bandera apagada; un enlace que no sirve, el permiso
 *    cancelado o un `state` alterado vuelven a la página de resultado con el motivo, sin guardar nada.
 */

const session = vi.hoisted(() => ({ role: "member", organizationId: "org_a", userId: "usr_1" }));
const flag = vi.hoisted(() => ({ on: true }));
const svc = vi.hoisted(() => ({
  createInvite: vi.fn(),
  revokeInvites: vi.fn(),
  resolveInvite: vi.fn(),
  resolveInviteById: vi.fn(),
  markInviteUsed: vi.fn(),
  listStaffCalendarStatus: vi.fn(),
  disconnectStaffCalendar: vi.fn(),
  saveStaffConnection: vi.fn(),
  syncStaffBusy: vi.fn(),
  requestStaffBusySync: vi.fn(),
  exchangeCode: vi.fn(),
}));

vi.mock("@/server/business/saas-guard", () => ({ moduleGate: async () => null }));
vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...session }),
  getSessionOrNull: async () => ({ ...session }),
}));
vi.mock("@/server/business/flag", () => ({
  salonEnabled: () => true,
  salonDisabledResponse: () => new Response(null, { status: 404 }),
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    APP_BASE_URL: "https://crm.ejemplo.test",
    BETTER_AUTH_SECRET: "secreto-de-prueba-123456",
    GOOGLE_ACCOUNTS_BASE_URL: "https://accounts.google.test",
    GOOGLE_OAUTH_BASE_URL: "https://oauth.google.test",
    GOOGLE_CAL_BASE_URL: "https://cal.google.test/v3",
    GOOGLE_OAUTH_CLIENT_ID: "cid",
    GOOGLE_OAUTH_CLIENT_SECRET: "csec",
  }),
}));
vi.mock("@/server/agenda/staff-calendar/flag", () => ({
  staffCalendarsEnabled: () => flag.on,
  staffCalendarsDisabledResponse: () => new Response(null, { status: 404 }),
}));
vi.mock("@/server/agenda/staff-calendar/invite", () => ({
  createInvite: svc.createInvite,
  revokeInvites: svc.revokeInvites,
  resolveInvite: svc.resolveInvite,
  resolveInviteById: svc.resolveInviteById,
  markInviteUsed: svc.markInviteUsed,
  InviteError: class InviteError extends Error {},
}));
vi.mock("@/server/agenda/staff-calendar/connection", () => ({
  listStaffCalendarStatus: svc.listStaffCalendarStatus,
  disconnectStaffCalendar: svc.disconnectStaffCalendar,
  saveStaffConnection: svc.saveStaffConnection,
}));
vi.mock("@/server/agenda/staff-calendar/busy", () => ({
  syncStaffBusy: svc.syncStaffBusy,
  requestStaffBusySync: svc.requestStaffBusySync,
}));
vi.mock("@/server/agenda/connectors/google-credentials", () => ({
  instanceOAuthApp: () => ({ clientId: "cid", clientSecret: "csec" }),
  getGoogleConnectionInfo: vi.fn(async () => null),
}));
vi.mock("@/server/notifications/service", () => ({ notify: vi.fn() }));

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function privateCases() {
  const list = await import("@/app/api/negocio/equipo/calendarios/route");
  const cal = await import("@/app/api/negocio/equipo/[id]/calendario/route");
  const link = await import("@/app/api/negocio/equipo/[id]/calendario/enlace/route");
  const req = () => new Request("https://x/api", { method: "POST" });
  return [
    { label: "GET calendarios", run: () => list.GET() },
    { label: "POST leer ahora", run: () => cal.POST(req(), params("stf_1")) },
    { label: "DELETE desconectar", run: () => cal.DELETE(req(), params("stf_1")) },
    { label: "POST generar enlace", run: () => link.POST(req(), params("stf_1")) },
    { label: "DELETE anular enlace", run: () => link.DELETE(req(), params("stf_1")) },
  ];
}

beforeEach(() => {
  session.role = "member";
  flag.on = true;
  for (const f of Object.values(svc)) f.mockReset();
});

describe("Equipo → calendario del profesional (privadas)", () => {
  it("un miembro recibe 403 en TODAS y no se toca nada", async () => {
    for (const c of await privateCases()) {
      const res = await c.run();
      expect(res.status, c.label).toBe(403);
    }
    for (const f of Object.values(svc)) expect(f).not.toHaveBeenCalled();
  });

  it("bandera apagada: el listado dice `available: false` y lo demás no existe (404)", async () => {
    session.role = "owner";
    flag.on = false;
    const [list, ...rest] = await privateCases();
    expect(await (await list!.run()).json()).toEqual({ available: false, staff: [] });
    for (const c of rest) expect((await c.run()).status, c.label).toBe(404);
    expect(svc.createInvite).not.toHaveBeenCalled();
  });

  it("el dueño genera el enlace: 201 con la URL, a su nombre", async () => {
    session.role = "owner";
    svc.createInvite.mockResolvedValue({ token: "t", url: "https://crm.ejemplo.test/conectar-calendario/t", expiresAt: new Date("2026-12-03T12:00:00Z") });
    const link = await import("@/app/api/negocio/equipo/[id]/calendario/enlace/route");
    const res = await link.POST(new Request("https://x", { method: "POST" }), params("stf_1"));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ url: "https://crm.ejemplo.test/conectar-calendario/t", expiresAt: "2026-12-03T12:00:00.000Z" });
    expect(svc.createInvite).toHaveBeenCalledWith({ organizationId: "org_a", staffId: "stf_1", userId: "usr_1" });
  });
});

describe("enlace público y vuelta de Google", () => {
  const ctxToken = (token: string) => ({ params: Promise.resolve({ token }) });

  it("con la bandera apagada no existen (404)", async () => {
    flag.on = false;
    const start = await import("@/app/api/calendar-invite/[token]/start/route");
    const cb = await import("@/app/api/calendar-invite/oauth/callback/route");
    expect((await start.GET(new Request("https://x"), ctxToken("t"))).status).toBe(404);
    expect((await cb.GET(new Request("https://x/cb?code=c&state=s"))).status).toBe(404);
  });

  it("un enlace vencido no lleva a Google: vuelve al resultado con el motivo", async () => {
    svc.resolveInvite.mockResolvedValue({ ok: false, reason: "expired" });
    const start = await import("@/app/api/calendar-invite/[token]/start/route");
    const res = await start.GET(new Request("https://x"), ctxToken("t"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://crm.ejemplo.test/conectar-calendario/resultado?estado=error&motivo=expired");
  });

  it("un enlace vigente lleva a Google con SOLO lectura, PKCE y la cookie del flujo", async () => {
    svc.resolveInvite.mockResolvedValue({ ok: true, invite: { id: "sci_1", organizationId: "org_a", staffId: "stf_1" } });
    const start = await import("@/app/api/calendar-invite/[token]/start/route");
    const res = await start.GET(new Request("https://x"), ctxToken("t"));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.google.test/o/oauth2/v2/auth");
    expect(to.searchParams.get("scope")).toContain("calendar.events.readonly");
    expect(to.searchParams.get("scope")).not.toMatch(/calendar\.events(\s|$)/);
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^vocero_staff_google_oauth=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/api/calendar-invite");
    expect(cookie).toContain("Secure");
  });

  it("vuelta de Google: cancelado o con un `state` alterado → resultado con el motivo, sin guardar nada", async () => {
    const cb = await import("@/app/api/calendar-invite/oauth/callback/route");
    const denied = await cb.GET(new Request("https://x/cb?error=access_denied"));
    expect(denied.headers.get("location")).toContain("estado=error&motivo=denied");
    const forged = await cb.GET(
      new Request("https://x/cb?code=c&state=falso.firma", { headers: { cookie: "vocero_staff_google_oauth=n.v" } })
    );
    expect(forged.headers.get("location")).toContain("motivo=state");
    expect(forged.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect(svc.resolveInviteById).not.toHaveBeenCalled();
    expect(svc.saveStaffConnection).not.toHaveBeenCalled();
  });
});
