import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Monedas, Paso 4, contra PostgreSQL REAL: los avisos de saldo (una vez por periodo y umbral, campanita y correo,
 * sin romper si falta SMTP), el ajuste de cuota por cambio de plan a mitad de periodo (solo sube, idempotente, tras
 * el commit de la suscripción) y la pregunta de corte de `/api/bot/messages`. Corre con `pnpm test:db`.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("monedas, paso 4 (base real)", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let c: typeof import("@/server/credits");
  let sync: typeof import("@/server/saas/credits-sync");
  let alerts: typeof import("@/server/notifications/credit-alerts");
  let aiMeter: typeof import("@/server/ai/metering");
  let subs: typeof import("@/server/saas/subscription");

  const tag = Date.now().toString(36);
  const org = (n: string) => `org_g${n}${tag}`;
  const names = ["al1", "al2", "al3", "al4", "pc1", "pc2", "pc3", "pc4", "pc5", "bt1", "bt2"];
  const ids = names.map(org);
  const planIds: string[] = [];
  const userIds: string[] = [];

  const P1 = new Date("2026-11-01T00:00:00.000Z");
  const P1_END = new Date("2026-12-01T00:00:00.000Z");
  const P2 = new Date("2026-12-01T00:00:00.000Z");
  const P2_END = new Date("2027-01-01T00:00:00.000Z");

  async function newPlan(n: string, features: Record<string, unknown>): Promise<string> {
    const id = `plan_g${n}${tag}`;
    await db.insert(schema.plan).values({ id, name: `Plan ${n} ${tag}`, slug: `tg-${n}-${tag}`, features: { channels: [], modules: [], ...features } as never });
    planIds.push(id);
    return id;
  }
  async function newSub(o: string, planId: string, start = P1, end = P1_END, status: "active" | "trialing" = "active"): Promise<string> {
    const id = `sub_g${o}`;
    await db.insert(schema.subscription).values({ id, organizationId: o, planId, status, currentPeriodStart: start, currentPeriodEnd: end });
    return id;
  }
  const bal = async (o: string) => (await c.getCreditBalance(o))!;
  const ledger = async (o: string) => db.select().from(schema.creditLedger).where(eq(schema.creditLedger.organizationId, o));
  const bells = async (o: string) => db.select().from(schema.notifications).where(eq(schema.notifications.organizationId, o));
  const alertRows = async (o: string) => db.select().from(schema.creditAlert).where(eq(schema.creditAlert.organizationId, o));
  const spend = (o: string, amount: number, key: string) => c.spendCredits({ organizationId: o, service: "ai", amount, idempotencyKey: key });
  const grant = (o: string, units: number, start = P1, end = P1_END) =>
    c.grantPeriodQuota({ organizationId: o, subscriptionId: `sub_x${o}`, periodStart: start, periodEnd: end, units });

  async function addMember(o: string, email: string, role: string): Promise<void> {
    const uid = `usr_g${userIds.length}${tag}`;
    userIds.push(uid);
    await db.insert(schema.user).values({ id: uid, name: `U ${uid}`, email });
    await db.insert(schema.member).values({ id: `mem_g${uid}`, organizationId: o, userId: uid, role });
  }

  beforeAll(async () => {
    vi.stubEnv("CREDITS", "on");
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("OPENROUTER_MODEL", "modelo-test");
    ({ eq } = await import("drizzle-orm"));
    const dbLib = await import("@/lib/db");
    db = dbLib.getDb();
    schema = dbLib.schema;
    c = await import("@/server/credits");
    sync = await import("@/server/saas/credits-sync");
    alerts = await import("@/server/notifications/credit-alerts");
    aiMeter = await import("@/server/ai/metering");
    subs = await import("@/server/saas/subscription");
    for (const id of ids) await db.insert(schema.organization).values({ id, name: `Org ${id}`, slug: id.toLowerCase() });
    await c.ensureDefaultRates();
  }, 60_000);

  beforeEach(() => c.clearRateCache());

  afterAll(async () => {
    if (!db) return;
    for (const id of ids) await db.delete(schema.organization).where(eq(schema.organization.id, id));
    for (const id of planIds) await db.delete(schema.plan).where(eq(schema.plan.id, id));
    for (const id of userIds) await db.delete(schema.user).where(eq(schema.user.id, id));
  });

  /* ───────────────────── Avisos de saldo ───────────────────── */

  describe("avisos de saldo", () => {
    it("sin cuenta, plan sin tope o monedas apagadas: no avisa nada", async () => {
      expect(await alerts.notifyBalanceIfNeeded(org("al4"))).toBeNull();
      await grant(org("al4"), -1);
      expect(await alerts.notifyBalanceIfNeeded(org("al4"))).toBeNull();
      vi.stubEnv("CREDITS", "");
      expect(await alerts.notifyBalanceIfNeeded(org("al4"))).toBeNull();
      vi.stubEnv("CREDITS", "on");
      expect(await bells(org("al4"))).toHaveLength(0);
    });

    it("cruza 80 %, se acaba la cuota y llega a cero: un aviso por umbral, cada uno UNA vez por periodo", async () => {
      const o = org("al1");
      await addMember(o, `owner.${tag}@example.com`, "owner");
      await addMember(o, `miembro.${tag}@example.com`, "member");
      await grant(o, 1_000);

      expect(await alerts.notifyBalanceIfNeeded(o)).toBeNull(); // 100 % disponible
      await spend(o, 850, "al1:a"); // quedan 150 ≤ 20 %
      expect(await alerts.notifyBalanceIfNeeded(o)).toBe("warn80");
      expect(await alerts.notifyBalanceIfNeeded(o)).toBeNull(); // mismo umbral: no se repite

      await spend(o, 150, "al1:b"); // cuota en 0, sin recargas → todo en cero
      expect(await alerts.notifyBalanceIfNeeded(o)).toBe("zero");
      expect(await alerts.notifyBalanceIfNeeded(o)).toBeNull();

      const rows = await alertRows(o);
      expect(rows.map((r) => r.threshold).sort()).toEqual(["warn80", "zero"]);
      const campanita = await bells(o);
      expect(campanita.map((b) => b.title).sort()).toEqual(["Te quedan pocas monedas", "Te quedaste sin monedas"]);
      expect(campanita.every((b) => b.category === "sistema")).toBe(true);
    });

    it("el umbral «exhausted» avisa que solo quedan recargas", async () => {
      const o = org("al2");
      await grant(o, 1_000);
      await c.adjustCredits({ organizationId: o, bucket: "topup", amount: 500, idempotencyKey: "al2:t", actorUserId: "", note: "recarga" });
      await spend(o, 1_000, "al2:s");
      expect(await alerts.notifyBalanceIfNeeded(o)).toBe("exhausted");
      expect((await bells(o))[0]!.message).toContain("recarga");
    });

    it("un periodo nuevo vuelve a avisar", async () => {
      const o = org("al2");
      await grant(o, 1_000, P2, P2_END);
      await spend(o, 1_000, "al2:p2");
      // Todavía quedan 500 de recarga: «exhausted» del periodo nuevo, que es otra clave que la del anterior.
      expect(await alerts.notifyBalanceIfNeeded(o)).toBe("exhausted");
      expect((await alertRows(o)).filter((r) => r.threshold === "exhausted")).toHaveLength(2);
    });

    it("avisos simultáneos del mismo umbral: sale UNO", async () => {
      const o = org("al3");
      await grant(o, 1_000);
      await spend(o, 1_000, "al3:s");
      const r = await Promise.all(Array.from({ length: 8 }, () => alerts.notifyBalanceIfNeeded(o)));
      expect(r.filter((x) => x === "zero")).toHaveLength(1);
      expect(await bells(o)).toHaveLength(1);
    });

    it("el correo sale a dueños y administradores (no a miembros) y sin SMTP no rompe nada", async () => {
      const o = org("al1");
      const consola = vi.spyOn(console, "log").mockImplementation(() => {});
      await addMember(o, `admin.${tag}@example.com`, "admin");
      // Nuevo periodo para poder avisar otra vez en esta organización.
      await grant(o, 1_000, P2, P2_END);
      await spend(o, 900, "al1:p2");
      expect(await alerts.notifyBalanceIfNeeded(o)).toBe("warn80");
      const enviados = consola.mock.calls.map((a) => String(a[0])).filter((s) => s.includes("[correo:desarrollo]"));
      expect(enviados.some((s) => s.includes(`owner.${tag}@example.com`))).toBe(true);
      expect(enviados.some((s) => s.includes(`admin.${tag}@example.com`))).toBe(true);
      expect(enviados.some((s) => s.includes(`miembro.${tag}@example.com`))).toBe(false);
      consola.mockRestore();
    });

    it("sin SMTP en producción el correo falla en silencio y la campanita igual avisa", async () => {
      const o = org("al4");
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("SMTP_HOST", "");
      vi.stubEnv("SMTP_FROM", "");
      await addMember(o, `dueno4.${tag}@example.com`, "owner");
      const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
      await c.grantPeriodQuota({ organizationId: o, subscriptionId: `sub_x${o}`, periodStart: P1, periodEnd: P1_END, units: 1_000 });
      await spend(o, 1_000, "al4:s");
      expect(await alerts.notifyBalanceIfNeeded(o)).toBe("zero");
      expect(await bells(o)).toHaveLength(1);
      expect(aviso.mock.calls.some((a) => String(a[0]).includes("no enviado"))).toBe(true);
      aviso.mockRestore();
      vi.unstubAllEnvs();
      vi.stubEnv("CREDITS", "on");
    });
  });

  /* ───────────────────── Cambio de plan a mitad de periodo ───────────────────── */

  describe("cambio de plan en el periodo", () => {
    const opAdjust = (o: string, units: number, start = P1) =>
      c.adjustPeriodQuota({ organizationId: o, subscriptionId: `sub_g${o}`, periodStart: start, units });

    it("subir de plan: entra solo la diferencia, una vez, y el libro lo explica", async () => {
      const o = org("pc1");
      await grant(o, 1_000);
      // `grant` usa otra clave de suscripción; la suma del periodo es lo que importa.
      await spend(o, 400, "pc1:s");
      const r = await opAdjust(o, 3_500);
      expect(r).toMatchObject({ status: "applied", balance: { plan: 600 + 2_500 } });
      expect((await opAdjust(o, 3_500)).status).toBe("nothing"); // repetir no suma
      const g = (await ledger(o)).filter((x) => x.kind === "grant").map((x) => x.amount).sort((a, b) => a - b);
      expect(g).toEqual([1_000, 2_500]);
      expect((await bal(o)).plan).toBe(3_100);
    });

    it("bajar de plan a mitad de periodo no quita nada", async () => {
      const o = org("pc1");
      expect((await opAdjust(o, 200)).status).toBe("nothing");
      expect((await bal(o)).plan).toBe(3_100);
    });

    it("pasar a «sin tope» lo marca ilimitado, y salir de él carga la cuota nueva completa", async () => {
      const o = org("pc2");
      await grant(o, 1_000);
      expect((await opAdjust(o, -1)).status).toBe("unlimited");
      expect((await bal(o)).unlimited).toBe(true);
      expect((await opAdjust(o, -1)).status).toBe("nothing");
      expect((await opAdjust(o, 2_000)).status).toBe("applied");
      const b = await bal(o);
      expect(b.unlimited).toBe(false);
      expect(b.plan).toBe(1_000 + 1_000); // el ajuste cubre lo que falta hasta 2.000 del periodo
    });

    it("un periodo distinto al cargado es `stale`: no toca nada", async () => {
      const o = org("pc2");
      expect((await opAdjust(o, 9_000, P2)).status).toBe("stale");
    });

    it("syncOrgQuota detecta el plan nuevo de la suscripción y ajusta la cuota del mismo periodo", async () => {
      const o = org("pc3");
      const pBajo = await newPlan("bajo", { monthlyCoins: 10_000 });
      const pAlto = await newPlan("alto", { monthlyCoins: 40_000 });
      await newSub(o, pBajo);
      await sync.syncOrgQuota(o);
      expect((await bal(o)).plan).toBe(10_000);
      await db.update(schema.subscription).set({ planId: pAlto }).where(eq(schema.subscription.organizationId, o));
      await sync.syncOrgQuota(o);
      await sync.syncOrgQuota(o);
      expect((await bal(o)).plan).toBe(40_000);
      expect((await ledger(o)).filter((x) => x.kind === "grant")).toHaveLength(2);
    });

    it("tras el commit de la puerta de la suscripción (change_plan) la cuota sube sola, sin esperar al barrido", async () => {
      const o = org("pc4");
      const pBajo = await newPlan("bajo2", { monthlyCoins: 10_000 });
      const pAlto = await newPlan("alto2", { monthlyCoins: 25_000 });
      await newSub(o, pBajo, new Date(), new Date(Date.now() + 25 * 86_400_000));
      await sync.syncOrgQuota(o);
      expect((await bal(o)).plan).toBe(10_000);

      const res = await subs.applySubscriptionAction({ organizationId: o, action: "change_plan", planId: pAlto, reason: "prueba", actor: { userId: null, ip: null } as never });
      expect(res.ok).toBe(true);
      // El ajuste corre después del commit y sin que nadie lo espere: se sondea un momento.
      await vi.waitFor(async () => expect((await bal(o)).plan).toBe(25_000), { timeout: 5_000, interval: 100 });
    });

    it("si las monedas fallan, la suscripción ya quedó escrita: el cambio de plan no se deshace ni lanza", async () => {
      const o = org("pc5");
      const pBajo = await newPlan("bajo3", { monthlyCoins: 10_000 });
      const pAlto = await newPlan("alto3", { monthlyCoins: 25_000 });
      await newSub(o, pBajo, new Date(), new Date(Date.now() + 25 * 86_400_000));
      await sync.syncOrgQuota(o);
      const roto = vi.spyOn(c, "adjustPeriodQuota");
      roto.mockRejectedValue(new Error("monedas caídas"));
      const consola = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await subs.applySubscriptionAction({ organizationId: o, action: "change_plan", planId: pAlto, reason: "prueba", actor: { userId: null, ip: null } as never });
      expect(res.ok).toBe(true);
      const [s] = await db.select().from(schema.subscription).where(eq(schema.subscription.organizationId, o));
      expect(s!.planId).toBe(pAlto);
      roto.mockRestore();
      consola.mockRestore();
      // Y el siguiente intento (la barrida, el próximo consumo) lo corrige.
      await sync.syncOrgQuota(o);
      await vi.waitFor(async () => expect((await bal(o)).plan).toBe(25_000), { timeout: 5_000, interval: 100 });
    });
  });

  /* ───────────────────── Corte para /api/bot/messages ───────────────────── */

  describe("aiBlockedByCredit", () => {
    it("modo sombra y con saldo: no bloquea", async () => {
      const o = org("bt1");
      await grant(o, 1_000);
      expect(await aiMeter.aiBlockedByCredit(o)).toBe(false);
      await spend(o, 1_000, "bt1:s");
      expect(await aiMeter.aiBlockedByCredit(o)).toBe(false); // sombra: cut_enabled=false
    });

    it("corte activo sin saldo para un turno: bloquea; con una recarga, no; apagadas las monedas, nunca", async () => {
      const o = org("bt1");
      await c.configureCut({ organizationId: o, cutEnabled: true });
      expect(await aiMeter.aiBlockedByCredit(o)).toBe(true);
      await c.adjustCredits({ organizationId: o, bucket: "topup", amount: 150, idempotencyKey: "bt1:t", actorUserId: "", note: "recarga" });
      expect(await aiMeter.aiBlockedByCredit(o)).toBe(false); // alcanza para 1 turno (100)
      vi.stubEnv("CREDITS", "");
      await spend(o, 0, "x").catch(() => {});
      expect(await aiMeter.aiBlockedByCredit(o)).toBe(false);
      vi.stubEnv("CREDITS", "on");
    });

    it("organización sin cuenta (sin suscripción): no se mide y no se corta", async () => {
      expect(await aiMeter.aiBlockedByCredit(org("bt2"))).toBe(false);
    });
  });

  it("al final el libro cuadra con la caché de cada cuenta", async () => {
    const r = await c.reconcileCredits();
    expect(r.drifts.filter((d) => ids.includes(d.organizationId))).toEqual([]);
  });
});
