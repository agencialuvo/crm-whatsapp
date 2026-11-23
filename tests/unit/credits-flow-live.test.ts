import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Monedas conectadas al flujo, contra PostgreSQL REAL: la cuota que sigue a la suscripción (concesión, renovación,
 * vencimiento), el turno del agente (pre-chequeo, modo sombra, corte, cobro idempotente, llave del cliente y
 * Laboratorio) y los envíos de WhatsApp (plantilla por categoría vs. mensaje libre, antes y después de Meta).
 * Corre con `pnpm test:db`; sin `RUN_DB_TESTS` se salta.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("monedas en el flujo (base real)", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let c: typeof import("@/server/credits");
  let sync: typeof import("@/server/saas/credits-sync");
  let aiMeter: typeof import("@/server/ai/metering");
  let outbox: typeof import("@/server/inbox/outbox");
  let wa: typeof import("@/server/inbox/metering");

  const tag = Date.now().toString(36);
  const org = (n: string) => `org_f${n}${tag}`;
  const ids = ["q1", "q2", "q3", "q4", "q5", "ai1", "ai2", "ai3", "ai4", "wa1", "wa2", "wa3"].map(org);
  const planSlug = (n: string) => `tf-${n}-${tag}`;
  const plans = new Map<string, string>();

  const P1 = new Date("2026-11-01T00:00:00.000Z");
  const P1_END = new Date("2026-12-01T00:00:00.000Z");
  const P2 = new Date("2026-12-01T00:00:00.000Z");
  const P2_END = new Date("2027-01-01T00:00:00.000Z");

  async function newPlan(name: string, features: Record<string, unknown>): Promise<string> {
    const id = `plan_f${name}${tag}`;
    await db.insert(schema.plan).values({ id, name: `Plan ${name} ${tag}`, slug: planSlug(name), features: { channels: [], modules: [], ...features } as never });
    plans.set(name, id);
    return id;
  }
  async function newOrg(id: string): Promise<void> {
    await db.insert(schema.organization).values({ id, name: `Org ${id}`, slug: id.toLowerCase() });
  }
  async function newSub(orgId: string, planId: string, status: "active" | "canceled" | "past_due" | "trialing", start = P1, end = P1_END): Promise<string> {
    const id = `sub_f${orgId}`;
    await db.insert(schema.subscription).values({ id, organizationId: orgId, planId, status, currentPeriodStart: start, currentPeriodEnd: end });
    return id;
  }
  const bal = async (o: string) => (await c.getCreditBalance(o))!;
  const ledger = async (o: string) => db.select().from(schema.creditLedger).where(eq(schema.creditLedger.organizationId, o));
  const usage = async (o: string) => db.select().from(schema.creditUsage).where(eq(schema.creditUsage.organizationId, o));
  const spends = async (o: string) => (await ledger(o)).filter((r) => r.kind === "spend");
  /** Cuenta con saldo a la medida, directo por la puerta (concesión + ajustes). */
  async function fund(o: string, planUnits: number, topupUnits = 0): Promise<void> {
    if (planUnits > 0) await c.grantPeriodQuota({ organizationId: o, subscriptionId: `sub_x${o}`, periodStart: P1, periodEnd: P1_END, units: planUnits });
    else await c.configureCut({ organizationId: o, cutEnabled: false }); // crea la cuenta vacía
    if (topupUnits > 0) await c.adjustCredits({ organizationId: o, bucket: "topup", amount: topupUnits, idempotencyKey: `fund:${o}`, actorUserId: "", note: "prueba" });
  }

  beforeAll(async () => {
    vi.stubEnv("CREDITS", "on");
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("OPENROUTER_MODEL", "modelo-test");
    ({ eq, and, inArray } = await import("drizzle-orm"));
    const dbLib = await import("@/lib/db");
    db = dbLib.getDb();
    schema = dbLib.schema;
    c = await import("@/server/credits");
    sync = await import("@/server/saas/credits-sync");
    aiMeter = await import("@/server/ai/metering");
    outbox = await import("@/server/inbox/outbox");
    wa = await import("@/server/inbox/metering");
    for (const id of ids) await newOrg(id);
    await c.ensureDefaultRates();
  }, 60_000);

  beforeEach(() => {
    c.clearRateCache();
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of ids) await db.delete(schema.organization).where(eq(schema.organization.id, id));
    for (const id of plans.values()) await db.delete(schema.plan).where(eq(schema.plan.id, id));
  });

  /* ───────────────────── Tarifas provisionales ───────────────────── */

  describe("tarifas", () => {
    it("quedan sembradas en credit_rate y volver a sembrar no cambia nada", async () => {
      expect(await c.ensureDefaultRates()).toBe(0);
      const lib = await import("@/lib/credits");
      for (const r of lib.DEFAULT_RATES) {
        const row = await c.getRate(r.key);
        expect(row, r.key).not.toBeNull();
      }
      expect(await c.priceFor("ai.turn")).toBe(100);
      expect(await c.priceFor("wa.text")).toBe(0);
      expect(await c.priceFor("wa.template.marketing")).toBe(300);
      expect(await c.priceFor("wa.template.nunca-vista")).toBe(0); // sin tarifa: solo medido
    });
  });

  /* ───────────────────── Cuota por suscripción ───────────────────── */

  describe("cuota mensual que sigue a la suscripción", () => {
    it("una suscripción activa recibe la cuota de su plan, una sola vez por periodo", async () => {
      const [o] = [org("q1")];
      const planId = await newPlan("a", { monthlyCoins: 70_000 });
      const sub = await newSub(o, planId, "active");

      expect(await sync.syncOrgQuota(o)).toBe(true);
      expect((await bal(o)).plan).toBe(70_000);
      const grants = (await ledger(o)).filter((r) => r.kind === "grant");
      expect(grants).toHaveLength(1);
      expect(grants[0]!.idempotencyKey).toBe(`period:${sub}:${P1.toISOString()}`);

      await sync.syncOrgQuota(o);
      await sync.syncAllQuotas();
      expect((await bal(o)).plan).toBe(70_000);
      expect((await ledger(o)).filter((r) => r.kind === "grant")).toHaveLength(1);
    });

    it("la barrida atiende a quien no tiene cuenta y a quien renovó, y vence lo que sobró", async () => {
      const o = org("q2");
      const planId = await newPlan("b", { monthlyCoins: 50_000 });
      await newSub(o, planId, "active");
      expect(await sync.syncAllQuotas()).toBeGreaterThanOrEqual(1);
      expect((await bal(o)).plan).toBe(50_000);

      // Gasta algo y renueva: lo que sobró vence, la cuota nueva entra entera.
      await c.spendCredits({ organizationId: o, service: "ai", amount: 10_000, idempotencyKey: "q2:s1" });
      await db.update(schema.subscription).set({ currentPeriodStart: P2, currentPeriodEnd: P2_END }).where(eq(schema.subscription.organizationId, o));
      await sync.syncAllQuotas();

      expect((await bal(o)).plan).toBe(50_000); // no se acumula: 40.000 vencieron
      const l = await ledger(o);
      expect(l.filter((r) => r.kind === "expire").map((r) => r.amount)).toEqual([-40_000]);
      expect(l.filter((r) => r.kind === "grant")).toHaveLength(2);
    });

    it("una cancelada con el periodo cumplido pierde lo que le quedaba de cuota, pero NO sus recargas", async () => {
      const o = org("q3");
      const planId = await newPlan("c", { monthlyCoins: 30_000 });
      await newSub(o, planId, "active");
      await sync.syncOrgQuota(o);
      await c.adjustCredits({ organizationId: o, bucket: "topup", amount: 5_000, idempotencyKey: "q3:topup", actorUserId: "", note: "prueba" });
      await db.update(schema.subscription).set({ status: "canceled", currentPeriodEnd: new Date("2026-11-15T00:00:00.000Z") }).where(eq(schema.subscription.organizationId, o));

      await sync.syncAllQuotas(new Date("2026-11-20T00:00:00.000Z"));
      const b = await bal(o);
      expect(b.plan).toBe(0);
      expect(b.topup).toBe(5_000);
      // Y una segunda barrida no vuelve a tocarla.
      await sync.syncAllQuotas(new Date("2026-11-21T00:00:00.000Z"));
      expect((await ledger(o)).filter((r) => r.kind === "expire")).toHaveLength(1);
    });

    it("Enterprise (-1) queda sin tope: se mide, no se descuenta", async () => {
      const o = org("q4");
      const planId = await newPlan("d", { monthlyCoins: -1 });
      await newSub(o, planId, "active");
      await sync.syncOrgQuota(o);
      expect((await bal(o)).unlimited).toBe(true);
      expect((await c.spendCredits({ organizationId: o, service: "ai", amount: 100, idempotencyKey: "q4:s" })).status).toBe("unlimited");
      expect((await c.checkCredit(o)).reason).toBe("unlimited");
    });

    it("un plan por slug conocido usa la cuota provisional si no declara la suya", async () => {
      const lib = await import("@/lib/credits");
      // Un plan «pro» real de la base (sembrado por la plataforma) o, si no existe, el cálculo puro.
      expect(lib.quotaForPlan({ slug: "pro" })).toBe(350_000);
    });

    it("una organización sin suscripción no se mide: ensureCreditAccount no crea cuenta y el corte la deja pasar", async () => {
      const o = org("q5");
      await sync.ensureCreditAccount(o);
      expect(await c.getCreditBalance(o)).toBeNull();
      expect(await c.checkCredit(o, { amount: 100 })).toEqual({ allow: true, wouldCut: false, reason: "no_account" });
    });

    it("ensureCreditAccount concede la cuota de quien aún no tenía cuenta (sin esperar a la barrida)", async () => {
      const o = org("ai4");
      const planId = await newPlan("e", { monthlyCoins: 10_000 });
      await newSub(o, planId, "trialing");
      await sync.ensureCreditAccount(o);
      expect((await bal(o)).plan).toBe(10_000);
    });
  });

  /* ───────────────────── El turno del agente ───────────────────── */

  describe("turno del agente", () => {
    const turn = (o: string, isTest = false, last = "m1") => aiMeter.beginAiTurnMeter({ organizationId: o, conversationId: `cv_${o}`, lastInboundId: last, isTest });
    const okResult = (source: "env" | "org") => ({ ok: true as const, data: {}, raw: "{}", meta: { source, model: "m", tokensIn: 100, tokensOut: 20, estimated: false, attempts: 1 } });

    it("con saldo y en modo sombra: pasa, mide con la clave del turno y cobra UNA vez aunque se asiente dos", async () => {
      const o = org("ai1");
      await fund(o, 1_000);
      const m = await turn(o);
      expect(m.blocked).toBe(false);
      expect(m.usage).toMatchObject({ service: "ai", key: `ai:cv_${o}:m1`, chargeUnits: 100, wouldCut: false });

      await m.settle(okResult("env"));
      await m.settle(okResult("env")); // un reintento del mismo turno
      expect((await spends(o)).map((r) => r.amount)).toEqual([-100]);
      expect((await bal(o)).plan).toBe(900);
      const s = (await spends(o))[0]!;
      expect(s.idempotencyKey).toBe(`ai:cv_${o}:m1`);
      expect(s.meta).toMatchObject({ tokensIn: 100, tokensOut: 20, attempts: 1 });
    });

    it("sin saldo en modo sombra (cut_enabled=false): no corta, pero lo anota y cobra (queda en negativo)", async () => {
      const o = org("ai2");
      await fund(o, 0);
      expect((await bal(o)).cutEnabled).toBe(false);
      const m = await turn(o);
      expect(m.blocked).toBe(false);
      expect(m.usage?.wouldCut).toBe(true);
      await m.settle(okResult("env"));
      expect((await bal(o)).topup).toBe(-100);
    });

    it("sin saldo con el corte activo: bloquea (el pipeline se calla) y no escribe nada", async () => {
      const o = org("ai3");
      await fund(o, 0);
      await c.configureCut({ organizationId: o, cutEnabled: true });
      const m = await turn(o);
      expect(m.blocked).toBe(true);
      expect(m.usage).toBeUndefined();
      await m.settle(okResult("env"));
      expect(await spends(o)).toHaveLength(0);
      expect(await usage(o)).toHaveLength(0);
    });

    it("el Laboratorio se mide como ai_lab, no se cobra y no se corta ni con el corte activo y saldo 0", async () => {
      const o = org("ai3");
      const m = await turn(o, true, "lab1");
      expect(m.blocked).toBe(false);
      expect(m.usage).toMatchObject({ service: "ai_lab" });
      expect(m.usage?.chargeUnits).toBeUndefined();
      await m.settle(okResult("env"));
      expect(await spends(o)).toHaveLength(0);
    });

    it("una respuesta de la llave del CLIENTE (org) o un error del proveedor no cobran", async () => {
      const o = org("ai1");
      const antes = (await bal(o)).total;
      const m = await turn(o, false, "m-byok");
      await m.settle(okResult("org"));
      await m.settle({ ok: false, error: "provider_error", detail: "x" });
      expect((await bal(o)).total).toBe(antes);
    });

    it("dos turnos distintos de la misma conversación cobran cada uno", async () => {
      const o = org("ai1");
      const antes = (await bal(o)).total;
      for (const last of ["m-a", "m-b"]) await (await turn(o, false, last)).settle(okResult("env"));
      expect((await bal(o)).total).toBe(antes - 200);
    });
  });

  /* ───────────────────── Envíos de WhatsApp ───────────────────── */

  describe("envíos", () => {
    async function conv(o: string, n: string): Promise<string> {
      const contactId = `ct_${n}${tag}`;
      const convId = `cv_${n}${tag}`;
      await db.insert(schema.contact).values({ id: contactId, organizationId: o, name: `C ${n}`, waIdentity: `5199${n}${tag}`, phone: `5199${n}${tag}` });
      await db.insert(schema.conversation).values({ id: convId, organizationId: o, contactId, lastInboundAt: new Date() });
      return convId;
    }
    const send = (o: string, convId: string, consumo: Parameters<typeof outbox.enviarYRegistrar>[0]["consumo"], waId: string) =>
      outbox.enviarYRegistrar({
        organizationId: o,
        conversationId: convId,
        fila: { type: "text", text: "hola", origin: "template" },
        estadoAlAceptar: "pending",
        automatico: true,
        consumo,
        enviar: async () => waId,
      });

    it("una plantilla de marketing se cobra al confirmar Meta, una vez, y deja su medición", async () => {
      const o = org("wa1");
      await fund(o, 1_000);
      const cv = await conv(o, "a");
      const r = await send(o, cv, { channel: "whatsapp", template: true, templateCategory: "MARKETING" }, `wamid.${tag}.1`);

      const s = await spends(o);
      expect(s.map((x) => x.amount)).toEqual([-300]);
      expect(s[0]!.idempotencyKey).toBe(`wa:${r.messageId}`);
      expect(s[0]!.service).toBe("whatsapp");
      expect((await bal(o)).plan).toBe(700);

      const u = (await usage(o)).filter((x) => x.service === "whatsapp");
      expect(u).toHaveLength(1);
      expect(u[0]).toMatchObject({ category: "marketing", chargedUnits: 300, refId: r.messageId, idempotencyKey: `wa:${r.messageId}` });

      // Reintentar el mismo asiento (p. ej. un reproceso) no duplica ni la medición ni el cobro.
      await wa.medirEnvio({ organizationId: o, conversationId: cv, messageId: r.messageId, waMessageId: `wamid.${tag}.1`, consumo: { channel: "whatsapp", template: true, templateCategory: "marketing" } });
      expect(await spends(o)).toHaveLength(1);
      expect((await usage(o)).filter((x) => x.service === "whatsapp")).toHaveLength(1);
    });

    it("cada categoría cuesta lo suyo: utility 100, authentication 100, desconocida 100", async () => {
      const o = org("wa1");
      const cv = await conv(o, "b");
      const antes = (await bal(o)).total;
      await send(o, cv, { channel: "whatsapp", template: true, templateCategory: "utility" }, `wamid.${tag}.u`);
      await send(o, cv, { channel: "whatsapp", template: true, templateCategory: "authentication" }, `wamid.${tag}.a`);
      await send(o, cv, { channel: "whatsapp", template: true, templateCategory: "rara" }, `wamid.${tag}.r`);
      expect((await bal(o)).total).toBe(antes - 300);
    });

    it("el mensaje libre (ventana de 24 h) y los demás canales se miden a 0 y no tocan el libro", async () => {
      const o = org("wa2");
      await fund(o, 1_000);
      const cv = await conv(o, "c");
      await send(o, cv, { channel: "whatsapp" }, `wamid.${tag}.t`);
      await send(o, cv, { channel: "instagram" }, `wamid.${tag}.ig`);
      await send(o, cv, { channel: "instagram", template: true, templateCategory: "marketing" }, `wamid.${tag}.ig2`); // no existe, pero no cobra
      expect(await spends(o)).toHaveLength(0);
      expect((await bal(o)).plan).toBe(1_000);
      const u = (await usage(o)).filter((x) => x.service === "whatsapp");
      expect(u).toHaveLength(3);
      expect(u.every((x) => x.chargedUnits === 0)).toBe(true);
      expect(u.find((x) => x.idempotencyKey?.length)).toBeDefined();
    });

    it("un envío que falla en Meta no cobra ni mide", async () => {
      const o = org("wa2");
      const cv = await conv(o, "d");
      const antes = (await usage(o)).length;
      await expect(
        outbox.enviarYRegistrar({
          organizationId: o,
          conversationId: cv,
          fila: { type: "text", text: "x", origin: "template" },
          estadoAlAceptar: "pending",
          automatico: true,
          consumo: { channel: "whatsapp", template: true, templateCategory: "marketing" },
          enviar: async () => {
            throw new Error("Meta caída");
          },
        })
      ).rejects.toThrow("Meta caída");
      expect((await usage(o)).length).toBe(antes);
      expect(await spends(o)).toHaveLength(0);
    });

    it("sin `consumo` (llamadas viejas) el envío no mide nada: nada cambia", async () => {
      const o = org("wa2");
      const cv = await conv(o, "e");
      const antes = (await usage(o)).length;
      await send(o, cv, undefined, `wamid.${tag}.n`);
      expect((await usage(o)).length).toBe(antes);
    });

    it("pre-chequeo de plantillas: sombra deja pasar (y anota), corte activo sin saldo bloquea, con saldo pasa", async () => {
      const o = org("wa3");
      await fund(o, 0);
      const tpl = { channel: "whatsapp", template: true, templateCategory: "marketing" };
      expect(await wa.puedeEnviar(o, tpl)).toEqual({ allow: true, wouldCut: true, price: 300 });

      await c.configureCut({ organizationId: o, cutEnabled: true });
      expect(await wa.puedeEnviar(o, tpl)).toEqual({ allow: false, wouldCut: true, price: 300 });
      // Un mensaje libre nunca se bloquea: no cuesta.
      expect(await wa.puedeEnviar(o, { channel: "whatsapp" })).toEqual({ allow: true, wouldCut: false, price: 0 });

      await c.adjustCredits({ organizationId: o, bucket: "topup", amount: 400, idempotencyKey: `wa3:${tag}`, actorUserId: "", note: "recarga de prueba" });
      expect((await wa.puedeEnviar(o, tpl)).allow).toBe(true);
    });

    it("una plantilla que cuesta más de lo que queda se bloquea con el corte activo, aunque quede algo", async () => {
      const o = org("wa3");
      await c.adjustCredits({ organizationId: o, bucket: "topup", amount: -250, idempotencyKey: `wa3b:${tag}`, actorUserId: "", note: "queda 150" });
      expect((await bal(o)).total).toBe(150);
      expect((await wa.puedeEnviar(o, { channel: "whatsapp", template: true, templateCategory: "marketing" })).allow).toBe(false); // 300 > 150
      expect((await wa.puedeEnviar(o, { channel: "whatsapp", template: true, templateCategory: "utility" })).allow).toBe(true); // 100 ≤ 150
    });
  });

  /* ───────────────────── Conciliación ───────────────────── */

  it("después de todo esto, el libro cuadra con la caché de cada cuenta", async () => {
    const r = await c.reconcileCredits();
    const mios = r.drifts.filter((d) => ids.includes(d.organizationId));
    expect(mios).toEqual([]);
    expect(inArray).toBeDefined();
    expect(and).toBeDefined();
  });
});
