import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Monedas contra PostgreSQL REAL: lo que los mocks no pueden probar. Idempotencia por clave, orden plan → recargas,
 * vencimiento de la cuota, sobregiro, modo sombra, aislamiento entre organizaciones, carreras entre operaciones
 * simultáneas y que el libro siempre cuadre con la caché. Corre con `pnpm test:db`; sin `RUN_DB_TESTS` se salta.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("monedas (base real)", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let like: (typeof import("drizzle-orm"))["like"];
  let c: typeof import("@/server/credits");
  let lib: typeof import("@/lib/credits");

  const tag = Date.now().toString(36);
  const orgA = `org_ca${tag}`;
  const orgB = `org_cb${tag}`;
  const orgs = [orgA, orgB];
  const RATE_KEY = `test.rate.${tag}`;

  const P1 = new Date("2026-11-01T00:00:00.000Z");
  const P1_END = new Date("2026-12-01T00:00:00.000Z");
  const P2 = new Date("2026-12-01T00:00:00.000Z");
  const P2_END = new Date("2027-01-01T00:00:00.000Z");

  const grant = (org: string, units: number, start = P1, end = P1_END, sub = "sub_t") =>
    c.grantPeriodQuota({ organizationId: org, subscriptionId: `${sub}${tag}`, periodStart: start, periodEnd: end, units });
  const spend = (org: string, amount: number, key: string, service: "ai" | "whatsapp" = "ai") =>
    c.spendCredits({ organizationId: org, service, amount, idempotencyKey: key });
  const ledger = async (org: string) =>
    db.select().from(schema.creditLedger).where(eq(schema.creditLedger.organizationId, org)).orderBy(schema.creditLedger.createdAt);
  const bal = async (org: string) => (await c.getCreditBalance(org))!;

  beforeAll(async () => {
    vi.stubEnv("CREDITS", "on");
    ({ eq, like } = await import("drizzle-orm"));
    const dbLib = await import("@/lib/db");
    db = dbLib.getDb();
    schema = dbLib.schema;
    c = await import("@/server/credits");
    lib = await import("@/lib/credits");
    for (const [id, slug] of [[orgA, `ca-${tag}`], [orgB, `cb-${tag}`]] as const) {
      await db.insert(schema.organization).values({ id, name: `Org ${slug}`, slug });
    }
  });

  afterAll(async () => {
    if (!db) return;
    // Todo lo de una organización cae en cascada con ella; las tarifas y paquetes de prueba se borran aparte.
    for (const id of orgs) await db.delete(schema.organization).where(eq(schema.organization.id, id));
    await db.delete(schema.creditRate).where(like(schema.creditRate.key, `test.rate.${tag}%`));
    await db.delete(schema.creditPack).where(like(schema.creditPack.name, `Prueba ${tag}%`));
  });

  /* ───────────────────── Cuota del periodo ───────────────────── */

  describe("cuota mensual", () => {
    it("sin cuenta: no hay saldo ni corte (la organización no está medida)", async () => {
      expect(await c.getCreditBalance(orgA)).toBeNull();
      expect(await c.checkCredit(orgA)).toEqual({ allow: true, wouldCut: false, reason: "no_account" });
    });

    it("concede la cuota del periodo y deja constancia en el libro", async () => {
      const r = await grant(orgA, 1000);
      expect(r).toMatchObject({ status: "applied", balance: { plan: 1000, topup: 0, total: 1000 } });
      const rows = await ledger(orgA);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "grant", bucket: "plan", amount: 1000, refType: "subscription" });
      expect(rows[0]!.idempotencyKey).toBe(`period:sub_t${tag}:${P1.toISOString()}`);
      const b = await bal(orgA);
      expect(b.planPeriodStart?.toISOString()).toBe(P1.toISOString());
      expect(b.planPeriodEnd?.toISOString()).toBe(P1_END.toISOString());
    });

    it("repetir la concesión del mismo periodo no hace nada (idempotente)", async () => {
      const r = await grant(orgA, 1000);
      expect(r.status).toBe("duplicate");
      expect((await bal(orgA)).plan).toBe(1000);
      expect(await ledger(orgA)).toHaveLength(1);
    });

    it("un periodo anterior al cargado se ignora: no pisa el más nuevo", async () => {
      const old = await grant(orgA, 5000, new Date("2026-10-01T00:00:00.000Z"), P1);
      expect(old.status).toBe("stale");
      expect((await bal(orgA)).plan).toBe(1000);
    });

    it("cuota 0 (el plan no incluye): no escribe en el libro", async () => {
      const r = await grant(orgB, 0);
      expect(r).toMatchObject({ status: "nothing", reason: "zero_quota" });
      expect(await ledger(orgB)).toHaveLength(0);
    });
  });

  /* ───────────────────── Gasto: orden y negativos ───────────────────── */

  describe("gasto: primero la cuota del plan, luego las recargas", () => {
    it("un gasto que cabe en la cuota sale solo del plan", async () => {
      const r = await spend(orgA, 300, "ai:cv_1:msg_1");
      expect(r).toMatchObject({ status: "applied", fromPlan: 300, fromTopup: 0, balance: { plan: 700, topup: 0, total: 700 } });
      const rows = (await ledger(orgA)).filter((l) => l.kind === "spend");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ bucket: "plan", amount: -300, service: "ai" });
    });

    it("el mismo gasto repetido (un reintento) NO cobra dos veces", async () => {
      const r = await spend(orgA, 300, "ai:cv_1:msg_1");
      expect(r.status).toBe("duplicate");
      expect((await bal(orgA)).plan).toBe(700);
      expect((await ledger(orgA)).filter((l) => l.kind === "spend")).toHaveLength(1);
    });

    it("gasto de 0 unidades: no escribe nada", async () => {
      expect(await spend(orgA, 0, "wa:msg_libre", "whatsapp")).toMatchObject({ status: "nothing", reason: "zero_amount" });
      expect((await ledger(orgA)).filter((l) => l.kind === "spend")).toHaveLength(1);
    });

    it("las recargas se abonan al saldo que no vence", async () => {
      const r = await c.applyTopup({ organizationId: orgA, units: 500, idempotencyKey: "topup:manual_1" });
      expect(r).toMatchObject({ status: "applied", balance: { plan: 700, topup: 500, total: 1200 } });
      expect((await c.applyTopup({ organizationId: orgA, units: 500, idempotencyKey: "topup:manual_1" })).status).toBe("duplicate");
      expect((await bal(orgA)).topup).toBe(500);
    });

    it("un gasto que toca los dos saldos deja DOS filas, plan primero y luego recargas", async () => {
      const r = await spend(orgA, 900, "wa:msg_grande", "whatsapp");
      expect(r).toMatchObject({ status: "applied", fromPlan: 700, fromTopup: 200, balance: { plan: 0, topup: 300, total: 300 } });
      const rows = (await ledger(orgA)).filter((l) => l.idempotencyKey.startsWith("wa:msg_grande"));
      expect(rows.map((l) => [l.bucket, l.amount, l.idempotencyKey]).sort()).toEqual(
        [["plan", -700, "wa:msg_grande"], ["topup", -200, "wa:msg_grande~topup"]].sort()
      );
    });

    it("repetir el gasto partido tampoco cobra de nuevo ni deja filas de más", async () => {
      const antes = (await ledger(orgA)).length;
      expect((await spend(orgA, 900, "wa:msg_grande", "whatsapp")).status).toBe("duplicate");
      expect(await ledger(orgA)).toHaveLength(antes);
      expect(await bal(orgA)).toMatchObject({ plan: 0, topup: 300 });
    });

    it("un gasto YA HECHO siempre se registra, aunque deje las recargas en negativo", async () => {
      const r = await spend(orgA, 1000, "ai:cv_2:msg_2");
      expect(r).toMatchObject({ status: "applied", fromPlan: 0, fromTopup: 1000, balance: { plan: 0, topup: -700, total: -700 } });
    });
  });

  /* ───────────────────── Renovación y vencimiento ───────────────────── */

  describe("renovación del periodo: la cuota vence y no se acumula", () => {
    it("al cargar el periodo siguiente, lo que sobró VENCE y entra la cuota nueva; las recargas no se tocan", async () => {
      // Un periodo nuevo para orgB (cuenta limpia): cuota 1000, se gastan 250, quedan 750 sin usar.
      await grant(orgB, 1000);
      await c.applyTopup({ organizationId: orgB, units: 400, idempotencyKey: "topup:b_1" });
      await spend(orgB, 250, "ai:b:1");
      expect(await bal(orgB)).toMatchObject({ plan: 750, topup: 400 });

      const r = await grant(orgB, 800, P2, P2_END);
      expect(r).toMatchObject({ status: "applied", balance: { plan: 800, topup: 400, total: 1200 } });

      const rows = await ledger(orgB);
      const expire = rows.find((l) => l.kind === "expire");
      expect(expire).toMatchObject({ bucket: "plan", amount: -750 });
      expect(expire!.idempotencyKey).toBe(`expire:${P1.toISOString()}`);
      expect(rows.filter((l) => l.kind === "grant").map((l) => l.amount).sort((a, b) => a - b)).toEqual([800, 1000]);
      const b = await bal(orgB);
      expect(b.planPeriodStart?.toISOString()).toBe(P2.toISOString());
    });

    it("repetir la renovación no vence ni concede dos veces", async () => {
      const antes = (await ledger(orgB)).length;
      expect((await grant(orgB, 800, P2, P2_END)).status).toBe("duplicate");
      expect(await ledger(orgB)).toHaveLength(antes);
      expect(await bal(orgB)).toMatchObject({ plan: 800, topup: 400 });
    });

    it("`expirePeriodQuota` vence lo que quede del periodo cargado, una sola vez", async () => {
      const r = await c.expirePeriodQuota({ organizationId: orgB, periodStart: P2 });
      expect(r).toMatchObject({ status: "applied", balance: { plan: 0, topup: 400, total: 400 } });
      expect((await c.expirePeriodQuota({ organizationId: orgB, periodStart: P2 })).status).toBe("nothing");
    });

    it("`expirePeriodQuota` de un periodo que NO es el cargado no toca nada (no vence una cuota más nueva)", async () => {
      await grant(orgB, 600, new Date("2027-01-01T00:00:00.000Z"), new Date("2027-02-01T00:00:00.000Z"));
      const r = await c.expirePeriodQuota({ organizationId: orgB, periodStart: P1 });
      expect(r.status).toBe("stale");
      expect((await bal(orgB)).plan).toBe(600);
    });
  });

  /* ───────────────────── Plan sin tope ───────────────────── */

  describe("plan sin tope", () => {
    const orgU = `org_cu${tag}`;
    beforeAll(async () => {
      orgs.push(orgU);
      await db.insert(schema.organization).values({ id: orgU, name: "Org U", slug: `cu-${tag}` });
    });

    it("se mide pero no se descuenta ni se corta jamás", async () => {
      expect((await grant(orgU, lib.UNLIMITED)).status).toBe("unlimited");
      expect(await spend(orgU, 5000, "ai:u:1")).toMatchObject({ status: "unlimited" });
      expect(await ledger(orgU)).toHaveLength(0);
      expect(await c.checkCredit(orgU)).toEqual({ allow: true, wouldCut: false, reason: "unlimited" });
      await c.configureCut({ organizationId: orgU, cutEnabled: true });
      expect((await c.checkCredit(orgU)).allow).toBe(true);
    });

    it("al pasar a un plan con cuota, vuelve a descontar", async () => {
      expect((await grant(orgU, 700, P2, P2_END)).status).toBe("applied");
      expect(await spend(orgU, 100, "ai:u:2")).toMatchObject({ status: "applied", balance: { plan: 600, topup: 0 } });
    });
  });

  /* ───────────────────── Corte, sobregiro y modo sombra ───────────────────── */

  describe("corte en saldo cero, sobregiro y modo sombra", () => {
    const orgS = `org_cs${tag}`;
    beforeAll(async () => {
      orgs.push(orgS);
      await db.insert(schema.organization).values({ id: orgS, name: "Org S", slug: `cs-${tag}` });
    });

    it("MODO SOMBRA (por defecto): la contabilidad es completa, no se corta, y se sabe qué habría pasado", async () => {
      await grant(orgS, 200);
      expect(await c.checkCredit(orgS)).toEqual({ allow: true, wouldCut: false, reason: "ok" });
      await spend(orgS, 200, "ai:s:1");
      expect(await bal(orgS)).toMatchObject({ plan: 0, topup: 0, total: 0, cutEnabled: false });
      // Agotada, pero no se corta: deja pasar y avisa del «habría cortado».
      expect(await c.checkCredit(orgS)).toEqual({ allow: true, wouldCut: true, reason: "exhausted" });
      // Y el gasto siguiente sigue contando (queda negativo): los datos del modo sombra no se pierden.
      await spend(orgS, 50, "ai:s:2");
      expect((await bal(orgS)).total).toBe(-50);
    });

    it("con el corte ACTIVADO y la bolsa agotada, se bloquea", async () => {
      await c.configureCut({ organizationId: orgS, cutEnabled: true });
      expect(await c.checkCredit(orgS)).toEqual({ allow: false, wouldCut: true, reason: "exhausted" });
    });

    it("el sobregiro tolera un poco de negativo antes de cortar", async () => {
      await c.configureCut({ organizationId: orgS, overdraftLimit: 100 });
      // total = -50, tolera 100 → todavía pasa.
      expect((await c.checkCredit(orgS)).allow).toBe(true);
      await spend(orgS, 60, "ai:s:3"); // total = -110 → pasó del sobregiro
      expect((await bal(orgS)).total).toBe(-110);
      expect(await c.checkCredit(orgS)).toEqual({ allow: false, wouldCut: true, reason: "exhausted" });
    });

    it("recargar levanta el corte sin más: el agente retoma solo", async () => {
      await c.applyTopup({ organizationId: orgS, units: 500, idempotencyKey: "topup:s_1" });
      expect(await bal(orgS)).toMatchObject({ total: 390 });
      expect(await c.checkCredit(orgS)).toEqual({ allow: true, wouldCut: false, reason: "ok" });
    });

    it("con un monto conocido (una plantilla), exige que alcance", async () => {
      expect((await c.checkCredit(orgS, { amount: 390 })).allow).toBe(true);
      // total 390 + sobregiro 100 = 490 disponible.
      expect((await c.checkCredit(orgS, { amount: 491 })).allow).toBe(false);
    });
  });

  /* ───────────────────── Recargas, reembolsos y ajustes ───────────────────── */

  describe("compra de un paquete, reembolso y ajustes manuales", () => {
    const orgT = `org_ct${tag}`;
    let packId = "";
    let topupId = "";
    beforeAll(async () => {
      orgs.push(orgT);
      await db.insert(schema.organization).values({ id: orgT, name: "Org T", slug: `ct-${tag}` });
      packId = `crk_t${tag}`;
      await db.insert(schema.creditPack).values({ id: packId, name: `Prueba ${tag} 500`, units: 50_000, priceCents: 4_900 });
      await db.insert(schema.user).values({ id: `usr_ct${tag}`, name: "Soporte", email: `ct-${tag}@example.test` });
    });
    afterAll(async () => {
      await db.delete(schema.user).where(eq(schema.user.id, `usr_ct${tag}`));
    });

    it("el intento copia las unidades y el precio del paquete, y queda pendiente", async () => {
      const r = await c.createTopupIntent({ organizationId: orgT, packId, userId: `usr_ct${tag}` });
      expect(r.status).toBe("created");
      if (r.status !== "created") return;
      expect(r.topup).toMatchObject({ units: 50_000, amountCents: 4_900, currency: "PEN", status: "pending", organizationId: orgT });
      expect(r.topup.expiresAt.getTime()).toBeGreaterThan(Date.now());
      topupId = r.topup.id;
    });

    it("un paquete que no existe o está retirado: no hay intento", async () => {
      expect(await c.createTopupIntent({ organizationId: orgT, packId: "crk_no_existe" })).toEqual({ status: "pack_not_found" });
      await db.update(schema.creditPack).set({ active: false }).where(eq(schema.creditPack.id, packId));
      expect(await c.createTopupIntent({ organizationId: orgT, packId })).toEqual({ status: "pack_not_found" });
      await db.update(schema.creditPack).set({ active: true }).where(eq(schema.creditPack.id, packId));
    });

    it("pagar la compra abona las unidades y la marca pagada, en una sola transacción", async () => {
      const id = topupId;
      const r = await c.applyTopup({ organizationId: orgT, topupId: id, mpPaymentId: `mp_${tag}` });
      expect(r).toMatchObject({ status: "applied", balance: { plan: 0, topup: 50_000, total: 50_000 } });
      const row = await c.getTopup(orgT, id);
      expect(row).toMatchObject({ status: "paid", mpPaymentId: `mp_${tag}` });
      expect(row!.completedAt).not.toBeNull();
      const l = (await ledger(orgT)).find((x) => x.kind === "topup")!;
      expect(l).toMatchObject({ bucket: "topup", amount: 50_000, refType: "topup", refId: id, idempotencyKey: `topup:${id}` });
    });

    it("el webhook duplicado no abona dos veces", async () => {
      const id = topupId;
      expect((await c.applyTopup({ organizationId: orgT, topupId: id, mpPaymentId: `mp_${tag}` })).status).toBe("duplicate");
      expect((await bal(orgT)).topup).toBe(50_000);
      expect((await ledger(orgT)).filter((x) => x.kind === "topup")).toHaveLength(1);
    });

    it("la compra de OTRA organización no se puede abonar aquí (aislamiento)", async () => {
      const id = topupId;
      const r = await c.applyTopup({ organizationId: orgA, topupId: id });
      expect(r).toMatchObject({ status: "rejected", reason: "topup_not_found" });
      expect(await c.getTopup(orgA, id)).toBeNull();
      expect(await c.refundTopup({ organizationId: orgA, topupId: id })).toMatchObject({ status: "rejected" });
    });

    it("un reembolso descuenta las unidades y marca la compra; repetirlo no descuenta de nuevo", async () => {
      const id = topupId;
      const r = await c.refundTopup({ organizationId: orgT, topupId: id, note: "Reembolso de prueba" });
      expect(r).toMatchObject({ status: "applied", balance: { topup: 0 } });
      expect((await c.getTopup(orgT, id))!.status).toBe("refunded");
      expect((await c.refundTopup({ organizationId: orgT, topupId: id })).status).toBe("duplicate");
      expect((await bal(orgT)).topup).toBe(0);
    });

    it("ajuste manual: queda con quién lo hizo y por qué, y es idempotente", async () => {
      const input = { organizationId: orgT, bucket: "topup" as const, amount: 1234, idempotencyKey: `adj:${tag}:1`, actorUserId: `usr_ct${tag}`, note: "Cortesía por la caída del servicio" };
      expect(await c.adjustCredits(input)).toMatchObject({ status: "applied", balance: { topup: 1234 } });
      expect((await c.adjustCredits(input)).status).toBe("duplicate");
      const l = (await ledger(orgT)).find((x) => x.kind === "adjustment")!;
      expect(l).toMatchObject({ amount: 1234, actorUserId: `usr_ct${tag}`, note: "Cortesía por la caída del servicio" });
    });

    it("un ajuste necesita su motivo, y la cuota del plan no puede quedar negativa", async () => {
      await expect(
        c.adjustCredits({ organizationId: orgT, bucket: "topup", amount: 5, idempotencyKey: "k_sin_nota", actorUserId: `usr_ct${tag}`, note: "  " })
      ).rejects.toThrow(/motivo/);
      expect(
        await c.adjustCredits({ organizationId: orgT, bucket: "plan", amount: -1, idempotencyKey: "k_plan_neg", actorUserId: `usr_ct${tag}`, note: "x" })
      ).toMatchObject({ status: "rejected", reason: "plan_would_be_negative" });
    });
  });

  /* ───────────────────── Aislamiento entre organizaciones ───────────────────── */

  describe("aislamiento multi-tenant", () => {
    const orgX = `org_cx${tag}`;
    const orgY = `org_cy${tag}`;
    beforeAll(async () => {
      orgs.push(orgX, orgY);
      for (const [id, slug] of [[orgX, `cx-${tag}`], [orgY, `cy-${tag}`]] as const) {
        await db.insert(schema.organization).values({ id, name: slug, slug });
      }
    });

    it("la misma clave de idempotencia en dos organizaciones cobra en las DOS (no chocan)", async () => {
      await grant(orgX, 1000);
      await grant(orgY, 1000);
      expect((await spend(orgX, 100, "ai:igual:1")).status).toBe("applied");
      expect((await spend(orgY, 100, "ai:igual:1")).status).toBe("applied");
      expect((await bal(orgX)).plan).toBe(900);
      expect((await bal(orgY)).plan).toBe(900);
    });

    it("lo que hace una no mueve a la otra", async () => {
      await spend(orgX, 400, "ai:x:solo");
      await c.applyTopup({ organizationId: orgX, units: 77, idempotencyKey: "topup:x" });
      expect(await bal(orgX)).toMatchObject({ plan: 500, topup: 77 });
      expect(await bal(orgY)).toMatchObject({ plan: 900, topup: 0 });
      expect((await ledger(orgY)).every((l) => l.organizationId === orgY)).toBe(true);
    });

    it("el corte y el sobregiro son de cada organización", async () => {
      await c.configureCut({ organizationId: orgX, cutEnabled: true, overdraftLimit: 25 });
      expect(await bal(orgX)).toMatchObject({ cutEnabled: true, overdraftLimit: 25 });
      expect(await bal(orgY)).toMatchObject({ cutEnabled: false, overdraftLimit: 0 });
    });

    it("la conciliación de una organización no mira a la otra", async () => {
      const r = await c.reconcileCredits({ organizationId: orgX });
      expect(r).toEqual({ checked: 1, drifts: [], repaired: 0 });
    });

    it("un aviso reclamado por una organización sigue disponible para la otra", async () => {
      const a = { periodStart: P1, threshold: "warn80" as const };
      expect(await c.claimAlert({ organizationId: orgX, ...a })).toBe(true);
      expect(await c.claimAlert({ organizationId: orgY, ...a })).toBe(true);
      expect(await c.claimAlert({ organizationId: orgX, ...a })).toBe(false);
    });
  });

  /* ───────────────────── Carreras ───────────────────── */

  describe("operaciones simultáneas", () => {
    const orgR = `org_cr${tag}`;
    beforeAll(async () => {
      orgs.push(orgR);
      await db.insert(schema.organization).values({ id: orgR, name: "Org R", slug: `cr-${tag}` });
      await grant(orgR, 1000);
    });

    it("20 gastos distintos a la vez: el saldo y el libro cuadran exactamente", async () => {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => spend(orgR, 10, `ai:r:${i}`)));
      expect(results.every((r) => r.status === "applied")).toBe(true);
      expect((await bal(orgR)).plan).toBe(800);
      expect((await ledger(orgR)).filter((l) => l.kind === "spend")).toHaveLength(20);
    });

    it("10 intentos del MISMO gasto a la vez: se cobra una sola vez", async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => spend(orgR, 50, "ai:r:mismo")));
      expect(results.filter((r) => r.status === "applied")).toHaveLength(1);
      expect(results.filter((r) => r.status === "duplicate")).toHaveLength(9);
      expect((await bal(orgR)).plan).toBe(750);
    });

    it("gastos y recargas mezclados a la vez no pierden ni inventan unidades", async () => {
      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => spend(orgR, 20, `ai:r:mix${i}`)),
        ...Array.from({ length: 5 }, (_, i) => c.applyTopup({ organizationId: orgR, units: 100, idempotencyKey: `topup:r:${i}` })),
      ]);
      const b = await bal(orgR);
      expect(b.topup + b.plan).toBe(750 - 200 + 500);
      expect((await c.reconcileCredits({ organizationId: orgR })).drifts).toEqual([]);
    });

    it("la misma recarga 8 veces a la vez: se abona una sola", async () => {
      const antes = (await bal(orgR)).topup;
      const rs = await Promise.all(Array.from({ length: 8 }, () => c.applyTopup({ organizationId: orgR, units: 300, idempotencyKey: "topup:r:igual" })));
      expect(rs.filter((r) => r.status === "applied")).toHaveLength(1);
      expect((await bal(orgR)).topup).toBe(antes + 300);
    });
  });

  /* ───────────────────── Medición ───────────────────── */

  describe("medición de uso (independiente del libro)", () => {
    const orgM = `org_cm${tag}`;
    beforeAll(async () => {
      orgs.push(orgM);
      await db.insert(schema.organization).values({ id: orgM, name: "Org M", slug: `cm-${tag}` });
    });

    it("registrar uso NO mueve el saldo, se cobre o no", async () => {
      await grant(orgM, 1000);
      const r = await c.recordUsage({ organizationId: orgM, service: "ai", source: "org", model: "gpt-x", tokensIn: 800, tokensOut: 200, conversationId: "cv_1" });
      expect(r.status).toBe("recorded");
      expect(await bal(orgM)).toMatchObject({ plan: 1000, topup: 0 });
      expect(await ledger(orgM)).toHaveLength(1); // solo la concesión
    });

    it("la misma clave no cuenta dos veces; sin clave, cada llamada es una fila", async () => {
      const base = { organizationId: orgM, service: "whatsapp" as const, category: "utility", idempotencyKey: "wa:msg_1" };
      expect((await c.recordUsage(base)).status).toBe("recorded");
      expect((await c.recordUsage(base)).status).toBe("duplicate");
      expect((await c.recordUsage({ organizationId: orgM, service: "whatsapp", category: "text" })).status).toBe("recorded");
      expect((await c.recordUsage({ organizationId: orgM, service: "whatsapp", category: "text" })).status).toBe("recorded");
      const rows = await db.select().from(schema.creditUsage).where(eq(schema.creditUsage.organizationId, orgM));
      expect(rows.filter((x) => x.idempotencyKey === "wa:msg_1")).toHaveLength(1);
    });

    it("el Laboratorio y la llave del cliente se miden sin cobrar; la de la plataforma, con lo cobrado", async () => {
      await c.recordUsage({ organizationId: orgM, service: "ai_lab", source: "org", tokensIn: 500, tokensOut: 100 });
      await c.recordUsage({ organizationId: orgM, service: "ai", source: "env", tokensIn: 1000, tokensOut: 300, chargedUnits: 120, wouldCut: true });
      const s = await c.usageSummary({ from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000), organizationId: orgM });
      const lab = s.find((x) => x.service === "ai_lab")!;
      const plat = s.find((x) => x.service === "ai" && x.source === "env")!;
      const cliente = s.find((x) => x.service === "ai" && x.source === "org")!;
      expect(lab).toMatchObject({ events: 1, tokensIn: 500, chargedUnits: 0 });
      expect(plat).toMatchObject({ events: 1, tokensIn: 1000, tokensOut: 300, chargedUnits: 120, wouldCutEvents: 1 });
      expect(cliente).toMatchObject({ events: 1, tokensIn: 800, tokensOut: 200, chargedUnits: 0 });
    });

    it("el resumen de una organización no incluye el de otra", async () => {
      const s = await c.usageSummary({ from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000), organizationId: orgB });
      expect(s).toEqual([]);
    });
  });

  /* ───────────────────── Tarifas ───────────────────── */

  describe("tarifas versionadas", () => {
    it("la vigente es la de effective_from más reciente que ya empezó; las futuras esperan", async () => {
      const t0 = new Date("2026-01-01T00:00:00.000Z");
      const t1 = new Date("2026-06-01T00:00:00.000Z");
      const futuro = new Date(Date.now() + 86_400_000 * 30);
      expect((await c.setRate({ key: RATE_KEY, service: "ai", unitKind: "per_turn", amount: 100, effectiveFrom: t0 })).status).toBe("applied");
      expect((await c.setRate({ key: RATE_KEY, service: "ai", unitKind: "per_turn", amount: 150, effectiveFrom: t1 })).status).toBe("applied");
      expect((await c.setRate({ key: RATE_KEY, service: "ai", unitKind: "per_turn", amount: 999, effectiveFrom: futuro })).status).toBe("applied");

      expect((await c.getRate(RATE_KEY, new Date("2025-12-31T00:00:00.000Z")))).toBeNull();
      expect((await c.getRate(RATE_KEY, new Date("2026-03-01T00:00:00.000Z")))!.amount).toBe(100);
      expect((await c.getRate(RATE_KEY, new Date("2026-07-01T00:00:00.000Z")))!.amount).toBe(150);
      expect((await c.getRate(RATE_KEY))!.amount).toBe(150); // la de 999 todavía no empezó
    });

    it("el historial se conserva y la misma versión no se duplica", async () => {
      const t0 = new Date("2026-01-01T00:00:00.000Z");
      expect((await c.setRate({ key: RATE_KEY, service: "ai", unitKind: "per_turn", amount: 777, effectiveFrom: t0 })).status).toBe("duplicate");
      const filas = await db.select().from(schema.creditRate).where(eq(schema.creditRate.key, RATE_KEY));
      expect(filas).toHaveLength(3);
    });

    it("una tarifa de 0 (mensajes libres) es válida; una negativa, no", async () => {
      const k = `${RATE_KEY}.libre`;
      expect((await c.setRate({ key: k, service: "whatsapp", unitKind: "per_message", amount: 0 })).status).toBe("applied");
      expect((await c.getRate(k))!.amount).toBe(0);
      await expect(c.setRate({ key: `${k}.neg`, service: "whatsapp", unitKind: "per_message", amount: -1 })).rejects.toThrow();
    });
  });

  /* ───────────────────── Avisos ───────────────────── */

  describe("deduplicación de avisos", () => {
    it("un aviso se reclama una sola vez por organización, periodo y umbral", async () => {
      const k = { organizationId: orgA, periodStart: P1 };
      expect(await c.claimAlert({ ...k, threshold: "zero" })).toBe(true);
      expect(await c.claimAlert({ ...k, threshold: "zero" })).toBe(false);
      expect(await c.claimAlert({ ...k, threshold: "exhausted" })).toBe(true);
      expect(await c.claimAlert({ organizationId: orgA, periodStart: P2, threshold: "zero" })).toBe(true);
    });

    it("8 reclamos simultáneos: solo uno manda el aviso", async () => {
      const rs = await Promise.all(Array.from({ length: 8 }, () => c.claimAlert({ organizationId: orgA, periodStart: P1, threshold: "warn80" })));
      expect(rs.filter(Boolean)).toHaveLength(1);
    });
  });

  /* ───────────────────── Conciliación ───────────────────── */

  describe("conciliación: el saldo es una caché del libro", () => {
    it("después de todo lo anterior, ninguna cuenta se desvía del libro", async () => {
      const r = await c.reconcileCredits();
      const nuestras = r.drifts.filter((d) => orgs.includes(d.organizationId));
      expect(nuestras).toEqual([]);
      expect(r.checked).toBeGreaterThanOrEqual(orgs.length - 1);
    });

    it("detecta una caché corrompida y, con `repair`, la reescribe desde el libro", async () => {
      const before = await bal(orgA);
      await db.update(schema.creditAccount).set({ topupBalance: before.topup + 999, planBalance: before.plan + 5 }).where(eq(schema.creditAccount.organizationId, orgA));

      const found = await c.reconcileCredits({ organizationId: orgA });
      expect(found.drifts).toEqual([{ organizationId: orgA, planCached: before.plan + 5, planLedger: before.plan, topupCached: before.topup + 999, topupLedger: before.topup }]);
      expect(found.repaired).toBe(0);

      const fixed = await c.reconcileCredits({ organizationId: orgA, repair: true });
      expect(fixed.repaired).toBe(1);
      expect(await bal(orgA)).toMatchObject({ plan: before.plan, topup: before.topup });
      expect((await c.reconcileCredits({ organizationId: orgA })).drifts).toEqual([]);
    });
  });

  /* ───────────────────── Reglas de la base ───────────────────── */

  describe("la base misma impide libros incoherentes", () => {
    const insertar = (over: Record<string, unknown>) =>
      db.insert(schema.creditLedger).values({
        id: `crl_x${tag}${Math.random().toString(36).slice(2, 8)}`,
        organizationId: orgA,
        kind: "spend",
        bucket: "plan",
        amount: -1,
        idempotencyKey: `raw:${Math.random()}`,
        ...over,
      } as never);

    it("un gasto con signo positivo no entra", async () => {
      await expect(insertar({ kind: "spend", amount: 5 })).rejects.toThrow();
    });
    it("una concesión o recarga con signo negativo no entra", async () => {
      await expect(insertar({ kind: "grant", amount: -5 })).rejects.toThrow();
      await expect(insertar({ kind: "topup", bucket: "topup", amount: -5 })).rejects.toThrow();
    });
    it("un movimiento de 0 no entra", async () => {
      await expect(insertar({ kind: "adjustment", amount: 0 })).rejects.toThrow();
    });
    it("la clave de idempotencia repetida en la misma organización no entra", async () => {
      const key = `raw:dup:${tag}`;
      await insertar({ kind: "adjustment", amount: 1, idempotencyKey: key });
      await expect(insertar({ kind: "adjustment", amount: 1, idempotencyKey: key })).rejects.toThrow();
      await db.delete(schema.creditLedger).where(eq(schema.creditLedger.idempotencyKey, key));
    });
    it("la cuota del plan no puede quedar en negativo en la caché", async () => {
      await expect(db.update(schema.creditAccount).set({ planBalance: -1 }).where(eq(schema.creditAccount.organizationId, orgA))).rejects.toThrow();
    });
  });
});
