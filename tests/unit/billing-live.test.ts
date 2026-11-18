import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 046 — Cobro con Mercado Pago contra PostgreSQL REAL (con la API de Mercado Pago simulada en memoria).
 *
 * Necesita una base con las migraciones aplicadas, así que NO corre con `pnpm test`:
 *   RUN_DB_TESTS=1 corepack pnpm exec vitest run tests/unit/billing-live.test.ts
 * Crea organizaciones y usuarios temporales y los borra al terminar.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

type FakePre = { id: string; status: string; external_reference: string; payer_id: number; amount: number; reason: string };
type FakeAp = { id: string; preapproval_id: string; status: string; transaction_amount: number; currency_id: string; debit_date: string; retry_attempt: number; payment: { id: string; status: string; status_detail: string } };

describe.skipIf(!live)("Cobro con Mercado Pago contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let sql: (typeof import("drizzle-orm"))["sql"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let door: typeof import("@/server/saas/subscription");
  let core: typeof import("@/server/billing/core");
  let checkoutLib: typeof import("@/server/billing/checkout");
  let change: typeof import("@/server/billing/change");
  let webhook: typeof import("@/server/billing/webhook");
  let reconcile: typeof import("@/server/billing/reconcile");
  let enforcement: typeof import("@/server/saas/enforcement");
  let metricsLib: typeof import("@/server/super-admin/metrics");

  const uid = Date.now().toString(36);
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const P: Record<string, string> = {};
  const DAY = 86_400_000;
  const days = (n: number) => new Date(Date.now() + n * DAY);

  // --- Mercado Pago simulado ---
  const pres = new Map<string, FakePre>();
  const aps = new Map<string, FakeAp>();
  const calls: string[] = [];
  let down = false;
  let seq = 0;
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const view = (p: FakePre) => ({
    id: p.id,
    status: p.status,
    external_reference: p.external_reference,
    payer_id: p.payer_id,
    init_point: `https://www.mercadopago.com.pe/checkout/${p.id}`,
    auto_recurring: { transaction_amount: p.amount, currency_id: "PEN" },
  });
  const fakeFetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/mp/, "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (down) return json({ message: "caído" }, 503);
    if (method === "POST" && path === "/preapproval") {
      const b = JSON.parse(init!.body!) as { external_reference: string; reason: string; auto_recurring: { transaction_amount: number } };
      const id = `mpre${uid}${++seq}`;
      const p: FakePre = { id, status: "pending", external_reference: b.external_reference, payer_id: 7000 + seq, amount: b.auto_recurring.transaction_amount, reason: b.reason };
      pres.set(id, p);
      return json(view(p), 201);
    }
    const mPre = /^\/preapproval\/([^/]+)$/.exec(path);
    if (mPre) {
      const p = pres.get(decodeURIComponent(mPre[1]!));
      if (!p) return json({ message: "nf" }, 404);
      if (method === "PUT") {
        const b = JSON.parse(init!.body!) as { status?: string; auto_recurring?: { transaction_amount?: number } };
        if (b.status) p.status = b.status;
        if (b.auto_recurring?.transaction_amount) p.amount = b.auto_recurring.transaction_amount;
      }
      return json(view(p));
    }
    if (path === "/authorized_payments/search") {
      const pid = url.searchParams.get("preapproval_id");
      return json({ results: [...aps.values()].filter((a) => a.preapproval_id === pid) });
    }
    const mAp = /^\/authorized_payments\/([^/]+)$/.exec(path);
    if (mAp) {
      const a = aps.get(decodeURIComponent(mAp[1]!));
      return a ? json(a) : json({ message: "nf" }, 404);
    }
    return json({ message: "nf" }, 404);
  };

  const cobro = (preId: string, status: "approved" | "rejected" | "refunded" | "charged_back", amount: number, id?: string, retry = 0): FakeAp => {
    const apId = id ?? `ap${uid}${++seq}`;
    const ap: FakeAp = {
      id: apId,
      preapproval_id: preId,
      status: status === "rejected" ? "recycling" : "processed",
      transaction_amount: amount,
      currency_id: "PEN",
      debit_date: new Date().toISOString(),
      retry_attempt: retry,
      payment: { id: `pay${seq}`, status, status_detail: status === "approved" ? "accredited" : "cc_rejected_insufficient_amount" },
    };
    aps.set(apId, ap);
    return ap;
  };
  const preDe = (preId: string) => view(pres.get(preId)!) as never;

  // --- datos ---
  async function nuevaOrg(tag: string): Promise<{ orgId: string; userId: string }> {
    const orgId = `org_bl${uid}${tag}`;
    const userId = `usr_bl${uid}${tag}`;
    await db.insert(schema.organization).values({ id: orgId, name: `Negocio ${tag} ${uid}`, createdAt: new Date() });
    orgIds.push(orgId);
    await db.insert(schema.user).values({ id: userId, name: `Dueño ${tag}`, email: `dueno-${tag}-${uid}@vocero.test`, emailVerified: true });
    userIds.push(userId);
    await db.insert(schema.member).values({ id: `mem_bl${uid}${tag}`, organizationId: orgId, userId, role: "owner" });
    return { orgId, userId };
  }
  async function enPrueba(tag: string) {
    const o = await nuevaOrg(tag);
    await db.insert(schema.subscription).values({
      id: `sub_bl${uid}${tag}`,
      organizationId: o.orgId,
      planId: P.demo!,
      status: "trialing",
      currentPeriodStart: days(-9),
      currentPeriodEnd: days(5),
      trialStartedAt: days(-9),
    });
    await db.insert(schema.subscriptionEvent).values({
      id: `sev_bl${uid}${tag}`,
      organizationId: o.orgId,
      type: "trial_started",
      toStatus: "trialing",
      toPlanId: P.demo!,
      toPlanName: "Demo",
      source: "signup",
      occurredAt: days(-9),
    });
    return o;
  }
  /** Una organización en prueba que ya inició el checkout de un plan. */
  async function conCheckout(tag: string, slug = "pro") {
    const o = await enPrueba(tag);
    const r = await checkoutLib.createCheckout({ organizationId: o.orgId, userId: o.userId, planId: P[slug]! });
    if (!r.ok) throw new Error(`checkout falló: ${r.code}`);
    const [c] = await db.select().from(schema.billingCheckout).where(eq(schema.billingCheckout.id, r.checkoutId));
    return { ...o, checkoutId: r.checkoutId, preId: c!.mpPreapprovalId!, url: r.url };
  }
  const subDe = async (orgId: string) => (await db.select().from(schema.subscription).where(eq(schema.subscription.organizationId, orgId)))[0]!;
  const eventosDe = async (orgId: string) =>
    await db.select().from(schema.subscriptionEvent).where(eq(schema.subscriptionEvent.organizationId, orgId)).orderBy(schema.subscriptionEvent.occurredAt, schema.subscriptionEvent.id);
  const pagosDe = async (orgId: string) => await db.select().from(schema.billingPayment).where(eq(schema.billingPayment.organizationId, orgId));
  const checkoutDe = async (id: string) => (await db.select().from(schema.billingCheckout).where(eq(schema.billingCheckout.id, id)))[0]!;

  beforeAll(async () => {
    process.env.MERCADOPAGO = "on";
    process.env.MP_ACCESS_TOKEN = "token-de-prueba";
    process.env.MP_API_BASE = "https://mp.fake/mp";
    process.env.APP_BASE_URL = "http://localhost:3002";
    vi.stubGlobal("fetch", fakeFetch);
    ({ sql, eq, inArray } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    door = await import("@/server/saas/subscription");
    core = await import("@/server/billing/core");
    checkoutLib = await import("@/server/billing/checkout");
    change = await import("@/server/billing/change");
    webhook = await import("@/server/billing/webhook");
    reconcile = await import("@/server/billing/reconcile");
    enforcement = await import("@/server/saas/enforcement");
    metricsLib = await import("@/server/super-admin/metrics");
    const { seedPlatformCatalog } = await import("@/server/seed/platform-catalog");
    await seedPlatformCatalog();
    for (const p of await db.select().from(schema.plan)) P[p.slug] = p.id;
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.MERCADOPAGO;
    delete process.env.MP_ACCESS_TOKEN;
    delete process.env.MP_API_BASE;
    if (!db) return;
    await db.delete(schema.billingWebhookEvent).where(sql`${schema.billingWebhookEvent.requestId} like ${`bl-${uid}%`}`);
    await db.delete(schema.organization).where(inArray(schema.organization.id, orgIds));
    await db.delete(schema.user).where(inArray(schema.user.id, userIds));
  }, 60_000);

  it("0. la migración 0081 dejó columnas, tablas e índices únicos", async () => {
    const cols = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns where table_name = 'subscription'
        and column_name in ('billing_provider','mp_preapproval_id','mp_payer_id','mp_status','billed_amount_cents','billed_currency','pending_plan_id','last_payment_at','next_payment_at')`);
    expect([...cols]).toHaveLength(9);
    const tablas = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_name in ('billing_checkout','billing_payment','billing_webhook_event')`);
    expect([...tablas]).toHaveLength(3);
    const idx = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where indexname in ('subscription_mp_preapproval_uq','bck_mp_preapproval_uq','bpy_authorized_payment_uq','bwh_request_uq')`);
    expect([...idx]).toHaveLength(4);
    const ev = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = 'subscription_event' and column_name = 'provider_ref'`);
    expect([...ev]).toHaveLength(1);
  });

  it("1. el checkout crea el intento, reemplaza el pendiente y devuelve el enlace de Mercado Pago", async () => {
    const o = await enPrueba("c1");
    const a = await checkoutLib.createCheckout({ organizationId: o.orgId, userId: o.userId, planId: P.pro! });
    expect(a).toMatchObject({ ok: true });
    if (!a.ok) return;
    expect(a.url).toContain("mercadopago.com.pe");
    const ca = await checkoutDe(a.checkoutId);
    expect(ca).toMatchObject({ status: "pending", amountCents: 14900, currency: "PEN", planId: P.pro });
    expect(ca.mpPreapprovalId).toBeTruthy();
    // el external_reference que viajó es el id opaco del checkout
    expect(pres.get(ca.mpPreapprovalId!)!.external_reference).toBe(a.checkoutId);
    expect(pres.get(ca.mpPreapprovalId!)!.amount).toBe(149);
    const b = await checkoutLib.createCheckout({ organizationId: o.orgId, userId: o.userId, planId: P.emprendedor! });
    expect(b.ok).toBe(true);
    expect((await checkoutDe(a.checkoutId)).status).toBe("replaced");
  });

  it("2. un plan de prueba o inexistente no se puede contratar; con Mercado Pago caído no queda un checkout colgado", async () => {
    const o = await enPrueba("c2");
    expect(await checkoutLib.createCheckout({ organizationId: o.orgId, userId: o.userId, planId: P.demo! })).toMatchObject({ ok: false, status: 422, code: "plan_not_billable" });
    expect(await checkoutLib.createCheckout({ organizationId: o.orgId, userId: o.userId, planId: "plan_no_existe" })).toMatchObject({ ok: false, status: 404 });
    down = true;
    try {
      const r = await checkoutLib.createCheckout({ organizationId: o.orgId, userId: o.userId, planId: P.pro! });
      expect(r).toMatchObject({ ok: false, status: 502, code: "provider_unavailable" });
    } finally {
      down = false;
    }
    const filas = await db.select().from(schema.billingCheckout).where(eq(schema.billingCheckout.organizationId, o.orgId));
    expect(filas.every((f) => f.status === "failed")).toBe(true);
    expect((await subDe(o.orgId)).status).toBe("trialing");
  });

  it("3. el primer cobro aprobado convierte la prueba: activa, 30 días, evento «converted» por pago y checkout pagado", async () => {
    const c = await conCheckout("p1");
    pres.get(c.preId)!.status = "authorized";
    const ap = cobro(c.preId, "approved", 149);
    const out = await core.processAuthorizedPayment(ap as never, preDe(c.preId));
    expect(out.kind).toBe("applied");
    const sub = await subDe(c.orgId);
    expect(sub).toMatchObject({ status: "active", planId: P.pro, billingProvider: "mercadopago", mpPreapprovalId: c.preId, mpStatus: "authorized", billedAmountCents: 14900, statusReason: "paid" });
    expect(sub.convertedAt).toBeTruthy();
    const fin = sub.currentPeriodEnd.getTime() - Date.now();
    expect(fin).toBeGreaterThan(29 * DAY);
    expect(fin).toBeLessThan(31 * DAY);
    const ev = (await eventosDe(c.orgId)).filter((e) => e.type === "converted");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ source: "payment", fromStatus: "trialing", toStatus: "active", toPlanName: "Pro", providerRef: ap.id });
    expect((await checkoutDe(c.checkoutId)).status).toBe("paid");
    const [pago] = await pagosDe(c.orgId);
    expect(pago).toMatchObject({ status: "approved", amountCents: 14900, mpAuthorizedPaymentId: ap.id });
    expect(pago!.appliedAt).toBeTruthy();
  });

  it("4. aplicar dos veces el mismo cobro (también a la vez) deja UN evento y UN cobro", async () => {
    const c = await conCheckout("p2");
    pres.get(c.preId)!.status = "authorized";
    const ap = cobro(c.preId, "approved", 149);
    const rs = await Promise.all([core.processAuthorizedPayment(ap as never, preDe(c.preId)), core.processAuthorizedPayment(ap as never, preDe(c.preId)), core.processAuthorizedPayment(ap as never, preDe(c.preId))]);
    expect(rs.filter((r) => r.kind === "applied")).toHaveLength(1);
    expect((await eventosDe(c.orgId)).filter((e) => e.source === "payment")).toHaveLength(1);
    expect(await pagosDe(c.orgId)).toHaveLength(1);
    // y de nuevo, ya en reposo
    expect((await core.processAuthorizedPayment(ap as never, preDe(c.preId))).kind).toBe("duplicate");
    expect((await eventosDe(c.orgId)).filter((e) => e.source === "payment")).toHaveLength(1);
  });

  it("5. la conversión y el MRR del panel se actualizan solos, con la conversión marcada como cobro", async () => {
    const m = await metricsLib.loadMetrics(new Date());
    expect(m.conversion.convertedBy.payment).toBeGreaterThanOrEqual(2);
    expect(m.mrr.mrrCents).toBeGreaterThanOrEqual(2 * 14900);
  });

  it("6. el webhook: el mismo x-request-id dos veces se procesa una sola vez", async () => {
    const c = await conCheckout("w1");
    pres.get(c.preId)!.status = "authorized";
    const ap = cobro(c.preId, "approved", 149);
    const n = { requestId: `bl-${uid}-a`, topic: "subscription_authorized_payment", resourceId: ap.id, action: "created", liveMode: false };
    const a = await webhook.handleNotification(n);
    const b = await webhook.handleNotification(n);
    expect(a).toMatchObject({ status: 200, body: { result: "applied" } });
    expect(b).toMatchObject({ status: 200, body: { result: "duplicate" } });
    expect((await eventosDe(c.orgId)).filter((e) => e.type === "converted")).toHaveLength(1);
    // otro request-id con el mismo cobro: la idempotencia del cobro lo frena igual
    const c2 = await webhook.handleNotification({ ...n, requestId: `bl-${uid}-b` });
    expect(c2.body.result).toBe("duplicate");
    expect((await eventosDe(c.orgId)).filter((e) => e.source === "payment")).toHaveLength(1);
  });

  it("7. un aviso que falla (Mercado Pago caído) queda `failed`, responde 500 y el temporizador lo reprocesa", async () => {
    const c = await conCheckout("w2");
    pres.get(c.preId)!.status = "authorized";
    const ap = cobro(c.preId, "approved", 149);
    down = true;
    let r;
    try {
      r = await webhook.handleNotification({ requestId: `bl-${uid}-f`, topic: "subscription_authorized_payment", resourceId: ap.id, action: null, liveMode: null });
    } finally {
      down = false;
    }
    expect(r.status).toBe(500);
    const [ev] = await db.select().from(schema.billingWebhookEvent).where(eq(schema.billingWebhookEvent.requestId, `bl-${uid}-f`));
    expect(ev).toMatchObject({ status: "failed" });
    expect((await subDe(c.orgId)).status).toBe("trialing");
    const n = await webhook.reprocessPending(new Date(Date.now() + 10 * 60 * 1000));
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await subDe(c.orgId)).status).toBe("active");
    const [ev2] = await db.select().from(schema.billingWebhookEvent).where(eq(schema.billingWebhookEvent.requestId, `bl-${uid}-f`));
    expect(ev2!.status).toBe("processed");
  });

  it("8. un recurso que Mercado Pago no conoce se ignora (200) y uno de otra organización queda huérfano sin romper nada", async () => {
    const r = await webhook.handleNotification({ requestId: `bl-${uid}-nf`, topic: "subscription_preapproval", resourceId: "no-existe", action: null, liveMode: null });
    expect(r).toMatchObject({ status: 200, body: { result: "not_found" } });
    const huerfano = cobro("mpre-desconocida", "approved", 149);
    expect((await core.processAuthorizedPayment(huerfano as never, { id: "mpre-desconocida", status: "authorized" } as never)).kind).toBe("orphan");
  });

  it("9. la renovación mensual extiende 30 días desde el fin vigente", async () => {
    const c = await conCheckout("r1");
    pres.get(c.preId)!.status = "authorized";
    await core.processAuthorizedPayment(cobro(c.preId, "approved", 149) as never, preDe(c.preId));
    const antes = (await subDe(c.orgId)).currentPeriodEnd;
    const out = await core.processAuthorizedPayment(cobro(c.preId, "approved", 149) as never, preDe(c.preId));
    expect(out.kind).toBe("applied");
    const despues = await subDe(c.orgId);
    expect(despues.currentPeriodEnd.getTime() - antes.getTime()).toBe(30 * DAY);
    expect((await eventosDe(c.orgId)).filter((e) => e.type === "renewed")).toHaveLength(1);
    expect((await eventosDe(c.orgId)).filter((e) => e.type === "converted")).toHaveLength(1);
  });

  it("10. un cobro mensual rechazado pasa a past_due con gracia; el reintento aprobado la reactiva", async () => {
    const c = await conCheckout("f1");
    pres.get(c.preId)!.status = "authorized";
    await core.processAuthorizedPayment(cobro(c.preId, "approved", 149) as never, preDe(c.preId));
    await db.update(schema.subscription).set({ currentPeriodEnd: days(-1) }).where(eq(schema.subscription.organizationId, c.orgId));
    const ap = cobro(c.preId, "rejected", 149);
    await core.processAuthorizedPayment(ap as never, preDe(c.preId));
    let sub = await subDe(c.orgId);
    expect(sub).toMatchObject({ status: "past_due", statusReason: "payment_failed" });
    expect((await eventosDe(c.orgId)).filter((e) => e.type === "payment_failed")).toHaveLength(1);
    expect((await pagosDe(c.orgId)).find((p) => p.status === "rejected")).toBeTruthy();
    // dentro de la gracia no se bloquea; pasada, sí
    const dentro = await enforcement.getSubscriptionAccess(c.orgId, new Date(), false);
    expect(dentro).toMatchObject({ status: "past_due", blocked: false });
    expect(dentro.graceEndsAt).toBeTruthy();
    const fuera = await enforcement.getSubscriptionAccess(c.orgId, days(10), false);
    expect(fuera.blocked).toBe(true);
    // el MISMO cobro se reintenta y esta vez entra
    ap.status = "processed";
    ap.payment.status = "approved";
    ap.payment.status_detail = "accredited";
    const out = await core.processAuthorizedPayment(ap as never, preDe(c.preId));
    expect(out.kind).toBe("applied");
    sub = await subDe(c.orgId);
    expect(sub).toMatchObject({ status: "active", statusReason: "paid" });
    expect((await pagosDe(c.orgId)).filter((p) => p.mpAuthorizedPaymentId === ap.id)).toHaveLength(1);
  });

  it("11. un rechazo tardío NO pisa un cobro ya aprobado", async () => {
    const c = await conCheckout("o1");
    pres.get(c.preId)!.status = "authorized";
    const ap = cobro(c.preId, "approved", 149);
    await core.processAuthorizedPayment(ap as never, preDe(c.preId));
    const viejo = { ...ap, status: "recycling", payment: { ...ap.payment, status: "rejected" } };
    await core.processAuthorizedPayment(viejo as never, preDe(c.preId));
    expect((await pagosDe(c.orgId))[0]!.status).toBe("approved");
    expect((await subDe(c.orgId)).status).toBe("active");
  });

  it("12. el primer cobro rechazado no cambia la prueba; el checkout falla con el motivo y un reintento tardío conserva el plan", async () => {
    const c = await conCheckout("f2", "emprendedor");
    const ap = cobro(c.preId, "rejected", 79);
    await core.processAuthorizedPayment(ap as never, preDe(c.preId));
    expect((await subDe(c.orgId)).status).toBe("trialing");
    const ck = await checkoutDe(c.checkoutId);
    expect(ck.status).toBe("failed");
    expect(ck.failureReason).toContain("fondos insuficientes");
    ap.status = "processed";
    ap.payment.status = "approved";
    pres.get(c.preId)!.status = "authorized";
    await core.processAuthorizedPayment(ap as never, preDe(c.preId));
    expect(await subDe(c.orgId)).toMatchObject({ status: "active", planId: P.emprendedor, billedAmountCents: 7900 });
    expect((await checkoutDe(c.checkoutId)).status).toBe("paid");
  });

  it("13. un monto distinto al del checkout NO activa: queda a revisar", async () => {
    const c = await conCheckout("m1");
    const ap = cobro(c.preId, "approved", 1);
    const out = await core.processAuthorizedPayment(ap as never, preDe(c.preId));
    expect(out).toMatchObject({ kind: "ignored", detail: "amount_mismatch" });
    expect((await subDe(c.orgId)).status).toBe("trialing");
    expect((await pagosDe(c.orgId))[0]).toMatchObject({ needsReview: true });
  });

  it("14. cancelar: propaga a Mercado Pago, conserva el acceso y solo el corte la pasa a canceled", async () => {
    const c = await conCheckout("x1");
    pres.get(c.preId)!.status = "authorized";
    await core.processAuthorizedPayment(cobro(c.preId, "approved", 149) as never, preDe(c.preId));
    const r = await change.cancelByOwner({ organizationId: c.orgId, userId: c.userId, reason: "ya no lo uso" });
    expect(r).toMatchObject({ ok: true, mode: "cancel_at_period_end" });
    expect(pres.get(c.preId)!.status).toBe("cancelled");
    expect(await subDe(c.orgId)).toMatchObject({ status: "active", cancelAtPeriodEnd: true, mpStatus: "cancelled", statusReason: "customer_cancelled" });
    expect(await change.cancelByOwner({ organizationId: c.orgId, userId: c.userId })).toMatchObject({ ok: false, status: 409 });
    expect(await door.closeCancelledPeriods(new Date())).toBe(0);
    expect((await subDe(c.orgId)).status).toBe("active");
    await db.update(schema.subscription).set({ currentPeriodEnd: days(-1) }).where(eq(schema.subscription.organizationId, c.orgId));
    expect(await door.closeCancelledPeriods(new Date())).toBeGreaterThanOrEqual(1);
    expect((await subDe(c.orgId)).status).toBe("canceled");
  });

  it("15. cancelar con Mercado Pago caído: 502 y NADA cambia", async () => {
    const c = await conCheckout("x2");
    pres.get(c.preId)!.status = "authorized";
    await core.processAuthorizedPayment(cobro(c.preId, "approved", 149) as never, preDe(c.preId));
    down = true;
    try {
      expect(await change.cancelByOwner({ organizationId: c.orgId, userId: c.userId })).toMatchObject({ ok: false, status: 502, code: "provider_unavailable" });
    } finally {
      down = false;
    }
    expect(await subDe(c.orgId)).toMatchObject({ status: "active", cancelAtPeriodEnd: false, mpStatus: "authorized" });
  });

  it("16. cancelada desde el lado de Mercado Pago: sigue activa hasta el corte (sin acción del cliente)", async () => {
    const c = await conCheckout("x3");
    pres.get(c.preId)!.status = "authorized";
    await core.processAuthorizedPayment(cobro(c.preId, "approved", 149) as never, preDe(c.preId));
    pres.get(c.preId)!.status = "cancelled";
    await core.syncPreapproval(c.preId);
    expect(await subDe(c.orgId)).toMatchObject({ status: "active", cancelAtPeriodEnd: true, statusReason: "mp_cancelled", mpStatus: "cancelled" });
  });

  it("17. cambio de plan: subir rige ya con el precio nuevo; bajar queda programado y se aplica en el siguiente cobro", async () => {
    const c = await conCheckout("u1", "emprendedor");
    pres.get(c.preId)!.status = "authorized";
    await core.processAuthorizedPayment(cobro(c.preId, "approved", 79) as never, preDe(c.preId));
    const up = await change.changePlanByOwner({ organizationId: c.orgId, userId: c.userId, planId: P.pro! });
    expect(up).toMatchObject({ ok: true, mode: "immediate" });
    expect(pres.get(c.preId)!.amount).toBe(149);
    expect(await subDe(c.orgId)).toMatchObject({ planId: P.pro, billedAmountCents: 14900, pendingPlanId: null });
    const down1 = await change.changePlanByOwner({ organizationId: c.orgId, userId: c.userId, planId: P.emprendedor! });
    expect(down1).toMatchObject({ ok: true, mode: "scheduled" });
    expect(pres.get(c.preId)!.amount).toBe(79);
    expect(await subDe(c.orgId)).toMatchObject({ planId: P.pro, pendingPlanId: P.emprendedor });
    await core.processAuthorizedPayment(cobro(c.preId, "approved", 79) as never, preDe(c.preId));
    expect(await subDe(c.orgId)).toMatchObject({ planId: P.emprendedor, pendingPlanId: null, billedAmountCents: 7900 });
    const evs = (await eventosDe(c.orgId)).filter((e) => e.type === "plan_changed");
    expect(evs.map((e) => e.reason)).toEqual(["upgrade", "downgrade_scheduled"]);
  });

  it("18. cambiar de plan sin una suscripción de Mercado Pago autorizada es 409", async () => {
    const o = await enPrueba("u2");
    expect(await change.changePlanByOwner({ organizationId: o.orgId, userId: o.userId, planId: P.pro! })).toMatchObject({ ok: false, status: 409, code: "not_managed" });
    const c = await conCheckout("u3");
    pres.get(c.preId)!.status = "authorized";
    await core.processAuthorizedPayment(cobro(c.preId, "approved", 149) as never, preDe(c.preId));
    // ya tiene una suscripción vigente: contratar de nuevo es 409
    expect(await checkoutLib.createCheckout({ organizationId: c.orgId, userId: c.userId, planId: P.enterprise! })).toMatchObject({ ok: false, status: 409, code: "already_subscribed" });
  });

  it("19. reembolso o contracargo: queda a revisar, sin cambiar el estado, y no se duplica", async () => {
    const c = await conCheckout("d1");
    pres.get(c.preId)!.status = "authorized";
    const ap = cobro(c.preId, "approved", 149);
    await core.processAuthorizedPayment(ap as never, preDe(c.preId));
    ap.payment.status = "charged_back";
    await core.processAuthorizedPayment(ap as never, preDe(c.preId));
    await core.processAuthorizedPayment(ap as never, preDe(c.preId));
    const [pago] = await pagosDe(c.orgId);
    expect(pago).toMatchObject({ status: "charged_back", needsReview: true });
    expect((await subDe(c.orgId)).status).toBe("active");
    expect((await eventosDe(c.orgId)).filter((e) => e.type === "refunded")).toHaveLength(1);
  });

  it("20. el panel sobre una suscripción de Mercado Pago: activar es 409, suspender se propaga y, con Mercado Pago caído, no cambia nada", async () => {
    const c = await conCheckout("s1");
    pres.get(c.preId)!.status = "authorized";
    await core.processAuthorizedPayment(cobro(c.preId, "approved", 149) as never, preDe(c.preId));
    expect(await change.propagateAdminAction({ organizationId: c.orgId, action: "activate", planId: P.pro })).toMatchObject({ ok: false, status: 409, code: "managed_by_provider" });
    down = true;
    try {
      expect(await change.propagateAdminAction({ organizationId: c.orgId, action: "suspend" })).toMatchObject({ ok: false, status: 502 });
    } finally {
      down = false;
    }
    expect(pres.get(c.preId)!.status).toBe("authorized");
    const p = await change.propagateAdminAction({ organizationId: c.orgId, action: "suspend" });
    expect(p).toMatchObject({ ok: true, providerStatus: "paused" });
    expect(pres.get(c.preId)!.status).toBe("paused");
    const r = await door.applySubscriptionAction({
      organizationId: c.orgId,
      action: "suspend",
      providerStatus: "paused",
      reason: "prueba",
      actor: { userId: c.userId, email: null, ip: null },
    });
    expect(r.ok).toBe(true);
    expect(await subDe(c.orgId)).toMatchObject({ status: "paused", mpStatus: "paused" });
    // reactivar la pausada vuelve a autorizar en Mercado Pago
    expect(await change.propagateAdminAction({ organizationId: c.orgId, action: "reactivate" })).toMatchObject({ ok: true, providerStatus: "authorized" });
  });

  it("21. el panel sobre una suscripción manual (sin pasarela) no toca Mercado Pago", async () => {
    const o = await enPrueba("s2");
    const antes = calls.length;
    expect(await change.propagateAdminAction({ organizationId: o.orgId, action: "activate", planId: P.pro })).toEqual({ ok: true });
    expect(calls.length).toBe(antes);
  });

  it("22. la reconciliación abandona los checkouts vencidos y repasa las suscripciones sin noticias", async () => {
    const o = await enPrueba("z1");
    const r = await checkoutLib.createCheckout({ organizationId: o.orgId, userId: o.userId, planId: P.pro! });
    if (!r.ok) throw new Error("checkout");
    await db.update(schema.billingCheckout).set({ expiresAt: days(-1) }).where(eq(schema.billingCheckout.id, r.checkoutId));
    const out = await reconcile.reconcileBilling(new Date());
    expect(out.abandoned).toBeGreaterThanOrEqual(1);
    expect((await checkoutDe(r.checkoutId)).status).toBe("abandoned");

    const c = await conCheckout("z2");
    pres.get(c.preId)!.status = "authorized";
    await core.processAuthorizedPayment(cobro(c.preId, "approved", 149) as never, preDe(c.preId));
    // se perdió un webhook: Mercado Pago ya cobró el mes siguiente y la suscripción lleva 2 días sin noticias
    cobro(c.preId, "approved", 149);
    await db.update(schema.subscription).set({ updatedAt: days(-2) }).where(eq(schema.subscription.organizationId, c.orgId));
    const out2 = await reconcile.reconcileBilling(new Date());
    expect(out2.synced).toBeGreaterThanOrEqual(1);
    expect((await eventosDe(c.orgId)).filter((e) => e.type === "renewed")).toHaveLength(1);
  });

  it("23. con la bandera apagada el temporizador no hace nada", async () => {
    process.env.MERCADOPAGO = "off";
    try {
      expect(await reconcile.reconcileBilling(new Date())).toEqual({ reprocessed: 0, synced: 0, abandoned: 0 });
    } finally {
      process.env.MERCADOPAGO = "on";
    }
  });

  it("24. el estado de un checkout hace la consulta activa al volver del pago (sin webhook)", async () => {
    const c = await conCheckout("v1");
    pres.get(c.preId)!.status = "authorized";
    cobro(c.preId, "approved", 149);
    const dto = await checkoutLib.getCheckoutStatus(c.orgId, c.checkoutId);
    expect(dto).toMatchObject({ status: "paid", subscriptionStatus: "active", planName: "Pro" });
    // y no se ve el checkout de otra organización
    const otra = await enPrueba("v2");
    expect(await checkoutLib.getCheckoutStatus(otra.orgId, c.checkoutId)).toBeNull();
  });
});
