import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `human_handoff` contra PostgreSQL REAL (`pnpm test:db`): la pausa de la IA, el motivo propio (`automatizacion`), el aviso de
 * «Atención humana» (con la nota) y la idempotencia, y un flujo completo por el motor. Crea su propia organización y la borra.
 * Los envíos son falsos.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("human_handoff contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: typeof import("drizzle-orm").eq;
  let and: typeof import("drizzle-orm").and;
  let handoff: typeof import("@/server/automation/handoff");
  let flows: typeof import("@/server/automation/flows");
  let engine: typeof import("@/server/automation/engine");
  let worker: typeof import("@/server/automation/worker");
  let manual: typeof import("@/server/automation/manual");
  let schemas: typeof import("@/lib/automation-schemas");

  const uid = Date.now().toString(36);
  const org = `org_ho${uid}`;
  const otraOrg = `org_ho2${uid}`;
  let seq = 0;

  async function mkChat(extra: Partial<typeof import("@/lib/db").schema.conversation.$inferInsert> = {}, nombre = "Cliente Handoff", organizationId = org) {
    const n = seq++;
    const contactId = `ct_ho${uid}${n}`;
    const conversationId = `cv_ho${uid}${n}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId, name: nombre, waIdentity: `ho-${uid}${n}` });
    await db.insert(schema.conversation).values({ id: conversationId, organizationId, contactId, lastInboundAt: new Date(), ...extra });
    return { contactId, conversationId };
  }
  const conv = async (id: string) => (await db.select().from(schema.conversation).where(eq(schema.conversation.id, id)))[0]!;
  const avisos = (contactId: string) =>
    db.select().from(schema.notifications).where(and(eq(schema.notifications.organizationId, org), eq(schema.notifications.link, `/bandeja?contact=${contactId}`)));

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    ({ eq, and } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    handoff = await import("@/server/automation/handoff");
    flows = await import("@/server/automation/flows");
    engine = await import("@/server/automation/engine");
    worker = await import("@/server/automation/worker");
    manual = await import("@/server/automation/manual");
    schemas = await import("@/lib/automation-schemas");
    await db.insert(schema.organization).values([
      { id: org, name: `Handoff live ${uid}` },
      { id: otraOrg, name: `Otra ${uid}` },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.organization).where(eq(schema.organization.id, org));
    await db.delete(schema.organization).where(eq(schema.organization.id, otraOrg));
  });

  describe("handoffConversation", () => {
    it("pasa la conversación a una persona: IA apagada, hora, motivo propio y aviso de «Atención humana» con la nota", async () => {
      const { contactId, conversationId } = await mkChat();
      const antes = Date.now();
      expect(await handoff.handoffConversation({ organizationId: org, conversationId, note: "Ganó el 50%; confirmar canje" })).toEqual({ status: "paused" });
      const c = await conv(conversationId);
      expect(c).toMatchObject({ aiEnabled: false, handoffReason: "automatizacion" });
      expect(c.handoffAt!.getTime()).toBeGreaterThanOrEqual(antes - 2000);
      const a = await avisos(contactId);
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ title: "Atención humana solicitada", category: "whatsapp", isRead: false });
      expect(a[0]!.message).toContain("Cliente Handoff");
      expect(a[0]!.message).toContain("Una automatización pidió que una persona atienda esta conversación");
      expect(a[0]!.message).toContain("Ganó el 50%; confirmar canje");
    });

    it("es idempotente: repetirlo no pisa la hora ni el motivo ni duplica el aviso", async () => {
      const { contactId, conversationId } = await mkChat();
      await handoff.handoffConversation({ organizationId: org, conversationId });
      const primera = (await conv(conversationId)).handoffAt!.getTime();
      expect(await handoff.handoffConversation({ organizationId: org, conversationId, note: "otra vez" })).toEqual({ status: "already_paused" });
      const c = await conv(conversationId);
      expect(c.handoffAt!.getTime()).toBe(primera);
      expect(c.handoffReason).toBe("automatizacion");
      expect(await avisos(contactId)).toHaveLength(1);
    });

    it("tres llamadas simultáneas: una sola transición y un solo aviso", async () => {
      const { contactId, conversationId } = await mkChat();
      const r = await Promise.all([1, 2, 3].map(() => handoff.handoffConversation({ organizationId: org, conversationId })));
      expect(r.filter((x) => x.status === "paused")).toHaveLength(1);
      expect(r.filter((x) => x.status === "already_paused")).toHaveLength(2);
      expect(await avisos(contactId)).toHaveLength(1);
    });

    it("respeta un traspaso anterior: si el agente ya la había escalado, conserva SU motivo y no avisa otra vez", async () => {
      const { contactId, conversationId } = await mkChat({ aiEnabled: false, handoffAt: new Date("2026-06-01T10:00:00Z"), handoffReason: "modelo" });
      expect(await handoff.handoffConversation({ organizationId: org, conversationId })).toEqual({ status: "already_paused" });
      expect(await conv(conversationId)).toMatchObject({ handoffReason: "modelo" });
      expect(await avisos(contactId)).toHaveLength(0);
    });

    it("una IA apagada a mano (sin traspaso) SÍ se escala: queda la hora y el aviso", async () => {
      const { contactId, conversationId } = await mkChat({ aiEnabled: false });
      expect(await handoff.handoffConversation({ organizationId: org, conversationId })).toEqual({ status: "paused" });
      expect((await conv(conversationId)).handoffReason).toBe("automatizacion");
      expect(await avisos(contactId)).toHaveLength(1);
    });

    it("aislamiento: no toca una conversación de otra organización ni una del Laboratorio, y una inexistente es not_found", async () => {
      const ajena = await mkChat({}, "Ajena", otraOrg);
      expect(await handoff.handoffConversation({ organizationId: org, conversationId: ajena.conversationId })).toEqual({ status: "not_found" });
      expect(await conv(ajena.conversationId)).toMatchObject({ aiEnabled: true, handoffAt: null, handoffReason: null });

      const lab = await mkChat({ isTest: true }, "Laboratorio");
      expect(await handoff.handoffConversation({ organizationId: org, conversationId: lab.conversationId })).toEqual({ status: "not_found" });
      expect(await conv(lab.conversationId)).toMatchObject({ aiEnabled: true, handoffAt: null });
      expect(await avisos(lab.contactId)).toHaveLength(0);

      expect(await handoff.handoffConversation({ organizationId: org, conversationId: "cv_no_existe" })).toEqual({ status: "not_found" });
    });
  });

  describe("por el motor, con la cola real", () => {
    const sent: string[] = [];
    const deps = () =>
      ({
        ...worker.defaultDeps(),
        sendText: vi.fn(async (i: { text: string }) => (sent.push(i.text), { messageId: "msg_fake" })),
        sendTemplate: vi.fn(async () => ({ messageId: "msg_fake" })),
        waMessageIdOf: async () => null,
      }) as import("@/server/automation/engine").Deps;
    const queueOf = (flowId: string) => db.select().from(schema.automationQueue).where(eq(schema.automationQueue.flowId, flowId)).orderBy(schema.automationQueue.createdAt);
    async function drain(flowId: string) {
      const d = deps();
      for (let guard = 0; guard < 20; guard++) {
        const pending = (await queueOf(flowId)).find((r) => r.status === "pending" && r.scheduledFor.getTime() <= Date.now() + 1000);
        if (!pending) break;
        await engine.processRow(pending as never, d);
      }
    }
    async function mkFlow(specs: { stepType: string; config: Record<string, unknown> }[]) {
      const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `HO ${uid}${seq++}`, triggerType: "manual" }));
      for (const [i, s] of specs.entries()) await flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ ...s, positionY: i * 100 }));
      await flows.updateFlow(org, flow.id, { active: true });
      return flow.id;
    }

    it("un flujo «pasar a una persona → avisar al cliente»: escala, deja la nota con el nombre y el flujo SIGUE", async () => {
      const { contactId, conversationId } = await mkChat({}, "Sofía");
      const flowId = await mkFlow([
        { stepType: "human_handoff", config: { note: "{{name}} pidió atención por su premio" } },
        { stepType: "send_whatsapp", config: { content: "Un asesor te escribirá en breve" } },
      ]);
      await manual.triggerManualFlow({ organizationId: org, flowId, contactId, batchId: `b_${uid}1`, triggeredBy: "u" });
      await drain(flowId);

      expect(await conv(conversationId)).toMatchObject({ aiEnabled: false, handoffReason: "automatizacion" });
      const a = await avisos(contactId);
      expect(a).toHaveLength(1);
      expect(a[0]!.message).toContain("Sofía pidió atención por su premio");
      expect(sent).toContain("Un asesor te escribirá en breve");
      const [run] = await db.select().from(schema.automationRun).where(eq(schema.automationRun.flowId, flowId));
      expect(run!.status).toBe("completed");
      const log = (await db.select().from(schema.automationExecutionLog).where(eq(schema.automationExecutionLog.flowId, flowId))).find(
        (l) => (l.metadata as { step?: { stepType?: string } }).step?.stepType === "human_handoff"
      )!;
      expect(log.status).toBe("success");
      expect(log.metadata).toMatchObject({ result: "paused" });
    });

    it("con la conversación ya pasada a una persona, el paso no repite el aviso y el flujo termina bien", async () => {
      const { contactId } = await mkChat({ aiEnabled: false, handoffAt: new Date(), handoffReason: "cliente" });
      const flowId = await mkFlow([{ stepType: "human_handoff", config: {} }]);
      await manual.triggerManualFlow({ organizationId: org, flowId, contactId, batchId: `b_${uid}2`, triggeredBy: "u" });
      await drain(flowId);
      expect(await avisos(contactId)).toHaveLength(0);
      const [run] = await db.select().from(schema.automationRun).where(eq(schema.automationRun.flowId, flowId));
      expect(run!.status).toBe("completed");
      const log = (await db.select().from(schema.automationExecutionLog).where(eq(schema.automationExecutionLog.flowId, flowId)))[0]!;
      expect(log.metadata).toMatchObject({ result: "already_paused" });
    });
  });
});
