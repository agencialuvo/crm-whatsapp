import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Monedas, sub-paso 5.3 (sin base real): el catálogo de paquetes de recarga. Validaciones de los cuerpos, que las
 * rutas del catálogo son SOLO de Super Admin (401 / 404 / 403), su cableado con el servicio, y que el listado para
 * clientes exige sesión, solo trae lo necesario y sale vacío con las monedas apagadas.
 */

let session: { user: { id: string } } | null = null;
const selectQueue: unknown[][] = [];
const packsOverview = vi.fn();
const packCreate = vi.fn();
const packUpdate = vi.fn();
const activePacks = vi.fn();
const requireSession = vi.fn();

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("notFound"); }, redirect: () => { throw new Error("redirect"); } }));
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getSession: async () => session } }) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), clientIp: () => "unknown" }));
vi.mock("@/server/super-admin/credits", () => ({ packsOverview, packCreate, packUpdate }));
vi.mock("@/server/saas/credits-summary", () => ({ activePacks }));
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), requireSession }));
vi.mock("@/server/saas/enforcement", async (orig) => ({ ...(await orig<typeof import("@/server/saas/enforcement")>()), subscriptionInactive: async () => null }));

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
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const pctx = (packId = "crk_1") => ({ params: Promise.resolve({ packId }) });

let rootRoute: typeof import("@/app/api/super-admin/credits/packs/route");
let idRoute: typeof import("@/app/api/super-admin/credits/packs/[packId]/route");
let publicRoute: typeof import("@/app/api/credits/packs/route");

beforeAll(async () => {
  rootRoute = await import("@/app/api/super-admin/credits/packs/route");
  idRoute = await import("@/app/api/super-admin/credits/packs/[packId]/route");
  publicRoute = await import("@/app/api/credits/packs/route");
}, 60_000);

beforeEach(() => {
  session = null;
  selectQueue.length = 0;
  for (const f of [packsOverview, packCreate, packUpdate, activePacks, requireSession]) f.mockReset();
});

const nuevo = { name: "Recarga 500", coins: 500, priceCents: 4990 };

const llamadas = {
  "GET /packs": () => rootRoute.GET(new Request("https://x/api/super-admin/credits/packs")),
  "POST /packs": () => rootRoute.POST(new Request("https://x/api/super-admin/credits/packs", json("POST", nuevo))),
  "PATCH /packs/:id": () => idRoute.PATCH(new Request("https://x/api/super-admin/credits/packs/crk_1", json("PATCH", { active: false })), pctx()),
} as const;

describe("el catálogo de paquetes es solo de Super Admin", () => {
  for (const [name, call] of Object.entries(llamadas)) {
    it(`${name}: sin sesión → 401`, async () => {
      expect((await call()).status).toBe(401);
    });
    it(`${name}: sin ser Super Admin → 404`, async () => {
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

  it("ninguna negada llegó al servicio", () => {
    expect(packsOverview).not.toHaveBeenCalled();
    expect(packCreate).not.toHaveBeenCalled();
    expect(packUpdate).not.toHaveBeenCalled();
  });
});

describe("rutas del catálogo con Super Admin", () => {
  it("GET lista el catálogo", async () => {
    asSuperAdmin();
    packsOverview.mockResolvedValue([{ id: "crk_1" }]);
    const res = await rootRoute.GET(new Request("https://x/a"));
    expect(res.status).toBe(200);
    expect((await res.json()).packs).toEqual([{ id: "crk_1" }]);
  });

  it("POST crea (201), con valores por defecto, y deja pasar a quien lo hizo para la auditoría", async () => {
    asSuperAdmin();
    packCreate.mockResolvedValue({ ok: true, pack: { id: "crk_9" }, changed: true });
    const res = await rootRoute.POST(new Request("https://x/a", json("POST", nuevo)));
    expect(res.status).toBe(201);
    expect(packCreate).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", email: "a@x.test" }), { ...nuevo, currency: "PEN", sortOrder: 0, active: true });
  });

  it("POST rechaza cuerpos inválidos (422) y no llega al servicio", async () => {
    const malos: Record<string, unknown>[] = [
      { ...nuevo, name: "x" }, // muy corto
      { ...nuevo, name: "x".repeat(61) },
      { ...nuevo, coins: 0 },
      { ...nuevo, coins: -5 },
      { ...nuevo, coins: 1.234 }, // 3 decimales
      { ...nuevo, coins: 1_000_001 },
      { ...nuevo, priceCents: 0 },
      { ...nuevo, priceCents: 49.9 }, // el precio va en centavos enteros
      { ...nuevo, priceCents: 10_000_001 },
      { ...nuevo, currency: "EUR" },
      { ...nuevo, sortOrder: -1 },
      { ...nuevo, sortOrder: 10_000 },
      { coins: 5, priceCents: 100 }, // sin nombre
    ];
    for (const malo of malos) {
      asSuperAdmin();
      expect((await rootRoute.POST(new Request("https://x/a", json("POST", malo)))).status, JSON.stringify(malo)).toBe(422);
    }
    expect(packCreate).not.toHaveBeenCalled();
  });

  it("POST traduce el nombre repetido (409) y el tope de paquetes (409)", async () => {
    asSuperAdmin();
    packCreate.mockResolvedValue({ ok: false, status: 409, code: "name_taken", message: "Ya existe" });
    const r = await rootRoute.POST(new Request("https://x/a", json("POST", nuevo)));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("name_taken");
  });

  it("PATCH cambia lo pedido, exige al menos un campo y rechaza campos desconocidos", async () => {
    asSuperAdmin();
    packUpdate.mockResolvedValue({ ok: true, pack: { id: "crk_1" }, changed: true });
    const ok = await idRoute.PATCH(new Request("https://x/a", json("PATCH", { priceCents: 5990, coins: 600, active: false })), pctx("crk_1"));
    expect(ok.status).toBe(200);
    expect(packUpdate).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), "crk_1", { priceCents: 5990, coins: 600, active: false });
    packUpdate.mockClear();
    for (const malo of [{}, { id: "otro" }, { units: 5 }, { priceCents: -1 }, { name: "" }]) {
      asSuperAdmin();
      expect((await idRoute.PATCH(new Request("https://x/a", json("PATCH", malo)), pctx())).status, JSON.stringify(malo)).toBe(422);
    }
    expect(packUpdate).not.toHaveBeenCalled();
  });

  it("PATCH: paquete inexistente → 404", async () => {
    asSuperAdmin();
    packUpdate.mockResolvedValue({ ok: false, status: 404, code: "not_found", message: "no" });
    expect((await idRoute.PATCH(new Request("https://x/a", json("PATCH", { active: true })), pctx("crk_x"))).status).toBe(404);
  });

  it("no existe DELETE: un paquete se desactiva, no se borra", () => {
    expect((idRoute as Record<string, unknown>).DELETE).toBeUndefined();
    expect((rootRoute as Record<string, unknown>).DELETE).toBeUndefined();
  });
});

describe("listado de paquetes para clientes", () => {
  it("sin sesión → 401", async () => {
    const { UnauthorizedError } = await import("@/lib/auth/session");
    requireSession.mockRejectedValue(new UnauthorizedError());
    expect((await publicRoute.GET()).status).toBe(401);
    expect(activePacks).not.toHaveBeenCalled();
  });

  it("con sesión devuelve lo que dice el servicio (solo activos y solo lo necesario)", async () => {
    requireSession.mockResolvedValue({ organizationId: "org_1", userId: "u", role: "member" });
    activePacks.mockResolvedValue({ enabled: true, packs: [{ id: "crk_1", name: "Recarga 500", units: 50_000, priceCents: 4990, currency: "PEN" }] });
    const res = await publicRoute.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, packs: [{ id: "crk_1", name: "Recarga 500", units: 50_000, priceCents: 4990, currency: "PEN" }] });
  });
});

