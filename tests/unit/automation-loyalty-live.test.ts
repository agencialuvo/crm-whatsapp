import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Fidelización multi-hito contra PostgreSQL REAL (`pnpm test:db`): `contactFacts.stampsToNextMilestone` con los hitos reales del
 * programa, un flujo de premio que escribe `{{premio}}`/`{{descuento}}`/`{{sellos}}`, las condiciones de sellos de punta a
 * punta, y el endpoint que alimenta el selector de hitos del disparador. Los envíos son falsos. Restaura la configuración
 * de fidelización que encontró.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const sesion = vi.hoisted(() => ({ actual: null as null | { userId: string; organizationId: string; role: string } }));
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...original,
    requireSession: async () => {
      if (!sesion.actual) throw new original.UnauthorizedError();
      return sesion.actual;
    },
  };
});

type Milestone = { stamps: number; title: string; rewardType: string; discountPercentage?: number };

describe.skipIf(!live)("fidelización multi-hito contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: typeof import("drizzle-orm").eq;
  let inArray: typeof import("drizzle-orm").inArray;
  let flows: typeof import("@/server/automation/flows");
  let engine: typeof import("@/server/automation/engine");
  let worker: typeof import("@/server/automation/worker");
  let manual: typeof import("@/server/automation/manual");
  let triggers: typeof import("@/server/automation/triggers");
  let actions: typeof import("@/server/automation/actions");
  let schemas: typeof import("@/lib/automation-schemas");
  let ruta: typeof import("@/app/api/automations/loyalty-milestones/route");

  const uid = Date.now().toString(36);
  let org = "";
  let otherOrg = "";
  let seq = 0;
  const created = { flows: [] as string[], contacts: [] as string[], convs: [] as string[], cards: [] as string[], settings: [] as string[] };
  /** La configuración de fidelización que había antes (para restaurarla). */
  const originales = new Map<string, Milestone[] | null>();

  const PROGRAMA: Milestone[] = [
    { stamps: 8, title: "50% de descuento", rewardType: "percentage_discount", discountPercentage: 50 },
    { stamps: 4, title: "20% de descuento", rewardType: "percentage_discount", discountPercentage: 20 },
  ];

  async function setMilestones(orgId: string, milestones: Milestone[]) {
    const s = schema.loyaltySettings;
    const [row] = await db.select().from(s).where(eq(s.organizationId, orgId)).limit(1);
    if (!originales.has(orgId)) originales.set(orgId, row ? (row.milestones as Milestone[]) : null);
    if (row) await db.update(s).set({ milestones: milestones as never }).where(eq(s.organizationId, orgId));
    else {
      const id = `lgs_${uid}${seq++}`;
      await db.insert(s).values({ id, organizationId: orgId, milestones: milestones as never });
      created.settings.push(id);
    }
  }

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    delete process.env.AUTOMATION_CODE_JS;
    ({ eq, inArray } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    flows = await import("@/server/automation/flows");
    engine = await import("@/server/automation/engine");
    worker = await import("@/server/automation/worker");
    manual = await import("@/server/automation/manual");
    triggers = await import("@/server/automation/triggers");
    actions = await import("@/server/automation/actions");
    schemas = await import("@/lib/automation-schemas");
    ruta = await import("@/app/api/automations/loyalty-milestones/route");
    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    org = orgs[0]!.id;
    otherOrg = orgs[1]!.id;
    await setMilestones(org, PROGRAMA);
  });

  afterAll(async () => {
    if (!db) return;
    if (created.flows.length) await db.delete(schema.automationFlow).where(inArray(schema.automationFlow.id, created.flows));
    if (created.cards.length) await db.delete(schema.customerLoyaltyCard).where(inArray(schema.customerLoyaltyCard.id, created.cards));
    if (created.convs.length) await db.delete(schema.conversation).where(inArray(schema.conversation.id, created.convs));
    if (created.contacts.length) await db.delete(schema.contact).where(inArray(schema.contact.id, created.contacts));
    for (const [orgId, antes] of originales) {
      if (antes) await db.update(schema.loyaltySettings).set({ milestones: antes as never }).where(eq(schema.loyaltySettings.organizationId, orgId));
    }
    if (created.settings.length) await db.delete(schema.loyaltySettings).where(inArray(schema.loyaltySettings.id, created.settings));
  });

  async function mkContact(stamps: number | null) {
    const n = seq++;
    const contactId = `ct_l${uid}${n}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Cliente Sellos", waIdentity: `l-${uid}${n}` });
    await db.insert(schema.conversation).values({ id: `cv_l${uid}${n}`, organizationId: org, contactId, lastInboundAt: new Date() });
    created.contacts.push(contactId);
    created.convs.push(`cv_l${uid}${n}`);
    if (stamps !== null) {
      const id = `clc_l${uid}${n}`;
      await db.insert(schema.customerLoyaltyCard).values({ id, organizationId: org, contactId, currentStamps: stamps });
      created.cards.push(id);
    }
    return contactId;
  }
  async function mkSimple(triggerType: string, specs: { stepType: string; config: Record<string, unknown> }[], triggerConfig: Record<string, unknown> | null = null) {
    const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `LY ${uid}${seq++}`, triggerType, triggerConfig }));
    created.flows.push(flow.id);
    for (const [i, s] of specs.entries()) await flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ ...s, positionY: i * 100 }));
    await flows.updateFlow(org, flow.id, { active: true });
    return flow.id;
  }
  const queueOf = (flowId: string) => db.select().from(schema.automationQueue).where(eq(schema.automationQueue.flowId, flowId)).orderBy(schema.automationQueue.createdAt);
  const runsOf = (flowId: string) => db.select().from(schema.automationRun).where(eq(schema.automationRun.flowId, flowId));

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

  /* ─── contactFacts ─── */

  describe("contactFacts.stampsToNextMilestone", () => {
    it.each([
      [null, 0, 4], // sin tarjeta: 0 sellos
      [0, 0, 4],
      [3, 3, 1],
      [5, 5, 3],
      [8, 8, null], // alcanzó el último premio
    ])("tarjeta %s → %i sellos, faltan %s para el siguiente premio", async (tarjeta, sellos, faltan) => {
      const contactId = await mkContact(tarjeta);
      const facts = await actions.contactFacts(org, contactId);
      expect(facts.stamps).toBe(sellos);
      expect(facts.stampsToNextMilestone).toBe(faltan);
    });

    it("sigue los hitos del negocio: al cambiar el programa cambia lo que falta", async () => {
      const contactId = await mkContact(5);
      expect((await actions.contactFacts(org, contactId)).stampsToNextMilestone).toBe(3); // 8
      await setMilestones(org, [{ stamps: 6, title: "Premio", rewardType: "service_free" }]);
      expect((await actions.contactFacts(org, contactId)).stampsToNextMilestone).toBe(1); // 6
      await setMilestones(org, [{ stamps: 5, title: "Premio", rewardType: "service_free" }]);
      expect((await actions.contactFacts(org, contactId)).stampsToNextMilestone).toBeNull(); // ya lo alcanzó
      await setMilestones(org, PROGRAMA);
    });
  });

  /* ─── Flujo de premio de punta a punta ─── */

  describe("flujo «Premio de fidelidad» con {{premio}}, {{descuento}} y {{sellos}}", () => {
    const unlock = (contactId: string, txId: string, m: Milestone, current: number) => ({
      organizationId: org,
      contactId,
      transactionId: txId,
      currentStamps: current,
      unlocked: [m] as never,
    });

    it("cada hito dispara SU flujo y el mensaje lleva el premio y el descuento de ese hito (20% en el 4, 50% en el 8)", async () => {
      const contactId = await mkContact(4);
      const f4 = await mkSimple("loyalty_reward_unlocked", [msg("Sello 4: {{premio}} ({{descuento}}%) llevas {{sellos}}")], { stamps: 4 });
      const f8 = await mkSimple("loyalty_reward_unlocked", [msg("Sello 8: {{premio}} ({{descuento}}%) llevas {{sellos}}")], { stamps: 8 });

      expect(await triggers.onLoyaltyRewardUnlocked(unlock(contactId, `ltr_${uid}a`, PROGRAMA[1]!, 4))).toBe(1);
      await drain(f4);
      await drain(f8);
      expect(sent).toContain("Sello 4: 20% de descuento (20%) llevas 4");
      expect(sent.some((t) => t.startsWith("Sello 8"))).toBe(false);

      expect(await triggers.onLoyaltyRewardUnlocked(unlock(contactId, `ltr_${uid}b`, PROGRAMA[0]!, 8))).toBe(1);
      await drain(f8);
      expect(sent).toContain("Sello 8: 50% de descuento (50%) llevas 8");
      expect((await runsOf(f4)).every((r) => r.status === "completed")).toBe(true);
    });

    it("un premio que no es descuento deja {{descuento}} vacío", async () => {
      const contactId = await mkContact(10);
      const f = await mkSimple("loyalty_reward_unlocked", [msg("{{premio}}[{{descuento}}]")]);
      await triggers.onLoyaltyRewardUnlocked(unlock(contactId, `ltr_${uid}c`, { stamps: 10, title: "Corte gratis", rewardType: "service_free" }, 10));
      await drain(f);
      expect(sent).toContain("Corte gratis[]");
    });

    it("un flujo de otro disparador deja las variables vacías (no rompe ni muestra la llave)", async () => {
      const contactId = await mkContact(null);
      const f = await mkSimple("manual", [msg("Hola [{{premio}}]")]);
      await manual.triggerManualFlow({ organizationId: org, flowId: f, contactId, batchId: `b_${uid}vars`, triggeredBy: "u" });
      await drain(f);
      expect(sent).toContain("Hola []");
    });
  });

  /* ─── Condiciones de sellos de punta a punta ─── */

  describe("condiciones de sellos en un flujo real", () => {
    const flujoCon = (rule: Record<string, unknown>, texto: string) =>
      mkSimple("manual", [{ stepType: "condition", config: { rule, ifTrue: "continue", ifFalse: "stop" } }, msg(texto)]);

    async function corre(flowId: string, contactId: string, batch: string) {
      sent.length = 0;
      await manual.triggerManualFlow({ organizationId: org, flowId, contactId, batchId: `${batch}${uid}`, triggeredBy: "u" });
      await drain(flowId);
      return [...sent];
    }

    it("stamps_remaining_lte: «le falta 1 o menos»: avisa con 7 sellos, no con 5 ni con 8 (ya los tiene todos)", async () => {
      const f = await flujoCon({ type: "stamps_remaining_lte", stamps: 1 }, "¡Un sello más!");
      expect(await corre(f, await mkContact(7), "r7")).toEqual(["¡Un sello más!"]);
      expect(await corre(f, await mkContact(5), "r5")).toEqual([]);
      expect(await corre(f, await mkContact(8), "r8")).toEqual([]);
    });

    it("stamps_between: entre el sello 4 y el 7", async () => {
      const f = await flujoCon({ type: "stamps_between", min: 4, max: 7 }, "En camino al premio grande");
      expect(await corre(f, await mkContact(4), "b4")).toEqual(["En camino al premio grande"]);
      expect(await corre(f, await mkContact(7), "b7")).toEqual(["En camino al premio grande"]);
      expect(await corre(f, await mkContact(3), "b3")).toEqual([]);
      expect(await corre(f, await mkContact(8), "b8")).toEqual([]);
    });

    it("la condición mira los sellos de AHORA (tras una espera ya pudieron canjearse)", async () => {
      const contactId = await mkContact(7);
      const f = await flujoCon({ type: "stamps_remaining_lte", stamps: 1 }, "ahora sí");
      expect(await corre(f, contactId, "n1")).toEqual(["ahora sí"]);
      await db.update(schema.customerLoyaltyCard).set({ currentStamps: 1 }).where(eq(schema.customerLoyaltyCard.contactId, contactId));
      expect(await corre(f, contactId, "n2")).toEqual([]);
    });
  });

  /* ─── Endpoint del selector ─── */

  describe("GET /api/automations/loyalty-milestones", () => {
    const get = () => ruta.GET();

    it("devuelve los hitos reales del programa, ordenados, con su premio y descuento", async () => {
      sesion.actual = { userId: "usr_o", organizationId: org, role: "owner" };
      const r = await get();
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.milestones).toEqual([
        { stamps: 4, title: "20% de descuento", rewardType: "percentage_discount", discountPercentage: 20 },
        { stamps: 8, title: "50% de descuento", rewardType: "percentage_discount", discountPercentage: 50 },
      ]);
      expect(typeof body.enabled).toBe("boolean");
    });

    it("no mezcla organizaciones: cada una ve SU programa", async () => {
      await setMilestones(otherOrg, [{ stamps: 3, title: "Café gratis", rewardType: "service_free" }]);
      sesion.actual = { userId: "usr_b", organizationId: otherOrg, role: "admin" };
      expect((await (await get()).json()).milestones).toEqual([{ stamps: 3, title: "Café gratis", rewardType: "service_free" }]);
      sesion.actual = { userId: "usr_o", organizationId: org, role: "owner" };
      expect((await (await get()).json()).milestones.map((m: { stamps: number }) => m.stamps)).toEqual([4, 8]);
    });

    it("401 sin sesión y 403 para un miembro sin permiso de configurar", async () => {
      sesion.actual = null;
      expect((await get()).status).toBe(401);
      sesion.actual = { userId: "usr_m", organizationId: org, role: "member" };
      expect((await get()).status).toBe(403);
    });
  });
});
