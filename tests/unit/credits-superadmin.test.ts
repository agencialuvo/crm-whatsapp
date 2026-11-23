import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Monedas, sub-paso 5.1 (sin base real): contratos de la API de Super Admin, que NADIE más puede usar (sin sesión 401,
 * sin ser Super Admin 404, sin 2FA 403), el cableado de las rutas con el servicio, la conciliación diaria (solo una vez
 * por día, nunca lanza, no repara sola) y la cuota `monthlyCoins` en los planes base.
 */

/* ───────── Simulación de sesión, base y servicio ───────── */

let session: { user: { id: string } } | null = null;
const selectQueue: unknown[][] = [];
const creditsOverview = vi.fn();
const creditsOrgDetail = vi.fn();
const applyCreditsAction = vi.fn();
const reconcileNow = vi.fn();

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("notFound"); }, redirect: () => { throw new Error("redirect"); } }));
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getSession: async () => session } }) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), clientIp: () => "unknown" }));
vi.mock("@/server/super-admin/credits", () => ({ creditsOverview, creditsOrgDetail, applyCreditsAction, reconcileNow }));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "orderBy"]) c[m] = () => c;
  (c as { then: unknown }).then = (resolve: (v: unknown) => void) => Promise.resolve(rows).then(resolve);
  return c;
}
vi.mock("@/lib/db", () => ({
  getDb: () => ({ select: () => chain(selectQueue.shift() ?? []) }),
  schema: new Proxy({}, { get: (_t, table) => new Proxy({}, { get: (_t2, col) => `${String(table)}.${String(col)}` }) }),
}));

const asSuperAdmin = () => {
  session = { user: { id: "u1" } };
  selectQueue.push([{ isSuperAdmin: true, twoFactorEnabled: true, email: "a@x.test", name: "Ada" }], [{ id: "m1" }]);
};

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (orgId = "org_1") => ({ params: Promise.resolve({ orgId }) });

let rootRoute: typeof import("@/app/api/super-admin/credits/route");
let orgRoute: typeof import("@/app/api/super-admin/credits/[orgId]/route");

beforeAll(async () => {
  rootRoute = await import("@/app/api/super-admin/credits/route");
  orgRoute = await import("@/app/api/super-admin/credits/[orgId]/route");
}, 60_000);

beforeEach(() => {
  session = null;
  selectQueue.length = 0;
  for (const f of [creditsOverview, creditsOrgDetail, applyCreditsAction, reconcileNow]) f.mockReset();
});

const llamadas = {
  "GET /credits": () => rootRoute.GET(new Request("https://x/api/super-admin/credits")),
  "POST /credits": () => rootRoute.POST(new Request("https://x/api/super-admin/credits", json({ action: "reconcile" }))),
  "GET /credits/:org": () => orgRoute.GET(new Request("https://x/api/super-admin/credits/org_1"), ctx()),
  "POST /credits/:org": () =>
    orgRoute.POST(new Request("https://x/api/super-admin/credits/org_1", json({ action: "cut", cutEnabled: true })), ctx()),
} as const;

describe("la API de monedas es solo de Super Admin", () => {
  for (const [name, call] of Object.entries(llamadas)) {
    it(`${name}: sin sesión → 401`, async () => {
      expect((await call()).status).toBe(401);
    });
    it(`${name}: con sesión pero sin ser Super Admin → 404 (no revela que existe)`, async () => {
      session = { user: { id: "u2" } };
      selectQueue.push([{ isSuperAdmin: false, twoFactorEnabled: true, email: "b@x.test", name: "Bo" }]);
      expect((await call()).status).toBe(404);
    });
    it(`${name}: Super Admin sin segundo factor → 403`, async () => {
      session = { user: { id: "u3" } };
      selectQueue.push([{ isSuperAdmin: true, twoFactorEnabled: false, email: "c@x.test", name: "Cy" }]);
      expect((await call()).status).toBe(403);
    });
  }

  it("ninguna negada llegó al servicio de monedas", () => {
    expect(creditsOverview).not.toHaveBeenCalled();
    expect(creditsOrgDetail).not.toHaveBeenCalled();
    expect(applyCreditsAction).not.toHaveBeenCalled();
    expect(reconcileNow).not.toHaveBeenCalled();
  });
});

