import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Monedas, 5.4 (sin base real y sin red): lo puro de Culqi (eventos, secreto, lectura tolerante de respuestas), el
 * cliente HTTP (la llave nunca se filtra, clasifica errores, no reintenta lo que crea cosas), el webhook (404 / 503 /
 * 401 / 200 / 5xx), las rutas de compra del cliente y del reembolso del Super Admin, y las reglas de vigilancia.
 */

let session: { user: { id: string } } | null = null;
const selectQueue: unknown[][] = [];
const requireSession = vi.fn();
const startTopupPurchase = vi.fn();
const topupStatus = vi.fn();
const confirmOrder = vi.fn();
const confirmRefund = vi.fn();
const topupRefund = vi.fn();
const rateAllowed = { value: true };

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("notFound"); }, redirect: () => { throw new Error("redirect"); } }));
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getSession: async () => session } }) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ allowed: rateAllowed.value }), clientIp: () => "unknown" }));
vi.mock("@/server/billing/credit-topup", () => ({ startTopupPurchase, topupStatus, confirmOrder, confirmRefund }));
vi.mock("@/server/super-admin/credits", () => ({ topupRefund }));
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

const SRC = path.resolve(__dirname, "../../src");
const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, "/");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = path.join(d, n); return statSync(f).isDirectory() ? walk(f) : /\.(ts|tsx)$/.test(f) ? [f] : []; });
const leer = (f: string) => readFileSync(f, "utf8");

const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const hook = (body: unknown, query = "") => new Request(`http://localhost/api/webhooks/culqi${query}`, post(body));

describe("lo puro de Culqi", () => {
  let w: typeof import("@/lib/culqi/webhook");
  let cl: typeof import("@/lib/culqi/client");
  beforeAll(async () => {
    w = await import("@/lib/culqi/webhook");
    cl = await import("@/lib/culqi/client");
  });

  it("parseCulqiEvent acepta data como texto JSON o como objeto, y rechaza lo que no es un evento", () => {
    expect(w.parseCulqiEvent({ type: "order.status.changed", data: JSON.stringify({ id: "ord_1" }) })).toEqual({ type: "order.status.changed", resourceId: "ord_1", chargeId: null, orderId: "ord_1" });
    expect(w.parseCulqiEvent({ type: "order.status.changed", data: { id: "ord_2" } })?.orderId).toBe("ord_2");
    expect(w.parseCulqiEvent({ type: "refund.creation.succeeded", data: { id: "ref_1", charge_id: "chr_1" } })).toMatchObject({ chargeId: "chr_1", orderId: null });
    expect(w.parseCulqiEvent({ type: "charge.creation.succeeded", data: { id: "chr_1", order_id: "ord_9" } })?.orderId).toBe("ord_9");
    for (const bad of [null, "x", 5, {}, { type: "" }, { type: "x".repeat(81) }, { data: {} }]) expect(w.parseCulqiEvent(bad)).toBeNull();
    expect(w.parseCulqiEvent({ type: "order.x", data: "no es json{" })).toMatchObject({ orderId: null });
  });

  it("secretMatches: igual o nada; sin secreto nunca", () => {
    expect(w.secretMatches("s3cret", "s3cret")).toBe(true);
    for (const [a, b] of [["s3cre", "s3cret"], ["s3cretx", "s3cret"], ["", "s3cret"], [null, "s3cret"], ["s3cret", undefined], ["", ""]] as const) expect(w.secretMatches(a, b)).toBe(false);
  });

  it("webhookToken lee el encabezado o el query", () => {
    expect(w.webhookToken(new Request("http://x/y?token=a"))).toBe("a");
    expect(w.webhookToken(new Request("http://x/y", { headers: { "x-webhook-token": "b" } }))).toBe("b");
    expect(w.webhookToken(new Request("http://x/y"))).toBeNull();
  });

  it("toOrder/toCharge leen lo que reconocen y dejan en null lo demás (nunca inventan)", () => {
    expect(cl.toOrder({ id: "ord_1", state: "paid", order_number: "crt_1", amount: 4990, currency_code: "PEN", charges: [{ id: "chr_1" }] })).toMatchObject({ id: "ord_1", state: "paid", orderNumber: "crt_1", amount: 4990, currency: "PEN", chargeId: "chr_1" });
    expect(cl.toOrder({ id: "ord_1", state: "rarisimo" })).toMatchObject({ state: "unknown", amount: null, orderNumber: null, chargeId: null });
    expect(cl.toOrder({ id: "ord_1", charge_id: "chr_2" })?.chargeId).toBe("chr_2");
    expect(cl.toOrder({ state: "paid" })).toBeNull();
    expect(cl.toOrder(null)).toBeNull();
    expect(cl.toCharge({ id: "chr_1", amount: 100, currency_code: "PEN", amount_refunded: 100, order_id: "ord_1" })).toMatchObject({ refundedAmount: 100, orderId: "ord_1" });
    expect(cl.toCharge({ id: "chr_1" })).toMatchObject({ refundedAmount: null });
    expect(cl.toCharge({})).toBeNull();
  });
});

