import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Monedas, 5.4, contra PostgreSQL REAL y con Culqi SIMULADO (ninguna llamada de red real): comprar un paquete,
 * abonar al confirmarse el pago (una sola vez aunque el aviso se repita o llegue a la vez), no abonar si el pago no
 * coincide, el pago tardío, el reembolso idempotente y el barrido de compras abiertas.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

type FakeOrder = { id: string; state: string; orderNumber: string | null; amount: number | null; currency: string | null; chargeId: string | null; paymentCode: string | null };
const orders = new Map<string, FakeOrder>();
const charges = new Map<string, { id: string; amount: number; currency: string; refundedAmount: number | null; orderId: string | null }>();
const calls = { createOrder: [] as unknown[], createRefund: [] as unknown[], getOrder: 0 };
const behavior = { createOrderFails: false, refundFails: false, getOrderFails: false };
let seq = 0;

vi.mock("@/lib/culqi/client", async (orig) => {
  const real = await orig<typeof import("@/lib/culqi/client")>();
  return {
    ...real,
    culqi: {
      createOrder: async (body: { amount: number; currency_code: string; order_number: string }) => {
        calls.createOrder.push(body);
        if (behavior.createOrderFails) throw new real.CulqiApiError("transient", 503, "Culqi tuvo un error", true);
        const o: FakeOrder = { id: `ord_test_${++seq}_${Date.now().toString(36)}`, state: "pending", orderNumber: body.order_number, amount: body.amount, currency: body.currency_code, chargeId: null, paymentCode: "123456" };
        orders.set(o.id, o);
        return o;
      },
      getOrder: async (id: string) => {
        calls.getOrder++;
        if (behavior.getOrderFails) throw new real.CulqiApiError("transient", 503, "Culqi tuvo un error", true);
        const o = orders.get(id);
        if (!o) throw new real.CulqiApiError("not_found", 404, "Recurso no encontrado en Culqi", false);
        return o;
      },
      getCharge: async (id: string) => {
        const ch = charges.get(id);
        if (!ch) throw new real.CulqiApiError("not_found", 404, "Recurso no encontrado en Culqi", false);
        return ch;
      },
      createRefund: async (body: { charge_id: string }) => {
        calls.createRefund.push(body);
        if (behavior.refundFails) throw new real.CulqiApiError("invalid", 400, "Culqi rechazó la solicitud (400)", false);
        return { id: "ref_test_1" };
      },
    },
  };
});