describe("rutas con Super Admin", () => {
  it("GET /credits devuelve el reporte (rango por defecto 30 días) y valida el rango", async () => {
    asSuperAdmin();
    creditsOverview.mockResolvedValue({ report: { enabled: true, rows: [] }, reconcile: null });
    const res = await rootRoute.GET(new Request("https://x/api/super-admin/credits?days=7"));
    expect(res.status).toBe(200);
    expect(creditsOverview).toHaveBeenCalledWith(7);
    asSuperAdmin();
    expect((await rootRoute.GET(new Request("https://x/api/super-admin/credits?days=9999"))).status).toBe(422);
    asSuperAdmin();
    await rootRoute.GET(new Request("https://x/api/super-admin/credits"));
    expect(creditsOverview).toHaveBeenLastCalledWith(30);
  });

  it("POST /credits concilia; con las monedas apagadas responde 409; repair solo si se pide", async () => {
    asSuperAdmin();
    reconcileNow.mockResolvedValue({ at: "x", checked: 2, drifts: [], repaired: 0, error: null });
    expect((await rootRoute.POST(new Request("https://x/api/super-admin/credits", json({ action: "reconcile" })))).status).toBe(200);
    expect(reconcileNow).toHaveBeenLastCalledWith(false);
    asSuperAdmin();
    await rootRoute.POST(new Request("https://x/api/super-admin/credits", json({ action: "reconcile", repair: true })));
    expect(reconcileNow).toHaveBeenLastCalledWith(true);
    asSuperAdmin();
    reconcileNow.mockResolvedValue(null);
    const off = await rootRoute.POST(new Request("https://x/api/super-admin/credits", json({ action: "reconcile" })));
    expect(off.status).toBe(409);
    expect((await off.json()).error.code).toBe("credits_off");
  });

  it("GET /credits/:org: 404 si la organización no existe", async () => {
    asSuperAdmin();
    creditsOrgDetail.mockResolvedValue(null);
    expect((await orgRoute.GET(new Request("https://x/a"), ctx("org_x"))).status).toBe(404);
  });

  it("POST /credits/:org: el ajuste lleva a quien lo hace, valida el cuerpo y traduce los resultados", async () => {
    const ajuste = { action: "adjust", bucket: "topup", coins: 25.5, note: "Compensación por falla", requestId: "req-12345678" };
    asSuperAdmin();
    applyCreditsAction.mockResolvedValue({ ok: true, duplicate: false });
    creditsOrgDetail.mockResolvedValue({ organizationId: "org_1" });
    const ok = await orgRoute.POST(new Request("https://x/a", json(ajuste)), ctx());
    expect(ok.status).toBe(200);
    expect(applyCreditsAction).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), "org_1", ajuste);

    // Cuerpos inválidos: sin motivo, en 0, con 3 decimales, sin requestId, acción desconocida → 422 y no se aplica nada.
    applyCreditsAction.mockClear();
    for (const malo of [
      { ...ajuste, note: "x" },
      { ...ajuste, coins: 0 },
      { ...ajuste, coins: 1.234 },
      { ...ajuste, requestId: "corto" },
      { ...ajuste, bucket: "otro" },
      { action: "borrar" },
    ]) {
      asSuperAdmin();
      expect((await orgRoute.POST(new Request("https://x/a", json(malo)), ctx())).status, JSON.stringify(malo)).toBe(422);
    }
    expect(applyCreditsAction).not.toHaveBeenCalled();

    asSuperAdmin();
    applyCreditsAction.mockResolvedValue({ ok: false, status: 422, code: "plan_would_be_negative", message: "no" });
    expect((await orgRoute.POST(new Request("https://x/a", json({ ...ajuste, bucket: "plan", coins: -999 })), ctx())).status).toBe(422);
    asSuperAdmin();
    applyCreditsAction.mockResolvedValue({ ok: false, status: 409, code: "credits_off", message: "off" });
    expect((await orgRoute.POST(new Request("https://x/a", json(ajuste)), ctx())).status).toBe(409);
  });
});

/* ───────── Conciliación diaria (con la puerta simulada) ───────── */

