import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";

/**
 * Fase 6 contra PostgreSQL REAL (`pnpm test:db`): bajas (palabra clave y manual, cancelación de ejecuciones, el freno
 * del motor), límite de frecuencia (conteo sobre el historial real, posponer sin gastar intento, descartar) y el paso
 * `send_media` de punta a punta con la biblioteca de Medios. Nada toca la API de WhatsApp: el envío se sustituye por
 * un doble que registra lo recibido. Crea y borra lo suyo.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

/** Un PNG de 1×1 válido: la biblioteca decide el formato por los bytes. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

describe.skipIf(!live)("cumplimiento y multimedia contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let flows: typeof import("@/server/automation/flows");
  let worker: typeof import("@/server/automation/worker");
  let engine: typeof import("@/server/automation/engine");
  let queue: typeof import("@/server/automation/queue");
  let store: typeof import("@/server/automation/trigger-store");
  let reply: typeof import("@/server/automation/reply");
  let optOut: typeof import("@/server/automation/opt-out");
  let canvas: typeof import("@/server/automation/canvas");
  let medios: typeof import("@/server/medios/store");
  let tags: typeof import("@/server/tags/store");
  let schemas: typeof import("@/lib/automation-schemas");
  let compliance: typeof import("@/lib/automation-compliance");
  let graph: typeof import("@/lib/automation-graph");

  const uid = Date.now().toString(36);
  let org = "";
  let otherOrg = "";
  let tagA = "";
  let seq = 0;
  const created = { flows: [] as string[], tags: [] as string[], contacts: [] as string[], convs: [] as string[], media: [] as { id: string; organizationId: string }[] };

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    ({ eq, and, inArray } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    flows = await import("@/server/automation/flows");
    worker = await import("@/server/automation/worker");
    engine = await import("@/server/automation/engine");
    queue = await import("@/server/automation/queue");
    store = await import("@/server/automation/trigger-store");
    reply = await import("@/server/automation/reply");
    optOut = await import("@/server/automation/opt-out");
    canvas = await import("@/server/automation/canvas");
    medios = await import("@/server/medios/store");
    tags = await import("@/server/tags/store");
    schemas = await import("@/lib/automation-schemas");
    compliance = await import("@/lib/automation-compliance");
    graph = await import("@/lib/automation-graph");

    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    org = orgs[0]!.id;
    otherOrg = orgs[1]!.id;
    const a = await tags.createTag(org, { name: `C-A ${uid}`, color: "blue" });
    tagA = a.id;
    created.tags.push(a.id);
  });

  afterAll(async () => {
    if (!db) return;
    if (created.flows.length) await db.delete(schema.automationFlow).where(inArray(schema.automationFlow.id, created.flows));
    if (created.tags.length) await db.delete(schema.tag).where(inArray(schema.tag.id, created.tags));
    if (created.convs.length) await db.delete(schema.conversation).where(inArray(schema.conversation.id, created.convs));
    if (created.contacts.length) await db.delete(schema.contact).where(inArray(schema.contact.id, created.contacts));
    for (const m of created.media) {
      await db.delete(schema.mediaLibraryItem).where(eq(schema.mediaLibraryItem.id, m.id));
      await rm(medios.rutaDeMedio(m.organizationId, m.id), { force: true }).catch(() => {});
    }
  });

  /* ─── Constructores ─── */

  async function mkContact(over: { lastInboundAt?: Date | null; organizationId?: string } = {}) {
    const n = seq++;
    const contactId = `ct_c${uid}${n}`;
    const conversationId = `cv_c${uid}${n}`;
    const organizationId = over.organizationId ?? org;
    await db.insert(schema.contact).values({ id: contactId, organizationId, name: "Cliente Cumpl", waIdentity: `cp-${uid}${n}`, phone: `52155577${String(n).padStart(4, "0")}` });
    await db.insert(schema.conversation).values({
      id: conversationId,
      organizationId,
      contactId,
      lastInboundAt: over.lastInboundAt === undefined ? new Date() : over.lastInboundAt,
    });
    created.contacts.push(contactId);
    created.convs.push(conversationId);
    return { contactId, conversationId };
  }

  type Spec = { stepType: string; config: Record<string, unknown> };
  async function makeFlow(specs: Spec[], triggerType = "manual") {
    const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `Cumpl ${uid}${seq++}`, triggerType }));
    created.flows.push(flow.id);
    const steps = [];
    for (const [i, x] of specs.entries()) steps.push(await flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ ...x, positionY: i * 100 })));
    await flows.updateFlow(org, flow.id, { active: true });
    return { flowId: flow.id, steps };
  }

  const start = (flowId: string, contactId: string, key: string) =>
    store.dbTriggerStore.enqueueFirstStep({ organizationId: org, flowId, contactId, scheduledFor: new Date(), dedupeKey: key });
  const runsOf = (flowId: string, contactId: string) =>
    db.select().from(schema.automationRun).where(and(eq(schema.automationRun.flowId, flowId), eq(schema.automationRun.contactId, contactId)));
  const queueOf = (flowId: string, contactId: string) =>
    db
      .select()
      .from(schema.automationQueue)
      .where(and(eq(schema.automationQueue.flowId, flowId), eq(schema.automationQueue.contactId, contactId)))
      .orderBy(schema.automationQueue.createdAt);
  const logsOf = (flowId: string, contactId?: string) =>
    db
      .select()
      .from(schema.automationExecutionLog)
      .where(contactId ? and(eq(schema.automationExecutionLog.flowId, flowId), eq(schema.automationExecutionLog.contactId, contactId)) : eq(schema.automationExecutionLog.flowId, flowId));
  const contactOf = async (id: string) => (await db.select().from(schema.contact).where(eq(schema.contact.id, id)))[0]!;
  const tagsOf = async (contactId: string) => (await tags.tagIdsOfContact(org, contactId)).sort();

  function deps() {
    const sent: string[] = [];
    const media: { mimeType: string; bytes: number; fileName: string; caption?: string }[] = [];
    const d: import("@/server/automation/engine").Deps = {
      ...worker.defaultDeps(),
      sendText: vi.fn(async (i: { text: string }) => (sent.push(i.text), { messageId: "msg_fake" })),
      sendTemplate: vi.fn(async () => ({ messageId: "msg_fake" })),
      sendMedia: vi.fn(async (i) => (media.push({ mimeType: i.file.mimeType, bytes: i.file.data.byteLength, fileName: i.file.fileName, caption: i.caption }), { messageId: "msg_media" })),
      waMessageIdOf: async () => null,
    };
    return { d, sent, media };
  }

  /** Procesa la cola del flujo para el contacto hasta que no hay pendientes vencidas. */
  async function drain(flowId: string, contactId: string, d = deps().d) {
    for (let guard = 0; guard < 15; guard++) {
      const pending = (await queueOf(flowId, contactId)).find((r) => r.status === "pending" && r.scheduledFor.getTime() <= Date.now() + 1000);
      if (!pending) break;
      await engine.processRow(pending as never, d);
    }
  }

  const say = (contactId: string, text: string | null) => optOut.onInboundOptOut({ organizationId: org, contactId, text });

  /** Inserta `n` envíos automáticos exitosos «ya hechos» del contacto, a las horas dadas hacia atrás (historial real). */
  async function seedSends(flowId: string, contactId: string, hoursAgo: number[], over: { status?: "success" | "failed" | "skipped_rate_limit"; stepType?: string } = {}) {
    for (const h of hoursAgo) {
      await db.insert(schema.automationExecutionLog).values({
        id: `log_c${uid}${seq++}`,
        organizationId: org,
        flowId,
        stepId: null,
        contactId,
        queueId: null,
        status: over.status ?? "success",
        metadata: { step: { stepType: over.stepType ?? "send_whatsapp", stepName: "previo", config: {} } },
        executedAt: new Date(Date.now() - h * 3_600_000),
      });
    }
  }

  /* ═══════════════════════════ Bajas ═══════════════════════════ */

  describe("baja por palabra clave", () => {
    it("«STOP» marca al contacto y cancela sus ejecuciones vivas, con su historial (skipped_opt_out)", async () => {
      const { contactId } = await mkContact();
      // Un flujo esperando respuesta y otro con un recordatorio programado a futuro.
      const waiting = await makeFlow([
        { stepType: "wait_reply", config: { timeoutMinutes: 60 } },
        { stepType: "send_whatsapp", config: { content: "gracias" } },
      ]);
      const delayed = await makeFlow([
        { stepType: "delay", config: { amount: 1, unit: "days" } },
        { stepType: "send_whatsapp", config: { content: "recordatorio" } },
      ]);
      expect(await start(waiting.flowId, contactId, "w")).toBe(true);
      expect(await start(delayed.flowId, contactId, "d")).toBe(true);
      await drain(waiting.flowId, contactId);
      await drain(delayed.flowId, contactId);
      expect((await runsOf(waiting.flowId, contactId))[0]).toMatchObject({ status: "waiting", waitingFor: "reply" });
      expect((await runsOf(delayed.flowId, contactId))[0]!.status).toBe("waiting");

      expect(await say(contactId, "STOP")).toBe("opt_out");

      const c = await contactOf(contactId);
      expect(c.optedOutAt).toBeInstanceOf(Date);
      expect(c.optOutSource).toBe("keyword");
      for (const f of [waiting.flowId, delayed.flowId]) {
        expect((await runsOf(f, contactId))[0]).toMatchObject({ status: "cancelled", waitingFor: null, waitingUntil: null });
        expect((await queueOf(f, contactId)).filter((r) => r.status === "pending")).toHaveLength(0);
        const skip = (await logsOf(f, contactId)).filter((l) => l.status === "skipped_opt_out");
        expect(skip).toHaveLength(1);
        expect(skip[0]!.metadata).toMatchObject({ reason: "keyword", cancelled: true, message: "STOP" });
      }
      // El recordatorio ya programado ya no existe en la cola: no hay nada que el worker pueda enviar.
      expect(await isEmptyOfSends(delayed.flowId, contactId)).toBe(true);
    });

    const isEmptyOfSends = async (flowId: string, contactId: string) =>
      (await logsOf(flowId, contactId)).every((l) => l.status !== "success" || (l.metadata as { step?: { stepType?: string } }).step?.stepType !== "send_whatsapp");

    it("una segunda baja es idempotente: no cambia la fecha ni la fuente", async () => {
      const { contactId } = await mkContact();
      await say(contactId, "baja");
      const first = await contactOf(contactId);
      await new Promise((r) => setTimeout(r, 20));
      expect(await say(contactId, "no quiero más mensajes")).toBe("opt_out");
      const second = await contactOf(contactId);
      expect(second.optedOutAt!.getTime()).toBe(first.optedOutAt!.getTime());
      expect(second.optOutSource).toBe("keyword");
    });

    it("«start» levanta la baja; un mensaje cualquiera no toca nada", async () => {
      const { contactId } = await mkContact();
      expect(await say(contactId, "quiero una cita para mañana")).toBeNull();
      expect((await contactOf(contactId)).optedOutAt).toBeNull();
      await say(contactId, "stop");
      expect((await contactOf(contactId)).optedOutAt).not.toBeNull();
      expect(await say(contactId, "START")).toBe("opt_in");
      expect(await contactOf(contactId)).toMatchObject({ optedOutAt: null, optOutSource: null });
      // Volver a levantar una baja que no existe no falla.
      expect(await say(contactId, "start")).toBe("opt_in");
    });

    it("«cancelar» (contestar a un recordatorio para cancelar la cita) NO da de baja", async () => {
      const { contactId } = await mkContact();
      expect(await say(contactId, "cancelar")).toBeNull();
      expect((await contactOf(contactId)).optedOutAt).toBeNull();
    });

    it("un STOP a un wait_reply da de baja y la espera NO se resuelve como «otra cosa»", async () => {
      const { contactId } = await mkContact();
      const { flowId, steps } = await makeFlow([
        { stepType: "wait_reply", config: { timeoutMinutes: 60, onOther: "continue" } },
        { stepType: "add_tag", config: { tagId: tagA } },
      ]);
      await start(flowId, contactId, "stop-wait");
      await drain(flowId, contactId);
      expect((await runsOf(flowId, contactId))[0]).toMatchObject({ status: "waiting", currentStepId: steps[0]!.id });

      // El orden de la ingesta: primero la baja, después la respuesta del wait_reply.
      expect(await say(contactId, "STOP")).toBe("opt_out");
      expect(await reply.onInboundReply({ organizationId: org, contactId, text: "STOP", messageId: "m" })).toBe(0);
      expect((await runsOf(flowId, contactId))[0]!.status).toBe("cancelled");
      expect(await tagsOf(contactId)).toEqual([]); // «onOther: continue» no se ejecutó
    });

    it("el módulo apagado no cambia nada (bandera AUTOMATIONS)", async () => {
      const { contactId } = await mkContact();
      const r = await optOut.onInboundOptOut({ organizationId: org, contactId, text: "STOP" }, { ...optOut.dbOptOutDeps, enabled: () => false });
      expect(r).toBeNull();
      expect((await contactOf(contactId)).optedOutAt).toBeNull();
    });
  });

  describe("baja manual", () => {
    it("applyOptOut(manual) marca y cancela; clearOptOut la levanta", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow([{ stepType: "delay", config: { amount: 1, unit: "days" } }, { stepType: "send_whatsapp", config: { content: "x" } }]);
      await start(flowId, contactId, "m");
      await drain(flowId, contactId);

      const res = await optOut.applyOptOut({ organizationId: org, contactId, source: "manual" });
      expect(res).toEqual({ found: true, changed: true, cancelledRuns: 1 });
      expect(await contactOf(contactId)).toMatchObject({ optOutSource: "manual" });
      expect((await contactOf(contactId)).optedOutAt).not.toBeNull();
      expect(await optOut.isOptedOut(org, contactId)).toBe(true);
      expect((await logsOf(flowId, contactId)).find((l) => l.status === "skipped_opt_out")!.metadata).toMatchObject({ reason: "manual" });

      expect(await optOut.clearOptOut(org, contactId)).toBe(true);
      expect(await optOut.isOptedOut(org, contactId)).toBe(false);
      expect(await optOut.clearOptOut(org, contactId)).toBe(false); // ya no estaba
    });

    it("aislamiento: el id de un contacto de OTRA organización no se toca", async () => {
      const { contactId } = await mkContact();
      const res = await optOut.applyOptOut({ organizationId: otherOrg, contactId, source: "manual" });
      expect(res).toEqual({ found: false, changed: false, cancelledRuns: 0 });
      expect((await contactOf(contactId)).optedOutAt).toBeNull();
      expect(await optOut.isOptedOut(otherOrg, contactId)).toBe(false);
      expect(await optOut.clearOptOut(otherOrg, contactId)).toBe(false);
    });
  });

  describe("el freno del motor", () => {
    it("un contacto dado de baja NO recibe el mensaje: omisión registrada, ejecución terminada y el flujo NO sigue", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow([
        { stepType: "send_whatsapp", config: { content: "promo" } },
        { stepType: "add_tag", config: { tagId: tagA } },
      ]);
      await db.update(schema.contact).set({ optedOutAt: new Date(), optOutSource: "manual" }).where(eq(schema.contact.id, contactId));
      await start(flowId, contactId, "freno");
      const { d, sent } = deps();
      await drain(flowId, contactId, d);

      expect(sent).toEqual([]);
      expect(d.sendText).not.toHaveBeenCalled();
      expect((await runsOf(flowId, contactId))[0]).toMatchObject({ status: "cancelled" });
      const [first] = await queueOf(flowId, contactId);
      expect(first).toMatchObject({ status: "cancelled", error: "skipped_opt_out" });
      expect(await queueOf(flowId, contactId)).toHaveLength(1); // no encoló el paso siguiente
      expect(await tagsOf(contactId)).toEqual([]);
      const logs = await logsOf(flowId, contactId);
      expect(logs.map((l) => l.status)).toEqual(["skipped_opt_out"]);
      expect(logs[0]!.metadata).toMatchObject({ reason: "opted_out", step: { stepType: "send_whatsapp" } });
    });

    it("una baja que llega con la tarea ya en cola se respeta: la tarea ya encolada tampoco envía", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow([{ stepType: "send_whatsapp", config: { content: "hola" } }]);
      await start(flowId, contactId, "tarde");
      await optOut.applyOptOut({ organizationId: org, contactId, source: "manual" }); // cancela la cola pendiente
      const { d, sent } = deps();
      await drain(flowId, contactId, d);
      expect(sent).toEqual([]);
    });

    it("los pasos que no envían (etiqueta) SÍ corren para un contacto dado de baja", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow([{ stepType: "add_tag", config: { tagId: tagA } }]);
      await optOut.applyOptOut({ organizationId: org, contactId, source: "manual" });
      await start(flowId, contactId, "solo-tag");
      await drain(flowId, contactId);
      expect(await tagsOf(contactId)).toEqual([tagA]);
      expect((await runsOf(flowId, contactId))[0]!.status).toBe("completed");
    });

    it("sin baja el mismo flujo envía normal", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow([{ stepType: "send_whatsapp", config: { content: "hola {{name}}" } }]);
      await start(flowId, contactId, "normal");
      const { d, sent } = deps();
      await drain(flowId, contactId, d);
      expect(sent).toEqual(["hola Cliente Cumpl"]);
    });
  });

  /* ═══════════════════ Límite de frecuencia ═══════════════════ */

  describe("límite de frecuencia", () => {
    const max = () => compliance.AUTOMATION_RATE_LIMIT.maxMessages;

    it("recentAutomaticSends cuenta solo los envíos exitosos de mensajes (no omisiones, fallos ni otros pasos) de la ventana", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow([{ stepType: "send_whatsapp", config: { content: "x" } }]);
      await seedSends(flowId, contactId, [1, 2]);
      await seedSends(flowId, contactId, [3], { stepType: "send_media" });
      await seedSends(flowId, contactId, [4], { stepType: "add_tag" });
      await seedSends(flowId, contactId, [5], { status: "failed" });
      await seedSends(flowId, contactId, [6], { status: "skipped_rate_limit" });
      await seedSends(flowId, contactId, [30]); // fuera de la ventana
      const at = await queue.recentAutomaticSends(org, contactId, new Date(Date.now() - 24 * 3_600_000));
      expect(at).toHaveLength(3);
    });

    it("al llegar al tope NO envía: pospone sin gastar intento hasta que el más antiguo salga de la ventana", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow([{ stepType: "send_whatsapp", config: { content: "uno más" } }]);
      const hours = Array.from({ length: max() }, (_, i) => 2 + i * 3); // 2, 5, 8, 11, 14, 17 h atrás
      await seedSends(flowId, contactId, hours);
      await start(flowId, contactId, "tope");
      // Se toma como lo hace `claimDue`: processing con un intento sumado.
      const [row] = await queueOf(flowId, contactId);
      await db.update(schema.automationQueue).set({ status: "processing", attempts: 1, lockedAt: new Date() }).where(eq(schema.automationQueue.id, row!.id));
      const claimed = (await queueOf(flowId, contactId))[0]!;

      const { d, sent } = deps();
      expect(await engine.processRow(claimed as never, d)).toBe("retry");
      expect(sent).toEqual([]);

      const [after] = await queueOf(flowId, contactId);
      expect(after).toMatchObject({ status: "pending", attempts: 0, error: "skipped_rate_limit", lockedAt: null });
      // El de hace 17 h sale de la ventana dentro de 7 h.
      const expected = Date.now() + 7 * 3_600_000;
      expect(Math.abs(after!.scheduledFor.getTime() - expected)).toBeLessThan(60_000);
      expect((await runsOf(flowId, contactId))[0]!.status).not.toBe("cancelled");
      const skip = (await logsOf(flowId, contactId)).filter((l) => l.status === "skipped_rate_limit");
      expect(skip).toHaveLength(1);
      expect(skip[0]!.metadata).toMatchObject({ used: max(), max: max(), action: "deferred" });
      // `failExhausted` no la mata (no gastó intentos): sigue elegible cuando llegue su hora.
      expect(await queue.failExhausted(new Date(Date.now() + 8 * 3_600_000))).toBe(0);
    });

    it("cuando hay hueco, la tarea pospuesta sale", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow([{ stepType: "send_whatsapp", config: { content: "ya hay hueco" } }]);
      await seedSends(flowId, contactId, Array.from({ length: max() }, (_, i) => 1 + i));
      await start(flowId, contactId, "hueco");
      const { d, sent } = deps();
      await drain(flowId, contactId, d);
      expect(sent).toEqual([]); // retenido
      // Pasa el tiempo: los envíos previos salen de la ventana.
      await db.update(schema.automationExecutionLog).set({ executedAt: new Date(Date.now() - 30 * 3_600_000) }).where(and(eq(schema.automationExecutionLog.flowId, flowId), eq(schema.automationExecutionLog.status, "success")));
      await db.update(schema.automationQueue).set({ scheduledFor: new Date(Date.now() - 1000) }).where(eq(schema.automationQueue.flowId, flowId));
      await drain(flowId, contactId, d);
      expect(sent).toEqual(["ya hay hueco"]);
      expect((await runsOf(flowId, contactId))[0]!.status).toBe("completed");
    });

    it("una tarea retenida más de 24 h se descarta: ejecución cancelada y el historial lo dice", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow([{ stepType: "send_whatsapp", config: { content: "ya viejo" } }]);
      await seedSends(flowId, contactId, Array.from({ length: max() }, (_, i) => 1 + i));
      await start(flowId, contactId, "viejo");
      await db.update(schema.automationQueue).set({ createdAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(schema.automationQueue.flowId, flowId));
      const { d, sent } = deps();
      await drain(flowId, contactId, d);
      expect(sent).toEqual([]);
      expect((await runsOf(flowId, contactId))[0]!.status).toBe("cancelled");
      expect((await queueOf(flowId, contactId))[0]).toMatchObject({ status: "cancelled", error: "skipped_rate_limit" });
      const skip = (await logsOf(flowId, contactId)).find((l) => l.status === "skipped_rate_limit")!;
      expect(skip.metadata).toMatchObject({ action: "discarded" });
    });

    it("es POR contacto: otro contacto con la misma historia de otro no se frena", async () => {
      const busy = await mkContact();
      const calm = await mkContact();
      const { flowId } = await makeFlow([{ stepType: "send_whatsapp", config: { content: "hola" } }]);
      await seedSends(flowId, busy.contactId, Array.from({ length: max() }, (_, i) => 1 + i));
      await start(flowId, busy.contactId, "b");
      await start(flowId, calm.contactId, "c");
      const { d, sent } = deps();
      await drain(flowId, busy.contactId, d);
      await drain(flowId, calm.contactId, d);
      expect(sent).toEqual(["hola"]); // solo el tranquilo
    });

    it("el conteo suma TODOS los flujos del contacto", async () => {
      const { contactId } = await mkContact();
      const other = await makeFlow([{ stepType: "send_whatsapp", config: { content: "de otro flujo" } }]);
      const { flowId } = await makeFlow([{ stepType: "send_whatsapp", config: { content: "este flujo" } }]);
      await seedSends(other.flowId, contactId, Array.from({ length: max() }, (_, i) => 1 + i)); // los envíos son de OTRO flujo
      await start(flowId, contactId, "suma");
      const { d, sent } = deps();
      await drain(flowId, contactId, d);
      expect(sent).toEqual([]);
    });

    it("los envíos reales quedan contados: tras enviar max, el siguiente se retiene", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow([{ stepType: "send_whatsapp", config: { content: "ráfaga" } }]);
      const { d, sent } = deps();
      for (let i = 0; i < max() + 2; i++) {
        await start(flowId, contactId, `rafaga-${i}`);
        await drain(flowId, contactId, d);
      }
      expect(sent).toHaveLength(max());
      const logs = await logsOf(flowId, contactId);
      expect(logs.filter((l) => l.status === "success")).toHaveLength(max());
      expect(logs.filter((l) => l.status === "skipped_rate_limit")).toHaveLength(2);
    });
  });

  /* ═══════════════════════ send_media ═══════════════════════ */

  describe("send_media", () => {
    async function mkMedia(organizationId = org) {
      const m = await medios.crearMedio({ organizationId, userId: "usr_test", data: PNG, nombre: `promo-${uid}-${seq++}.png`, source: "upload" });
      created.media.push({ id: m.id, organizationId });
      return m;
    }

    it("envía el archivo de la biblioteca con la leyenda renderizada y lo registra", async () => {
      const m = await mkMedia();
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow([{ stepType: "send_media", config: { name: "Promo", mediaId: m.id, caption: "Hola {{name}}" } }]);
      await start(flowId, contactId, "media");
      const { d, media } = deps();
      await drain(flowId, contactId, d);

      expect(media).toHaveLength(1);
      expect(media[0]).toMatchObject({ mimeType: "image/png", bytes: PNG.byteLength, caption: "Hola Cliente Cumpl" });
      expect(media[0]!.fileName).toMatch(/\.png$/);
      expect((await runsOf(flowId, contactId))[0]!.status).toBe("completed");
      const [log] = await logsOf(flowId, contactId);
      expect(log).toMatchObject({ status: "success" });
      expect(log!.metadata).toMatchObject({
        step: { stepType: "send_media", stepName: "Promo" },
        payload: { mode: "media", mediaId: m.id, mimeType: "image/png", caption: "Hola Cliente Cumpl" },
      });
    });

    it("cuenta para el límite igual que un mensaje, y el siguiente paso continúa", async () => {
      const m = await mkMedia();
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow([
        { stepType: "send_media", config: { mediaId: m.id } },
        { stepType: "send_whatsapp", config: { content: "después de la imagen" } },
      ]);
      await start(flowId, contactId, "media-seq");
      const { d, sent, media } = deps();
      await drain(flowId, contactId, d);
      expect(media).toHaveLength(1);
      expect(sent).toEqual(["después de la imagen"]);
      expect(await queue.recentAutomaticSends(org, contactId, new Date(Date.now() - 3_600_000))).toHaveLength(2);
    });

    it("con la ventana de 24 h cerrada falla a la vista (sin plantilla para adjuntos) y NO envía", async () => {
      const m = await mkMedia();
      const { contactId } = await mkContact({ lastInboundAt: new Date(Date.now() - 30 * 3_600_000) });
      const { flowId } = await makeFlow([{ stepType: "send_media", config: { mediaId: m.id } }]);
      await start(flowId, contactId, "cerrada");
      const { d, media } = deps();
      await drain(flowId, contactId, d);
      expect(media).toEqual([]);
      expect((await runsOf(flowId, contactId))[0]!.status).toBe("failed");
      expect((await queueOf(flowId, contactId))[0]).toMatchObject({ status: "failed", error: "out_of_window_media_requires_open_window" });
      expect((await logsOf(flowId, contactId))[0]).toMatchObject({ status: "failed" });
    });

    it("un medio borrado falla con media_not_found; un archivo ausente, con media_file_missing", async () => {
      const gone = await mkMedia();
      const lost = await mkMedia();
      const a = await mkContact();
      const b = await mkContact();
      const fa = await makeFlow([{ stepType: "send_media", config: { mediaId: gone.id } }]);
      const fb = await makeFlow([{ stepType: "send_media", config: { mediaId: lost.id } }]);
      // Borrados «por debajo» (el guardia de uso solo protege el borrado normal): fila / archivo.
      await db.delete(schema.mediaLibraryItem).where(eq(schema.mediaLibraryItem.id, gone.id));
      await rm(medios.rutaDeMedio(org, lost.id), { force: true });
      await start(fa.flowId, a.contactId, "gone");
      await start(fb.flowId, b.contactId, "lost");
      const { d, media } = deps();
      await drain(fa.flowId, a.contactId, d);
      await drain(fb.flowId, b.contactId, d);
      expect(media).toEqual([]);
      expect((await queueOf(fa.flowId, a.contactId))[0]).toMatchObject({ status: "failed", error: "media_not_found" });
      expect((await queueOf(fb.flowId, b.contactId))[0]).toMatchObject({ status: "failed", error: "media_file_missing" });
    });

    it("la baja y el límite frenan también un send_media", async () => {
      const m = await mkMedia();
      const off = await mkContact();
      const busy = await mkContact();
      const { flowId } = await makeFlow([{ stepType: "send_media", config: { mediaId: m.id } }]);
      await optOut.applyOptOut({ organizationId: org, contactId: off.contactId, source: "manual" });
      await seedSends(flowId, busy.contactId, Array.from({ length: compliance.AUTOMATION_RATE_LIMIT.maxMessages }, (_, i) => 1 + i));
      await start(flowId, off.contactId, "o");
      await start(flowId, busy.contactId, "r");
      const { d, media } = deps();
      await drain(flowId, off.contactId, d);
      await drain(flowId, busy.contactId, d);
      expect(media).toEqual([]);
      expect((await logsOf(flowId, off.contactId)).map((l) => l.status)).toEqual(["skipped_opt_out"]);
      expect((await logsOf(flowId, busy.contactId)).filter((l) => l.status === "skipped_rate_limit")).toHaveLength(1);
    });

    describe("referencias a la biblioteca", () => {
      it("el servidor rechaza un archivo que no existe o es de OTRA organización (API de pasos y PUT /graph)", async () => {
        const theirs = await mkMedia(otherOrg);
        const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `Refs ${uid}${seq++}`, triggerType: "manual" }));
        created.flows.push(flow.id);

        for (const mediaId of [theirs.id, "med_inexistente"]) {
          await expect(flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ stepType: "send_media", config: { mediaId } }))).rejects.toMatchObject({
            status: 422,
            code: "media_not_found",
          });
          await expect(
            canvas.saveGraph(
              org,
              flow.id,
              graph.graphPayloadSchema.parse({
                nodes: [
                  { id: "trg", type: "trigger", config: { triggerType: "manual", triggerConfig: null }, position: { x: 0, y: 0 } },
                  { id: "new_1", type: "send_media", config: { mediaId }, position: { x: 0, y: 100 } },
                ],
                edges: [{ source: "trg", target: "new_1", sourceHandle: "default" }],
              })
            )
          ).rejects.toMatchObject({ status: 422, code: "media_not_found" });
        }
        // Y nada quedó a medias.
        expect(await db.select().from(schema.automationStep).where(eq(schema.automationStep.flowId, flow.id))).toHaveLength(0);
      });

      it("el lienzo guarda y el motor ejecuta un send_media propio (PUT /graph)", async () => {
        const m = await mkMedia();
        const { contactId } = await mkContact();
        const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `Lienzo media ${uid}${seq++}`, triggerType: "manual" }));
        created.flows.push(flow.id);
        const saved = await canvas.saveGraph(
          org,
          flow.id,
          graph.graphPayloadSchema.parse({
            nodes: [
              { id: "trg", type: "trigger", config: { triggerType: "manual", triggerConfig: null }, position: { x: 0, y: 0 } },
              { id: "new_1", type: "send_media", config: { mediaId: m.id, caption: "Mira" }, position: { x: 40, y: 140 } },
            ],
            edges: [{ source: "trg", target: "new_1", sourceHandle: "default" }],
          })
        );
        expect(saved.nodes.find((n) => n.type === "send_media")).toBeTruthy();
        await flows.updateFlow(org, flow.id, { active: true });
        await start(flow.id, contactId, "lienzo-media");
        const { d, media } = deps();
        await drain(flow.id, contactId, d);
        expect(media).toHaveLength(1);
        expect(media[0]).toMatchObject({ caption: "Mira", mimeType: "image/png" });
      });

      it("no se puede borrar un medio que un flujo envía; sí cuando ya no lo usa", async () => {
        const m = await mkMedia();
        const { flowId, steps } = await makeFlow([{ stepType: "send_media", config: { mediaId: m.id } }]);
        await expect(medios.borrarMedio({ organizationId: org, userId: "usr_test", puedeAdministrar: true, id: m.id })).rejects.toMatchObject({ code: "in_use" });
        expect(await medios.flujosQueUsanMedio(org, m.id)).toHaveLength(1);
        // El lote reporta el motivo en vez de fallar entero.
        const batch = await medios.borrarMedios({ organizationId: org, userId: "usr_test", puedeAdministrar: true, ids: [m.id] });
        expect(batch.borrados).toEqual([]);
        expect(batch.omitidos[0]!.motivo).toContain("Cambia ese paso antes de borrarlo");

        await flows.deleteStep(org, flowId, steps[0]!.id);
        await medios.borrarMedio({ organizationId: org, userId: "usr_test", puedeAdministrar: true, id: m.id });
        expect((await db.select().from(schema.mediaLibraryItem).where(eq(schema.mediaLibraryItem.id, m.id))).length).toBe(0);
      });

      it("el uso es por organización: otra organización puede borrar su medio aunque el id coincida con una referencia ajena", async () => {
        const theirs = await mkMedia(otherOrg);
        expect(await medios.flujosQueUsanMedio(org, theirs.id)).toEqual([]);
        await medios.borrarMedio({ organizationId: otherOrg, userId: "usr_test", puedeAdministrar: true, id: theirs.id });
      });
    });
  });
});
