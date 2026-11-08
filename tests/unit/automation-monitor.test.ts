import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOGS_DEFAULT_LIMIT, LOGS_MAX_LIMIT, logsQuerySchema } from "@/lib/automation-schemas";
import { parseLogsQuery } from "@/server/automation/http";
import { logError } from "@/server/automation/monitor";

/**
 * Monitoreo de automatizaciones (estado y historial) — contrato de la query, lectura del error y
 * guardas de las cuatro rutas. Las consultas contra Postgres se prueban en `automation-monitor-live.test.ts`.
 */

const getStats = vi.fn();
const listLogs = vi.fn();
vi.mock("@/server/automation/monitor", async (orig) => ({
  ...(await orig<typeof import("@/server/automation/monitor")>()),
  getStats: (...a: unknown[]) => getStats(...a),
  listLogs: (...a: unknown[]) => listLogs(...a),
}));
const requireSession = vi.fn();
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  requireSession: () => requireSession(),
}));

const session = (role: string) => ({ userId: "u", organizationId: "org_1", role });
const url = (q = "") => new Request(`http://localhost/api/automations/logs${q}`);
const ctx = (id = "flw_1") => ({ params: Promise.resolve({ id }) });

describe("logsQuerySchema", () => {
  it("valores por defecto: 25 por página, desde el inicio, sin filtro", () => {
    expect(logsQuerySchema.parse({})).toEqual({ limit: LOGS_DEFAULT_LIMIT, offset: 0 });
  });
  it("acepta los filtros de estado, incluido el grupo «skipped»", () => {
    for (const status of ["success", "failed", "skipped", "skipped_rate_limit", "skipped_opt_out"]) {
      expect(logsQuerySchema.safeParse({ status }).success).toBe(true);
    }
    expect(logsQuerySchema.safeParse({ status: "completed" }).success).toBe(false);
  });
  it("limit entre 1 y 100, offset no negativo, solo enteros", () => {
    expect(logsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(logsQuerySchema.safeParse({ limit: String(LOGS_MAX_LIMIT + 1) }).success).toBe(false);
    expect(logsQuerySchema.parse({ limit: String(LOGS_MAX_LIMIT) }).limit).toBe(LOGS_MAX_LIMIT);
    expect(logsQuerySchema.safeParse({ offset: "-1" }).success).toBe(false);
    expect(logsQuerySchema.safeParse({ limit: "2.5" }).success).toBe(false);
    expect(logsQuerySchema.safeParse({ limit: "abc" }).success).toBe(false);
  });
});

describe("parseLogsQuery", () => {
  it("lee status, limit y offset de la URL; vacío cuenta como ausente", () => {
    const r = parseLogsQuery(url("?status=failed&limit=10&offset=20"));
    expect(r).toEqual({ ok: true, data: { status: "failed", limit: 10, offset: 20 } });
    expect(parseLogsQuery(url("?status=&limit="))).toEqual({ ok: true, data: { limit: 25, offset: 0 } });
  });
  it("un valor inválido responde 422 con el código invalid_query", async () => {
    const r = parseLogsQuery(url("?limit=500"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(422);
      expect((await r.response.json()).error.code).toBe("invalid_query");
    }
  });
  it("ignora claves desconocidas", () => {
    expect(parseLogsQuery(url("?organizationId=org_x")).ok).toBe(true);
  });
});

describe("logError", () => {
  it("saca metadata.error y devuelve null si no hay", () => {
    expect(logError({ error: "out_of_window_requires_template", x: 1 })).toBe("out_of_window_requires_template");
    expect(logError({ error: "" })).toBeNull();
    expect(logError({ error: 5 })).toBeNull();
    expect(logError({})).toBeNull();
    expect(logError(null)).toBeNull();
    expect(logError("texto")).toBeNull();
  });
});

describe("rutas de monitoreo", () => {
  const original = process.env.AUTOMATIONS;
  beforeEach(() => {
    getStats.mockReset().mockResolvedValue({ summary: {} });
    listLogs.mockReset().mockResolvedValue({ logs: [], total: 0, limit: 25, offset: 0 });
    requireSession.mockReset().mockResolvedValue(session("owner"));
    process.env.AUTOMATIONS = "on";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AUTOMATIONS;
    else process.env.AUTOMATIONS = original;
  });

  const routes = async () => ({
    orgStats: (await import("@/app/api/automations/stats/route")).GET as (r: Request) => Promise<Response>,
    orgLogs: (await import("@/app/api/automations/logs/route")).GET as (r: Request) => Promise<Response>,
    flowStats: (await import("@/app/api/automations/[id]/stats/route")).GET as (r: Request, c: unknown) => Promise<Response>,
    flowLogs: (await import("@/app/api/automations/[id]/logs/route")).GET as (r: Request, c: unknown) => Promise<Response>,
  });
  const callAll = async () => {
    const r = await routes();
    return [
      await r.orgStats(url()),
      await r.orgLogs(url()),
      await r.flowStats(url(), ctx()),
      await r.flowLogs(url(), ctx()),
    ];
  };

  it("apagado (AUTOMATIONS): las cuatro responden 404 sin consultar nada", async () => {
    delete process.env.AUTOMATIONS;
    for (const res of await callAll()) expect(res.status).toBe(404);
    expect(getStats).not.toHaveBeenCalled();
    expect(listLogs).not.toHaveBeenCalled();
  });
  it("un miembro del equipo recibe 403 en las cuatro", async () => {
    requireSession.mockResolvedValue(session("member"));
    for (const res of await callAll()) expect(res.status).toBe(403);
    expect(getStats).not.toHaveBeenCalled();
    expect(listLogs).not.toHaveBeenCalled();
  });
  it("el dueño y el administrador pasan, y siempre con SU organización", async () => {
    for (const role of ["owner", "admin"]) {
      requireSession.mockResolvedValue(session(role));
      for (const res of await callAll()) expect(res.status).toBe(200);
    }
    expect(getStats).toHaveBeenCalledWith("org_1", null);
    expect(getStats).toHaveBeenCalledWith("org_1", "flw_1");
    expect(listLogs).toHaveBeenCalledWith("org_1", null, { limit: 25, offset: 0 });
    expect(listLogs).toHaveBeenCalledWith("org_1", "flw_1", { limit: 25, offset: 0 });
  });
  it("una organización pedida por query no se usa: manda la de la sesión", async () => {
    const r = await routes();
    await r.orgLogs(url("?organizationId=org_ajena&status=success"));
    expect(listLogs).toHaveBeenCalledWith("org_1", null, { status: "success", limit: 25, offset: 0 });
  });
  it("una query inválida es 422 y no consulta", async () => {
    const r = await routes();
    expect((await r.orgLogs(url("?status=raro"))).status).toBe(422);
    expect((await r.flowLogs(url("?limit=0"), ctx())).status).toBe(422);
    expect(listLogs).not.toHaveBeenCalled();
  });
  it("un flujo inexistente o ajeno (AutomationError 404) responde 404 con el contrato de error", async () => {
    const { AutomationError } = await import("@/server/automation/http");
    getStats.mockRejectedValue(new AutomationError("not_found", 404, "El flujo no existe"));
    const res = await (await routes()).flowStats(url(), ctx("flw_ajeno"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
});