describe("conciliación diaria", () => {
  const reconcileCredits = vi.fn();
  let sync: typeof import("@/server/saas/credits-sync");

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("@/server/credits", () => ({
      creditsEnabled: () => process.env.CREDITS === "on",
      reconcileCredits,
      adjustPeriodQuota: vi.fn(),
      ensureDefaultRates: vi.fn(),
      expirePeriodQuota: vi.fn(),
      getCreditBalance: vi.fn(),
      grantPeriodQuota: vi.fn(),
    }));
    sync = await import("@/server/saas/credits-sync");
  }, 60_000);

  beforeEach(() => {
    reconcileCredits.mockReset();
    reconcileCredits.mockResolvedValue({ checked: 3, drifts: [], repaired: 0 });
    (globalThis as { __creditReconcile?: unknown }).__creditReconcile = undefined;
    vi.stubEnv("CREDITS", "on");
  });

  const T0 = new Date("2026-11-23T10:00:00.000Z");
  const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);

  it("corre la primera vez, no vuelve a correr en las siguientes 24 h y sí al cumplirse el día", async () => {
    expect(await sync.reconcileIfDue(T0)).toBe(true);
    expect(await sync.reconcileIfDue(hours(1))).toBe(false);
    expect(await sync.reconcileIfDue(hours(23))).toBe(false);
    expect(await sync.reconcileIfDue(hours(24))).toBe(true);
    expect(reconcileCredits).toHaveBeenCalledTimes(2);
    expect(sync.lastReconcile()).toMatchObject({ checked: 3, error: null });
  });

  it("sin repair por defecto: un descuadre se REGISTRA pero no se repara solo", async () => {
    reconcileCredits.mockResolvedValue({ checked: 2, drifts: [{ organizationId: "org_9", planCached: 5, planLedger: 4, topupCached: 0, topupLedger: 0 }], repaired: 0 });
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    await sync.reconcileIfDue(T0);
    expect(reconcileCredits).toHaveBeenCalledWith({ repair: false });
    expect(sync.lastReconcile()?.drifts).toHaveLength(1);
    expect(consola.mock.calls.some((c) => String(c[0]).includes("org_9"))).toBe(true);
    consola.mockRestore();
  });

  it("si la conciliación lanza, no lanza hacia el barrido: queda el error en el estado", async () => {
    reconcileCredits.mockRejectedValue(new Error("base caída"));
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sync.reconcileIfDue(T0)).resolves.toBe(true);
    expect(sync.lastReconcile()).toMatchObject({ error: "base caída", checked: 0 });
    consola.mockRestore();
  });

  it("a pedido del operador `repair` sí se pasa", async () => {
    await sync.runReconcile({ repair: true });
    expect(reconcileCredits).toHaveBeenCalledWith({ repair: true });
  });

  it("con CREDITS apagada no corre ni toca nada", async () => {
    vi.stubEnv("CREDITS", "");
    expect(await sync.reconcileIfDue(T0)).toBe(false);
    expect(await sync.runReconcile()).toBeNull();
    expect(reconcileCredits).not.toHaveBeenCalled();
  });
});

/* ───────── Cableado del barrido y cuotas de los planes ───────── */

describe("barrido y planes base", () => {
  const ROOT = path.resolve(import.meta.dirname, "..", "..");
  const leer = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

  it("el barrido horario concilia (una vez al día) DESPUÉS de las cuotas y fuera del try de la suscripción no lanza", () => {
    const code = leer("src/server/saas/subscription-sweeper.ts");
    expect(code).toContain("reconcileIfDue(now)");
    expect(code.indexOf("syncAllQuotas(now)")).toBeLessThan(code.indexOf("reconcileIfDue(now)"));
  });

  it("los planes base declaran su cuota mensual igual que la tabla provisional (Demo 200, Emprendedor 1000, Pro 3500, Enterprise sin tope)", async () => {
    const { BASE_PLANS } = await import("@/server/seed/platform-catalog");
    const { DEFAULT_PLAN_QUOTA_UNITS, UNLIMITED } = await import("@/lib/credits");
    const por = Object.fromEntries(BASE_PLANS.map((p) => [p.slug, (p.features as { monthlyCoins?: number }).monthlyCoins]));
    expect(por).toEqual({ demo: 20_000, emprendedor: 100_000, pro: 350_000, enterprise: UNLIMITED });
    for (const [slug, units] of Object.entries(DEFAULT_PLAN_QUOTA_UNITS)) expect(por[slug]).toBe(units);
  });
});

describe("contratos de las acciones", () => {
  it("el ajuste acepta hasta 2 decimales y negativos; el corte acepta tolerancia opcional", async () => {
    const { creditsActionSchema } = await import("@/lib/super-admin-credits");
    const base = { action: "adjust" as const, bucket: "plan" as const, note: "motivo válido", requestId: "req-12345678" };
    expect(creditsActionSchema.safeParse({ ...base, coins: -10.25 }).success).toBe(true);
    expect(creditsActionSchema.safeParse({ ...base, coins: 1_000_001 }).success).toBe(false);
    expect(creditsActionSchema.safeParse({ action: "cut", cutEnabled: false }).success).toBe(true);
    expect(creditsActionSchema.safeParse({ action: "cut", cutEnabled: true, overdraftCoins: 5 }).success).toBe(true);
    expect(creditsActionSchema.safeParse({ action: "cut", cutEnabled: true, overdraftCoins: -1 }).success).toBe(false);
  });
});