describe("piezas puras", () => {
  it("parsePriceToCents: soles con coma o punto, máximo 2 decimales, mayor que 0", async () => {
    const { parsePriceToCents } = await import("@/lib/super-admin-credits");
    expect(parsePriceToCents("49.90")).toBe(4990);
    expect(parsePriceToCents("49,9")).toBe(4990);
    expect(parsePriceToCents(" 10 ")).toBe(1000);
    expect(parsePriceToCents("0.01")).toBe(1);
    for (const mal of ["", "0", "0.00", "-5", "1.234", "abc", "1e3", "1,2,3"]) expect(parsePriceToCents(mal), mal).toBeNull();
  });

  it("pricePerCoinCents compara paquetes por lo que cuesta cada moneda", async () => {
    const { pricePerCoinCents } = await import("@/lib/credits");
    expect(pricePerCoinCents({ units: 50_000, priceCents: 4990 })).toBeCloseTo(9.98, 2); // 500 monedas a S/ 49,90
    expect(pricePerCoinCents({ units: 100_000, priceCents: 8000 })).toBeLessThan(pricePerCoinCents({ units: 50_000, priceCents: 4990 }));
    expect(pricePerCoinCents({ units: 0, priceCents: 100 })).toBe(0);
  });

  it("los esquemas convierten el nombre (espacios) y aceptan solo los campos del contrato", async () => {
    const { packCreateSchema, packUpdateSchema } = await import("@/lib/super-admin-credits");
    expect(packCreateSchema.parse({ ...nuevo, name: "  Recarga   500  " }).name).toBe("Recarga 500");
    expect(packUpdateSchema.safeParse({ active: true }).success).toBe(true);
    expect(packUpdateSchema.safeParse({ units: 5 }).success).toBe(false);
  });
});

describe("cableado y vigilancia", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("el panel se monta en la pantalla de monedas del Super Admin", () => {
    expect(read("src/app/super-admin/(panel)/monedas/page.tsx")).toContain("<CreditPacksPanel />");
  });

  it("el panel nunca borra y desactiva por PATCH", () => {
    const code = read("src/components/super-admin/credit-packs-panel.tsx");
    expect(code).not.toContain('method: "DELETE"');
    expect(code).toContain('method: "PATCH"');
    expect(code).not.toContain("<select");
  });

  it("la puerta no depende de la bandera para el catálogo, pero el listado a clientes sí", () => {
    expect(read("src/server/credits/packs.ts")).not.toContain("creditsEnabled()");
    expect(read("src/server/saas/credits-summary.ts")).toMatch(/activePacks[\s\S]*?if \(!creditsEnabled\(\)\) return \{ enabled: false, packs: \[\] \}/);
  });
});
