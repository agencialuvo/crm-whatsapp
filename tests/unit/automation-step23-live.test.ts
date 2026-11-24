import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Pasos 2 y 3 contra PostgreSQL REAL (`pnpm test:db`): disparo manual con `batchId`, `tag_added` (rearme y anti-bucle),
 * `loyalty_reward_unlocked`, la memoria entre nodos (`context.vars` fundida bajo el candado del `run`, con reversión si
 * `StepError`), y el guardado/carga del Switch (`case_<id>`), sus referencias y su rechazo en el Modo Simple.
 * Nada toca la API de WhatsApp (los envíos son dobles). Crea y borra lo suyo.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("pasos 2 y 3 contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let flows: typeof import("@/server/automation/flows");
  let canvas: typeof import("@/server/automation/canvas");
  let worker: typeof import("@/server/automation/worker");
  let engine: typeof import("@/server/automation/engine");
  let queue: typeof import("@/server/automation/queue");
  let manual: typeof import("@/server/automation/manual");
  let triggers: typeof import("@/server/automation/triggers");
  let tags: typeof import("@/server/tags/store");
  let schemas: typeof import("@/lib/automation-schemas");
  let graphPayloadSchema: (typeof import("@/lib/automation-graph"))["graphPayloadSchema"];

  const uid = Date.now().toString(36);
  let org = "";
  let otherOrg = "";
  let tagX = "";
  let tagY = "";
  let foreignTag = "";
  let seq = 0;
  const created = { flows: [] as string[], tags: [] as string[], contacts: [] as string[], convs: [] as string[] };

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    delete process.env.AUTOMATION_CODE_JS;
    ({ eq, inArray } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    flows = await import("@/server/automation/flows");
    canvas = await import("@/server/automation/canvas");
    worker = await import("@/server/automation/worker");
    engine = await import("@/server/automation/engine");
    queue = await import("@/server/automation/queue");
    manual = await import("@/server/automation/manual");
    triggers = await import("@/server/automation/triggers");
    tags = await import("@/server/tags/store");
    schemas = await import("@/lib/automation-schemas");
    ({ graphPayloadSchema } = await import("@/lib/automation-graph"));

    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    org = orgs[0]!.id;
    otherOrg = orgs[1]!.id;
    for (const [name, setter, o] of [
      ["X", (v: string) => (tagX = v), org],
      ["Y", (v: string) => (tagY = v), org],
      ["F", (v: string) => (foreignTag = v), otherOrg],
    ] as const) {
      const t = await tags.createTag(o, { name: `S23-${name} ${uid}`, color: "blue" });
      setter(t.id);
      created.tags.push(t.id);
    }
  });

  afterAll(async () => {
    if (!db) return;
    if (created.flows.length) await db.delete(schema.automationFlow).where(inArray(schema.automationFlow.id, created.flows));
    if (created.tags.length) await db.delete(schema.tag).where(inArray(schema.tag.id, created.tags));
    if (created.convs.length) await db.delete(schema.conversation).where(inArray(schema.conversation.id, created.convs));
    if (created.contacts.length) await db.delete(schema.contact).where(inArray(schema.contact.id, created.contacts));
  });

  /* ─── Constructores ─── */

  async function mkContact() {
    const n = seq++;
    const contactId = `ct_s${uid}${n}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Cliente Paso", waIdentity: `s23-${uid}${n}` });
    await db.insert(schema.conversation).values({ id: `cv_s${uid}${n}`, organizationId: org, contactId, lastInboundAt: new Date() });
    created.contacts.push(contactId);
    created.convs.push(`cv_s${uid}${n}`);
    return contactId;
  }
  async function mkFlow(triggerType: string, triggerConfig: Record<string, unknown> | null = null) {
    const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `S23 ${uid}${seq++}`, triggerType, triggerConfig }));
    created.flows.push(flow.id);
    return flow.id;
  }
  async function mkSimple(triggerType: string, specs: { stepType: string; config: Record<string, unknown> }[], triggerConfig: Record<string, unknown> | null = null) {
    const flowId = await mkFlow(triggerType, triggerConfig);
    const out = [];
    for (const [i, s] of specs.entries()) out.push(await flows.createStep(org, flowId, schemas.stepCreateSchema.parse({ ...s, positionY: i * 100 })));
    await flows.updateFlow(org, flowId, { active: true });
    return { flowId, steps: out };
  }
  const runsOf = (flowId: string) => db.select().from(schema.automationRun).where(eq(schema.automationRun.flowId, flowId));
  const queueOf = (flowId: string) => db.select().from(schema.automationQueue).where(eq(schema.automationQueue.flowId, flowId)).orderBy(schema.automationQueue.createdAt);
  const logsOf = (flowId: string) => db.select().from(schema.automationExecutionLog).where(eq(schema.automationExecutionLog.flowId, flowId));

  const sent: string[] = [];
  function deps() {
    return {
      ...worker.defaultDeps(),
      sendText: vi.fn(async (i: { text: string }) => (sent.push(i.text), { messageId: "msg_fake" })),
      sendTemplate: vi.fn(async () => ({ messageId: "msg_fake" })),
      waMessageIdOf: async () => null,
    } as import("@/server/automation/engine").Deps;
  }
  async function drain(flowId: string) {
    const d = deps();
    for (let guard = 0; guard < 20; guard++) {
      const pending = (await queueOf(flowId)).find((r) => r.status === "pending" && r.scheduledFor.getTime() <= Date.now() + 1000);
      if (!pending) break;
      await engine.processRow(pending as never, d);
    }
  }
  const msg = (content: string) => ({ stepType: "send_whatsapp", config: { content } });

  /* ─── Paso 2: manual ─── */

  describe("disparador manual con batchId", () => {
    it("el mismo batchId no crea otra ejecución; otro batchId sí; el origen queda en el contexto", async () => {
      const contactId = await mkContact();
      const { flowId } = await mkSimple("manual", [msg("Hola {{name}}")]);
      const input = { organizationId: org, flowId, contactId, batchId: "b_prueba1", triggeredBy: "usr_test" };

      expect(await manual.triggerManualFlow(input)).toEqual({ started: true });
      expect(await manual.triggerManualFlow(input)).toEqual({ started: false });
      expect(await runsOf(flowId)).toHaveLength(1);
      expect((await queueOf(flowId)).length).toBe(1);

      const [run] = await runsOf(flowId);
      expect(run!.context).toMatchObject({ source: "manual", triggeredBy: "usr_test", batchId: "b_prueba1" });

      expect(await manual.triggerManualFlow({ ...input, batchId: "b_prueba2" })).toEqual({ started: true });
      expect(await runsOf(flowId)).toHaveLength(2);

      await drain(flowId);
      expect(sent).toContain("Hola Cliente Paso");
      expect((await logsOf(flowId)).filter((l) => l.status === "success").length).toBe(2);
    });

    it("un flujo apagado, ajeno o no manual se rechaza con su código", async () => {
      const contactId = await mkContact();
      const { flowId } = await mkSimple("manual", [msg("x")]);
      await flows.updateFlow(org, flowId, { active: false });
      await expect(manual.triggerManualFlow({ organizationId: org, flowId, contactId, batchId: "b_off", triggeredBy: "u" })).rejects.toMatchObject({ code: "flow_inactive", status: 409 });
      await expect(manual.triggerManualFlow({ organizationId: otherOrg, flowId, contactId, batchId: "b_x", triggeredBy: "u" })).rejects.toMatchObject({ code: "not_found" });
      const lead = await mkSimple("lead_created", [msg("x")]);
      await expect(manual.triggerManualFlow({ organizationId: org, flowId: lead.flowId, contactId, batchId: "b_y", triggeredBy: "u" })).rejects.toMatchObject({ code: "not_manual_flow" });
    });
  });

  /* ─── Paso 2: tag_added ─── */

  describe("tag_added", () => {
    it("asignar arranca el flujo de esa etiqueta; repetir no; quitar y volver a poner lo rearma; viaAutomation no emite", async () => {
      const contactId = await mkContact();
      const mine = await mkSimple("tag_added", [msg("etiqueta X")], { tagId: tagX });
      const other = await mkSimple("tag_added", [msg("etiqueta Y")], { tagId: tagY });
      const any = await mkSimple("tag_added", [msg("cualquiera")]);

      expect(await tags.assignTag(org, contactId, tagX)).toBe(true);
      expect(await runsOf(mine.flowId)).toHaveLength(1);
      expect(await runsOf(any.flowId)).toHaveLength(1);
      expect(await runsOf(other.flowId)).toHaveLength(0);
      expect((await runsOf(mine.flowId))[0]!.context).toMatchObject({ tagId: tagX });

      // Ya la tenía: no es una asignación nueva.
      expect(await tags.assignTag(org, contactId, tagX)).toBe(false);
      expect(await runsOf(mine.flowId)).toHaveLength(1);

      // Quitarla y volver a ponerla rearma (la llave lleva la hora de la asignación).
      await tags.unassignTag(org, contactId, tagX);
      await new Promise((r) => setTimeout(r, 15));
      await tags.assignTag(org, contactId, tagX);
      expect(await runsOf(mine.flowId)).toHaveLength(2);

      // Anti-bucle: una etiqueta puesta por una automatización no dispara otro flujo.
      expect(await tags.assignTag(org, contactId, tagY, { viaAutomation: true })).toBe(true);
      expect(await runsOf(other.flowId)).toHaveLength(0);
    });

    it("un flujo que etiqueta con add_tag no dispara a otro tag_added (cadena cortada)", async () => {
      const contactId = await mkContact();
      const chain = await mkSimple("tag_added", [{ stepType: "add_tag", config: { tagId: tagY } }], { tagId: tagX });
      const next = await mkSimple("tag_added", [msg("no debe salir")], { tagId: tagY });
      await tags.assignTag(org, contactId, tagX);
      await drain(chain.flowId);
      expect(await tags.tagIdsOfContact(org, contactId)).toContain(tagY);
      expect(await runsOf(next.flowId)).toHaveLength(0);
    });
  });

  /* ─── Paso 2: fidelización ─── */

  describe("loyalty_reward_unlocked", () => {
    const unlock = (contactId: string, txId: string, stamps = 8) => ({
      organizationId: org,
      contactId,
      transactionId: txId,
      currentStamps: stamps,
      unlocked: [{ stamps, title: "Corte gratis", rewardType: "discount", discountPercentage: 100 }] as never,
    });
    it("arranca una ejecución por premio, una sola vez por movimiento, con el detalle en el contexto", async () => {
      const contactId = await mkContact();
      const any = await mkSimple("loyalty_reward_unlocked", [msg("premio")]);
      const eight = await mkSimple("loyalty_reward_unlocked", [msg("premio 8")], { stamps: 8 });
      const four = await mkSimple("loyalty_reward_unlocked", [msg("premio 4")], { stamps: 4 });

      expect(await triggers.onLoyaltyRewardUnlocked(unlock(contactId, `ltr_${uid}`))).toBe(2);
      expect(await triggers.onLoyaltyRewardUnlocked(unlock(contactId, `ltr_${uid}`))).toBe(0); // mismo movimiento
      expect(await runsOf(any.flowId)).toHaveLength(1);
      expect(await runsOf(eight.flowId)).toHaveLength(1);
      expect(await runsOf(four.flowId)).toHaveLength(0);
      expect((await runsOf(eight.flowId))[0]!.context).toMatchObject({
        loyalty: { milestoneStamps: 8, title: "Corte gratis", currentStamps: 8, transactionId: `ltr_${uid}` },
      });
      // Otro movimiento = otra ejecución.
      expect(await triggers.onLoyaltyRewardUnlocked(unlock(contactId, `ltr_${uid}b`))).toBe(2);
    });
  });

  /* ─── Paso 3: context.vars ─── */

  describe("context.vars", () => {
    it("set_var → mensaje: la variable viaja en el run y el mensaje la lee ({{vars.clave}})", async () => {
      const contactId = await mkContact();
      const { flowId } = await mkSimple("manual", [
        { stepType: "set_var", config: { key: "plan", value: "Pro de {{name}}" } },
        msg("Tu plan: {{vars.plan}}{{vars.nada}}"),
      ]);
      await manual.triggerManualFlow({ organizationId: org, flowId, contactId, batchId: "b_vars", triggeredBy: "u" });
      await drain(flowId);
      expect(sent).toContain("Tu plan: Pro de Cliente Paso");
      const [run] = await runsOf(flowId);
      expect(run!.status).toBe("completed");
      expect(run!.context).toMatchObject({ source: "manual", batchId: "b_vars", vars: { plan: "Pro de Cliente Paso" } });
      // El historial no guarda el valor.
      const log = (await logsOf(flowId)).find((l) => (l.metadata as { step?: { stepType?: string } }).step?.stepType === "set_var")!;
      expect(JSON.stringify(log.metadata)).not.toContain("Pro de Cliente");
    });

    it("completeAndAdvance funde las variables con las que ya había y conserva las claves del disparo", async () => {
      const contactId = await mkContact();
      const { flowId } = await mkSimple("manual", [{ stepType: "delay", config: { amount: 1, unit: "seconds" } }, msg("fin")]);
      await manual.triggerManualFlow({ organizationId: org, flowId, contactId, batchId: "b_merge", triggeredBy: "u" });
      const row = (await queueOf(flowId)).find((r) => r.status === "pending")!;

      await queue.completeAndAdvance(row as never, new Date(), { vars: { a: "1", b: "2" } });
      const [r1] = await runsOf(flowId);
      expect(r1!.context).toMatchObject({ source: "manual", batchId: "b_merge", vars: { a: "1", b: "2" } });

      const next = (await queueOf(flowId)).find((r) => r.status === "pending")!;
      await queue.completeAndAdvance(next as never, new Date(), { vars: { b: "dos", c: 3, a: null } });
      const [r2] = await runsOf(flowId);
      expect(r2!.context).toMatchObject({ source: "manual", vars: { b: "dos", c: 3 } });
      expect((r2!.context as { vars: Record<string, unknown> }).vars).not.toHaveProperty("a");
    });

    it("pasarse del tope lanza StepError y REVIERTE todo: la tarea sigue viva y el contexto no cambia", async () => {
      const contactId = await mkContact();
      const { flowId } = await mkSimple("manual", [{ stepType: "delay", config: { amount: 1, unit: "seconds" } }, msg("fin")]);
      await manual.triggerManualFlow({ organizationId: org, flowId, contactId, batchId: "b_rev", triggeredBy: "u" });
      const row = (await queueOf(flowId)).find((r) => r.status === "pending")!;
      const [before] = await runsOf(flowId);
      const queueBefore = (await queueOf(flowId)).length;

      const tooMany = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, "x"]));
      await expect(queue.completeAndAdvance(row as never, new Date(), { vars: tooMany })).rejects.toMatchObject({ name: "StepError", code: "vars_limit" });

      const [after] = await runsOf(flowId);
      expect(after!.context).toEqual(before!.context);
      expect(after!.currentStepId).toBe(before!.currentStepId);
      const q = await queueOf(flowId);
      expect(q).toHaveLength(queueBefore); // no se encoló el siguiente
      expect(q.find((r) => r.id === row.id)!.status).toBe("pending"); // la tarea NO quedó completada
    });

    it("el motor falla a la vista (definitivo) si un set_var revienta el tope", async () => {
      const contactId = await mkContact();
      const { flowId } = await mkSimple("manual", [{ stepType: "set_var", config: { key: "nueva", value: "x" } }]);
      await manual.triggerManualFlow({ organizationId: org, flowId, contactId, batchId: "b_full", triggeredBy: "u" });
      const full = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "x"]));
      await db.update(schema.automationRun).set({ context: { source: "manual", vars: full } }).where(eq(schema.automationRun.flowId, flowId));
      await drain(flowId);
      const q = await queueOf(flowId);
      expect(q[0]!.status).toBe("failed");
      expect(q[0]!.error).toBe("vars_limit");
      expect((await runsOf(flowId))[0]!.status).toBe("failed");
    });

    it("code_js con la bandera apagada: no se puede guardar un bloque nuevo, y uno existente falla a la vista", async () => {
      const flowId = await mkFlow("manual");
      const payload = graphPayloadSchema.parse({
        nodes: [
          { id: "trg", type: "trigger", config: { triggerType: "manual", triggerConfig: null }, position: { x: 0, y: 0 } },
          { id: "new_c", type: "code_js", config: { code: "return { vars: { x: 1 } };" }, position: { x: 0, y: 100 } },
        ],
        edges: [{ source: "trg", target: "new_c", sourceHandle: "default" }],
      });
      await expect(canvas.saveGraph(org, flowId, payload)).rejects.toMatchObject({ code: "code_js_disabled", status: 422 });
      expect(await db.select().from(schema.automationStep).where(eq(schema.automationStep.flowId, flowId))).toHaveLength(0);
    });
  });

  /* ─── Paso 3: Switch ─── */

  describe("Switch", () => {
    const node = (id: string, type: string, config: Record<string, unknown>, x: number, y = 100) => ({ id, type, config, position: { x, y } });
    const cases = (extra: Record<string, unknown>[] = []) => ({
      cases: [
        { id: "vip", label: "VIP", rule: { type: "tag_has", tagId: tagX } },
        { id: "plan", label: "Plan pro", rule: { type: "var_equals", key: "plan", value: "pro" } },
        ...extra,
      ],
    });
    const graph = (swConfig: Record<string, unknown>, edges: { source: string; target: string; sourceHandle: string }[]) =>
      graphPayloadSchema.parse({
        nodes: [
          { id: "trg", type: "trigger", config: { triggerType: "manual", triggerConfig: null }, position: { x: 0, y: 0 } },
          node("new_sw", "switch", swConfig, 0),
          node("new_a", "send_whatsapp", { content: "rama VIP" }, -200, 200),
          node("new_b", "send_whatsapp", { content: "rama plan" }, 0, 200),
          node("new_o", "send_whatsapp", { content: "rama otro" }, 200, 200),
        ],
        edges: [{ source: "trg", target: "new_sw", sourceHandle: "default" }, ...edges],
      });
    const full = [
      { source: "new_sw", target: "new_a", sourceHandle: "case_vip" },
      { source: "new_sw", target: "new_b", sourceHandle: "case_plan" },
      { source: "new_sw", target: "new_o", sourceHandle: "default" },
    ];

    it("guarda y carga el Switch con sus aristas case_<id>, y el motor sigue la rama correcta", async () => {
      const flowId = await mkFlow("manual");
      const saved = await canvas.saveGraph(org, flowId, graph(cases(), full));
      const handles = saved.edges.map((e) => e.sourceHandle).sort();
      expect(handles).toEqual(["case_plan", "case_vip", "default"]); // la salida del disparador no es una arista
      expect(saved.edges.filter((e) => e.sourceHandle.startsWith("case_"))).toHaveLength(2);
      expect(saved.nodes.find((n) => n.type === "switch")!.config).toMatchObject({ cases: [{ id: "vip" }, { id: "plan" }] });

      // Recargar devuelve lo mismo.
      const again = await (await import("@/server/automation/graph")).getGraph(org, flowId);
      expect(again.edges.map((e) => `${e.sourceHandle}`).sort()).toEqual(saved.edges.map((e) => `${e.sourceHandle}`).sort());

      await flows.updateFlow(org, flowId, { active: true });

      // Con la etiqueta VIP: rama VIP.
      const vip = await mkContact();
      await tags.assignTag(org, vip, tagX, { viaAutomation: true });
      await manual.triggerManualFlow({ organizationId: org, flowId, contactId: vip, batchId: "b_sw1", triggeredBy: "u" });
      await drain(flowId);
      expect(sent).toContain("rama VIP");

      // Sin etiqueta y con la variable plan=pro: rama del plan.
      const pro = await mkContact();
      await manual.triggerManualFlow({ organizationId: org, flowId, contactId: pro, batchId: "b_sw2", triggeredBy: "u" });
      await db.update(schema.automationRun).set({ context: { source: "manual", vars: { plan: "pro" } } }).where(eq(schema.automationRun.contactId, pro));
      await drain(flowId);
      expect(sent).toContain("rama plan");

      // Nada coincide: «Otro».
      const none = await mkContact();
      await manual.triggerManualFlow({ organizationId: org, flowId, contactId: none, batchId: "b_sw3", triggeredBy: "u" });
      await drain(flowId);
      expect(sent).toContain("rama otro");
    });

    it("una arista de un caso que no existe (huérfana) se rechaza al guardar, sin dejar nada a medias", async () => {
      const flowId = await mkFlow("manual");
      await expect(
        canvas.saveGraph(org, flowId, graph(cases(), [...full, { source: "new_sw", target: "new_a", sourceHandle: "case_zzz" }]))
      ).rejects.toMatchObject({ code: "invalid_graph", status: 422 });
      expect(await db.select().from(schema.automationStep).where(eq(schema.automationStep.flowId, flowId))).toHaveLength(0);

      // Quitar un caso conservando su arista también es huérfana.
      await expect(canvas.saveGraph(org, flowId, graph({ cases: [cases().cases[0]!] }, full))).rejects.toMatchObject({ code: "invalid_graph" });
    });

    it("una etiqueta de OTRA organización dentro de un caso se rechaza (assertRefsOwned)", async () => {
      const flowId = await mkFlow("manual");
      const bad = { cases: [{ id: "x", label: "Ajena", rule: { type: "tag_has", tagId: foreignTag } }] };
      await expect(canvas.saveGraph(org, flowId, graph(bad, [{ source: "new_sw", target: "new_a", sourceHandle: "case_x" }]))).rejects.toMatchObject({ code: "tag_not_found", status: 422 });
    });

    it("un flujo con Switch no se puede pasar al Modo Simple (409 graph_not_linear) y no se toca nada", async () => {
      const flowId = await mkFlow("manual");
      await canvas.saveGraph(org, flowId, graph(cases(), full));
      await expect(canvas.setEditorMode(org, flowId, "simple")).rejects.toMatchObject({ code: "graph_not_linear", status: 409 });
      const [flow] = await db.select().from(schema.automationFlow).where(eq(schema.automationFlow.id, flowId));
      expect(flow!.editorMode).toBe("canvas");
      expect((await db.select().from(schema.automationEdge).where(eq(schema.automationEdge.flowId, flowId))).length).toBe(3);
    });

    it("la API de pasos de la lista rechaza crear un Switch", async () => {
      const flowId = await mkFlow("manual");
      const parsed = schemas.stepCreateSchema.parse({ stepType: "switch", config: cases() });
      await expect(flows.createStep(org, flowId, parsed)).rejects.toMatchObject({ code: "switch_requires_canvas", status: 422 });
    });
  });
});