describe.skipIf(!live)("monedas 5.4 (base real, Culqi simulado)", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let like: (typeof import("drizzle-orm"))["like"];
  let and: (typeof import("drizzle-orm"))["and"];
  let c: typeof import("@/server/credits");
  let p: typeof import("@/server/billing/credit-topup");
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  const tag = Date.now().toString(36);
  const userId = `usr_t${tag}`;
  const orgId = `org_t${tag}`;
  const orgOther = `org_u${tag}`;
  const nm = (n: string) => `Recarga ${tag} ${n}`;
  const bal = async (org = orgId) => (await c.getCreditBalance(org)) ?? { plan: 0, topup: 0, total: 0 };
  let packId = "";
  let inactivePackId = "";

  const start = (over: Partial<Parameters<typeof p.startTopupPurchase>[0]> = {}) => p.startTopupPurchase({ organizationId: orgId, userId, packId, ...over });
  /** Compra iniciada y lista (orden en Culqi simulado). */
  async function bought() {
    const r = await start();
    if (!r.ok) throw new Error(`no se pudo comprar: ${r.code}`);
    return r;
  }
  const pay = (orderId: string, over: Partial<FakeOrder> = {}) => Object.assign(orders.get(orderId)!, { state: "paid", chargeId: `chr_test_${orderId}` }, over);
  const topupRow = async (id: string) => (await db.select().from(schema.creditTopup).where(eq(schema.creditTopup.id, id)))[0]!;

  beforeAll(async () => {
    ({ eq, like, and } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    c = await import("@/server/credits");
    p = await import("@/server/billing/credit-topup");
    await db.insert(schema.user).values({ id: userId, name: "Ana Pérez Soto", email: `t.${tag}@example.com` });
    await db.insert(schema.organization).values({ id: orgId, name: `Org ${orgId}`, slug: orgId.toLowerCase() });
    await db.insert(schema.organization).values({ id: orgOther, name: `Org ${orgOther}`, slug: orgOther.toLowerCase() });
    const [a] = await db.insert(schema.creditPack).values({ id: `crk_t${tag}a`, name: nm("A"), units: 50_000, priceCents: 4990, currency: "PEN", sortOrder: 0, active: true }).returning();
    const [b] = await db.insert(schema.creditPack).values({ id: `crk_t${tag}b`, name: nm("B"), units: 10_000, priceCents: 1000, currency: "PEN", sortOrder: 1, active: false }).returning();
    packId = a!.id;
    inactivePackId = b!.id;
  }, 60_000);

  beforeEach(async () => {
    vi.stubEnv("CREDITS", "on");
    // El tope de compras abiertas es por organización: cada prueba parte sin pendientes de las anteriores.
    if (db) await db.delete(schema.creditTopup).where(and(eq(schema.creditTopup.organizationId, orgId), eq(schema.creditTopup.status, "pending")));
    vi.stubEnv("CULQI", "on");
    vi.stubEnv("CULQI_SECRET_KEY", "sk_test_no_real");
    vi.stubEnv("CULQI_PUBLIC_KEY", "pk_test_no_real");
    calls.createOrder.length = 0;
    calls.createRefund.length = 0;
    calls.getOrder = 0;
    Object.assign(behavior, { createOrderFails: false, refundFails: false, getOrderFails: false });
    fetchSpy.mockClear();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!db) return;
    for (const org of [orgId, orgOther]) {
      await db.delete(schema.creditLedger).where(eq(schema.creditLedger.organizationId, org));
      await db.delete(schema.creditTopup).where(eq(schema.creditTopup.organizationId, org));
      await db.delete(schema.creditAccount).where(eq(schema.creditAccount.organizationId, org));
      await db.delete(schema.organization).where(eq(schema.organization.id, org));
    }
    await db.delete(schema.creditPack).where(like(schema.creditPack.name, `Recarga ${tag}%`));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  });

  describe("comprar", () => {
    it("crea la compra con el monto del paquete y una orden en Culqi cuyo order_number es la compra", async () => {
      const r = await start({ phone: "+51999888777" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r).toMatchObject({ units: 50_000, amountCents: 4990, currency: "PEN", publicKey: "pk_test_no_real" });
      expect(r.topupId).toMatch(/^crt_/);
      const sent = calls.createOrder[0] as { amount: number; currency_code: string; order_number: string; confirm: boolean; client_details: { first_name: string; last_name: string; phone_number?: string } };
      expect(sent).toMatchObject({ amount: 4990, currency_code: "PEN", order_number: r.topupId, confirm: false });
      expect(sent.client_details).toMatchObject({ first_name: "Ana", last_name: "Pérez Soto", phone_number: "51999888777" });
      const t = await topupRow(r.topupId);
      expect(t).toMatchObject({ status: "pending", gateway: "culqi", gatewayOrderId: r.orderId, organizationId: orgId });
      expect((await bal()).topup).toBe(0); // todavía no hay saldo: nadie pagó
    });

    it("un paquete inactivo o inexistente no se puede comprar y no llama a Culqi", async () => {
      expect(await start({ packId: inactivePackId })).toMatchObject({ ok: false, status: 404, code: "pack_not_found" });
      expect(await start({ packId: "crk_no_existe" })).toMatchObject({ ok: false, code: "pack_not_found" });
      expect(calls.createOrder).toHaveLength(0);
    });

    it("con CREDITS apagada no crea nada; con CULQI apagada o sin llave, tampoco", async () => {
      const antes = (await db.select().from(schema.creditTopup).where(eq(schema.creditTopup.organizationId, orgId))).length;
      vi.stubEnv("CREDITS", "");
      expect(await start()).toMatchObject({ ok: false, status: 404 });
      vi.stubEnv("CREDITS", "on");
      vi.stubEnv("CULQI", "");
      expect(await start()).toMatchObject({ ok: false, status: 503, code: "not_configured" });
      vi.stubEnv("CULQI", "on");
      vi.stubEnv("CULQI_SECRET_KEY", "");
      expect(await start()).toMatchObject({ ok: false, status: 503, code: "not_configured" });
      expect(calls.createOrder).toHaveLength(0);
      expect((await db.select().from(schema.creditTopup).where(eq(schema.creditTopup.organizationId, orgId))).length).toBe(antes);
    });

    it("si Culqi falla al crear la orden, la compra queda failed y no se pierde nada ni se abona", async () => {
      behavior.createOrderFails = true;
      const r = await start();
      expect(r).toMatchObject({ ok: false, status: 502, code: "gateway_error" });
      const rows = await db.select().from(schema.creditTopup).where(eq(schema.creditTopup.organizationId, orgId));
      expect(rows.filter((t) => t.status === "failed" && t.failureReason)).not.toHaveLength(0);
    });

    it("no más de 5 compras abiertas por organización", async () => {
      await db.delete(schema.creditTopup).where(eq(schema.creditTopup.organizationId, orgOther));
      const results = [];
      for (let i = 0; i < 6; i++) results.push(await start({ organizationId: orgOther }));
      expect(results.filter((r) => r.ok)).toHaveLength(5);
      expect(results[5]).toMatchObject({ ok: false, status: 429, code: "too_many_pending" });
      await db.delete(schema.creditTopup).where(eq(schema.creditTopup.organizationId, orgOther));
    });
  });

  describe("confirmar el pago (abonar)", () => {
    it("orden pagada → abona las monedas del paquete una vez y marca la compra pagada", async () => {
      const b = await bought();
      const antes = (await bal()).topup;
      pay(b.orderId);
      expect(await p.confirmOrder(b.orderId)).toEqual({ status: "applied" });
      expect((await bal()).topup).toBe(antes + 50_000);
      const t = await topupRow(b.topupId);
      expect(t).toMatchObject({ status: "paid", mpPaymentId: b.orderId, gatewayChargeId: `chr_test_${b.orderId}` });
      expect(t.completedAt).not.toBeNull();
    });

    it("un aviso repetido no abona dos veces; ni cinco confirmaciones a la vez", async () => {
      const b = await bought();
      pay(b.orderId);
      const antes = (await bal()).topup;
      const res = await Promise.all([1, 2, 3, 4, 5].map(() => p.confirmOrder(b.orderId)));
      expect(res.filter((r) => r.status === "applied")).toHaveLength(1);
      expect(res.filter((r) => r.status === "duplicate")).toHaveLength(4);
      expect(await p.confirmOrder(b.orderId)).toEqual({ status: "duplicate" });
      expect((await bal()).topup).toBe(antes + 50_000);
      const filas = (await db.select().from(schema.creditLedger).where(eq(schema.creditLedger.organizationId, orgId))).filter((l) => l.refId === b.topupId && l.kind === "topup");
      expect(filas).toHaveLength(1);
    });

    it("orden pendiente → no abona; vencida → la compra queda abandonada", async () => {
      const b = await bought();
      const antes = (await bal()).topup;
      expect(await p.confirmOrder(b.orderId)).toEqual({ status: "pending" });
      orders.get(b.orderId)!.state = "expired";
      expect(await p.confirmOrder(b.orderId)).toEqual({ status: "closed" });
      expect(await topupRow(b.topupId)).toMatchObject({ status: "abandoned" });
      expect((await bal()).topup).toBe(antes);
    });

    it("un pago tardío (la compra ya estaba abandonada) igual se abona: el dinero ya se cobró", async () => {
      const b = await bought();
      orders.get(b.orderId)!.state = "expired";
      await p.confirmOrder(b.orderId);
      const antes = (await bal()).topup;
      pay(b.orderId);
      expect(await p.confirmOrder(b.orderId)).toEqual({ status: "applied" });
      expect((await bal()).topup).toBe(antes + 50_000);
      expect(await topupRow(b.topupId)).toMatchObject({ status: "paid" });
    });

    it("si el monto, la moneda o la referencia no coinciden, NO se abona y queda anotado", async () => {
      for (const over of [{ amount: 100 }, { currency: "USD" }, { orderNumber: "crt_otra_compra" }]) {
        const b = await bought();
        const antes = (await bal()).topup;
        pay(b.orderId, over);
        // Con un order_number ajeno la compra se encuentra por el id de la orden; en los otros casos también.
        expect(await p.confirmOrder(b.orderId)).toEqual({ status: "mismatch" });
        expect((await bal()).topup).toBe(antes);
        const t = await topupRow(b.topupId);
        expect(t.status).toBe("pending");
        expect(t.failureReason).toMatch(/no coincide/);
      }
    });

    it("una orden que no es de ninguna compra nuestra se ignora; la compra de otra organización no se toca", async () => {
      orders.set("ord_ajena", { id: "ord_ajena", state: "paid", orderNumber: "crt_inexistente", amount: 100, currency: "PEN", chargeId: null, paymentCode: null });
      expect(await p.confirmOrder("ord_ajena")).toEqual({ status: "ignored", reason: "unknown_order" });
      // Una orden «pagada» cuyo order_number apunta a una compra que ya tiene OTRA orden no se adopta.
      const b = await bought();
      orders.set("ord_intrusa", { id: "ord_intrusa", state: "paid", orderNumber: b.topupId, amount: 4990, currency: "PEN", chargeId: null, paymentCode: null });
      expect(await p.confirmOrder("ord_intrusa")).toEqual({ status: "ignored", reason: "unknown_order" });
      expect(await topupRow(b.topupId)).toMatchObject({ status: "pending" });
    });

    it("si Culqi no responde, confirmar lanza (el webhook responde 5xx y Culqi reintenta) y no abona", async () => {
      const b = await bought();
      pay(b.orderId);
      const antes = (await bal()).topup;
      behavior.getOrderFails = true;
      await expect(p.confirmOrder(b.orderId)).rejects.toThrow(/Culqi/);
      expect((await bal()).topup).toBe(antes);
      behavior.getOrderFails = false;
      expect(await p.confirmOrder(b.orderId)).toEqual({ status: "applied" });
    });

    it("con CREDITS apagada no abona ni consulta a Culqi", async () => {
      const b = await bought();
      pay(b.orderId);
      vi.stubEnv("CREDITS", "");
      const consultas = calls.getOrder;
      expect(await p.confirmOrder(b.orderId)).toEqual({ status: "disabled" });
      expect(calls.getOrder).toBe(consultas);
      vi.stubEnv("CREDITS", "on");
      expect(await p.confirmOrder(b.orderId)).toEqual({ status: "applied" });
    });

    it("el abono va al saldo de RECARGAS (no vence) y no toca la cuota del plan", async () => {
      const b = await bought();
      const antes = await bal();
      pay(b.orderId);
      await p.confirmOrder(b.orderId);
      const despues = await bal();
      expect(despues.plan).toBe(antes.plan);
      expect(despues.topup).toBe(antes.topup + 50_000);
    });
  });

  describe("estado de la compra", () => {
    it("lo ve su organización (y asienta si ya se pagó); otra organización no la ve", async () => {
      const b = await bought();
      pay(b.orderId);
      const t = await p.topupStatus(orgId, b.topupId);
      expect(t).toMatchObject({ id: b.topupId, status: "paid", units: 50_000, amountCents: 4990, currency: "PEN" });
      expect(t!.completedAt).not.toBeNull();
      expect(await p.topupStatus(orgOther, b.topupId)).toBeNull();
      expect(await p.topupStatus(orgId, "crt_no_existe")).toBeNull();
    });

    it("si Culqi falla al consultar, responde lo que hay en vez de romperse", async () => {
      const b = await bought();
      behavior.getOrderFails = true;
      expect(await p.topupStatus(orgId, b.topupId)).toMatchObject({ status: "pending" });
    });
  });

  describe("reembolso", () => {
    async function paid() {
      const b = await bought();
      pay(b.orderId);
      await p.confirmOrder(b.orderId);
      return b;
    }

    it("devuelve el dinero en Culqi y descuenta las monedas; repetirlo no hace nada ni vuelve a llamar a Culqi", async () => {
      const b = await paid();
      const antes = (await bal()).topup;
      const r1 = await p.refundPurchase({ topupId: b.topupId, actorUserId: userId, reason: "Pedido del cliente" });
      expect(r1).toEqual({ ok: true, duplicate: false });
      expect(calls.createRefund).toHaveLength(1);
      expect(calls.createRefund[0]).toMatchObject({ amount: 4990, charge_id: `chr_test_${b.orderId}`, reason: "solicitud_comprador" });
      expect((await bal()).topup).toBe(antes - 50_000);
      expect(await topupRow(b.topupId)).toMatchObject({ status: "refunded" });
      const fila = (await db.select().from(schema.creditLedger).where(eq(schema.creditLedger.organizationId, orgId))).find((l) => l.refId === b.topupId && l.kind === "refund");
      expect(fila).toMatchObject({ amount: -50_000, actorUserId: userId });

      expect(await p.refundPurchase({ topupId: b.topupId, actorUserId: userId })).toEqual({ ok: true, duplicate: true });
      expect(calls.createRefund).toHaveLength(1);
      expect((await bal()).topup).toBe(antes - 50_000);
    });

    it("si Culqi no acepta el reembolso, no se descuenta nada y la compra sigue pagada", async () => {
      const b = await paid();
      const antes = (await bal()).topup;
      behavior.refundFails = true;
      expect(await p.refundPurchase({ topupId: b.topupId, actorUserId: userId })).toMatchObject({ ok: false, status: 502, code: "gateway_error" });
      expect((await bal()).topup).toBe(antes);
      expect(await topupRow(b.topupId)).toMatchObject({ status: "paid" });
      behavior.refundFails = false;
      expect(await p.refundPurchase({ topupId: b.topupId, actorUserId: userId })).toEqual({ ok: true, duplicate: false });
    });

    it("solo se reembolsa lo pagado; una compra desconocida es 404; sin cargo conocido se pide hacerlo en Culqi", async () => {
      const pend = await bought();
      expect(await p.refundPurchase({ topupId: pend.topupId, actorUserId: userId })).toMatchObject({ ok: false, status: 409, code: "not_paid" });
      expect(await p.refundPurchase({ topupId: "crt_no_existe", actorUserId: userId })).toMatchObject({ ok: false, status: 404 });
      const b = await paid();
      await db.update(schema.creditTopup).set({ gatewayChargeId: null }).where(eq(schema.creditTopup.id, b.topupId));
      orders.get(b.orderId)!.chargeId = null;
      expect(await p.refundPurchase({ topupId: b.topupId, actorUserId: userId })).toMatchObject({ ok: false, status: 409, code: "charge_unknown" });
      expect(calls.createRefund).toHaveLength(0);
    });

    it("dos reembolsos a la vez descuentan una sola vez", async () => {
      const b = await paid();
      const antes = (await bal()).topup;
      await Promise.all([p.refundPurchase({ topupId: b.topupId, actorUserId: userId }), p.refundPurchase({ topupId: b.topupId, actorUserId: userId })]);
      expect((await bal()).topup).toBe(antes - 50_000);
    });

    it("un aviso de reembolso hecho en el panel de Culqi: solo si es total y Culqi lo confirma; repetido, una vez", async () => {
      const b = await paid();
      const chargeId = `chr_test_${b.orderId}`;
      const antes = (await bal()).topup;
      charges.set(chargeId, { id: chargeId, amount: 4990, currency: "PEN", refundedAmount: 1000, orderId: b.orderId });
      expect(await p.confirmRefund(chargeId)).toEqual({ status: "ignored" }); // parcial
      expect((await bal()).topup).toBe(antes);
      charges.set(chargeId, { id: chargeId, amount: 4990, currency: "PEN", refundedAmount: null, orderId: b.orderId });
      expect(await p.confirmRefund(chargeId)).toEqual({ status: "ignored" }); // sin confirmar
      charges.set(chargeId, { id: chargeId, amount: 4990, currency: "PEN", refundedAmount: 4990, orderId: b.orderId });
      expect(await p.confirmRefund(chargeId)).toEqual({ status: "applied" });
      expect(await p.confirmRefund(chargeId)).toEqual({ status: "duplicate" });
      expect((await bal()).topup).toBe(antes - 50_000);
      expect(await p.confirmRefund("chr_desconocido")).toEqual({ status: "ignored" });
    });

    it("tras reembolsar, un aviso tardío de «pagada» no vuelve a abonar", async () => {
      const b = await paid();
      await p.refundPurchase({ topupId: b.topupId, actorUserId: userId });
      const antes = (await bal()).topup;
      expect(await p.confirmOrder(b.orderId)).toEqual({ status: "duplicate" });
      expect((await bal()).topup).toBe(antes);
    });
  });

  describe("barrido de compras abiertas", () => {
    it("asienta una compra pagada cuyo aviso se perdió, y deja en paz a las recientes", async () => {
      const viejo = await bought();
      const nuevo = await bought();
      pay(viejo.orderId);
      pay(nuevo.orderId);
      await db.update(schema.creditTopup).set({ createdAt: new Date(Date.now() - 10 * 60 * 1000) }).where(eq(schema.creditTopup.id, viejo.topupId));
      const antes = (await bal()).topup;
      expect(await p.reconcilePendingTopups(new Date())).toBeGreaterThanOrEqual(1);
      expect(await topupRow(viejo.topupId)).toMatchObject({ status: "paid" });
      expect(await topupRow(nuevo.topupId)).toMatchObject({ status: "pending" }); // muy reciente: aún no
      expect((await bal()).topup).toBe(antes + 50_000);
      expect(await p.reconcilePendingTopups(new Date())).toBe(0); // idempotente
    });

    it("con CULQI o CREDITS apagadas no hace nada y nunca lanza", async () => {
      vi.stubEnv("CULQI", "");
      expect(await p.reconcilePendingTopups(new Date())).toBe(0);
      vi.stubEnv("CULQI", "on");
      behavior.getOrderFails = true;
      await expect(p.reconcilePendingTopups(new Date(Date.now() + 60 * 60 * 1000))).resolves.toBeGreaterThanOrEqual(0);
    });
  });

  it("ninguna prueba de esta suite habló con la red de verdad", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
