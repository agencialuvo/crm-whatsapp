import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Monedas, 5.2, contra PostgreSQL REAL: el resumen que ve el cliente (saldo, cuota del libro, consumo del periodo por
 * servicio, bloqueos) y la franja de «sin monedas», con cuentas de verdad. Solo lee: nada de esto mueve saldo.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("monedas 5.2 (base real)", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let c: typeof import("@/server/credits");
  let sum: typeof import("@/server/saas/credits-summary");

  const tag = Date.now().toString(36);
  const org = (n: string) => `org_u${n}${tag}`;
  const ids = ["s1", "s2", "s3", "s4", "s5"].map(org);
  const P1 = new Date("2026-11-01T00:00:00.000Z");
  const P1_END = new Date("2026-12-01T00:00:00.000Z");

  const grant = (o: string, units: number) => c.grantPeriodQuota({ organizationId: o, subscriptionId: `sub_u${o}`, periodStart: P1, periodEnd: P1_END, units });
  const ai = (o: string, k: string, amount = 100) => c.spendCredits({ organizationId: o, service: "ai", amount, idempotencyKey: k });
  const wa = (o: string, k: string, amount = 300) => c.spendCredits({ organizationId: o, service: "whatsapp", amount, idempotencyKey: k });

  beforeAll(async () => {
    vi.stubEnv("CREDITS", "on");
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("OPENROUTER_MODEL", "modelo-test");
    ({ eq } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    c = await import("@/server/credits");
    sum = await import("@/server/saas/credits-summary");
    for (const id of ids) await db.insert(schema.organization).values({ id, name: `Org ${id}`, slug: id.toLowerCase() });
    await c.ensureDefaultRates();
  }, 60_000);

  beforeEach(() => c.clearRateCache());

  afterAll(async () => {
    if (!db) return;
    for (const id of ids) await db.delete(schema.organization).where(eq(schema.organization.id, id));
  });

  it("sin suscripción: habilitado pero sin cuenta (`metered: false`) y sin franja", async () => {
    const s = await sum.creditSummary(org("s5"));
    expect(s).toMatchObject({ enabled: true, metered: false, total: 0 });
    expect(await sum.avisoMonedasDe(org("s5"))).toBeNull();
  });

  it("saldo, cuota del libro y consumo por servicio salen de lo que de verdad se cobró", async () => {
    const o = org("s1");
    await grant(o, 10_000);
    await ai(o, "s1:a", 100);
    await ai(o, "s1:b", 100);
    await wa(o, "s1:w", 300);
    await ai(o, "s1:a", 100); // repetido: no cuenta dos veces
    const s = await sum.creditSummary(o);
    if (!s.enabled) throw new Error("debería estar habilitado");
    expect(s).toMatchObject({ metered: true, unlimited: false, planBalance: 9_500, topupBalance: 0, total: 9_500, quota: 10_000, cutEnabled: false });
    expect(s.spend).toEqual({ ai: { count: 2, units: 200 }, whatsapp: { count: 1, units: 300 } });
    expect(s.turnCost).toBe(100);
    expect(s.templateCosts).toMatchObject({ marketing: 300, utility: 100, authentication: 100, other: 100 });
  });

  it("un gasto repartido entre cuota y recargas cuenta como UNA respuesta y su total completo", async () => {
    const o = org("s2");
    await grant(o, 150);
    await c.adjustCredits({ organizationId: o, bucket: "topup", amount: 500, idempotencyKey: `s2:t:${tag}`, actorUserId: "", note: "recarga de prueba" });
    await wa(o, "s2:w", 300); // 150 de la cuota + 150 de recargas → dos filas del libro
    const s = await sum.creditSummary(o);
    if (!s.enabled) throw new Error("x");
    expect(s.spend.whatsapp).toEqual({ count: 1, units: 300 });
    expect(s).toMatchObject({ planBalance: 0, topupBalance: 350, total: 350 });
  });

  it("el consumo de un periodo anterior no entra en el actual", async () => {
    const o = org("s2");
    await db.update(schema.creditLedger).set({ createdAt: new Date("2026-01-05T00:00:00.000Z") }).where(eq(schema.creditLedger.organizationId, o));
    const s = await sum.creditSummary(o);
    if (!s.enabled) throw new Error("x");
    expect(s.spend).toEqual({ ai: { count: 0, units: 0 }, whatsapp: { count: 0, units: 0 } });
  });

  it("modo sombra: sin saldo no hay bloqueo ni franja", async () => {
    const o = org("s3");
    await grant(o, 100);
    await ai(o, "s3:a", 100);
    await ai(o, "s3:b", 100); // queda en deuda
    const s = await sum.creditSummary(o);
    if (!s.enabled) throw new Error("x");
    expect(s.total).toBeLessThan(0);
    expect(s).toMatchObject({ cutEnabled: false, blockedAi: false, blockedTemplates: false });
    expect(await sum.avisoMonedasDe(o)).toBeNull();
  });

  it("corte activo y sin saldo: bloquea, y la franja dice que el agente está en pausa (llave de la plataforma)", async () => {
    const o = org("s3");
    await c.configureCut({ organizationId: o, cutEnabled: true, overdraftLimit: 0 });
    const s = await sum.creditSummary(o);
    if (!s.enabled) throw new Error("x");
    expect(s).toMatchObject({ cutEnabled: true, blockedAi: true, blockedTemplates: true });
    const a = await sum.avisoMonedasDe(o);
    expect(a?.kind).toBe("agent");
    expect(a?.mensaje).toContain("siguen llegando a la bandeja");
  });

  it("al recargar, la franja desaparece sola", async () => {
    const o = org("s3");
    await c.adjustCredits({ organizationId: o, bucket: "topup", amount: 1_000, idempotencyKey: `s3:r:${tag}`, actorUserId: "", note: "recarga" });
    expect(await sum.avisoMonedasDe(o)).toBeNull();
    const s = await sum.creditSummary(o);
    if (!s.enabled) throw new Error("x");
    expect(s).toMatchObject({ blockedAi: false, blockedTemplates: false });
  });

  it("plan sin tope: nunca se bloquea ni hay franja, aunque el corte esté activo", async () => {
    const o = org("s4");
    await grant(o, -1);
    await c.configureCut({ organizationId: o, cutEnabled: true });
    const s = await sum.creditSummary(o);
    if (!s.enabled) throw new Error("x");
    expect(s).toMatchObject({ unlimited: true, blockedAi: false, blockedTemplates: false });
    expect(await sum.avisoMonedasDe(o)).toBeNull();
  });

  it("con CREDITS apagada no se toca nada: `enabled: false` y sin franja", async () => {
    vi.stubEnv("CREDITS", "");
    expect(await sum.creditSummary(org("s1"))).toEqual({ enabled: false });
    expect(await sum.avisoMonedasDe(org("s3"))).toBeNull();
    vi.stubEnv("CREDITS", "on");
  });

  it("solo lee: tras pedir el resumen el libro de cada cuenta no cambió", async () => {
    const antes = (await db.select().from(schema.creditLedger).where(eq(schema.creditLedger.organizationId, org("s1")))).length;
    await sum.creditSummary(org("s1"));
    await sum.avisoMonedasDe(org("s1"));
    expect((await db.select().from(schema.creditLedger).where(eq(schema.creditLedger.organizationId, org("s1")))).length).toBe(antes);
  });
});
