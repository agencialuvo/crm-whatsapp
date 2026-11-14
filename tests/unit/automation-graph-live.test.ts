import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Fase 3 contra PostgreSQL REAL (`pnpm test:db`): aristas sincronizadas con la lista de pasos, ciclo de vida de
 * la ejecución (`automation_run`), ramas `true`/`false` y `late` con aristas reales, idempotencia por `run`,
 * flujos anteriores a las aristas (curación perezosa), borrado de pasos, tareas caídas, el grafo expuesto y —lo
 * delicado— la carrera «cancelar la ejecución» contra «avanzar la tarea en vuelo». Nada toca la API de WhatsApp.
 * Crea y borra lo suyo.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("grafo y ejecuciones contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let flows: typeof import("@/server/automation/flows");
  let graph: typeof import("@/server/automation/graph");
  let worker: typeof import("@/server/automation/worker");
  let engine: typeof import("@/server/automation/engine");
  let queue: typeof import("@/server/automation/queue");
  let store: typeof import("@/server/automation/trigger-store");
  let tags: typeof import("@/server/tags/store");
  let schemas: typeof import("@/lib/automation-schemas");

  const uid = Date.now().toString(36);
  let org = "";
  let otherOrg = "";
  let contactId = "";
  let tagA = "";
  let tagB = "";
  const created = { flows: [] as string[], tags: [] as string[], bookings: [] as string[] };
  let seq = 0;

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    ({ eq, and, inArray } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    flows = await import("@/server/automation/flows");
    graph = await import("@/server/automation/graph");
    worker = await import("@/server/automation/worker");
    engine = await import("@/server/automation/engine");
    queue = await import("@/server/automation/queue");
    store = await import("@/server/automation/trigger-store");
    tags = await import("@/server/tags/store");
    schemas = await import("@/lib/automation-schemas");

    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    expect(orgs.length, "hacen falta dos organizaciones").toBeGreaterThanOrEqual(2);
    org = orgs[0]!.id;
    otherOrg = orgs[1]!.id;

    contactId = `ct_g${uid}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Cliente Grafo", waIdentity: `gr-${uid}`, phone: "5215557770" });
    const a = await tags.createTag(org, { name: `G-A ${uid}`, color: "blue" });
    const b = await tags.createTag(org, { name: `G-B ${uid}`, color: "green" });
    tagA = a.id;
    tagB = b.id;
    created.tags.push(a.id, b.id);
  });

  afterAll(async () => {
    if (!db) return;
    if (created.flows.length) await db.delete(schema.automationFlow).where(inArray(schema.automationFlow.id, created.flows));
    if (created.bookings.length) await db.delete(schema.booking).where(inArray(schema.booking.id, created.bookings));
    if (created.tags.length) await db.delete(schema.tag).where(inArray(schema.tag.id, created.tags));
    await db.delete(schema.contact).where(eq(schema.contact.id, contactId));
  });

  type StepSpec = { stepType: string; config: Record<string, unknown> };
  const ADD_A: StepSpec = { stepType: "add_tag", config: { tagId: "" } }; // el id real se rellena en `mk`
  const mkSteps = (specs: StepSpec[]) =>
    specs.map((x) => (x.stepType === "add_tag" || x.stepType === "remove_tag" ? { ...x, config: { ...x.config, tagId: x.config.tagId || tagA } } : x));

  /** Un flujo con los pasos dados, creados por el servicio real (así se compilan las aristas). */
  async function makeFlow(triggerType: string, specs: StepSpec[], active = true) {
    const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `Grafo ${uid}${seq++}`, triggerType }));
    created.flows.push(flow.id);
    const steps = [];
    for (const [i, x] of mkSteps(specs).entries()) {
      steps.push(await flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ ...x, positionY: i * 100 })));
    }
    if (active && specs.length) await flows.updateFlow(org, flow.id, { active: true });
    return { flowId: flow.id, steps };
  }

  const start = (flowId: string, key: string, over: Record<string, unknown> = {}) =>
    store.dbTriggerStore.enqueueFirstStep({ organizationId: org, flowId, contactId, scheduledFor: new Date(), dedupeKey: key, ...over });

  const runsOf = (flowId: string) => db.select().from(schema.automationRun).where(eq(schema.automationRun.flowId, flowId));
  const queueOf = (flowId: string) =>
    db.select().from(schema.automationQueue).where(eq(schema.automationQueue.flowId, flowId)).orderBy(schema.automationQueue.createdAt);
  const edgesOf = (flowId: string) => db.select().from(schema.automationEdge).where(eq(schema.automationEdge.flowId, flowId));
  const brief = (es: { sourceStepId: string; targetStepId: string; sourceHandle: string }[], ids: string[]) =>
    es.map((x) => `${ids.indexOf(x.sourceStepId)}-${x.sourceHandle}->${ids.indexOf(x.targetStepId)}`).sort();

  function deps() {
    const d: import("@/server/automation/engine").Deps = {
      ...worker.defaultDeps(),
      sendText: vi.fn(async () => ({ messageId: "msg_fake" })),
      sendTemplate: vi.fn(async () => ({ messageId: "msg_fake" })),
      waMessageIdOf: async () => null,
    };
    return d;
  }

  /** Procesa la cola del flujo, tarea por tarea, hasta que no queda nada pendiente. */
  async function drain(flowId: string) {
    const d = deps();
    for (let guard = 0; guard < 15; guard++) {
      const pending = (await queueOf(flowId)).find((r) => r.status === "pending");
      if (!pending) break;
      await engine.processRow(pending as never, d);
    }
  }

  describe("aristas sincronizadas con la lista", () => {
    it("crear, editar, mover y borrar pasos recompila las aristas en la misma operación", async () => {
      const { flowId, steps } = await makeFlow("manual", [ADD_A, ADD_A, ADD_A]);
      const ids = steps.map((x) => x.id);
      expect(brief(await edgesOf(flowId), ids)).toEqual(["0-default->1", "1-default->2"]);

      // Un paso nuevo al final: se encadena.
      const fourth = await flows.createStep(org, flowId, schemas.stepCreateSchema.parse({ ...mkSteps([ADD_A])[0], positionY: 300 }));
      expect(brief(await edgesOf(flowId), [...ids, fourth.id])).toEqual(["0-default->1", "1-default->2", "2-default->3"]);

      // Mover el último arriba del todo reordena la cadena.
      await flows.updateStep(org, flowId, fourth.id, { positionY: -100 });
      expect(brief(await edgesOf(flowId), [fourth.id, ...ids])).toEqual(["0-default->1", "1-default->2", "2-default->3"]);

      // Borrar uno del medio une a sus vecinos; las aristas del borrado se fueron por la cascada.
      await flows.deleteStep(org, flowId, ids[1]!);
      const rest = [fourth.id, ids[0]!, ids[2]!];
      expect(brief(await edgesOf(flowId), rest)).toEqual(["0-default->1", "1-default->2"]);
    });

    it("editar una condición cambia sus aristas true/false; no hay dos aristas por (paso, asa)", async () => {
      const { flowId, steps } = await makeFlow("manual", [
        { stepType: "condition", config: { rule: { type: "tag_has", tagId: tagA } } },
        ADD_A,
        ADD_A,
      ]);
      const ids = steps.map((x) => x.id);
      // Por defecto: verdadero sigue, falso termina.
      expect(brief((await edgesOf(flowId)).filter((x) => x.sourceStepId === ids[0]), ids)).toEqual(["0-true->1"]);

      await flows.updateStep(org, flowId, ids[0]!, {
        config: { rule: { type: "tag_has", tagId: tagA }, ifTrue: "skip_next", ifFalse: "continue" },
      });
      expect(brief((await edgesOf(flowId)).filter((x) => x.sourceStepId === ids[0]), ids)).toEqual(["0-false->1", "0-true->2"]);

      const keys = (await edgesOf(flowId)).map((x) => `${x.sourceStepId}:${x.sourceHandle}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("el índice único impide dos aristas por el mismo asa", async () => {
      const { flowId, steps } = await makeFlow("manual", [ADD_A, ADD_A, ADD_A]);
      await expect(
        db.insert(schema.automationEdge).values({
          id: `edg_dup${uid}`,
          organizationId: org,
          flowId,
          sourceStepId: steps[0]!.id,
          targetStepId: steps[2]!.id,
          sourceHandle: "default",
        })
      ).rejects.toThrow();
    });
  });

  describe("GET graph", () => {
    it("devuelve nodos en orden, aristas y el paso de entrada; otra organización no lo ve", async () => {
      const { flowId, steps } = await makeFlow("manual", [ADD_A, { stepType: "delay", config: { amount: 1, unit: "days" } }]);
      const g = await graph.getGraph(org, flowId);
      expect(g.nodes.map((n) => n.id)).toEqual(steps.map((x) => x.id));
      expect(g.nodes[0]).toMatchObject({ type: "add_tag", position: { x: 0, y: 0 } });
      expect(g.edges).toHaveLength(1);
      expect(g.edges[0]).toMatchObject({ source: steps[0]!.id, target: steps[1]!.id, sourceHandle: "default" });
      expect(g.entryStepId).toBe(steps[0]!.id);
      // El servicio de flujos es el que exige que el flujo sea de la organización (404).
      await expect(flows.getFlow(otherOrg, flowId)).rejects.toMatchObject({ status: 404 });
    });

    it("cura un flujo anterior a las aristas (lectura perezosa) y la ejecución lo recorre", async () => {
      // Un flujo «viejo»: pasos insertados a mano, sin pasar por el servicio → sin aristas.
      const flowId = `aut_old${uid}`;
      await db.insert(schema.automationFlow).values({ id: flowId, organizationId: org, name: `Viejo ${uid}`, triggerType: "manual", active: true });
      created.flows.push(flowId);
      const ids = [`stp_o1${uid}`, `stp_o2${uid}`];
      await db.insert(schema.automationStep).values([
        { id: ids[0]!, organizationId: org, flowId, stepType: "add_tag", config: { tagId: tagA }, positionY: 0 },
        { id: ids[1]!, organizationId: org, flowId, stepType: "add_tag", config: { tagId: tagB }, positionY: 100 },
      ]);
      expect(await edgesOf(flowId)).toHaveLength(0);

      // Arrancar la ejecución cura el flujo…
      expect(await start(flowId, `viejo:${uid}`)).toBe(true);
      expect(brief(await edgesOf(flowId), ids)).toEqual(["0-default->1"]);

      // …y aun sin aristas guardadas (respaldo en memoria) el paso termina bien: las borramos y corremos.
      await db.delete(schema.automationEdge).where(eq(schema.automationEdge.flowId, flowId));
      await drain(flowId);
      expect((await runsOf(flowId))[0]).toMatchObject({ status: "completed" });
      expect((await tags.tagIdsOfContact(org, contactId)).sort()).toEqual([tagA, tagB].sort());
      await tags.unassignTag(org, contactId, tagA);
      await tags.unassignTag(org, contactId, tagB);
    });
  });

  describe("ciclo de vida de la ejecución", () => {
    it("arranca «running», espera «waiting/time» ante un paso futuro y termina «completed»", async () => {
      const { flowId, steps } = await makeFlow("manual", [ADD_A, { stepType: "delay", config: { amount: 1, unit: "days" } }, { stepType: "remove_tag", config: { tagId: tagA } }]);
      expect(await start(flowId, "ciclo:1")).toBe(true);

      let [run] = await runsOf(flowId);
      expect(run).toMatchObject({ status: "running", waitingFor: null, currentStepId: steps[0]!.id, endedAt: null });
      expect(run!.context).toEqual({});
      const [first] = await queueOf(flowId);
      expect(first!.runId).toBe(run!.id);

      const d = deps();
      await engine.processRow(first as never, d); // add_tag → delay (inmediato)
      const second = (await queueOf(flowId)).find((r) => r.stepId === steps[1]!.id)!;
      expect(second.runId).toBe(run!.id);
      expect((await runsOf(flowId))[0]).toMatchObject({ status: "running", currentStepId: steps[1]!.id });

      await engine.processRow(second as never, d); // el delay deja el siguiente a un día
      [run] = await runsOf(flowId);
      expect(run).toMatchObject({ status: "waiting", waitingFor: "time", currentStepId: steps[2]!.id });

      // Vence el día: el último paso corre y la ejecución se completa (sin arista de salida).
      const third = (await queueOf(flowId)).find((r) => r.stepId === steps[2]!.id)!;
      await engine.processRow(third as never, d);
      [run] = await runsOf(flowId);
      expect(run).toMatchObject({ status: "completed", waitingFor: null });
      expect(run!.endedAt).not.toBeNull();
    });

    it("una tarea que falla definitivamente deja la ejecución «failed»", async () => {
      const gone = await tags.createTag(org, { name: `G-gone ${uid}`, color: "red" });
      const { flowId } = await makeFlow("manual", [{ stepType: "add_tag", config: { tagId: gone.id } }, ADD_A]);
      await tags.deleteTag(org, gone.id); // la etiqueta del paso ya no existe
      await start(flowId, "falla:1");
      await drain(flowId);
      expect((await runsOf(flowId))[0]).toMatchObject({ status: "failed" });
      expect((await runsOf(flowId))[0]!.endedAt).not.toBeNull();
      expect((await queueOf(flowId)).map((r) => r.status)).toEqual(["failed"]);
    });

    it("una tarea caída sin intentos cierra su ejecución como «failed» (failExhausted)", async () => {
      const { flowId } = await makeFlow("manual", [ADD_A, ADD_A]);
      await start(flowId, "caida:1");
      const [row] = await queueOf(flowId);
      await db
        .update(schema.automationQueue)
        .set({ status: "processing", attempts: 5, maxAttempts: 5, lockedAt: new Date(Date.now() - 3_600_000) })
        .where(eq(schema.automationQueue.id, row!.id));
      expect(await queue.failExhausted(new Date())).toBeGreaterThanOrEqual(1);
      expect((await runsOf(flowId))[0]).toMatchObject({ status: "failed" });
    });
  });

  describe("ramas reales", () => {
    const condFlow = (config: Record<string, unknown>) =>
      makeFlow("manual", [
        { stepType: "condition", config: { rule: { type: "tag_has", tagId: tagA }, ...config } },
        { stepType: "add_tag", config: { tagId: tagB } }, // 1.º tras la condición
        { stepType: "remove_tag", config: { tagId: tagB } }, // 2.º
      ]);

    it("la arista del resultado manda: verdadero→siguiente, falso→el de después (ifFalse: skip_next)", async () => {
      const { flowId, steps } = await condFlow({ ifTrue: "continue", ifFalse: "skip_next" });
      const ids = steps.map((x) => x.id);

      // Falso (no tiene A): salta al 2.º, que quita B (no hace nada) → B nunca se agrega.
      await start(flowId, "rama:false");
      await drain(flowId);
      let visited = (await queueOf(flowId)).map((r) => ids.indexOf(r.stepId));
      expect(visited).toEqual([0, 2]);
      expect(await tags.tagIdsOfContact(org, contactId)).not.toContain(tagB);
      expect((await runsOf(flowId))[0]).toMatchObject({ status: "completed" });

      // Verdadero (tiene A): sigue por el 1.º (agrega B) y luego el 2.º (lo quita).
      await tags.assignTag(org, contactId, tagA);
      await db.delete(schema.automationRun).where(eq(schema.automationRun.flowId, flowId)); // limpia (cascada a la cola)
      await start(flowId, "rama:true");
      await drain(flowId);
      visited = (await queueOf(flowId)).map((r) => ids.indexOf(r.stepId));
      expect(visited).toEqual([0, 1, 2]);
      await tags.unassignTag(org, contactId, tagA);
    });

    it("sin arista para el asa, la ejecución termina (ifFalse: stop) y queda «completed»", async () => {
      const { flowId } = await condFlow({}); // falso → termina
      await start(flowId, "rama:stop");
      await drain(flowId);
      expect((await queueOf(flowId)).length).toBe(1);
      expect((await runsOf(flowId))[0]).toMatchObject({ status: "completed" });
    });

    it("el log de la condición guarda el asa por la que salió", async () => {
      const { flowId } = await condFlow({});
      await start(flowId, "rama:log");
      await drain(flowId);
      const logs = await db.select().from(schema.automationExecutionLog).where(eq(schema.automationExecutionLog.flowId, flowId));
      expect(logs[0]!.metadata).toMatchObject({ result: false, handle: "false" });
    });
  });

  describe("idempotencia por ejecución", () => {
    it("el mismo disparo una o varias veces crea UN run y UNA tarea (también en paralelo)", async () => {
      const { flowId } = await makeFlow("manual", [ADD_A, ADD_A]);
      const results = await Promise.all(Array.from({ length: 6 }, () => start(flowId, "idem:1")));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await runsOf(flowId)).toHaveLength(1);
      expect(await queueOf(flowId)).toHaveLength(1);
      // Otra llave sí arranca otra ejecución.
      expect(await start(flowId, "idem:2")).toBe(true);
      expect(await runsOf(flowId)).toHaveLength(2);
    });

    it("si la tarea inicial choca con una llave de antes de los run, no queda un run huérfano", async () => {
      const { flowId, steps } = await makeFlow("manual", [ADD_A, ADD_A]);
      await db.insert(schema.automationQueue).values({
        id: `que_old${uid}`,
        organizationId: org,
        flowId,
        contactId,
        stepId: steps[0]!.id,
        scheduledFor: new Date(),
        dedupeKey: "vieja:1",
      });
      expect(await start(flowId, "vieja:1")).toBe(false);
      expect(await runsOf(flowId)).toHaveLength(0);
    });

    it("un flujo sin pasos no arranca nada", async () => {
      const { flowId } = await makeFlow("manual", [], false);
      expect(await start(flowId, "vacio:1")).toBe(false);
      expect(await runsOf(flowId)).toHaveLength(0);
    });

    it("el contexto guarda la cita y la tarea la lleva", async () => {
      const bookingId = `bk_g${uid}ctx`;
      await db.insert(schema.booking).values({
        id: bookingId,
        organizationId: org,
        kind: "session",
        status: "agendada",
        source: "manual",
        contactId,
        scheduledAt: new Date(Date.now() + 5 * 86_400_000),
        durationMinutes: 30,
        connector: "enlace-fijo",
      });
      created.bookings.push(bookingId);
      const { flowId } = await makeFlow("booking_created", [ADD_A, ADD_A]);
      await start(flowId, "ctx:1", { bookingId });
      expect((await runsOf(flowId))[0]!.context).toEqual({ bookingId });
      expect((await queueOf(flowId))[0]!.bookingId).toBe(bookingId);
    });
  });

  describe("borrar un paso", () => {
    it("cancela las ejecuciones que estaban en él (no quedan «en curso» para siempre)", async () => {
      const { flowId, steps } = await makeFlow("manual", [ADD_A, { stepType: "delay", config: { amount: 1, unit: "days" } }, ADD_A]);
      await start(flowId, "borra:1");
      const d = deps();
      await engine.processRow((await queueOf(flowId))[0] as never, d); // → delay
      await engine.processRow((await queueOf(flowId)).find((r) => r.stepId === steps[1]!.id) as never, d); // → 3.º, a un día
      expect((await runsOf(flowId))[0]).toMatchObject({ status: "waiting", currentStepId: steps[2]!.id });

      await flows.deleteStep(org, flowId, steps[2]!.id);
      const [run] = await runsOf(flowId);
      expect(run).toMatchObject({ status: "cancelled" });
      expect(run!.endedAt).not.toBeNull();
      expect((await queueOf(flowId)).filter((r) => r.status === "pending")).toHaveLength(0);
    });
  });

  describe("cancelar vs avanzar (carreras)", () => {
    async function bookingFlow(n: number) {
      const bookingId = `bk_g${uid}r${n}`;
      await db.insert(schema.booking).values({
        id: bookingId,
        organizationId: org,
        kind: "session",
        status: "agendada",
        source: "manual",
        contactId,
        scheduledAt: new Date(Date.now() + (10 + n) * 86_400_000),
        durationMinutes: 30,
        connector: "enlace-fijo",
      });
      created.bookings.push(bookingId);
      const { flowId, steps } = await makeFlow("booking_created", [ADD_A, ADD_A, ADD_A]);
      await start(flowId, `carrera:${n}`, { bookingId });
      return { bookingId, flowId, steps };
    }

    it("cancelar la cita cancela la ejecución y sus tareas pendientes (con y sin tarea en vuelo)", async () => {
      const { bookingId, flowId } = await bookingFlow(0);
      expect(await store.dbTriggerStore.cancelPendingForBooking(org, bookingId, "booking_cancelled")).toBe(1);
      expect((await runsOf(flowId))[0]).toMatchObject({ status: "cancelled" });
      expect((await queueOf(flowId))[0]).toMatchObject({ status: "cancelled", error: "booking_cancelled" });
    });

    it("una tarea YA TOMADA cuya ejecución se canceló no ejecuta su paso: se cancela sola", async () => {
      const { bookingId, flowId } = await bookingFlow(1);
      const [row] = await queueOf(flowId);
      await db.update(schema.automationQueue).set({ status: "processing", attempts: 1 }).where(eq(schema.automationQueue.id, row!.id));
      await store.dbTriggerStore.cancelPendingForBooking(org, bookingId, "booking_rescheduled");
      expect((await runsOf(flowId))[0]).toMatchObject({ status: "cancelled" }); // la tarea en vuelo también cuenta (D8)

      const [taken] = await queueOf(flowId);
      const d = deps();
      const applyTag = vi.spyOn(d, "applyTag");
      expect(await engine.processRow({ ...taken, status: "processing" } as never, d)).toBe("cancelled");
      expect(applyTag).not.toHaveBeenCalled();
      expect((await queueOf(flowId))[0]).toMatchObject({ status: "cancelled", error: "run_cancelled" });
    });

    it("cancelar y avanzar a la vez: nunca queda una tarea pendiente de una ejecución cancelada", async () => {
      // Se repite para exercitar los dos órdenes posibles de llegada.
      for (let i = 0; i < 12; i++) {
        const { bookingId, flowId } = await bookingFlow(10 + i);
        const [row] = await queueOf(flowId);
        await db.update(schema.automationQueue).set({ status: "processing", attempts: 1 }).where(eq(schema.automationQueue.id, row!.id));
        const [claimed] = await db.select().from(schema.automationQueue).where(eq(schema.automationQueue.id, row!.id));

        await Promise.all([
          queue.completeAndAdvance(claimed as never, new Date()),
          store.dbTriggerStore.cancelPendingForBooking(org, bookingId, "booking_cancelled"),
        ]);

        const [run] = await runsOf(flowId);
        expect(run!.status, `ronda ${i}`).toBe("cancelled");
        const pending = (await queueOf(flowId)).filter((r) => r.status === "pending");
        expect(pending, `ronda ${i}: tareas pendientes de un run cancelado`).toHaveLength(0);
      }
    });

    it("dos avances de la misma tarea no encolan dos pasos", async () => {
      const { flowId } = await bookingFlow(30);
      const [row] = await queueOf(flowId);
      await db.update(schema.automationQueue).set({ status: "processing", attempts: 1 }).where(eq(schema.automationQueue.id, row!.id));
      const [claimed] = await db.select().from(schema.automationQueue).where(eq(schema.automationQueue.id, row!.id));
      const results = await Promise.all([
        queue.completeAndAdvance(claimed as never, new Date()),
        queue.completeAndAdvance(claimed as never, new Date()),
      ]);
      // Solo uno avanza: el otro ve la tarea ya cerrada bajo el candado y no encola nada.
      expect(results.filter(Boolean)).toHaveLength(1);
      const next = (await queueOf(flowId)).filter((r) => r.id !== row!.id);
      expect(next).toHaveLength(1);
    });

    it("una tarea cancelada no avanza aunque su proceso termine después", async () => {
      const { flowId } = await bookingFlow(31);
      const [row] = await queueOf(flowId);
      await db.update(schema.automationQueue).set({ status: "cancelled" }).where(eq(schema.automationQueue.id, row!.id));
      expect(await queue.completeAndAdvance(row as never, new Date())).toBeNull();
      expect(await queueOf(flowId)).toHaveLength(1);
    });
  });

  it("aislamiento: la ejecución, las aristas y el estado de una organización no se ven desde otra", async () => {
    const { flowId } = await makeFlow("manual", [ADD_A, ADD_A]);
    await start(flowId, "aisla:1");
    const [run] = await runsOf(flowId);
    expect(await queue.runStatus(otherOrg, run!.id)).toBeNull();
    expect(await queue.runStatus(org, run!.id)).toBe("running");
    const strangers = await db
      .select()
      .from(schema.automationEdge)
      .where(and(eq(schema.automationEdge.flowId, flowId), eq(schema.automationEdge.organizationId, otherOrg)));
    expect(strangers).toHaveLength(0);
  });
});