describe("el cliente HTTP de Culqi (fetch simulado)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CULQI_SECRET_KEY", "sk_test_SECRETA");
    vi.stubEnv("CULQI_API_BASE", "https://culqi.test/v2");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const orderBody = { amount: 4990, currency_code: "PEN", description: "d", order_number: "crt_1", expiration_date: 1, client_details: { first_name: "A", last_name: "B", email: "a@b.c" }, confirm: false as const };

  it("manda la llave como Bearer a la base configurada y lee la orden", async () => {
    const { culqi } = await import("@/lib/culqi/client");
    fetchMock.mockResolvedValueOnce(ok({ id: "ord_1", state: "pending", order_number: "crt_1", amount: 4990, currency_code: "PEN" }));
    const o = await culqi.createOrder(orderBody);
    expect(o).toMatchObject({ id: "ord_1", state: "pending" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://culqi.test/v2/orders");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk_test_SECRETA" });
  });

  it("clasifica los errores y la llave JAMÁS aparece en el mensaje", async () => {
    const { culqi, CulqiApiError } = await import("@/lib/culqi/client");
    fetchMock.mockResolvedValueOnce(new Response("eco de sk_test_SECRETA en el cuerpo", { status: 400 }));
    const e1 = await culqi.createOrder(orderBody).catch((e) => e);
    expect(e1).toBeInstanceOf(CulqiApiError);
    expect(e1).toMatchObject({ kind: "invalid", status: 400, retryable: false });
    expect(e1.message).not.toContain("sk_test_SECRETA");
    expect(e1.message).toContain("[llave]");
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    expect(await culqi.getOrder("ord_1").catch((e) => e)).toMatchObject({ kind: "auth", retryable: false });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    expect(await culqi.getOrder("ord_x").catch((e) => e)).toMatchObject({ kind: "not_found" });
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await culqi.createRefund({ amount: 1, charge_id: "c", reason: "r" }).catch((e) => e)).toMatchObject({ kind: "transient", retryable: true });
  });

  it("las lecturas reintentan una vez; crear órdenes y reembolsos NUNCA se reintentan (no se duplica un cobro)", async () => {
    const { culqi } = await import("@/lib/culqi/client");
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(ok({ id: "ord_1", state: "paid" }));
    expect(await culqi.getOrder("ord_1")).toMatchObject({ state: "paid" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("", { status: 503 }));
    await expect(culqi.createOrder(orderBody)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await expect(culqi.createRefund({ amount: 1, charge_id: "c", reason: "r" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("una respuesta ilegible es un error, no un objeto a medias", async () => {
    const { culqi } = await import("@/lib/culqi/client");
    fetchMock.mockResolvedValueOnce(ok({ sin: "id" }));
    await expect(culqi.createOrder(orderBody)).rejects.toThrow(/ilegible/);
  });
});

describe("el webhook de Culqi", () => {
  let route: typeof import("@/app/api/webhooks/culqi/route");
  beforeAll(async () => {
    route = await import("@/app/api/webhooks/culqi/route");
  });
  beforeEach(() => {
    for (const f of [confirmOrder, confirmRefund]) f.mockReset();
    vi.stubEnv("CULQI", "on");
    vi.stubEnv("CULQI_SECRET_KEY", "sk_test_x");
    vi.stubEnv("CULQI_WEBHOOK_SECRET", "hook-secret");
  });
  afterEach(() => vi.unstubAllEnvs());
  const orderEvent = { type: "order.status.changed", data: JSON.stringify({ id: "ord_1" }) };

  it("apagado → 404 sin leer nada; sin secreto → 503; secreto malo o ausente → 401, y en ninguno se atiende", async () => {
    vi.stubEnv("CULQI", "");
    expect((await route.POST(hook(orderEvent, "?token=hook-secret"))).status).toBe(404);
    vi.stubEnv("CULQI", "on");
    vi.stubEnv("CULQI_WEBHOOK_SECRET", "");
    expect((await route.POST(hook(orderEvent, "?token=hook-secret"))).status).toBe(503);
    vi.stubEnv("CULQI_WEBHOOK_SECRET", "hook-secret");
    expect((await route.POST(hook(orderEvent))).status).toBe(401);
    expect((await route.POST(hook(orderEvent, "?token=otro"))).status).toBe(401);
    expect(confirmOrder).not.toHaveBeenCalled();
  });

  it("evento de orden → confirma consultando a Culqi (el cuerpo no decide nada)", async () => {
    confirmOrder.mockResolvedValueOnce({ status: "applied" });
    const res = await route.POST(hook(orderEvent, "?token=hook-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handled: true, result: "applied" });
    expect(confirmOrder).toHaveBeenCalledWith("ord_1");
    // El secreto también vale por encabezado.
    confirmOrder.mockResolvedValueOnce({ status: "duplicate" });
    const r2 = await route.POST(new Request("http://localhost/api/webhooks/culqi", post(orderEvent, { "x-webhook-token": "hook-secret" })));
    expect(r2.status).toBe(200);
  });

  it("evento de reembolso → confirma el cargo; tipos desconocidos y cuerpos basura → 200 sin hacer nada", async () => {
    confirmRefund.mockResolvedValueOnce({ status: "applied" });
    const r = await route.POST(hook({ type: "refund.creation.succeeded", data: { id: "ref_1", charge_id: "chr_1" } }, "?token=hook-secret"));
    expect(r.status).toBe(200);
    expect(confirmRefund).toHaveBeenCalledWith("chr_1");
    for (const body of [{ type: "customer.created", data: { id: "cus_1" } }, { nada: true }, "texto"]) {
      const res = await route.POST(hook(body, "?token=hook-secret"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ handled: false });
    }
    const raw = await route.POST(new Request("http://localhost/api/webhooks/culqi?token=hook-secret", { method: "POST", body: "{no json" }));
    expect(raw.status).toBe(200);
    expect(confirmOrder).not.toHaveBeenCalled();
  });

  it("si Culqi o la base fallan responde 503 (Culqi reintenta); un error definitivo de Culqi responde 200", async () => {
    const { CulqiApiError } = await import("@/lib/culqi/client");
    confirmOrder.mockRejectedValueOnce(new CulqiApiError("transient", 503, "caído", true));
    expect((await route.POST(hook(orderEvent, "?token=hook-secret"))).status).toBe(503);
    confirmOrder.mockRejectedValueOnce(new Error("la base se cayó"));
    expect((await route.POST(hook(orderEvent, "?token=hook-secret"))).status).toBe(503);
    confirmOrder.mockRejectedValueOnce(new CulqiApiError("not_found", 404, "no existe", false));
    expect((await route.POST(hook(orderEvent, "?token=hook-secret"))).status).toBe(200);
    confirmOrder.mockResolvedValueOnce({ status: "disabled" });
    expect((await route.POST(hook(orderEvent, "?token=hook-secret"))).status).toBe(503);
  });
});

describe("rutas de compra del cliente", () => {
  let buy: typeof import("@/app/api/credits/topups/route");
  let status: typeof import("@/app/api/credits/topups/[topupId]/route");
  beforeAll(async () => {
    buy = await import("@/app/api/credits/topups/route");
    status = await import("@/app/api/credits/topups/[topupId]/route");
  });
  beforeEach(() => {
    for (const f of [requireSession, startTopupPurchase, topupStatus]) f.mockReset();
    rateAllowed.value = true;
    vi.stubEnv("APP_BASE_URL", "https://app.test");
  });
  afterEach(() => vi.unstubAllEnvs());
  const asOwner = (role = "owner") => requireSession.mockResolvedValue({ userId: "u1", organizationId: "org_1", role });
  const req = (body: unknown, headers: Record<string, string> = {}) => new Request("https://app.test/api/credits/topups", post(body, headers));
  const ctx = (topupId = "crt_1") => ({ params: Promise.resolve({ topupId }) });

  it("sin sesión → 401 en ambas", async () => {
    const { UnauthorizedError } = await import("@/lib/auth/session");
    requireSession.mockRejectedValue(new UnauthorizedError());
    expect((await buy.POST(req({ packId: "crk_1" }))).status).toBe(401);
    expect((await status.GET(new Request("https://app.test/x"), ctx())).status).toBe(401);
    expect(startTopupPurchase).not.toHaveBeenCalled();
  });

  it("solo el dueño compra (403), solo desde el propio sitio (403) y con límite de tasa (429)", async () => {
    asOwner("member");
    expect((await buy.POST(req({ packId: "crk_1" }))).status).toBe(403);
    asOwner();
    expect((await buy.POST(req({ packId: "crk_1" }, { origin: "https://malo.test" }))).status).toBe(403);
    rateAllowed.value = false;
    expect((await buy.POST(req({ packId: "crk_1" }))).status).toBe(429);
    expect(startTopupPurchase).not.toHaveBeenCalled();
  });

  it("valida el cuerpo: packId obligatorio, teléfono con forma; el cuerpo NO puede traer monto ni organización", async () => {
    asOwner();
    for (const body of [{}, { packId: "" }, { packId: "x".repeat(65) }, { packId: "crk_1", phone: "abc" }, { packId: 5 }]) {
      expect((await buy.POST(req(body))).status).toBe(422);
    }
    expect(startTopupPurchase).not.toHaveBeenCalled();
    startTopupPurchase.mockResolvedValueOnce({ ok: true, topupId: "crt_1", orderId: "ord_1", publicKey: "pk", paymentCode: null, units: 1, amountCents: 1, currency: "PEN", expiresAt: "x" });
    const res = await buy.POST(req({ packId: "crk_1", phone: "+51999888777", amountCents: 1, organizationId: "org_ajena" }));
    expect(res.status).toBe(201);
    expect(startTopupPurchase).toHaveBeenCalledWith({ organizationId: "org_1", userId: "u1", packId: "crk_1", phone: "+51999888777" });
    const body = await res.json();
    expect(body).toMatchObject({ topupId: "crt_1", orderId: "ord_1" });
    expect(body).not.toHaveProperty("ok");
  });

  it("traduce los fallos del servicio (404 apagado / paquete, 429, 502, 503)", async () => {
    asOwner();
    for (const [status_, code] of [[404, "pack_not_found"], [429, "too_many_pending"], [502, "gateway_error"], [503, "not_configured"]] as const) {
      startTopupPurchase.mockResolvedValueOnce({ ok: false, status: status_, code, message: "m" });
      const r = await buy.POST(req({ packId: "crk_1" }));
      expect(r.status).toBe(status_);
      expect((await r.json()).error.code).toBe(code);
    }
  });

  it("el estado de una compra: la organización sale de la sesión; ajena o inexistente → 404", async () => {
    asOwner("member");
    topupStatus.mockResolvedValueOnce({ id: "crt_1", status: "paid" });
    const ok = await status.GET(new Request("https://app.test/x"), ctx("crt_1"));
    expect(ok.status).toBe(200);
    expect(topupStatus).toHaveBeenCalledWith("org_1", "crt_1");
    topupStatus.mockResolvedValueOnce(null);
    expect((await status.GET(new Request("https://app.test/x"), ctx("crt_otra"))).status).toBe(404);
    rateAllowed.value = false;
    expect((await status.GET(new Request("https://app.test/x"), ctx())).status).toBe(429);
  });
});

describe("reembolso del Super Admin", () => {
  let route: typeof import("@/app/api/super-admin/credits/topups/[topupId]/refund/route");
  beforeAll(async () => {
    route = await import("@/app/api/super-admin/credits/topups/[topupId]/refund/route");
  });
  beforeEach(() => {
    session = null;
    selectQueue.length = 0;
    topupRefund.mockReset();
    rateAllowed.value = true;
  });
  const ctx = (topupId = "crt_1") => ({ params: Promise.resolve({ topupId }) });
  const asSuperAdmin = () => {
    session = { user: { id: "u1" } };
    selectQueue.push([{ isSuperAdmin: true, twoFactorEnabled: true, email: "a@x.test", name: "Ada" }], [{ id: "m1" }]);
  };

  it("401 sin sesión, 404 si no es Super Admin, 403 sin 2FA; ninguno llega al servicio", async () => {
    expect((await route.POST(new Request("http://x/r", post({})), ctx())).status).toBe(401);
    session = { user: { id: "u1" } };
    selectQueue.push([{ isSuperAdmin: false, twoFactorEnabled: true, email: "a", name: "A" }]);
    expect((await route.POST(new Request("http://x/r", post({})), ctx())).status).toBe(404);
    session = { user: { id: "u1" } };
    selectQueue.push([{ isSuperAdmin: true, twoFactorEnabled: false, email: "a", name: "A" }], [{ id: "m1" }]);
    expect((await route.POST(new Request("http://x/r", post({})), ctx())).status).toBe(403);
    expect(topupRefund).not.toHaveBeenCalled();
  });

  it("valida el motivo (3–200, sin campos extra), reembolsa y devuelve duplicate; traduce fallos", async () => {
    asSuperAdmin();
    expect((await route.POST(new Request("http://x/r", post({ reason: "x" })), ctx())).status).toBe(422);
    asSuperAdmin();
    expect((await route.POST(new Request("http://x/r", post({ reason: "ok bien", units: 5 })), ctx())).status).toBe(422);
    asSuperAdmin();
    topupRefund.mockResolvedValueOnce({ ok: true, duplicate: false });
    const r = await route.POST(new Request("http://x/r", post({ reason: "Pedido del cliente" })), ctx("crt_9"));
    expect(await r.json()).toEqual({ refunded: true, duplicate: false });
    expect(topupRefund).toHaveBeenCalledWith("u1", "crt_9", "Pedido del cliente");
    asSuperAdmin();
    topupRefund.mockResolvedValueOnce({ ok: true, duplicate: true });
    expect(await (await route.POST(new Request("http://x/r", post({})), ctx())).json()).toEqual({ refunded: true, duplicate: true });
    asSuperAdmin();
    topupRefund.mockResolvedValueOnce({ ok: false, status: 409, code: "not_paid", message: "m" });
    expect((await route.POST(new Request("http://x/r", post({})), ctx())).status).toBe(409);
  });
});

describe("vigilancia: Culqi queda en su rincón", () => {
  const todos = walk(SRC);

  it("solo lib/culqi/{config,client}.ts leen las llaves y hablan con la API de Culqi", () => {
    const lectores = todos.filter((f) => /CULQI_SECRET_KEY|CULQI_WEBHOOK_SECRET|CULQI_PUBLIC_KEY|api\.culqi\.com/.test(leer(f)));
    // `env.ts` solo las declara para el doctor; el webhook compara el secreto vía config.
    expect(lectores.map(rel).sort()).toEqual(["lib/culqi/client.ts", "lib/culqi/config.ts", "lib/env.ts"]);
  });

  it("nada de Culqi toca la suscripción (Mercado Pago) y nada de Mercado Pago toca las recargas", () => {
    for (const f of todos.filter((x) => rel(x).startsWith("lib/culqi/") || rel(x) === "server/billing/credit-topup.ts")) {
      expect(leer(f), rel(f)).not.toMatch(/from "[^"]*mercadopago|from "@\/server\/saas\/subscription|from "@\/server\/billing\/(core|webhook|checkout|change)/);
    }
    for (const f of todos.filter((x) => /server\/billing\/(core|webhook|checkout|change|reconcile)\.ts$/.test(rel(x)))) {
      expect(leer(f), rel(f)).not.toMatch(/from "[^"]*(culqi|credit-topup)/i);
    }
  });

  it("las rutas de compra y de webhook no importan la puerta de monedas: pasan por server/billing/credit-topup", () => {
    for (const r of ["app/api/credits/topups/route.ts", "app/api/credits/topups/[topupId]/route.ts", "app/api/webhooks/culqi/route.ts", "app/api/super-admin/credits/topups/[topupId]/refund/route.ts"]) {
      expect(leer(path.join(SRC, r)), r).not.toMatch(/from "@\/server\/credits/);
    }
  });

  it("el cliente de Culqi nunca reintenta lo que crea cosas", () => {
    const code = leer(path.join(SRC, "lib/culqi/client.ts"));
    expect(code).toMatch(/createOrder:[\s\S]*?call\("POST", "\/orders", body\)/);
    expect(code).toMatch(/call\("POST", "\/refunds", body\)/);
    expect(code).not.toMatch(/call\("POST"[^)]*true\)/);
  });

  it("el webhook compara el secreto en tiempo constante y no abona por lo que diga el cuerpo", () => {
    expect(leer(path.join(SRC, "lib/culqi/webhook.ts"))).toContain("timingSafeEqual");
    const route = leer(path.join(SRC, "app/api/webhooks/culqi/route.ts"));
    expect(route).toContain("secretMatches");
    expect(route).not.toMatch(/applyTopup|refundTopup/);
  });

  it("CULQI y las monedas arrancan apagadas: sin variables, nada está encendido", async () => {
    vi.stubEnv("CULQI", "");
    vi.stubEnv("CREDITS", "");
    vi.stubEnv("CULQI_SECRET_KEY", "sk");
    const { culqiEnabled } = await import("@/lib/culqi/config");
    expect(culqiEnabled()).toBe(false);
    vi.stubEnv("CULQI", "on");
    vi.stubEnv("CULQI_SECRET_KEY", "");
    expect(culqiEnabled()).toBe(false); // encendido pero sin llave = apagado
    vi.stubEnv("CULQI_SECRET_KEY", "sk");
    expect(culqiEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});
