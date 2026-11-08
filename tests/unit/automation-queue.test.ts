import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Motor de automatizaciones contra PostgreSQL REAL: el bloqueo atómico de la cola, el rescate de
 * tomas caídas, la idempotencia del log y un flujo recorrido de punta a punta.
 *
 * Necesita una base con las migraciones aplicadas, así que NO corre con `pnpm test`: se enciende con
 *   RUN_DB_TESTS=1 pnpm vitest run tests/unit/automation-queue.test.ts
 * (toma `DATABASE_URL` del entorno o del `.env`). Crea sus propios datos y los borra al terminar.
 * Las tareas vencidas de OTRAS organizaciones que existan en esa base no se tocan, pero esta suite
 * asume que no hay tareas vencidas ajenas en la organización que elige (la primera).
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const HOUR = 3_600_000;

describe.skipIf(!live)("automation_queue contra Postgres", () => {
  let orgId = "";
  let contactId = "";
  const flowIds: string[] = [];
  let db: Awaited<ReturnType<typeof import("@/lib/db")["getDb"]>>;
  let schema: typeof import("@/lib/db")["schema"];
  let queue: typeof import("@/server/automation/queue");
  let worker: typeof import("@/server/automation/worker");
  let eq: typeof import("drizzle-orm")["eq"];
  let inArray: typeof import("drizzle-orm")["inArray"];

  beforeAll(async () => {
    ({ eq, inArray } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    queue = await import("@/server/automation/queue");
    worker = await import("@/server/automation/worker");
    const [org] = await db.select({ id: schema.organization.id }).from(schema.organization).limit(1);
    orgId = org!.id;
    const [ct] = await db
      .select({ id: schema.contact.id })
      .from(schema.contact)
      .where(eq(schema.contact.organizationId, orgId))
      .limit(1);
    contactId = ct!.id;
  });

  afterAll(async () => {
    if (flowIds.length) {
      // El borrado en cascada desde el flujo limpia pasos, cola y log.
      await db.delete(schema.automationFlow).where(inArray(schema.automationFlow.id, flowIds));
    }
  });

  let seq = 0;
  async function makeFlow(configs: { stepType: "send_whatsapp" | "delay"; config: object }[], active = true) {
    const n = `${Date.now().toString(36)}${seq++}`;
    const flowId = `aut_t${n}`;
    flowIds.push(flowId);
    await db.insert(schema.automationFlow).values({ id: flowId, organizationId: orgId, name: "t", triggerType: "manual", active });
    const stepIds: string[] = [];
    for (const [i, c] of configs.entries()) {
      const id = `stp_t${n}_${i}`;
      stepIds.push(id);
      await db.insert(schema.automationStep).values({
        id,
        organizationId: orgId,
        flowId,
        stepType: c.stepType,
        config: c.config,
        positionY: i * 100,
      });
    }
    return { flowId, stepIds };
  }

  async function enqueue(flowId: string, stepId: string, over: Partial<typeof schema.automationQueue.$inferInsert> = {}) {
    const id = `que_t${Date.now().toString(36)}${seq++}`;
    await db.insert(schema.automationQueue).values({
      id,
      organizationId: orgId,
      flowId,
      contactId,
      stepId,
      scheduledFor: new Date(Date.now() - 1000),
      ...over,
    });
    return id;
  }

  const row = async (id: string) =>
    (await db.select().from(schema.automationQueue).where(eq(schema.automationQueue.id, id)))[0]!;

  it("dos workers en paralelo jamás toman la misma tarea", async () => {
    const { flowId, stepIds } = await makeFlow([{ stepType: "delay", config: { amount: 1, unit: "hours" } }]);
    const ids = await Promise.all(Array.from({ length: 12 }, () => enqueue(flowId, stepIds[0]!)));

    const [a, b] = await Promise.all([queue.claimDue(20), queue.claimDue(20)]);
    const mine = new Set(ids);
    const gotA = a.filter((r) => mine.has(r.id)).map((r) => r.id);
    const gotB = b.filter((r) => mine.has(r.id)).map((r) => r.id);

    expect(gotA.filter((id) => gotB.includes(id))).toEqual([]); // sin solapamiento
    expect(new Set([...gotA, ...gotB]).size).toBe(12); // y entre los dos, todas
    for (const id of ids) {
      const r = await row(id);
      expect(r.status).toBe("processing");
      expect(r.attempts).toBe(1);
      expect(r.lockedAt).toBeInstanceOf(Date);
    }
  });

  it("solo toma lo vencido y con intentos disponibles", async () => {
    const { flowId, stepIds } = await makeFlow([{ stepType: "delay", config: { amount: 1, unit: "hours" } }]);
    const s = stepIds[0]!;
    const due = await enqueue(flowId, s);
    const future = await enqueue(flowId, s, { scheduledFor: new Date(Date.now() + HOUR) });
    const exhausted = await enqueue(flowId, s, { attempts: 5, maxAttempts: 5 });
    const done = await enqueue(flowId, s, { status: "completed" });
    const freshLock = await enqueue(flowId, s, { status: "processing", lockedAt: new Date() });

    const got = (await queue.claimDue(50)).map((r) => r.id);
    expect(got).toContain(due);
    for (const id of [future, exhausted, done, freshLock]) expect(got).not.toContain(id);
    expect((await row(future)).status).toBe("pending");
    expect((await row(freshLock)).attempts).toBe(0); // la toma reciente de otro worker no se pisa
  });

  it("reclama la tarea cuyo worker se cayó (toma vencida) y cuenta el intento", async () => {
    const { flowId, stepIds } = await makeFlow([{ stepType: "delay", config: { amount: 1, unit: "hours" } }]);
    const id = await enqueue(flowId, stepIds[0]!, {
      status: "processing",
      lockedAt: new Date(Date.now() - queue.LOCK_TIMEOUT_MS - 60_000),
      attempts: 1,
    });
    const got = (await queue.claimDue(50)).map((r) => r.id);
    expect(got).toContain(id);
    expect((await row(id)).attempts).toBe(2);
  });

  it("cierra como fallida la tarea caída que ya gastó todos sus intentos", async () => {
    const { flowId, stepIds } = await makeFlow([{ stepType: "delay", config: { amount: 1, unit: "hours" } }]);
    const id = await enqueue(flowId, stepIds[0]!, {
      status: "processing",
      lockedAt: new Date(Date.now() - queue.LOCK_TIMEOUT_MS - 60_000),
      attempts: 5,
      maxAttempts: 5,
    });
    expect(await queue.claimDue(50)).not.toContainEqual(expect.objectContaining({ id }));
    await queue.failExhausted();
    const r = await row(id);
    expect(r.status).toBe("failed");
    expect(r.error).toBe("max_attempts_exceeded");
  });

  it("completar y encolar el siguiente paso es una sola operación, en el orden del lienzo", async () => {
    const { flowId, stepIds } = await makeFlow([
      { stepType: "delay", config: { amount: 1, unit: "hours" } },
      { stepType: "delay", config: { amount: 2, unit: "hours" } },
    ]);
    const id = await enqueue(flowId, stepIds[0]!, { status: "processing", attempts: 1 });
    const at = new Date(Date.now() + HOUR);
    const first = await row(id);
    const nextId = await queue.completeAndAdvance(first, at);
    expect(nextId).toBeTruthy();
    expect((await row(id)).status).toBe("completed");
    const next = await row(nextId!);
    expect(next).toMatchObject({ stepId: stepIds[1], status: "pending", contactId });
    expect(next.scheduledFor.getTime()).toBe(at.getTime());

    // El último paso no encola nada.
    expect(await queue.completeAndAdvance(next, at)).toBeNull();
  });

  it("un éxito repetido de la misma tarea queda registrado una sola vez (idempotencia)", async () => {
    const { flowId, stepIds } = await makeFlow([{ stepType: "delay", config: { amount: 1, unit: "hours" } }]);
    const queueId = await enqueue(flowId, stepIds[0]!);
    const entry = { organizationId: orgId, flowId, stepId: stepIds[0]!, contactId, queueId, status: "success" as const, metadata: { n: 1 } };
    await queue.writeLog(entry);
    await queue.writeLog({ ...entry, metadata: { n: 2 } });
    await queue.writeLog({ ...entry, status: "failed" as never }); // un fallo no choca con el índice del éxito
    const logs = await db.select().from(schema.automationExecutionLog).where(eq(schema.automationExecutionLog.queueId, queueId));
    expect(logs.filter((l) => l.status === "success")).toHaveLength(1);
    expect(await queue.hasSuccessLog(orgId, queueId)).toBe(true);
  });

  describe("tickAutomations de punta a punta (con envío simulado)", () => {
    const stubDeps = (over: Record<string, unknown> = {}, clock = () => new Date()) => {
      const sent: string[] = [];
      const deps = {
        ...worker.defaultDeps(),
        now: clock,
        loadTarget: async () => ({
          conversationId: "cv_stub",
          channel: "whatsapp",
          isTest: false,
          lastInboundAt: new Date(Date.now() - HOUR),
          contactName: "Ana",
        }),
        sendText: vi.fn(async (i: { text: string }) => (sent.push(i.text), { messageId: "msg_stub" })),
        sendTemplate: vi.fn(async () => ({ messageId: "msg_stub" })),
        waMessageIdOf: async () => "wamid.stub",
        ...over,
      } as ReturnType<typeof worker.defaultDeps>;
      return { deps, sent };
    };

    it("recorre mensaje → espera → mensaje, deja el historial con la foto del nodo y respeta la espera", async () => {
      const { flowId, stepIds } = await makeFlow([
        { stepType: "send_whatsapp", config: { name: "Hola", content: "Hola {{name}}" } },
        { stepType: "delay", config: { amount: 1, unit: "minutes" } },
        { stepType: "send_whatsapp", config: { name: "Seguimiento", content: "¿Todo bien, {{name}}?" } },
      ]);
      const first = await enqueue(flowId, stepIds[0]!);
      let t = Date.now();
      const { deps, sent } = stubDeps({}, () => new Date(t));

      expect(await worker.tickAutomations(new Date(t), deps)).toBeGreaterThanOrEqual(1); // mensaje
      expect(await worker.tickAutomations(new Date(t), deps)).toBeGreaterThanOrEqual(1); // espera
      expect(sent).toEqual(["Hola Ana"]);
      // El tercer paso aún no vence: queda una espera de 1 minuto.
      const queued = await db.select().from(schema.automationQueue).where(eq(schema.automationQueue.flowId, flowId));
      const third = queued.find((q) => q.stepId === stepIds[2])!;
      expect(third.status).toBe("pending");
      expect(third.scheduledFor.getTime()).toBeGreaterThan(t + 50_000);

      t += 2 * 60_000;
      await worker.tickAutomations(new Date(t), deps);
      expect(sent).toEqual(["Hola Ana", "¿Todo bien, Ana?"]);

      const after = await db.select().from(schema.automationQueue).where(eq(schema.automationQueue.flowId, flowId));
      expect(after.every((q) => q.status === "completed")).toBe(true);
      expect((await row(first)).status).toBe("completed");

      const logs = await db.select().from(schema.automationExecutionLog).where(eq(schema.automationExecutionLog.flowId, flowId));
      expect(logs).toHaveLength(3);
      const send = logs.find((l) => l.stepId === stepIds[0])!;
      expect(send.queueId).toBe(first);
      expect(send.metadata).toMatchObject({
        step: { stepType: "send_whatsapp", stepName: "Hola", config: { content: "Hola {{name}}" } },
        waMessageId: "wamid.stub",
        payload: { mode: "text", text: "Hola Ana" },
      });

      // El historial sobrevive aunque el paso se borre después.
      await db.delete(schema.automationStep).where(eq(schema.automationStep.id, stepIds[0]!));
      const kept = await db.select().from(schema.automationExecutionLog).where(eq(schema.automationExecutionLog.id, send.id));
      expect(kept[0]?.stepId).toBeNull();
      expect(kept[0]?.metadata).toMatchObject({ step: { stepName: "Hola" } });
    });

    it("fuera de las 24 h sin plantilla: la cola queda failed con out_of_window_requires_template y no se envía", async () => {
      const { flowId, stepIds } = await makeFlow([{ stepType: "send_whatsapp", config: { content: "Hola" } }]);
      const id = await enqueue(flowId, stepIds[0]!);
      const { deps, sent } = stubDeps({
        loadTarget: async () => ({ conversationId: "cv_stub", channel: "whatsapp", isTest: false, lastInboundAt: new Date(Date.now() - 30 * HOUR), contactName: "Ana" }),
      });
      await worker.tickAutomations(new Date(), deps);
      const r = await row(id);
      expect(r.status).toBe("failed");
      expect(r.error).toBe("out_of_window_requires_template");
      expect(sent).toEqual([]);
    });

    it("una caída de Meta reprograma con backoff y, al agotar los intentos, falla", async () => {
      const { flowId, stepIds } = await makeFlow([{ stepType: "send_whatsapp", config: { content: "Hola" } }]);
      const id = await enqueue(flowId, stepIds[0]!, { maxAttempts: 2 });
      const down = () => Object.assign(new Error("Meta no está disponible ahora"), { name: "SendError", code: "meta_unavailable" });
      const { deps } = stubDeps({ sendText: vi.fn(async () => { throw down(); }) });

      const t0 = Date.now();
      await worker.tickAutomations(new Date(t0), deps);
      let r = await row(id);
      expect(r.status).toBe("pending");
      expect(r.attempts).toBe(1);
      expect(r.scheduledFor.getTime()).toBeGreaterThanOrEqual(t0 + 29_000); // backoff de 30 s
      expect(r.lockedAt).toBeNull();
      expect(r.error).toContain("meta_unavailable");

      await worker.tickAutomations(new Date(t0 + 60_000), deps); // vencido el backoff
      r = await row(id);
      expect(r.status).toBe("failed");
      expect(r.attempts).toBe(2);
      expect(r.error).toContain("max_attempts_exceeded");
    });

    it("un flujo apagado cancela sus tareas pendientes sin enviar", async () => {
      const { flowId, stepIds } = await makeFlow([{ stepType: "send_whatsapp", config: { content: "Hola" } }], false);
      const id = await enqueue(flowId, stepIds[0]!);
      const { deps, sent } = stubDeps();
      await worker.tickAutomations(new Date(), deps);
      expect((await row(id)).status).toBe("cancelled");
      expect(sent).toEqual([]);
    });
  });
});
