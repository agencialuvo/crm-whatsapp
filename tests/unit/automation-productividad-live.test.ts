import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * «Terminar flujo» y «Duplicar flujo» contra PostgreSQL REAL (`pnpm test:db`):
 *  - un flujo de lienzo «Condición → Sí: Terminar flujo / No: mensaje» corre por el motor con la cola real: la rama «Sí» deja su
 *    línea en el historial y cierra la ejecución sin enviar nada; guardarlo no avisa de rama suelta;
 *  - duplicar copia disparador, pasos, conexiones y configuraciones, nace PAUSADO, con nombre incremental, sin copiar ejecuciones,
 *    sin cruzar organizaciones y sin repetir nombre aunque se pidan varias copias a la vez.
 * Crea sus propias organizaciones y las borra. Los envíos son falsos.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("terminar flujo y duplicar contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: typeof import("drizzle-orm").eq;
  let flows: typeof import("@/server/automation/flows");
  let canvas: typeof import("@/server/automation/canvas");
  let engine: typeof import("@/server/automation/engine");
  let worker: typeof import("@/server/automation/worker");
  let manual: typeof import("@/server/automation/manual");
  let schemas: typeof import("@/lib/automation-schemas");
  let graphLib: typeof import("@/lib/automation-graph");

  const uid = Date.now().toString(36);
  const org = `org_pd${uid}`;
  const otraOrg = `org_pd2${uid}`;
  let seq = 0;
  const DAY = 86_400_000;

  async function mkContact(conBooking: boolean) {
    const n = seq++;
    const contactId = `ct_pd${uid}${n}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Cliente PD", waIdentity: `pd-${uid}${n}` });
    await db.insert(schema.conversation).values({ id: `cv_pd${uid}${n}`, organizationId: org, contactId, lastInboundAt: new Date() });
    if (conBooking) {
      await db.insert(schema.booking).values({
        id: `bk_pd${uid}${n}`,
        organizationId: org,
        kind: "session",
        status: "agendada",
        source: "manual",
        contactId,
        scheduledAt: new Date(Date.now() + 3 * DAY),
        durationMinutes: 30,
        connector: "enlace-fijo",
      });
    }
    return contactId;
  }

  const sent: string[] = [];
  const deps = () =>
    ({
      ...worker.defaultDeps(),
      sendText: vi.fn(async (i: { text: string }) => (sent.push(i.text), { messageId: "msg_fake" })),
      sendTemplate: vi.fn(async () => ({ messageId: "msg_fake" })),
      waMessageIdOf: async () => null,
    }) as import("@/server/automation/engine").Deps;
  const queueOf = (flowId: string) => db.select().from(schema.automationQueue).where(eq(schema.automationQueue.flowId, flowId)).orderBy(schema.automationQueue.createdAt);
  const runsOf = (flowId: string) => db.select().from(schema.automationRun).where(eq(schema.automationRun.flowId, flowId));
  const logsOf = (flowId: string) => db.select().from(schema.automationExecutionLog).where(eq(schema.automationExecutionLog.flowId, flowId));
  async function drain(flowId: string) {
    const d = deps();
    for (let guard = 0; guard < 20; guard++) {
      const pending = (await queueOf(flowId)).find((r) => r.status === "pending" && r.scheduledFor.getTime() <= Date.now() + 1000);
      if (!pending) break;
      await engine.processRow(pending as never, d);
    }
  }
  async function run(flowId: string, contactId: string) {
    sent.length = 0;
    await manual.triggerManualFlow({ organizationId: org, flowId, contactId, batchId: `b_${uid}${seq++}`, triggeredBy: "u" });
    await drain(flowId);
  }

  /** Un flujo de lienzo: manual → Condición (¿cita próxima?) → Sí: «Terminar flujo» · No: mensaje «SEGUIR». */
  async function mkCanvasFlow(name = `Lienzo ${uid}${seq++}`) {
    const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name, triggerType: "manual", editorMode: "canvas" }));
    const T = graphLib.TRIGGER_NODE_TYPE;
    const saved = await canvas.saveGraph(
      org,
      flow.id,
      graphLib.graphPayloadSchema.parse({
        nodes: [
          { id: T, type: T, config: { triggerType: "manual", triggerConfig: null }, position: { x: 0, y: 0 } },
          { id: "new_c", type: "condition", config: { name: "¿Ya agendó?", rule: { type: "has_upcoming_booking" }, ifTrue: "continue", ifFalse: "stop" }, position: { x: 0, y: 100 } },
          { id: "new_e", type: "end_flow", config: { name: "Ya tiene cita" }, position: { x: -150, y: 250 } },
          { id: "new_m", type: "send_whatsapp", config: { content: "SEGUIR" }, position: { x: 150, y: 250 } },
        ],
        edges: [
          { source: T, target: "new_c", sourceHandle: "default" },
          { source: "new_c", target: "new_e", sourceHandle: "true" },
          { source: "new_c", target: "new_m", sourceHandle: "false" },
        ],
        viewport: { x: 5, y: 6, zoom: 0.9 },
      })
    );
    await flows.updateFlow(org, flow.id, { active: true });
    return { flowId: flow.id, saved };
  }

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    delete process.env.AUTOMATION_CODE_JS;
    ({ eq } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    flows = await import("@/server/automation/flows");
    canvas = await import("@/server/automation/canvas");
    engine = await import("@/server/automation/engine");
    worker = await import("@/server/automation/worker");
    manual = await import("@/server/automation/manual");
    schemas = await import("@/lib/automation-schemas");
    graphLib = await import("@/lib/automation-graph");
    await db.insert(schema.organization).values([
      { id: org, name: `Prod live ${uid}` },
      { id: otraOrg, name: `Otra ${uid}` },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.organization).where(eq(schema.organization.id, org));
    await db.delete(schema.organization).where(eq(schema.organization.id, otraOrg));
  });

  describe("Terminar flujo por el motor", () => {
    it("guardar el lienzo con la rama «Sí» conectada a «Terminar flujo» no avisa de rama suelta", async () => {
      const { saved } = await mkCanvasFlow();
      expect(saved.warnings.map((w) => w.code)).not.toContain("open_output");
      expect(saved.nodes.map((n) => n.type).sort()).toEqual(["condition", "end_flow", "send_whatsapp"]);
    });

    it("rama «Sí»: deja su línea en el historial, cierra la ejecución y NO envía nada", async () => {
      const { flowId } = await mkCanvasFlow();
      const c = await mkContact(true);
      await run(flowId, c);
      expect(sent).toHaveLength(0);
      const [r] = await runsOf(flowId);
      expect(r!.status).toBe("completed");
      expect(r!.endedAt).not.toBeNull();
      const fin = (await logsOf(flowId)).find((l) => (l.metadata as { step?: { stepType?: string } }).step?.stepType === "end_flow")!;
      expect(fin).toBeTruthy();
      expect(fin.status).toBe("success");
      expect(fin.metadata).toMatchObject({ result: "ended", reason: "end_flow", step: { stepName: "Ya tiene cita" } });
      // La tarea del cierre quedó completada y no encoló nada después.
      const q = await queueOf(flowId);
      expect(q.every((x) => x.status === "completed")).toBe(true);
      expect(q).toHaveLength(2);
    });

    it("rama «No»: sigue por el mensaje y no pasa por el cierre", async () => {
      const { flowId } = await mkCanvasFlow();
      const c = await mkContact(false);
      await run(flowId, c);
      expect(sent).toEqual(["SEGUIR"]);
      expect((await runsOf(flowId))[0]!.status).toBe("completed");
      expect((await logsOf(flowId)).some((l) => (l.metadata as { step?: { stepType?: string } }).step?.stepType === "end_flow")).toBe(false);
    });

    it("la lista (Modo Simple) no lo admite: se crea solo en el lienzo", async () => {
      const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `Lista ${uid}${seq++}`, triggerType: "manual" }));
      await expect(flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ stepType: "end_flow", config: {}, positionY: 0 }))).rejects.toMatchObject({
        code: "end_flow_requires_canvas",
        status: 422,
      });
    });

    it("no se puede volver a la lista con un «Terminar flujo» dibujado, y nada se destruye", async () => {
      const { flowId } = await mkCanvasFlow();
      await expect(canvas.setEditorMode(org, flowId, "simple")).rejects.toMatchObject({ status: 409 });
      expect((await flows.getFlow(org, flowId)).flow.editorMode).toBe("canvas");
    });
  });

  describe("Duplicar un flujo", () => {
    it("copia disparador, pasos, conexiones y configuraciones; nace PAUSADA y el original no cambia", async () => {
      const { flowId } = await mkCanvasFlow("Recordatorio de cita");
      expect((await flows.getFlow(org, flowId)).flow.active).toBe(true);
      const graphMod = await import("@/server/automation/graph");
      const original = await graphMod.getGraph(org, flowId);

      const copy = await flows.cloneFlow(org, flowId);
      expect(copy.name).toBe("Recordatorio de cita (copia)");
      expect(copy.active).toBe(false);
      expect(copy.triggerType).toBe("manual");
      expect(copy.editorMode).toBe("canvas");
      expect(copy.id).not.toBe(flowId);

      const g = await graphMod.getGraph(org, copy.id);
      expect(g.nodes).toHaveLength(original.nodes.length);
      // Ids nuevos, mismas configuraciones y posiciones.
      const oldIds = new Set(original.nodes.map((n) => n.id));
      expect(g.nodes.every((n) => !oldIds.has(n.id))).toBe(true);
      const key = (n: { type: string; config: unknown; position: unknown }) => JSON.stringify([n.type, n.config, n.position]);
      expect(g.nodes.map(key).sort()).toEqual(original.nodes.map(key).sort());
      // Conexiones: mismas asas, apuntando a los pasos NUEVOS; la entrada también.
      expect(g.edges).toHaveLength(original.edges.length);
      const newIds = new Set(g.nodes.map((n) => n.id));
      expect(g.edges.every((e) => newIds.has(e.source) && newIds.has(e.target))).toBe(true);
      expect(g.edges.map((e) => e.sourceHandle).sort()).toEqual(original.edges.map((e) => e.sourceHandle).sort());
      expect(g.entryStepId && newIds.has(g.entryStepId)).toBe(true);
      const typeOf = (id: string | null) => g.nodes.find((n) => n.id === id)?.type;
      expect(typeOf(g.entryStepId)).toBe("condition");
      const cond = g.nodes.find((n) => n.type === "condition")!;
      expect(typeOf(g.edges.find((e) => e.source === cond.id && e.sourceHandle === "true")!.target)).toBe("end_flow");
      expect(typeOf(g.edges.find((e) => e.source === cond.id && e.sourceHandle === "false")!.target)).toBe("send_whatsapp");
      expect(g.viewport).toMatchObject({ x: 5, y: 6, zoom: 0.9 });

      // El original sigue encendido y con los mismos pasos.
      const o2 = await graphMod.getGraph(org, flowId);
      expect(o2.nodes.map((n) => n.id).sort()).toEqual(original.nodes.map((n) => n.id).sort());
      expect((await flows.getFlow(org, flowId)).flow.active).toBe(true);
    });

    it("la copia funciona igual cuando se enciende (la rama «Sí» termina, la «No» manda)", async () => {
      const { flowId } = await mkCanvasFlow();
      const copy = await flows.cloneFlow(org, flowId);
      await flows.updateFlow(org, copy.id, { active: true });
      await run(copy.id, await mkContact(true));
      expect(sent).toHaveLength(0);
      expect((await runsOf(copy.id))[0]!.status).toBe("completed");
      await run(copy.id, await mkContact(false));
      expect(sent).toEqual(["SEGUIR"]);
    });

    it("nombre incremental: «(copia)», «(copia 2)», «(copia 3)», también al copiar la copia", async () => {
      const { flowId } = await mkCanvasFlow("Reseña tras la cita");
      const a = await flows.cloneFlow(org, flowId);
      const b = await flows.cloneFlow(org, flowId);
      const c = await flows.cloneFlow(org, a.id); // copia de la copia
      expect([a.name, b.name, c.name]).toEqual(["Reseña tras la cita (copia)", "Reseña tras la cita (copia 2)", "Reseña tras la cita (copia 3)"]);
      const all = (await flows.listFlows(org)).map((f) => f.name);
      expect(new Set(all).size).toBe(all.length);
    });

    it("tres copias a la vez del mismo flujo: ningún nombre repetido", async () => {
      const { flowId } = await mkCanvasFlow("Simultáneo");
      const copies = await Promise.all([1, 2, 3].map(() => flows.cloneFlow(org, flowId)));
      const names = copies.map((x) => x.name).sort();
      expect(new Set(names).size).toBe(3);
      expect(names).toEqual(["Simultáneo (copia 2)", "Simultáneo (copia 3)", "Simultáneo (copia)"]);
    });

    it("un flujo de la lista (Modo Simple) se copia con sus pasos y conexiones recompiladas", async () => {
      const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `Simple ${uid}`, triggerType: "manual" }));
      await flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ stepType: "delay", config: { amount: 1, unit: "days" }, positionY: 0 }));
      await flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ stepType: "send_whatsapp", config: { content: "Hola" }, positionY: 100 }));
      const copy = await flows.cloneFlow(org, flow.id);
      expect(copy).toMatchObject({ name: `Simple ${uid} (copia)`, active: false, editorMode: "simple" });
      const g = await (await import("@/server/automation/graph")).getGraph(org, copy.id);
      expect(g.nodes.map((n) => n.type)).toEqual(["delay", "send_whatsapp"]);
      expect(g.edges).toHaveLength(1);
      expect(g.edges[0]).toMatchObject({ source: g.nodes[0]!.id, target: g.nodes[1]!.id, sourceHandle: "default" });
    });

    it("conserva los ajustes del disparador (por ejemplo «desde 3 sellos»)", async () => {
      const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `Sellos ${uid}`, triggerType: "loyalty_stamp_earned", triggerConfig: { minStamps: 3 } }));
      await flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ stepType: "send_whatsapp", config: { content: "Sello {{sellos}}" }, positionY: 0 }));
      const copy = await flows.cloneFlow(org, flow.id);
      expect(copy.triggerType).toBe("loyalty_stamp_earned");
      expect(copy.triggerConfig).toEqual({ minStamps: 3 });
    });

    it("no copia lo que pasó: ejecuciones, cola ni historial", async () => {
      const { flowId } = await mkCanvasFlow();
      await run(flowId, await mkContact(true));
      expect((await runsOf(flowId)).length).toBeGreaterThan(0);
      const copy = await flows.cloneFlow(org, flowId);
      expect(await runsOf(copy.id)).toHaveLength(0);
      expect(await queueOf(copy.id)).toHaveLength(0);
      expect(await logsOf(copy.id)).toHaveLength(0);
    });

    it("un flujo sin pasos también se copia (y sigue pausado)", async () => {
      const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `Vacío ${uid}`, triggerType: "manual", editorMode: "canvas" }));
      const copy = await flows.cloneFlow(org, flow.id);
      expect(copy).toMatchObject({ name: `Vacío ${uid} (copia)`, active: false, editorMode: "canvas" });
    });

    it("aislamiento: un flujo de otra organización o inexistente responde 404 y no crea nada", async () => {
      const ajeno = await flows.createFlow(otraOrg, schemas.flowCreateSchema.parse({ name: `Ajeno ${uid}`, triggerType: "manual" }));
      const antesOrg = (await flows.listFlows(org)).length;
      const antesOtra = (await flows.listFlows(otraOrg)).length;
      await expect(flows.cloneFlow(org, ajeno.id)).rejects.toMatchObject({ code: "not_found", status: 404 });
      await expect(flows.cloneFlow(org, "aut_no_existe")).rejects.toMatchObject({ status: 404 });
      expect((await flows.listFlows(org)).length).toBe(antesOrg);
      expect((await flows.listFlows(otraOrg)).length).toBe(antesOtra);
    });

    it("los nombres son por organización: copiar en una no choca con los nombres de la otra", async () => {
      const a = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `Mismo ${uid}`, triggerType: "manual" }));
      await flows.createFlow(otraOrg, schemas.flowCreateSchema.parse({ name: `Mismo ${uid} (copia)`, triggerType: "manual" }));
      expect((await flows.cloneFlow(org, a.id)).name).toBe(`Mismo ${uid} (copia)`);
    });
  });
});
