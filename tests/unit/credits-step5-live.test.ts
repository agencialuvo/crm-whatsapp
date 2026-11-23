import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Monedas, sub-paso 5.1, contra PostgreSQL REAL: el reporte de calibración (consumo por organización y servicio,
 * `wouldCut`, cuota y saldo), el detalle y las acciones del operador (ajuste idempotente con quién y por qué, corte
 * por organización), la conciliación (encuentra y solo repara si se pide) y la cuota `monthlyCoins` en los planes.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("monedas 5.1 (base real)", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let c: typeof import("@/server/credits");
  let sa: typeof import("@/server/super-admin/credits");
  let sync: typeof import("@/server/saas/credits-sync");
  let catalog: typeof import("@/server/seed/platform-catalog");

  const tag = Date.now().toString(36);
  const org = (n: string) => `org_h${n}${tag}`;
  const ids = ["r1", "r2", "r3", "a1", "a2", "c1", "c2"].map(org);
  const adminId = `usr_h${tag}`;
  const admin = { userId: adminId };

  const P1 = new Date("2026-11-01T00:00:00.000Z");
  const P1_END = new Date("2026-12-01T00:00:00.000Z");

  const grant = (o: string, units: number) => c.grantPeriodQuota({ organizationId: o, subscriptionId: `sub_h${o}`, periodStart: P1, periodEnd: P1_END, units });
  const usage = (o: string, over: Partial<Parameters<typeof c.recordUsage>[0]> & { key: string }) =>
    c.recordUsage({ organizationId: o, service: "ai", source: "env", conversationId: "cv_x", idempotencyKey: over.key, ...over });
  const ledger = async (o: string) => db.select().from(schema.creditLedger).where(eq(schema.creditLedger.organizationId, o));
  const row = async (o: string) => (await sa.creditsOverview(7)).report.rows.find((r) => r.organizationId === o);

  beforeAll(async () => {
    vi.stubEnv("CREDITS", "on");
    ({ eq } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    c = await import("@/server/credits");
    sa = await import("@/server/super-admin/credits");
    sync = await import("@/server/saas/credits-sync");
    catalog = await import("@/server/seed/platform-catalog");
    for (const id of ids) await db.insert(schema.organization).values({ id, name: `Org ${id}`, slug: id.toLowerCase() });
    await db.insert(schema.user).values({ id: adminId, name: "Admin prueba", email: `admin.${tag}@example.com` });
  }, 60_000);

  beforeEach(() => {
    (globalThis as { __creditReconcile?: unknown }).__creditReconcile = undefined;
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of ids) await db.delete(schema.organization).where(eq(schema.organization.id, id));
    await db.delete(schema.user).where(eq(schema.user.id, adminId));
  });

  /* ───────────────────── Reporte de calibración ───────────────────── */

  describe("reporte de calibración", () => {
    it("consumo por organización y servicio, con saldo, cuota y estado del corte", async () => {
      const o = org("r1");
      await grant(o, 10_000);
      // IA: 2 turnos válidos (uno tras un reintento fallido) y una llamada de la llave del cliente.
      await usage(o, { key: "r1:a#1", tokensIn: 100, tokensOut: 10, chargedUnits: 0, meta: { valid: false } });
      await usage(o, { key: "r1:a#2", tokensIn: 120, tokensOut: 20, chargedUnits: 100, meta: { valid: true } });
      await usage(o, { key: "r1:b#1", tokensIn: 50, tokensOut: 5, chargedUnits: 100, meta: { valid: true } });
      await usage(o, { key: "r1:c#1", source: "org", tokensIn: 40, tokensOut: 4, chargedUnits: 0, meta: { valid: true } });
      // Laboratorio.
      await usage(o, { key: "r1:lab", service: "ai_lab", tokensIn: 10, tokensOut: 1, meta: { valid: true } });
      // WhatsApp: una plantilla cobrada y un mensaje libre a 0.
      await c.recordUsage({ organizationId: o, service: "whatsapp", category: "marketing", chargedUnits: 300, idempotencyKey: "r1:w1" });
      await c.recordUsage({ organizationId: o, service: "whatsapp", category: "text", chargedUnits: 0, idempotencyKey: "r1:w2" });

      const r = (await row(o))!;
      expect(r.organizationName).toBe(`Org ${o}`);
      expect(r.account).toMatchObject({ planBalance: 10_000, quota: 10_000, cutEnabled: false, unlimited: false });
      expect(r.ai).toMatchObject({ events: 4, okEvents: 3, tokensIn: 310, tokensOut: 39, chargedUnits: 200, envEvents: 3 });
      expect(r.aiLab).toMatchObject({ events: 1 });
      expect(r.whatsapp).toMatchObject({ events: 2, okEvents: 2, chargedUnits: 300 });
      expect(r.wouldCutEvents).toBe(0);
    });

    it("cuenta los wouldCut válidos (no los reintentos fallidos) y la organización sube al principio", async () => {
      const o = org("r2");
      await grant(o, 100);
      await usage(o, { key: "r2:a#1", chargedUnits: 0, wouldCut: true, meta: { valid: false } }); // intento fallido: no cuenta
      await usage(o, { key: "r2:a#2", chargedUnits: 100, wouldCut: true, meta: { valid: true } });
      await usage(o, { key: "r2:b#1", chargedUnits: 100, wouldCut: true, meta: { valid: true } });
      await c.recordUsage({ organizationId: o, service: "whatsapp", category: "marketing", chargedUnits: 300, wouldCut: true, idempotencyKey: "r2:w" });

      const { report } = await sa.creditsOverview(7);
      const r = report.rows.find((x) => x.organizationId === o)!;
      expect(r.ai.wouldCutEvents).toBe(2);
      expect(r.whatsapp.wouldCutEvents).toBe(1);
      expect(r.wouldCutEvents).toBe(3);
      // Ordenado: lo más cortable primero.
      const idx = report.rows.findIndex((x) => x.organizationId === o);
      expect(report.rows.slice(0, idx).every((x) => x.wouldCutEvents >= 3)).toBe(true);
      expect(report.totals.wouldCutEvents).toBeGreaterThanOrEqual(3);
      expect(report.totals.orgsThatWouldBeCut).toBeGreaterThanOrEqual(1);
      expect(report.enabled).toBe(true);
    });

    it("el rango importa: el consumo viejo no entra en un rango corto", async () => {
      const o = org("r3");
      await usage(o, { key: "r3:viejo", chargedUnits: 100, meta: { valid: true } });
      await db.update(schema.creditUsage).set({ createdAt: new Date(Date.now() - 40 * 86_400_000) }).where(eq(schema.creditUsage.organizationId, o));
      expect((await sa.creditsOverview(7)).report.rows.find((x) => x.organizationId === o)).toBeUndefined();
      expect((await sa.creditsOverview(90)).report.rows.find((x) => x.organizationId === o)?.ai.okEvents).toBe(1);
    });

    it("con CREDITS apagada el reporte se puede leer y avisa que están apagadas", async () => {
      vi.stubEnv("CREDITS", "");
      const { report } = await sa.creditsOverview(7);
      expect(report.enabled).toBe(false);
      expect(report.rows.find((x) => x.organizationId === org("r1"))).toBeDefined();
      vi.stubEnv("CREDITS", "on");
    });

    it("el reporte no expone contenido de conversaciones: solo cifras y nombres de organización", async () => {
      const json = JSON.stringify((await sa.creditsOverview(7)).report);
      expect(json).not.toMatch(/"text"|"phone"|"email"|"token"/);
    });
  });

  /* ───────────────────── Detalle y acciones del operador ───────────────────── */

  describe("operador", () => {
    it("detalle: cuenta, libro con quién y por qué, y los wouldCut recientes", async () => {
      const o = org("r2");
      const d = (await sa.creditsOrgDetail(o))!;
      expect(d.account?.quota).toBe(100);
      expect(d.wouldCutTotal).toBe(3);
      expect(d.wouldCut.every((w) => ["ai", "whatsapp"].includes(w.service))).toBe(true);
      expect(d.ledger.length).toBeGreaterThan(0);
      expect(await sa.creditsOrgDetail("org_no_existe")).toBeNull();
    });

    it("ajuste manual: suma al saldo, queda en el libro con el operador y el motivo, y es idempotente por requestId", async () => {
      const o = org("a1");
      const input = { action: "adjust" as const, bucket: "topup" as const, coins: 12.5, note: "Compensación por caída", requestId: `req-${tag}-1` };
      expect(await sa.applyCreditsAction(admin, o, input)).toEqual({ ok: true, duplicate: false });
      expect(await sa.applyCreditsAction(admin, o, input)).toEqual({ ok: true, duplicate: true }); // doble clic
      const d = (await sa.creditsOrgDetail(o))!;
      expect(d.account?.topupBalance).toBe(1_250);
      const filas = (await ledger(o)).filter((r) => r.kind === "adjustment");
      expect(filas).toHaveLength(1);
      expect(filas[0]).toMatchObject({ amount: 1_250, actorUserId: adminId, note: "Compensación por caída", bucket: "topup" });
      // Un ajuste nuevo (otro requestId) es otra operación; restar también vale.
      await sa.applyCreditsAction(admin, o, { ...input, coins: -2.5, requestId: `req-${tag}-2`, note: "Corrección" });
      expect((await sa.creditsOrgDetail(o))!.account?.topupBalance).toBe(1_000);
    });

    it("la cuota del plan no puede quedar en negativo (422), pero las recargas sí admiten deuda", async () => {
      const o = org("a1");
      const r = await sa.applyCreditsAction(admin, o, { action: "adjust", bucket: "plan", coins: -5, note: "No debería pasar", requestId: `req-${tag}-3` });
      expect(r).toMatchObject({ ok: false, status: 422, code: "plan_would_be_negative" });
      const deuda = await sa.applyCreditsAction(admin, o, { action: "adjust", bucket: "topup", coins: -50, note: "Reembolso manual", requestId: `req-${tag}-4` });
      expect(deuda).toEqual({ ok: true, duplicate: false });
      expect((await sa.creditsOrgDetail(o))!.account?.topupBalance).toBe(1_000 - 5_000);
    });

    it("activar y desactivar el corte de UNA organización, sin tocar a las demás", async () => {
      const o = org("a2");
      const otra = org("a1");
      await grant(o, 1_000);
      expect((await sa.creditsOrgDetail(o))!.account?.cutEnabled).toBe(false);
      expect(await sa.applyCreditsAction(admin, o, { action: "cut", cutEnabled: true })).toEqual({ ok: true, duplicate: false });
      expect((await sa.creditsOrgDetail(o))!.account?.cutEnabled).toBe(true);
      expect((await sa.creditsOrgDetail(otra))!.account?.cutEnabled).toBe(false);
      await sa.applyCreditsAction(admin, o, { action: "cut", cutEnabled: true, overdraftCoins: 3 });
      expect((await sa.creditsOrgDetail(o))!.account?.overdraftLimit).toBe(300);
      await sa.applyCreditsAction(admin, o, { action: "cut", cutEnabled: false });
      expect((await sa.creditsOrgDetail(o))!.account?.cutEnabled).toBe(false);
      // El reporte lo refleja.
      await sa.applyCreditsAction(admin, o, { action: "cut", cutEnabled: true });
      expect((await sa.creditsOverview(7)).report.rows.find((r) => r.organizationId === o)?.account?.cutEnabled).toBe(true);
    });

    it("organización inexistente: 404; monedas apagadas: 409 y no cambia nada", async () => {
      expect(await sa.applyCreditsAction(admin, "org_no_existe", { action: "cut", cutEnabled: true })).toMatchObject({ ok: false, status: 404 });
      const o = org("a2");
      vi.stubEnv("CREDITS", "");
      const antes = (await ledger(o)).length;
      expect(await sa.applyCreditsAction(admin, o, { action: "adjust", bucket: "topup", coins: 5, note: "apagadas", requestId: `req-${tag}-5` })).toMatchObject({ ok: false, status: 409, code: "credits_off" });
      expect(await sa.applyCreditsAction(admin, o, { action: "cut", cutEnabled: false })).toMatchObject({ ok: false, code: "credits_off" });
      expect((await ledger(o)).length).toBe(antes);
      vi.stubEnv("CREDITS", "on");
    });

    it("el corte activado desde el panel sí corta: el chequeo del agente lo ve", async () => {
      const o = org("a2");
      await c.adjustCredits({ organizationId: o, bucket: "plan", amount: -1_000, idempotencyKey: `h:${tag}:vaciar`, actorUserId: adminId, note: "vaciar para la prueba" });
      await sa.applyCreditsAction(admin, o, { action: "cut", cutEnabled: true, overdraftCoins: 0 }); // sin tolerancia
      expect((await c.checkCredit(o, { amount: 100 })).allow).toBe(false); // corte activo, sin saldo
      await sa.applyCreditsAction(admin, o, { action: "cut", cutEnabled: false });
      expect(await c.checkCredit(o, { amount: 100 })).toMatchObject({ allow: true, wouldCut: true }); // vuelve a sombra
    });
  });

  /* ───────────────────── Conciliación ───────────────────── */

  describe("conciliación", () => {
    it("encuentra un descuadre, NO lo repara por defecto, y lo repara solo si se pide", async () => {
      const o = org("c1");
      await grant(o, 1_000);
      await db.update(schema.creditAccount).set({ planBalance: 999 }).where(eq(schema.creditAccount.organizationId, o));
      const consola = vi.spyOn(console, "error").mockImplementation(() => {});

      const s = (await sync.runReconcile())!;
      expect(s.error).toBeNull();
      expect(s.drifts.map((d) => d.organizationId)).toContain(o);
      expect(s.repaired).toBe(0);
      expect((await c.getCreditBalance(o))!.plan).toBe(999); // sigue mal: reparar es una decisión

      const r = (await sync.runReconcile({ repair: true }))!;
      expect(r.repaired).toBeGreaterThanOrEqual(1);
      expect((await c.getCreditBalance(o))!.plan).toBe(1_000);
      expect((await sync.runReconcile())!.drifts.filter((d) => ids.includes(d.organizationId))).toEqual([]);
      consola.mockRestore();
    });

    it("la diaria corre una vez por día y sobre las cuentas medidas", async () => {
      const t0 = new Date();
      expect(await sync.reconcileIfDue(t0)).toBe(true);
      expect(await sync.reconcileIfDue(new Date(t0.getTime() + 3_600_000))).toBe(false);
      expect(sync.lastReconcile()!.checked).toBeGreaterThanOrEqual(ids.length - 2);
      expect(await sync.reconcileIfDue(new Date(t0.getTime() + 25 * 3_600_000))).toBe(true);
    });

    it("el reporte muestra el último resultado de la conciliación", async () => {
      await sync.runReconcile();
      const o = await sa.creditsOverview(7);
      expect(o.reconcile?.at).toBeDefined();
    });
  });

  /* ───────────────────── Cuotas en los planes ───────────────────── */

  describe("monthlyCoins en los planes", () => {
    const SLUGS = ["demo", "emprendedor", "pro", "enterprise"] as const;
    type Snap = { id: string; slug: string; features: unknown };
    let snap: Snap[] = [];

    const planes = async () => (await db.select({ id: schema.plan.id, slug: schema.plan.slug, features: schema.plan.features }).from(schema.plan)).filter((p) => (SLUGS as readonly string[]).includes(p.slug));
    const coinsOf = (p: Snap) => (p.features as { monthlyCoins?: number }).monthlyCoins;

    beforeAll(async () => {
      await catalog.seedPlatformCatalog(); // por si la base de pruebas no tiene los planes base
      snap = await planes();
    });
    afterAll(async () => {
      for (const s of snap) await db.update(schema.plan).set({ features: s.features as never }).where(eq(schema.plan.id, s.id));
    });

    it("tras sembrar, los cuatro planes base tienen su cuota", async () => {
      await catalog.backfillPlanQuotas();
      const lib = await import("@/lib/credits");
      for (const p of await planes()) expect(coinsOf(p), p.slug).toBe(lib.DEFAULT_PLAN_QUOTA_UNITS[p.slug]);
    });

    it("rellena solo a quien no la declara, conserva el resto de features y es idempotente", async () => {
      const pro = (await planes()).find((p) => p.slug === "pro")!;
      const antes = pro.features as Record<string, unknown>;
      // Se la quitamos para simular un plan sembrado antes de las monedas.
      await db.execute(await import("drizzle-orm").then(({ sql }) => sql`update plan set features = features - 'monthlyCoins' where id = ${pro.id}`));
      expect(coinsOf((await planes()).find((p) => p.slug === "pro")!)).toBeUndefined();

      expect(await catalog.backfillPlanQuotas()).toBeGreaterThanOrEqual(1);
      const despues = (await planes()).find((p) => p.slug === "pro")!.features as Record<string, unknown>;
      expect(despues).toEqual(antes); // mismas features, con su monthlyCoins de vuelta
      expect(await catalog.backfillPlanQuotas()).toBe(0); // segunda vez: nada
    });

    it("no pisa una cuota ya fijada, ni siquiera 0 o sin tope", async () => {
      const [demo, emp, ent] = ["demo", "emprendedor", "enterprise"].map((s) => snap.find((p) => p.slug === s)!) as [Snap, Snap, Snap];
      for (const [p, v] of [[demo, 0], [emp, 777], [ent, -1]] as const) {
        await db.update(schema.plan).set({ features: { ...(p.features as object), monthlyCoins: v } as never }).where(eq(schema.plan.id, p.id));
      }
      expect(await catalog.backfillPlanQuotas()).toBe(0);
      const ahora = await planes();
      expect(coinsOf(ahora.find((p) => p.slug === "demo")!)).toBe(0);
      expect(coinsOf(ahora.find((p) => p.slug === "emprendedor")!)).toBe(777);
      expect(coinsOf(ahora.find((p) => p.slug === "enterprise")!)).toBe(-1);
    });

    it("no toca planes con otro slug", async () => {
      const id = `plan_h${tag}`;
      await db.insert(schema.plan).values({ id, name: `Otro ${tag}`, slug: `otro-${tag}`, features: { channels: [], modules: [] } });
      await catalog.backfillPlanQuotas();
      const [otro] = await db.select().from(schema.plan).where(eq(schema.plan.id, id));
      expect((otro!.features as { monthlyCoins?: number }).monthlyCoins).toBeUndefined();
      await db.delete(schema.plan).where(eq(schema.plan.id, id));
    });
  });
});
