import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MpApiError, mp } from "@/lib/mercadopago/client";
import { billingEnabled, extraCheckoutHosts, mpApiBase, paymentGraceDays } from "@/lib/mercadopago/config";

const TOKEN = "APP_USR-token-super-secreto";
const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  process.env.MP_ACCESS_TOKEN = TOKEN;
  process.env.MP_API_BASE = "https://api.test.local";
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.MP_ACCESS_TOKEN;
  delete process.env.MP_API_BASE;
  delete process.env.MERCADOPAGO;
  delete process.env.PAYMENT_GRACE_DAYS;
  delete process.env.WA_MOCK_ENABLED;
});

const run = async <T>(p: Promise<T>): Promise<T | MpApiError> => {
  const settled = p.catch((e) => e as MpApiError);
  await vi.advanceTimersByTimeAsync(5000);
  return settled;
};

describe("cliente de Mercado Pago", () => {
  it("manda el token, la base configurada y la clave de idempotencia", async () => {
    const f = vi.fn().mockResolvedValue(res(201, { id: "mpre1", status: "pending", init_point: "https://x" }));
    vi.stubGlobal("fetch", f);
    const out = await run(
      mp.createPreapproval(
        { reason: "r", external_reference: "bck_1", payer_email: "a@b.pe", back_url: "https://app/x", status: "pending", auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: 149, currency_id: "PEN" } },
        "bck_1"
      )
    );
    expect(out).toMatchObject({ id: "mpre1" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.test.local/preapproval");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["X-Idempotency-Key"]).toBe("bck_1");
  });

  it.each([
    [401, "auth", false],
    [403, "auth", false],
    [404, "not_found", false],
    [400, "invalid", false],
  ])("clasifica el HTTP %i como %s (sin reintento)", async (status, kind, retryable) => {
    const f = vi.fn().mockResolvedValue(res(status, { message: "x" }));
    vi.stubGlobal("fetch", f);
    const out = await run(mp.getPreapproval("p1"));
    expect(out).toBeInstanceOf(MpApiError);
    expect((out as MpApiError).kind).toBe(kind);
    expect((out as MpApiError).retryable).toBe(retryable);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("reintenta UNA vez un 5xx y se recupera", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200, { id: "p1", status: "authorized" }));
    vi.stubGlobal("fetch", f);
    expect(await run(mp.getPreapproval("p1"))).toMatchObject({ status: "authorized" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("si el reintento también falla, propaga el error transitorio (el webhook responde 5xx)", async () => {
    const f = vi.fn().mockResolvedValue(res(500));
    vi.stubGlobal("fetch", f);
    const out = (await run(mp.getPreapproval("p1"))) as MpApiError;
    expect(out.kind).toBe("transient");
    expect(out.retryable).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("un 429 respeta retry-after y es reintentable", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429, {}, { "retry-after": "1" })).mockResolvedValueOnce(res(200, { id: "p1", status: "pending" }));
    vi.stubGlobal("fetch", f);
    expect(await run(mp.getPreapproval("p1"))).toMatchObject({ id: "p1" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("un corte de red es transitorio", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect(((await run(mp.getPreapproval("p1"))) as MpApiError).kind).toBe("transient");
  });

  it("el token NUNCA aparece en el mensaje de un error aunque Mercado Pago lo eco", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(400, { message: `bad token ${TOKEN}` })));
    const out = (await run(mp.getPreapproval("p1"))) as MpApiError;
    expect(out.message).not.toContain(TOKEN);
    expect(String(out.stack)).not.toContain(TOKEN);
  });

  it("codifica los ids en la ruta", async () => {
    const f = vi.fn().mockResolvedValue(res(200, { id: "x" }));
    vi.stubGlobal("fetch", f);
    await run(mp.getPreapproval("../users/me"));
    expect(f.mock.calls[0]![0]).toBe("https://api.test.local/preapproval/..%2Fusers%2Fme");
  });
});

describe("configuración del conector", () => {
  it("apagado por defecto; encendido solo con la bandera Y el token", () => {
    expect(billingEnabled()).toBe(false);
    process.env.MERCADOPAGO = "on";
    expect(billingEnabled()).toBe(true);
    delete process.env.MP_ACCESS_TOKEN;
    expect(billingEnabled()).toBe(false);
    process.env.MP_ACCESS_TOKEN = TOKEN;
    process.env.MERCADOPAGO = "off";
    expect(billingEnabled()).toBe(false);
  });
  it("la base por defecto es la real y los días de gracia, 5", () => {
    delete process.env.MP_API_BASE;
    expect(mpApiBase()).toBe("https://api.mercadopago.com");
    expect(paymentGraceDays()).toBe(5);
    process.env.PAYMENT_GRACE_DAYS = "9";
    expect(paymentGraceDays()).toBe(9);
    process.env.PAYMENT_GRACE_DAYS = "-3";
    expect(paymentGraceDays()).toBe(5);
  });
  it("el host del mock solo se permite con los mocks encendidos", () => {
    expect(extraCheckoutHosts()).toEqual([]);
    process.env.WA_MOCK_ENABLED = "true";
    process.env.MP_API_BASE = "http://localhost:3002/api/dev/mp-mock";
    expect(extraCheckoutHosts()).toEqual(["localhost:3002"]);
  });
});
