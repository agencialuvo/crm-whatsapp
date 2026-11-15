import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Fase 5 contra PostgreSQL REAL (`pnpm test:db`): el `PUT /graph` atómico y optimista, la validación en el
 * servidor, ids nuevos y conservados, borrado de pasos que cancela ejecuciones, el MOTOR ejecutando un grafo
 * dibujado (ramas a bloques lejanos y un ciclo con espera), la conversión Simple ⇄ Visual sin perder nada, y el
 * bloqueo de la API de pasos mientras el flujo es de lienzo. Nada toca la API de WhatsApp. Crea y borra lo suyo.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("lienzo contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let flows: typeof import("@/server/automation/flows");
  let canvas: typeof import("@/server/automation/canvas");
  let graph: typeof import("@/server/automation/graph");
  let worker: typeof import("@/server/automation/worker");
  let engine: typeof import("@/server/automation/engine");
  let store: typeof import("@/server/automation/trigger-store");
  let reply: typeof import("@/server/automation/reply");
  let tags: typeof import("@/server/tags/store");
  let schemas: typeof import("@/lib/automation-schemas");
  let graphPayloadSchema: (typeof import("@/lib/automation-graph"))["graphPayloadSchema"];

  const uid = Date.now().toString(36);
  let org = "";
  let otherOrg = "";
  let tagX = "";
  let tagA = "";
  let tagB = "";
  let tagC = "";
  let stageId = "";
  let seq = 0;
  const created = { flows: [] as string[], tags: [] as string[], contacts: [] as string[], convs: [] as string[] };

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    ({ eq, and, inArray } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    flows = await import("@/server/automation/flows");
    canvas = await import("@/server/automation/canvas");
    graph = await import("@/server/automation/graph");
    worker = await import("@/server/automation/worker");
    engine = await import("@/server/automation/engine");
    store = await import("@/server/automation/trigger-store");
    reply = await import("@/server/automation/reply");
    tags = await import("@/server/tags/store");
    schemas = await import("@/lib/automation-schemas");
    ({ graphPayloadSchema } = await import("@/lib/automation-graph"));

    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    org = orgs[0]!.id;
    otherOrg = orgs[1]!.id;
    for (const [name, setter] of [["X", (v: string) => (tagX = v)], ["A", (v: string) => (tagA = v)], ["B", (v: string) => (tagB = v)], ["C", (v: string) => (tagC = v)]] as const) {
      const t = await tags.createTag(org, { name: `L-${name} ${uid}`, color: "blue" });
      setter(t.id);
      created.tags.push(t.id);
    }
    stageId = `stg_l${uid}`;
    await db.insert(schema.pipelineStage).values({ id: stageId, organizationId: org, name: `Lienzo ${uid}`, position: 950, kind: "open" });
  });

  afterAll(async () => {
    if (!db) return;
    if (created.flows.length) await db.delete(schema.automationFlow).where(inArray(schema.automationFlow.id, created.flows));
    if (created.tags.length) await db.delete(schema.tag).where(inArray(schema.tag.id, created.tags));
    if (created.convs.length) await db.delete(schema.conversation).where(inArray(schema.conversation.id, created.convs));
    if (created.contacts.length) await db.delete(schema.contact).where(inArray(schema.contact.id, created.contacts));
    await db.delete(schema.pipelineStage).where(eq(schema.pipelineStage.id, stageId));
  });

  /* ─── Constructores ─── */

  async function mkContact() {
    const n = seq++;
    const contactId = `ct_l${uid}${n}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Cliente Lienzo", waIdentity: `lz-${uid}${n}` });
    await db.insert(schema.conversation).values({ id: `cv_l${uid}${n}`, organizationId: org, contactId, lastInboundAt: new Date() });
    created.contacts.push(contactId);
    created.convs.push(`cv_l${uid}${n}`);
    return contactId;
  }

  const trg = (x = 0, y = 0, triggerType = "lead_created", triggerConfig: unknown = null) => ({
    id: "trg",
    type: "trigger" as const,
    config: { triggerType, triggerConfig },
    position: { x, y },
  });
  const step = (id: string, type: string, config: Record<string, unknown>, x: number, y = 100) => ({ id, type: type as never, config, position: { x, y } });
  const addTag = (id: string, tagId: string, x: number) => step(id, "add_tag", { tagId }, x);
  const edge = (source: string, target: string, sourceHandle = "default") => ({ source, target, sourceHandle: sourceHandle as never });
  /** Lo que la ruta hace antes de llamar al servicio: parsear con el contrato (redondea posiciones, pone el asa por defecto). */
  const payload = (nodes: unknown[], edges: unknown[], extra: Record<string, unknown> = {}) =>
    graphPayloadSchema.parse({ nodes, edges, ...extra });
  /** Los flujos nacen apagados: los de las pruebas del motor se encienden para que su cola corra. */
  const activate = (flowId: string) => flows.updateFlow(org, flowId, { active: true });

  /** Un flujo vacío (Modo Simple). */
  async function mkFlow(triggerType = "lead_created") {
    const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `Lienzo ${uid}${seq++}`, triggerType }));
    created.flows.push(flow.id);
    return flow.id;
  }
  /** Un flujo de lista con pasos, creados por el servicio real. */
  async function mkSimple(specs: { stepType: string; config: Record<string, unknown> }[], triggerType = "lead_created") {
    const flowId = await mkFlow(triggerType);
    const out = [];
    for (const [i, s] of specs.entries()) out.push(await flows.createStep(org, flowId, schemas.stepCreateSchema.parse({ ...s, positionY: i * 100 })));
    return { flowId, steps: out };
  }

  const flowRow = async (flowId: string) => (await db.select().from(schema.automationFlow).where(eq(schema.automationFlow.id, flowId)))[0]!;
  const stepsOf = (flowId: string) => db.select().from(schema.automationStep).where(eq(schema.automationStep.flowId, flowId));
  const edgesOf = (flowId: string) => db.select().from(schema.automationEdge).where(eq(schema.automationEdge.flowId, flowId));
  const runsOf = (flowId: string) => db.select().from(schema.automationRun).where(eq(schema.automationRun.flowId, flowId));
  const queueOf = (flowId: string) => db.select().from(schema.automationQueue).where(eq(schema.automationQueue.flowId, flowId)).orderBy(schema.automationQueue.createdAt);
  const idAtX = (g: { nodes: { id: string; position: { x: number; y: number } }[] }, x: number) => g.nodes.find((n) => n.position.x === x)!.id;
  const edgeSet = (es: { sourceStepId: string; targetStepId: string; sourceHandle: string }[]) => es.map((e) => `${e.sourceStepId}|${e.sourceHandle}|${e.targetStepId}`).sort();

  function deps() {
    const d: import("@/server/automation/engine").Deps = {
      ...worker.defaultDeps(),
      sendText: vi.fn(async () => ({ messageId: "msg_fake" })),
      sendTemplate: vi.fn(async () => ({ messageId: "msg_fake" })),
      waMessageIdOf: async () => null,
    };
    return d;
  }
  async function drain(flowId: string) {
    const d = deps();
    for (let guard = 0; guard < 20; guard++) {
      const pending = (await queueOf(flowId)).find((r) => r.status === "pending" && r.scheduledFor.getTime() <= Date.now() + 1000);
      if (!pending) break;
      await engine.processRow(pending as never, d);
    }
  }
  const start = (flowId: string, contactId: string, key: string) =>
    store.dbTriggerStore.enqueueFirstStep({ organizationId: org, flowId, contactId, scheduledFor: new Date(), dedupeKey: key });
  const tagsOf = async (contactId: string) => (await tags.tagIdsOfContact(org, contactId)).sort();

  /* ─── El guardado ─── */

  describe("PUT /graph", () => {
    it("guarda un grafo nuevo: pasos con ids reales, aristas remapeadas, entrada, posiciones y cámara", async () => {
      const flowId = await mkFlow();
      const saved = await canvas.saveGraph(
        org,
        flowId,
        payload(
          [trg(10, 20), step("new_cond", "condition", { rule: { type: "tag_has", tagId: tagX } }, 5), addTag("new_a", tagA, -150), addTag("new_b", tagB, 150)],
          [edge("trg", "new_cond"), edge("new_cond", "new_a", "true"), edge("new_cond", "new_b", "false")],
          { viewport: { x: 1, y: 2, zoom: 0.75 } }
        )
      );

      expect(saved.flow.editorMode).toBe("canvas");
      expect(saved.nodes).toHaveLength(3);
      expect(saved.nodes.every((n) => n.id.startsWith("stp_"))).toBe(true);
      const cond = idAtX(saved, 5);
      const a = idAtX(saved, -150);
      const b = idAtX(saved, 150);
      expect(saved.entryStepId).toBe(cond);
      expect(saved.edges.map((e) => `${e.source}|${e.sourceHandle}|${e.target}`).sort()).toEqual([`${cond}|false|${b}`, `${cond}|true|${a}`].sort());

      const row = await flowRow(flowId);
      expect(row).toMatchObject({ editorMode: "canvas", entryStepId: cond });
      expect(row.viewport).toEqual({ x: 1, y: 2, zoom: 0.75, trigger: { x: 10, y: 20 } });
      // Las posiciones visuales se guardan tal cual en automation_step (enteros).
      const steps = await stepsOf(flowId);
      expect(steps.find((s) => s.id === a)).toMatchObject({ positionX: -150, positionY: 100 });
      expect(saved.warnings).toEqual([]);
    });

    it("conserva los ids al volver a guardar y es idempotente", async () => {
      const flowId = await mkFlow();
      const first = await canvas.saveGraph(org, flowId, payload([trg(), addTag("new_1", tagA, 0)], [edge("trg", "new_1")]));
      const id = first.nodes[0]!.id;
      const again = await canvas.saveGraph(
        org,
        flowId,
        payload([trg(), { ...addTag(id, tagA, 0), position: { x: 0, y: 100 } }], [edge("trg", id)], { expectedUpdatedAt: first.updatedAt })
      );
      expect(again.nodes[0]!.id).toBe(id);
      expect(await stepsOf(flowId)).toHaveLength(1);
      expect(await edgesOf(flowId)).toHaveLength(0);
      expect(again.entryStepId).toBe(id);
    });

    it("las posiciones se redondean a entero", async () => {
      const flowId = await mkFlow();
      const saved = await canvas.saveGraph(
        org,
        flowId,
        payload([trg(), { ...addTag("new_1", tagA, 0), position: { x: 10.6, y: -3.4 } }], [edge("trg", "new_1")])
      );
      expect(saved.nodes[0]!.position).toEqual({ x: 11, y: -3 });
    });

    it("devuelve los avisos (inalcanzables, salidas abiertas) y los guarda igual", async () => {
      const flowId = await mkFlow();
      const saved = await canvas.saveGraph(
        org,
        flowId,
        payload([trg(), step("new_c", "condition", { rule: { type: "tag_has", tagId: tagX } }, 0), addTag("new_a", tagA, 100), addTag("new_o", tagB, 300)], [edge("trg", "new_c"), edge("new_c", "new_a", "true")])
      );
      expect(saved.warnings.map((w) => w.code).sort()).toEqual(["open_output", "unreachable"]);
      expect(await stepsOf(flowId)).toHaveLength(3);
    });

    it("un grafo vacío (solo el disparador) apaga un flujo encendido sin pasos", async () => {
      const { flowId } = await mkSimple([{ stepType: "add_tag", config: { tagId: tagA } }]);
      await flows.updateFlow(org, flowId, { active: true });
      const saved = await canvas.saveGraph(org, flowId, payload([trg()], []));
      expect(saved.flow.active).toBe(false);
      expect(await stepsOf(flowId)).toHaveLength(0);
    });

    it("cambiar el nodo disparador cambia el disparador del flujo (con sus ajustes validados)", async () => {
      const flowId = await mkFlow("lead_created");
      const saved = await canvas.saveGraph(org, flowId, payload([trg(0, 0, "stage_changed", { toStageId: stageId }), addTag("new_1", tagA, 0)], [edge("trg", "new_1")]));
      expect(saved.flow).toMatchObject({ triggerType: "stage_changed", triggerConfig: { toStageId: stageId } });
      // Una etapa de otra organización no se acepta.
      await expect(
        canvas.saveGraph(org, flowId, payload([trg(0, 0, "stage_changed", { toStageId: "stg_ajena" }), addTag("new_2", tagA, 0)], [edge("trg", "new_2")]))
      ).rejects.toMatchObject({ code: "stage_not_found" });
    });
  });

  describe("validación en el servidor", () => {
    const untouched = async (flowId: string, before: { steps: number; edges: number; updatedAt: number }) => {
      expect((await stepsOf(flowId)).length).toBe(before.steps);
      expect((await edgesOf(flowId)).length).toBe(before.edges);
      expect((await flowRow(flowId)).updatedAt.getTime()).toBe(before.updatedAt);
    };

    it("un ciclo sin espera se rechaza (422) y no deja NADA a medias", async () => {
      const { flowId } = await mkSimple([{ stepType: "add_tag", config: { tagId: tagA } }, { stepType: "add_tag", config: { tagId: tagB } }]);
      const before = { steps: 2, edges: (await edgesOf(flowId)).length, updatedAt: (await flowRow(flowId)).updatedAt.getTime() };
      await expect(
        canvas.saveGraph(org, flowId, payload([trg(), addTag("new_a", tagA, 0), addTag("new_b", tagB, 100)], [edge("trg", "new_a"), edge("new_a", "new_b"), edge("new_b", "new_a")]))
      ).rejects.toMatchObject({ code: "invalid_graph", status: 422 });
      await untouched(flowId, before);
      expect((await flowRow(flowId)).editorMode).toBe("simple");
    });

    it("una configuración inválida, dos disparadores o un asa que no existe también se rechazan", async () => {
      const flowId = await mkFlow();
      const bad = [
        payload([trg(), { id: "x", type: "add_tag", config: {}, position: { x: 0, y: 0 } }], [edge("trg", "x")]),
        payload([trg(), { ...trg(), id: "trg2" }], []),
        payload([trg(), addTag("x", tagA, 0), addTag("y", tagB, 1)], [edge("trg", "x"), edge("x", "y", "true")]),
      ];
      for (const p of bad) await expect(canvas.saveGraph(org, flowId, p)).rejects.toMatchObject({ code: "invalid_graph" });
      expect(await stepsOf(flowId)).toHaveLength(0);
    });

    it("no acepta etiquetas de otra organización", async () => {
      const theirs = await tags.createTag(otherOrg, { name: `L-ajena ${uid}`, color: "red" });
      created.tags.push(theirs.id);
      const flowId = await mkFlow();
      await expect(canvas.saveGraph(org, flowId, payload([trg(), addTag("x", theirs.id, 0)], [edge("trg", "x")]))).rejects.toMatchObject({ code: "tag_not_found" });
      expect(await stepsOf(flowId)).toHaveLength(0);
    });

    it("el tipo de un bloque existente no cambia", async () => {
      const first = await (async () => {
        const flowId = await mkFlow();
        const saved = await canvas.saveGraph(org, flowId, payload([trg(), addTag("new_1", tagA, 0)], [edge("trg", "new_1")]));
        return { flowId, id: saved.nodes[0]!.id, updatedAt: saved.updatedAt };
      })();
      await expect(
        canvas.saveGraph(org, first.flowId, payload([trg(), step(first.id, "delay", { amount: 1, unit: "days" }, 0)], [edge("trg", first.id)]))
      ).rejects.toMatchObject({ code: "step_type_changed" });
      expect((await stepsOf(first.flowId))[0]!.stepType).toBe("add_tag");
    });

    it("aislamiento: otra organización no puede guardar ni ver este flujo", async () => {
      const flowId = await mkFlow();
      await expect(canvas.saveGraph(otherOrg, flowId, payload([trg()], []))).rejects.toMatchObject({ status: 404 });
      await expect(canvas.setEditorMode(otherOrg, flowId, "canvas")).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("concurrencia optimista", () => {
    it("un guardado con un updatedAt viejo se rechaza (409) y no pisa lo guardado", async () => {
      const flowId = await mkFlow();
      const first = await canvas.saveGraph(org, flowId, payload([trg(), addTag("new_1", tagA, 0)], [edge("trg", "new_1")]));
      const second = await canvas.saveGraph(org, flowId, payload([trg(), addTag("new_1", tagB, 0)], [edge("trg", "new_1")], { expectedUpdatedAt: first.updatedAt }));
      await expect(
        canvas.saveGraph(org, flowId, payload([trg(), addTag("new_1", tagC, 0)], [edge("trg", "new_1")], { expectedUpdatedAt: first.updatedAt }))
      ).rejects.toMatchObject({ code: "stale_graph", status: 409 });
      // Quedó lo del segundo guardado, no lo del tercero.
      expect((await stepsOf(flowId)).map((s) => (s.config as { tagId: string }).tagId)).toEqual([tagB]);
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    });

    it("dos guardados SIMULTÁNEOS con el mismo updatedAt: gana uno y el otro recibe 409", async () => {
      for (let i = 0; i < 6; i++) {
        const flowId = await mkFlow();
        const base = await canvas.saveGraph(org, flowId, payload([trg(), addTag("new_1", tagA, 0)], [edge("trg", "new_1")]));
        const mine = (tag: string) => payload([trg(), addTag(base.nodes[0]!.id, tag, 0)], [edge("trg", base.nodes[0]!.id)], { expectedUpdatedAt: base.updatedAt });
        const results = await Promise.allSettled([canvas.saveGraph(org, flowId, mine(tagB)), canvas.saveGraph(org, flowId, mine(tagC))]);
        const ok = results.filter((r) => r.status === "fulfilled");
        const stale = results.filter((r) => r.status === "rejected" && (r.reason as { code?: string }).code === "stale_graph");
        expect(ok.length, `ronda ${i}`).toBe(1);
        expect(stale.length, `ronda ${i}`).toBe(1);
        expect(await stepsOf(flowId)).toHaveLength(1);
      }
    });

    it("un cambio por otra vía (renombrar el flujo) también hace «vieja» la copia del lienzo", async () => {
      const flowId = await mkFlow();
      const base = await canvas.saveGraph(org, flowId, payload([trg()], []));
      await new Promise((r) => setTimeout(r, 5)); // que `updatedAt` cambie de milisegundo
      await flows.updateFlow(org, flowId, { name: `Renombrado ${uid}` });
      await expect(canvas.saveGraph(org, flowId, payload([trg()], [], { expectedUpdatedAt: base.updatedAt }))).rejects.toMatchObject({ code: "stale_graph" });
    });
  });

  describe("borrar un bloque", () => {
    it("el paso se va y la ejecución que estaba en él se cancela", async () => {
      const flowId = await mkFlow();
      const saved = await canvas.saveGraph(
        org,
        flowId,
        payload([trg(), addTag("new_a", tagA, 0), step("new_d", "delay", { amount: 1, unit: "days" }, 100), addTag("new_b", tagB, 200)], [edge("trg", "new_a"), edge("new_a", "new_d"), edge("new_d", "new_b")])
      );
      await activate(flowId);
      const contactId = await mkContact();
      await start(flowId, contactId, "borra:1");
      await drain(flowId); // a → delay → b queda a un día
      const [run] = await runsOf(flowId);
      expect(run).toMatchObject({ status: "waiting", waitingFor: "time", currentStepId: idAtX(saved, 200) });

      // Se quita el último bloque (donde está parada la ejecución). Encender el flujo cambió su `updatedAt`:
      // el lienzo lo recarga antes de guardar, como haría la pantalla.
      const keepA = idAtX(saved, 0);
      const keepD = idAtX(saved, 100);
      const fresh = (await graph.getGraph(org, flowId)).updatedAt;
      await canvas.saveGraph(
        org,
        flowId,
        payload(
          [trg(), { ...addTag(keepA, tagA, 0), position: { x: 0, y: 100 } }, step(keepD, "delay", { amount: 1, unit: "days" }, 100)],
          [edge("trg", keepA), edge(keepA, keepD)],
          { expectedUpdatedAt: fresh }
        )
      );
      expect((await runsOf(flowId))[0]).toMatchObject({ status: "cancelled" });
      expect((await stepsOf(flowId)).map((s) => s.id).sort()).toEqual([keepA, keepD].sort());
      expect((await queueOf(flowId)).filter((r) => r.status === "pending")).toHaveLength(0);
    });
  });

  describe("el motor ejecuta el grafo dibujado", () => {
    it("una rama a un bloque LEJANO (que la lista no puede expresar) se sigue tal cual", async () => {
      const flowId = await mkFlow();
      const saved = await canvas.saveGraph(
        org,
        flowId,
        payload(
          [
            trg(),
            step("new_c", "condition", { rule: { type: "tag_has", tagId: tagX } }, 0),
            addTag("new_1", tagA, -300),
            addTag("new_2", tagB, -150),
            addTag("new_far", tagC, 300),
          ],
          [edge("trg", "new_c"), edge("new_c", "new_far", "true"), edge("new_c", "new_1", "false"), edge("new_1", "new_2"), edge("new_2", "new_far")]
        )
      );
      expect(saved.warnings).toEqual([]);
      await activate(flowId);

      // Verdadero (tiene X): salta directo al bloque lejano → solo C.
      const yes = await mkContact();
      await tags.assignTag(org, yes, tagX);
      await start(flowId, yes, "lejos:si");
      // Falso: recorre 1 → 2 → far → A, B y C.
      const no = await mkContact();
      await start(flowId, no, "lejos:no");
      await drain(flowId);

      expect(await tagsOf(yes)).toEqual([tagC, tagX].sort());
      expect(await tagsOf(no)).toEqual([tagA, tagB, tagC].sort());
      expect((await runsOf(flowId)).every((r) => r.status === "completed")).toBe(true);
    });

    it("un ciclo con espera: «si no responde, recuérdale y vuelve a esperar», y confirmar lo corta", async () => {
      const flowId = await mkFlow();
      const saved = await canvas.saveGraph(
        org,
        flowId,
        payload(
          [
            trg(),
            step("new_w", "wait_reply", { timeoutMinutes: 60 }, 0),
            addTag("new_ok", tagA, -200),
            addTag("new_again", tagB, 200),
          ],
          [edge("trg", "new_w"), edge("new_w", "new_ok", "confirmed"), edge("new_w", "new_again", "timeout"), edge("new_again", "new_w")]
        )
      );
      expect(saved.warnings.map((w) => w.code)).toContain("cycle");
      const wait = idAtX(saved, 0);
      await activate(flowId);

      const contactId = await mkContact();
      await start(flowId, contactId, "ciclo:1");
      await drain(flowId);
      expect((await runsOf(flowId))[0]).toMatchObject({ status: "waiting", waitingFor: "reply", currentStepId: wait });

      // Vence el tiempo → «Sin respuesta» → etiqueta B → vuelve a esperar (otra tarea de timeout).
      await db
        .update(schema.automationQueue)
        .set({ scheduledFor: new Date(Date.now() - 1000) })
        .where(and(eq(schema.automationQueue.flowId, flowId), eq(schema.automationQueue.status, "pending")));
      await drain(flowId);
      expect(await tagsOf(contactId)).toEqual([tagB]);
      const [afterLoop] = await runsOf(flowId);
      expect(afterLoop).toMatchObject({ status: "waiting", waitingFor: "reply", currentStepId: wait });
      expect((await queueOf(flowId)).filter((r) => r.status === "pending" && r.dedupeKey?.startsWith("reply_timeout:"))).toHaveLength(1);

      // Ahora sí responde: «Confirma» → etiqueta A y el flujo termina.
      expect(await reply.onInboundReply({ organizationId: org, contactId, text: "sí" })).toBe(1);
      await drain(flowId);
      expect(await tagsOf(contactId)).toEqual([tagA, tagB].sort());
      expect((await runsOf(flowId))[0]).toMatchObject({ status: "completed" });
    });

    it("sin salida conectada el flujo termina (no «cae» a la lista): el segundo bloque no corre", async () => {
      const flowId = await mkFlow();
      await canvas.saveGraph(org, flowId, payload([trg(), addTag("new_a", tagA, 0), addTag("new_b", tagB, 100)], [edge("trg", "new_a")]));
      await activate(flowId);
      const contactId = await mkContact();
      await start(flowId, contactId, "sin-salida:1");
      await drain(flowId);
      expect(await tagsOf(contactId)).toEqual([tagA]);
      expect((await runsOf(flowId))[0]).toMatchObject({ status: "completed" });
    });

    it("sin entrada (el disparador sin conectar) no arranca nada", async () => {
      const flowId = await mkFlow();
      await canvas.saveGraph(org, flowId, payload([trg(), addTag("new_a", tagA, 0)], []));
      const contactId = await mkContact();
      expect(await start(flowId, contactId, "sin-entrada:1")).toBe(false);
      expect(await runsOf(flowId)).toHaveLength(0);
    });

    it("las posiciones son solo visuales: cambiarlas no cambia la ejecución", async () => {
      const flowId = await mkFlow();
      const saved = await canvas.saveGraph(org, flowId, payload([trg(), addTag("new_a", tagA, 0), addTag("new_b", tagB, 100)], [edge("trg", "new_b"), edge("new_b", "new_a")]));
      // «b» está a la derecha y «a» a la izquierda; la entrada es «b» → «a». En una lista, «a» iría primero.
      await activate(flowId);
      const contactId = await mkContact();
      await start(flowId, contactId, "pos:1");
      await drain(flowId);
      const order = (await queueOf(flowId)).map((q) => q.stepId);
      expect(order).toEqual([idAtX(saved, 100), idAtX(saved, 0)]);
    });
  });

  describe("sincronía con el Modo Simple", () => {
    it("syncEdges y ensureEdges son inertes en un flujo de lienzo", async () => {
      const flowId = await mkFlow();
      await canvas.saveGraph(org, flowId, payload([trg(), addTag("new_a", tagA, 0), addTag("new_b", tagB, 100)], [edge("trg", "new_a")])); // a y b SIN conectar
      expect(await graph.syncEdges(org, flowId)).toBe(0);
      expect(await graph.ensureEdges(org, flowId)).toBe(0);
      expect(await edgesOf(flowId)).toHaveLength(0);
    });

    it("la API de pasos de la lista se bloquea en un flujo de lienzo; renombrar y encender siguen", async () => {
      const flowId = await mkFlow();
      const saved = await canvas.saveGraph(org, flowId, payload([trg(), addTag("new_a", tagA, 0)], [edge("trg", "new_a")]));
      const id = saved.nodes[0]!.id;
      const input = schemas.stepCreateSchema.parse({ stepType: "add_tag", config: { tagId: tagA } });
      await expect(flows.createStep(org, flowId, input)).rejects.toMatchObject({ code: "canvas_mode", status: 409 });
      await expect(flows.updateStep(org, flowId, id, { positionY: 5 })).rejects.toMatchObject({ code: "canvas_mode" });
      await expect(flows.deleteStep(org, flowId, id)).rejects.toMatchObject({ code: "canvas_mode" });
      expect(await stepsOf(flowId)).toHaveLength(1);
      await expect(flows.updateFlow(org, flowId, { name: `Otro nombre ${uid}`, active: true })).resolves.toMatchObject({ active: true, editorMode: "canvas" });
    });

    it("Simple → Visual: las aristas compiladas pasan tal cual, la entrada es el primer paso y se acomodan por niveles", async () => {
      const { flowId, steps } = await mkSimple([
        { stepType: "condition", config: { rule: { type: "tag_has", tagId: tagX }, ifTrue: "continue", ifFalse: "skip_next" } },
        { stepType: "add_tag", config: { tagId: tagA } },
        { stepType: "add_tag", config: { tagId: tagB } },
      ]);
      const before = edgeSet(await edgesOf(flowId));
      const res = await canvas.setEditorMode(org, flowId, "canvas");
      expect(res.editorMode).toBe("canvas");
      expect(res.entryStepId).toBe(steps[0]!.id);
      expect(edgeSet(await edgesOf(flowId))).toEqual(before);
      // Posiciones por niveles: el siguiente y el «saltado» comparten fila, bajo la condición.
      const pos = Object.fromEntries((await stepsOf(flowId)).map((s) => [s.id, { x: s.positionX, y: s.positionY }]));
      expect(pos[steps[1]!.id]!.y).toBe(pos[steps[2]!.id]!.y);
      expect(pos[steps[0]!.id]!.y).toBeLessThan(pos[steps[1]!.id]!.y);
      expect((await flowRow(flowId)).viewport).toEqual({ trigger: { x: 0, y: 0 } });
      // Idempotente.
      expect((await canvas.setEditorMode(org, flowId, "canvas")).editorMode).toBe("canvas");
    });

    it("IDA Y VUELTA sin tocar nada: Simple → Visual → Simple deja los pasos, sus acciones y las aristas igual", async () => {
      const specs = [
        { stepType: "condition", config: { rule: { type: "tag_has", tagId: tagX }, ifTrue: "skip_next", ifFalse: "stop" } },
        { stepType: "add_tag", config: { tagId: tagA } },
        { stepType: "add_tag", config: { tagId: tagB } },
        { stepType: "add_tag", config: { tagId: tagC } },
      ];
      const { flowId, steps } = await mkSimple(specs);
      const edgesBefore = edgeSet(await edgesOf(flowId));

      await canvas.setEditorMode(org, flowId, "canvas");
      const back = await canvas.setEditorMode(org, flowId, "simple");
      expect(back.editorMode).toBe("simple");

      const after = await stepsOf(flowId);
      // El orden por posición es el de antes (una columna) y las acciones de las ramas se conservan.
      const ordered = [...after].sort((a, b) => a.positionY - b.positionY || a.positionX - b.positionX);
      expect(ordered.map((s) => s.id)).toEqual(steps.map((s) => s.id));
      expect(ordered.every((s) => s.positionX === 0)).toBe(true);
      expect(ordered[0]!.config).toMatchObject({ ifTrue: "skip_next", ifFalse: "stop" });
      expect(edgeSet(await edgesOf(flowId))).toEqual(edgesBefore);
      expect(await flowRow(flowId)).toMatchObject({ editorMode: "simple", entryStepId: null, viewport: null });
    });

    it("Visual → Simple con un grafo que la lista no puede mostrar: 409 y NO se toca nada", async () => {
      const flowId = await mkFlow();
      const saved = await canvas.saveGraph(
        org,
        flowId,
        payload(
          [trg(), step("new_c", "condition", { rule: { type: "tag_has", tagId: tagX } }, 0), addTag("new_1", tagA, -300), addTag("new_2", tagB, -150), addTag("new_far", tagC, 300)],
          [edge("trg", "new_c"), edge("new_c", "new_far", "true"), edge("new_c", "new_1", "false"), edge("new_1", "new_2"), edge("new_2", "new_far")]
        )
      );
      const edgesBefore = edgeSet(await edgesOf(flowId));
      const posBefore = (await stepsOf(flowId)).map((s) => `${s.id}:${s.positionX},${s.positionY}`).sort();
      await expect(canvas.setEditorMode(org, flowId, "simple")).rejects.toMatchObject({ code: "graph_not_linear", status: 409 });
      expect((await flowRow(flowId)).editorMode).toBe("canvas");
      expect(edgeSet(await edgesOf(flowId))).toEqual(edgesBefore);
      expect((await stepsOf(flowId)).map((s) => `${s.id}:${s.positionX},${s.positionY}`).sort()).toEqual(posBefore);
      expect(saved.entryStepId).toBeTruthy();
    });

    it("un grafo simple dibujado en el lienzo SÍ vuelve al Modo Simple, y entonces la lista lo edita", async () => {
      const flowId = await mkFlow();
      await canvas.saveGraph(
        org,
        flowId,
        payload([trg(), addTag("new_b", tagB, 300), addTag("new_a", tagA, -300)], [edge("trg", "new_a"), edge("new_a", "new_b")])
      );
      await canvas.setEditorMode(org, flowId, "simple");
      const ordered = (await stepsOf(flowId)).sort((a, b) => a.positionY - b.positionY);
      expect(ordered.map((s) => (s.config as { tagId: string }).tagId)).toEqual([tagA, tagB]);
      // Y la API de la lista vuelve a funcionar.
      const input = schemas.stepCreateSchema.parse({ stepType: "add_tag", config: { tagId: tagC }, positionY: 200 });
      await expect(flows.createStep(org, flowId, input)).resolves.toMatchObject({ stepType: "add_tag" });
      expect(edgeSet(await edgesOf(flowId))).toHaveLength(2);
    });

    it("un flujo sin pasos cambia de modo sin problema, en los dos sentidos", async () => {
      const flowId = await mkFlow();
      expect((await canvas.setEditorMode(org, flowId, "canvas")).entryStepId).toBeNull();
      expect((await canvas.setEditorMode(org, flowId, "simple")).editorMode).toBe("simple");
    });
  });

  it("GET graph expone el modo, la cámara y el updatedAt con los que se guardará", async () => {
    const flowId = await mkFlow();
    const saved = await canvas.saveGraph(org, flowId, payload([trg(3, 4), addTag("new_a", tagA, 0)], [edge("trg", "new_a")], { viewport: { x: 5, y: 6, zoom: 2 } }));
    const g = await graph.getGraph(org, flowId);
    expect(g).toMatchObject({ editorMode: "canvas", viewport: { x: 5, y: 6, zoom: 2, trigger: { x: 3, y: 4 } }, entryStepId: saved.entryStepId });
    expect(g.updatedAt).toBe(saved.updatedAt);
  });
});
