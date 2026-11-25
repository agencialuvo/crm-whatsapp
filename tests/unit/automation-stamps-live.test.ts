import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `loyalty_stamp_earned` contra PostgreSQL REAL (`pnpm test:db`), por el camino de verdad: una venta cobrada en Caja suma el
 * sello (`registerServiceSale`), la transacción hace commit y recién entonces avisa a las automatizaciones. También el
 * movimiento de sellos suelto (ajuste, canje, repetición) y el motor con el contexto del sello. Crea su propia organización
 * (con su programa de fidelidad: 20% en el sello 2, 50% en el 4) y la borra al terminar. Los envíos son falsos.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("loyalty_stamp_earned contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: typeof import("drizzle-orm").eq;
  let flows: typeof import("@/server/automation/flows");
  let engine: typeof import("@/server/automation/engine");
  let worker: typeof import("@/server/automation/worker");
  let schemas: typeof import("@/lib/automation-schemas");
  let sales: typeof import("@/server/business/sales-service");
  let loyalty: typeof import("@/server/loyalty/actions");
  let saleInputSchema: (typeof import("@/lib/salon/schemas"))["saleInputSchema"];

  const uid = Date.now().toString(36);
  const org = `org_st${uid}`;
  const servicio = `srv_st${uid}`;
  let seq = 0;

  async function mkContact() {
    const n = seq++;
    const contactId = `ct_st${uid}${n}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Cliente Sello", waIdentity: `st-${uid}${n}` });
    await db.insert(schema.conversation).values({ id: `cv_st${uid}${n}`, organizationId: org, contactId, lastInboundAt: new Date() });
    return contactId;
  }
  async function mkFlow(triggerType: string, specs: { stepType: string; config: Record<string, unknown> }[], triggerConfig: Record<string, unknown> | null = null) {
    const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `ST ${uid}${seq++}`, triggerType, triggerConfig }));
    for (const [i, s] of specs.entries()) await flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ ...s, positionY: i * 100 }));
    await flows.updateFlow(org, flow.id, { active: true });
    return flow.id;
  }
  const runsOf = (flowId: string) => db.select().from(schema.automationRun).where(eq(schema.automationRun.flowId, flowId));
  const queueOf = (flowId: string) => db.select().from(schema.automationQueue).where(eq(schema.automationQueue.flowId, flowId)).orderBy(schema.automationQueue.createdAt);

  const sent: string[] = [];
  const deps = () =>
    ({
      ...worker.defaultDeps(),
      sendText: vi.fn(async (i: { text: string }) => (sent.push(i.text), { messageId: "msg_fake" })),
      sendTemplate: vi.fn(async () => ({ messageId: "msg_fake" })),
      waMessageIdOf: async () => null,
    }) as import("@/server/automation/engine").Deps;
  async function drain(flowId: string) {
    const d = deps();
    for (let guard = 0; guard < 20; guard++) {
      const pending = (await queueOf(flowId)).find((r) => r.status === "pending" && r.scheduledFor.getTime() <= Date.now() + 1000);
      if (!pending) break;
      await engine.processRow(pending as never, d);
    }
  }
  const msg = (content: string) => ({ stepType: "send_whatsapp", config: { content } });
  const cobra = (contactId: string) => sales.registerServiceSale(org, saleInputSchema.parse({ paymentMethod: "efectivo", amountCents: 5000, serviceId: servicio, contactId }));
  const tarjeta = async (contactId: string) => (await db.select().from(schema.customerLoyaltyCard).where(eq(schema.customerLoyaltyCard.contactId, contactId)))[0]!;

  // Los flujos del negocio de la prueba.
  let cada: string; // cada sello
  let exacto: string; // exactamente el sello 2
  let minimo: string; // desde el sello 3
  let premio2: string; // premio del sello 2
  let premio4: string; // premio del sello 4

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    process.env.SALON = "on";
    delete process.env.AUTOMATION_CODE_JS;
    ({ eq } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    flows = await import("@/server/automation/flows");
    engine = await import("@/server/automation/engine");
    worker = await import("@/server/automation/worker");
    schemas = await import("@/lib/automation-schemas");
    sales = await import("@/server/business/sales-service");
    loyalty = await import("@/server/loyalty/actions");
    ({ saleInputSchema } = await import("@/lib/salon/schemas"));

    await db.insert(schema.organization).values({ id: org, name: `Sellos live ${uid}` });
    await db.insert(schema.service).values({ id: servicio, organizationId: org, name: "Corte", priceCents: 5000 });
    await db.insert(schema.loyaltySettings).values({
      id: `lgs_st${uid}`,
      organizationId: org,
      milestones: [
        { stamps: 2, title: "20% de descuento", rewardType: "percentage_discount", discountPercentage: 20 },
        { stamps: 4, title: "50% de descuento", rewardType: "percentage_discount", discountPercentage: 50 },
      ] as never,
    });
    cada = await mkFlow("loyalty_stamp_earned", [msg("Sello {{sellos}}. Faltan {{faltan}} para {{proximo_premio}}")]);
    exacto = await mkFlow("loyalty_stamp_earned", [msg("Justo el segundo")], { stamps: 2 });
    minimo = await mkFlow("loyalty_stamp_earned", [msg("Ya vas de {{sellos}} para arriba")], { minStamps: 3 });
    premio2 = await mkFlow("loyalty_reward_unlocked", [msg("Premio: {{premio}} ({{descuento}}%)")], { stamps: 2 });
    premio4 = await mkFlow("loyalty_reward_unlocked", [msg("Premio: {{premio}} ({{descuento}}%)")], { stamps: 4 });
  });

  afterAll(async () => {
    if (!db) return;
    // El borrado en cascada de la organización se lleva flujos, ventas, tarjetas, contactos y conversaciones.
    await db.delete(schema.organization).where(eq(schema.organization.id, org));
  });

  it("un cobro en Caja suma el sello y arranca el flujo de cada sello, con el contexto y SIN premio si no cruza ninguno", async () => {
    const c = await mkContact();
    await cobra(c);
    expect((await tarjeta(c)).currentStamps).toBe(1);
    const mine = (await runsOf(cada)).filter((r) => r.contactId === c);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.context).toMatchObject({
      loyalty: { currentStamps: 1, stampsAdded: 1, stampsToNext: 1, nextMilestone: { stamps: 2, title: "20% de descuento", discountPercentage: 20 } },
    });
    expect(mine[0]!.context).not.toHaveProperty("loyalty.milestoneStamps");
    // El sello 1 no cruza premio, ni es el 2 exacto, ni el 3+: solo «cada sello».
    for (const f of [exacto, minimo, premio2, premio4]) expect((await runsOf(f)).filter((r) => r.contactId === c)).toHaveLength(0);
    sent.length = 0;
    await drain(cada);
    expect(sent).toContain("Sello 1. Faltan 1 para 20% de descuento");
  });

  it("el sello que cruza un premio dispara AMBOS: el de cada sello y el del premio, cada uno con su contexto", async () => {
    const c = await mkContact();
    await cobra(c);
    await cobra(c); // 2.º sello: cruza el hito del sello 2
    expect((await tarjeta(c)).currentStamps).toBe(2);
    expect((await runsOf(cada)).filter((r) => r.contactId === c)).toHaveLength(2);
    expect((await runsOf(exacto)).filter((r) => r.contactId === c)).toHaveLength(1);
    const premio = (await runsOf(premio2)).filter((r) => r.contactId === c);
    expect(premio).toHaveLength(1);
    expect(premio[0]!.context).toMatchObject({ loyalty: { milestoneStamps: 2, title: "20% de descuento", discountPercentage: 20, currentStamps: 2 } });
    expect((await runsOf(premio4)).filter((r) => r.contactId === c)).toHaveLength(0);
    sent.length = 0;
    await drain(premio2);
    expect(sent).toContain("Premio: 20% de descuento (20%)");
  });

  it("los filtros: «exactamente el 2» solo en el 2.º sello y «desde el 3» solo del 3.º en adelante", async () => {
    const c = await mkContact();
    for (let i = 0; i < 4; i++) await cobra(c);
    expect((await tarjeta(c)).currentStamps).toBe(4);
    expect((await runsOf(cada)).filter((r) => r.contactId === c)).toHaveLength(4);
    expect((await runsOf(exacto)).filter((r) => r.contactId === c)).toHaveLength(1);
    expect((await runsOf(minimo)).filter((r) => r.contactId === c)).toHaveLength(2); // sellos 3 y 4
    expect((await runsOf(premio4)).filter((r) => r.contactId === c)).toHaveLength(1);
  });

  it("un ajuste manual o un canje NO cuentan como «sello ganado»; avisar dos veces el mismo cobro no duplica", async () => {
    const c = await mkContact();
    const r1 = await loyalty.registerLoyaltyTransaction({ organizationId: org, contactId: c, type: "earned" });
    await loyalty.announceLoyaltyUnlock(r1);
    await loyalty.announceLoyaltyUnlock(r1); // reintento del mismo movimiento
    expect((await runsOf(cada)).filter((r) => r.contactId === c)).toHaveLength(1);

    const adj = await loyalty.registerLoyaltyTransaction({ organizationId: org, contactId: c, type: "adjusted", stampsChange: 1, notes: "corrección manual del dueño" });
    await loyalty.announceLoyaltyUnlock(adj);
    expect((await runsOf(cada)).filter((r) => r.contactId === c)).toHaveLength(1); // sigue siendo 1
    // Pero el ajuste que cruza un premio sí lo avisa (comportamiento de siempre).
    expect((await runsOf(premio2)).filter((r) => r.contactId === c)).toHaveLength(1);

    const redeemed = await loyalty.registerLoyaltyTransaction({ organizationId: org, contactId: c, type: "redeemed", milestoneStamps: 2 });
    await loyalty.announceLoyaltyUnlock(redeemed);
    expect((await runsOf(cada)).filter((r) => r.contactId === c)).toHaveLength(1);

    const cumple = await loyalty.registerLoyaltyTransaction({ organizationId: org, contactId: c, type: "birthday_excluded" });
    await loyalty.announceLoyaltyUnlock(cumple);
    expect((await runsOf(cada)).filter((r) => r.contactId === c)).toHaveLength(1);
  });

  it("aislamiento: el sello de OTRA organización no arranca los flujos de esta", async () => {
    const otraOrg = `org_st2${uid}`;
    await db.insert(schema.organization).values({ id: otraOrg, name: `Otra ${uid}` });
    try {
      const contactId = `ct_st2${uid}`;
      await db.insert(schema.contact).values({ id: contactId, organizationId: otraOrg, name: "Otra", waIdentity: `st2-${uid}` });
      await db.insert(schema.conversation).values({ id: `cv_st2${uid}`, organizationId: otraOrg, contactId, lastInboundAt: new Date() });
      const antes = (await runsOf(cada)).length;
      const r = await loyalty.registerLoyaltyTransaction({ organizationId: otraOrg, contactId, type: "earned" });
      await loyalty.announceLoyaltyUnlock(r);
      expect((await runsOf(cada)).length).toBe(antes);
    } finally {
      await db.delete(schema.organization).where(eq(schema.organization.id, otraOrg));
    }
  });
});
