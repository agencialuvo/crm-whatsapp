import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Fase 4 contra PostgreSQL REAL (`pnpm test:db`): `wait_reply` de punta a punta (entrar a la espera, resolver
 * por cada asa, vencer el tiempo), la carrera «respuesta vs. vencimiento» —la delicada—, solo el texto cuenta,
 * confirmar la cita desde la respuesta, cancelaciones, y el disparador `ad_referral` con el contexto del
 * servicio. El LLM se sustituye por un clasificador fijo; nada toca la API de WhatsApp. Crea y borra lo suyo.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("espera de respuesta y anuncios contra Postgres", () => {
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
  let tags: typeof import("@/server/tags/store");
  let attribution: typeof import("@/server/attribution/store");
  let schemas: typeof import("@/lib/automation-schemas");
  let lib: typeof import("@/lib/automation");

  const uid = Date.now().toString(36);
  let org = "";
  let tagA = "";
  let tagB = "";
  let seq = 0;
  const created = {
    flows: [] as string[],
    tags: [] as string[],
    bookings: [] as string[],
    contacts: [] as string[],
    convs: [] as string[],
    services: [] as string[],
    adFlows: [] as string[],
  };

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
    tags = await import("@/server/tags/store");
    attribution = await import("@/server/attribution/store");
    schemas = await import("@/lib/automation-schemas");
    lib = await import("@/lib/automation");

    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    org = orgs[0]!.id;
    const a = await tags.createTag(org, { name: `R-A ${uid}`, color: "blue" });
    const b = await tags.createTag(org, { name: `R-B ${uid}`, color: "green" });
    tagA = a.id;
    tagB = b.id;
    created.tags.push(a.id, b.id);
  });

  afterAll(async () => {
    if (!db) return;
    if (created.flows.length) await db.delete(schema.automationFlow).where(inArray(schema.automationFlow.id, created.flows));
    if (created.adFlows.length) await db.delete(schema.adFlow).where(inArray(schema.adFlow.id, created.adFlows));
    if (created.bookings.length) await db.delete(schema.booking).where(inArray(schema.booking.id, created.bookings));
    if (created.services.length) await db.delete(schema.service).where(inArray(schema.service.id, created.services));
    if (created.tags.length) await db.delete(schema.tag).where(inArray(schema.tag.id, created.tags));
    if (created.convs.length) await db.delete(schema.conversation).where(inArray(schema.conversation.id, created.convs));
    if (created.contacts.length) await db.delete(schema.contact).where(inArray(schema.contact.id, created.contacts));
  });

  /** Un contacto con su chat real de WhatsApp (ventana abierta). */
  async function mkContact() {
    const n = seq++;
    const contactId = `ct_r${uid}${n}`;
    const conversationId = `cv_r${uid}${n}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Cliente Resp", waIdentity: `rp-${uid}${n}`, phone: `52155588${String(n).padStart(4, "0")}` });
    await db.insert(schema.conversation).values({ id: conversationId, organizationId: org, contactId, lastInboundAt: new Date() });
    created.contacts.push(contactId);
    created.convs.push(conversationId);
    return { contactId, conversationId };
  }

  async function mkBooking(contactId: string) {
    const id = `bk_r${uid}${seq++}`;
    await db.insert(schema.booking).values({
      id,
      organizationId: org,
      kind: "session",
      status: "agendada",
      source: "manual",
      contactId,
      scheduledAt: new Date(Date.now() + 6 * 86_400_000),
      durationMinutes: 30,
      connector: "enlace-fijo",
    });
    created.bookings.push(id);
    return id;
  }

  type Spec = { stepType: string; config: Record<string, unknown> };
  async function makeFlow(triggerType: string, specs: Spec[], triggerConfig?: Record<string, unknown>) {
    const flow = await flows.createFlow(
      org,
      schemas.flowCreateSchema.parse({ name: `Resp ${uid}${seq++}`, triggerType, ...(triggerConfig ? { triggerConfig } : {}) })
    );
    created.flows.push(flow.id);
    const steps = [];
    for (const [i, x] of specs.entries()) {
      steps.push(await flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ ...x, positionY: i * 100 })));
    }
    await flows.updateFlow(org, flow.id, { active: true });
    return { flowId: flow.id, steps };
  }

  /** wait_reply → A → B. Confirma → A y B; vence el tiempo (skip_next) → solo B; dice que no → A y B. */
  const WAIT_FLOW: Spec[] = [
    { stepType: "wait_reply", config: { timeoutMinutes: 60, onConfirmed: "continue", onDeclined: "continue", onReschedule: "stop", onOther: "stop", onTimeout: "skip_next" } },
    { stepType: "add_tag", config: { tagId: "A" } },
    { stepType: "add_tag", config: { tagId: "B" } },
  ];
  const withTags = (specs: Spec[]) =>
    specs.map((s) => (s.stepType === "add_tag" ? { ...s, config: { tagId: s.config.tagId === "A" ? tagA : tagB } } : s));

  const start = (flowId: string, contactId: string, key: string, over: Record<string, unknown> = {}) =>
    store.dbTriggerStore.enqueueFirstStep({ organizationId: org, flowId, contactId, scheduledFor: new Date(), dedupeKey: key, ...over });
  const runsOf = (flowId: string, contactId?: string) =>
    db
      .select()
      .from(schema.automationRun)
      .where(contactId ? and(eq(schema.automationRun.flowId, flowId), eq(schema.automationRun.contactId, contactId)) : eq(schema.automationRun.flowId, flowId));
  const queueOf = (flowId: string, contactId?: string) =>
    db
      .select()
      .from(schema.automationQueue)
      .where(contactId ? and(eq(schema.automationQueue.flowId, flowId), eq(schema.automationQueue.contactId, contactId)) : eq(schema.automationQueue.flowId, flowId))
      .orderBy(schema.automationQueue.createdAt);

  function deps() {
    const sent: string[] = [];
    const d: import("@/server/automation/engine").Deps = {
      ...worker.defaultDeps(),
      sendText: vi.fn(async (i: { text: string }) => (sent.push(i.text), { messageId: "msg_fake" })),
      sendTemplate: vi.fn(async () => ({ messageId: "msg_fake" })),
      waMessageIdOf: async () => null,
    };
    return { d, sent };
  }

  /** Procesa la cola del flujo para el contacto hasta que no hay pendientes VENCIDAS (las futuras se dejan). */
  async function drain(flowId: string, contactId: string, d = deps().d) {
    for (let guard = 0; guard < 15; guard++) {
      const pending = (await queueOf(flowId, contactId)).find((r) => r.status === "pending" && r.scheduledFor.getTime() <= Date.now() + 1000);
      if (!pending) break;
      await engine.processRow(pending as never, d);
    }
  }

  /** Arranca el flujo y lo lleva hasta quedar esperando la respuesta. */
  async function enterWait(flowId: string, contactId: string, key = "espera") {
    expect(await start(flowId, contactId, key)).toBe(true);
    await drain(flowId, contactId);
  }

  const classifier = (intent: "confirmed" | "declined" | "reschedule" | "other") => ({
    ...reply.dbReplyDeps,
    classify: async () => ({ intent, source: "rules" as const }),
  });
  const say = (contactId: string, text: string | null, d = reply.dbReplyDeps) => reply.onInboundReply({ organizationId: org, contactId, text, messageId: "msg_x" }, d);
  const tagsOf = async (contactId: string) => (await tags.tagIdsOfContact(org, contactId)).sort();

  describe("entrar a la espera", () => {
    it("la ejecución queda esperando respuesta, con límite, y la tarea del paso se cambia por una de timeout", async () => {
      const { contactId } = await mkContact();
      const { flowId, steps } = await makeFlow("manual", withTags(WAIT_FLOW));
      await enterWait(flowId, contactId);

      const [run] = await runsOf(flowId, contactId);
      expect(run).toMatchObject({ status: "waiting", waitingFor: "reply", currentStepId: steps[0]!.id });
      expect(run!.waitingUntil!.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
      expect(run!.waitingUntil!.getTime()).toBeLessThan(Date.now() + 65 * 60_000);

      const rows = await queueOf(flowId, contactId);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ status: "completed", stepId: steps[0]!.id });
      expect(rows[1]).toMatchObject({ status: "pending", stepId: steps[0]!.id, runId: run!.id });
      expect(rows[1]!.dedupeKey).toBe(lib.replyTimeoutKey(run!.id, steps[0]!.id, rows[1]!.scheduledFor));
      expect(rows[1]!.scheduledFor.getTime()).toBe(run!.waitingUntil!.getTime());
      // Nada avanzó: ni etiquetas ni siguiente paso.
      expect(await tagsOf(contactId)).toEqual([]);
    });

    it("reintentar la entrada (tras una caída) no duplica la tarea de timeout", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow("manual", withTags(WAIT_FLOW));
      await enterWait(flowId, contactId);
      const [first] = await queueOf(flowId, contactId);
      const again = await queue.enterReplyWait(first as never, new Date(Date.now() + 60 * 60_000));
      expect(again).toBe("waiting");
      expect(await queueOf(flowId, contactId)).toHaveLength(2);
    });

    it("una ejecución cancelada no entra a la espera", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow("manual", withTags(WAIT_FLOW));
      await start(flowId, contactId, "cancelada");
      const [row] = await queueOf(flowId, contactId);
      await db.update(schema.automationRun).set({ status: "cancelled" }).where(eq(schema.automationRun.flowId, flowId));
      expect(await queue.enterReplyWait(row as never, new Date(Date.now() + 60_000))).toBe("cancelled");
    });
  });

  describe("la respuesta del cliente", () => {
    it("«sí» (regla exacta, sin LLM) reanuda por «confirmed»: sigue A y B y completa la ejecución", async () => {
      const { contactId } = await mkContact();
      const { flowId, steps } = await makeFlow("manual", withTags(WAIT_FLOW));
      await enterWait(flowId, contactId);

      expect(await say(contactId, "¡Sí!")).toBe(1); // dbReplyDeps real: la regla lo resuelve sin tocar el LLM
      let [run] = await runsOf(flowId, contactId);
      expect(run).toMatchObject({ status: "running", waitingFor: null, waitingUntil: null, currentStepId: steps[1]!.id });
      const rows = await queueOf(flowId, contactId);
      expect(rows.find((r) => r.dedupeKey?.startsWith("reply_timeout:"))).toMatchObject({ status: "completed" }); // el timeout ya no corre
      expect(rows.filter((r) => r.status === "pending").map((r) => r.stepId)).toEqual([steps[1]!.id]);

      await drain(flowId, contactId);
      [run] = await runsOf(flowId, contactId);
      expect(run).toMatchObject({ status: "completed" });
      expect(await tagsOf(contactId)).toEqual([tagA, tagB].sort());

      const logs = await db.select().from(schema.automationExecutionLog).where(eq(schema.automationExecutionLog.flowId, flowId));
      const resolution = logs.find((l) => (l.metadata as { waitedFor?: string }).waitedFor === "reply" && l.queueId === null);
      expect(resolution?.metadata).toMatchObject({ handle: "confirmed", intent: "confirmed", source: "rules", runId: run!.id });
    });

    it.each([
      ["declined", "continue"], // onDeclined: continue → A y B
      ["reschedule", "stop"], // onReschedule: stop → termina
      ["other", "stop"],
    ] as const)("la intención %s sigue la arista de su asa (%s)", async (intent, action) => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow("manual", withTags(WAIT_FLOW));
      await enterWait(flowId, contactId);
      expect(await say(contactId, "lo que sea", classifier(intent))).toBe(1);
      await drain(flowId, contactId);
      expect((await runsOf(flowId, contactId))[0]).toMatchObject({ status: "completed" });
      expect(await tagsOf(contactId)).toEqual(action === "continue" ? [tagA, tagB].sort() : []);
    });

    it("un sticker o una reacción (sin texto) NO reanuda la espera", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow("manual", withTags(WAIT_FLOW));
      await enterWait(flowId, contactId);
      expect(await say(contactId, null)).toBe(0);
      expect(await say(contactId, "   ")).toBe(0);
      expect((await runsOf(flowId, contactId))[0]).toMatchObject({ status: "waiting", waitingFor: "reply" });
      // Y luego sí responde: la espera sigue viva.
      expect(await say(contactId, "sí")).toBe(1);
    });

    it("un contacto sin espera no dispara nada (ni toca otras ejecuciones)", async () => {
      const waiting = await mkContact();
      const other = await mkContact();
      const { flowId } = await makeFlow("manual", withTags(WAIT_FLOW));
      await enterWait(flowId, waiting.contactId);
      expect(await say(other.contactId, "sí")).toBe(0);
      expect((await runsOf(flowId, waiting.contactId))[0]).toMatchObject({ status: "waiting" });
    });

    it("una segunda respuesta ya no encuentra la espera (no se resuelve dos veces)", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow("manual", withTags(WAIT_FLOW));
      await enterWait(flowId, contactId);
      expect(await say(contactId, "sí")).toBe(1);
      expect(await say(contactId, "sí")).toBe(0);
      expect(await queueOf(flowId, contactId).then((r) => r.filter((x) => x.status === "pending"))).toHaveLength(1);
    });

    it("el flujo apagado mientras esperaba: la respuesta cancela la ejecución en vez de reanudarla", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow("manual", withTags(WAIT_FLOW));
      await enterWait(flowId, contactId);
      await flows.updateFlow(org, flowId, { active: false });
      expect(await say(contactId, "sí")).toBe(0);
      expect((await runsOf(flowId, contactId))[0]).toMatchObject({ status: "cancelled" });
      expect((await queueOf(flowId, contactId)).filter((r) => r.status === "pending")).toHaveLength(0);
      expect(await tagsOf(contactId)).toEqual([]);
    });
  });

  describe("vence el tiempo", () => {
    it("la tarea de timeout resuelve por «timeout»: se salta A (skip_next) y sigue con B", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow("manual", withTags(WAIT_FLOW));
      await enterWait(flowId, contactId);
      await db
        .update(schema.automationQueue)
        .set({ scheduledFor: new Date(Date.now() - 1000) })
        .where(and(eq(schema.automationQueue.flowId, flowId), eq(schema.automationQueue.status, "pending")));
      await drain(flowId, contactId);
      expect((await runsOf(flowId, contactId))[0]).toMatchObject({ status: "completed", waitingFor: null });
      expect(await tagsOf(contactId)).toEqual([tagB]);
      // Y después ya no hay a quién responderle.
      expect(await say(contactId, "sí")).toBe(0);
    });
  });

  describe("carrera: respuesta vs. vencimiento del temporizador", () => {
    it("exactamente una vía gana, todas las veces: nunca se encolan los dos destinos", async () => {
      const wins = { reply: 0, timeout: 0 };
      for (let i = 0; i < 16; i++) {
        const { contactId } = await mkContact();
        const { flowId, steps } = await makeFlow("manual", withTags(WAIT_FLOW));
        await enterWait(flowId, contactId, `carrera:${i}`);

        // El temporizador venció y un worker YA tomó la tarea (`processing`) justo cuando llega la respuesta.
        const [timeout] = (await queueOf(flowId, contactId)).filter((r) => r.status === "pending");
        await db
          .update(schema.automationQueue)
          .set({ status: "processing", attempts: 1, scheduledFor: new Date(Date.now() - 1000), lockedAt: new Date() })
          .where(eq(schema.automationQueue.id, timeout!.id));
        const [claimed] = await db.select().from(schema.automationQueue).where(eq(schema.automationQueue.id, timeout!.id));

        const d = deps().d;
        const [resumed] = await Promise.all([say(contactId, "sí"), engine.processRow(claimed as never, d)]);

        const [run] = await runsOf(flowId, contactId);
        const rows = await queueOf(flowId, contactId);
        // Confirmó → destino A (steps[1]); venció → destino B (steps[2], por skip_next). Jamás los dos.
        const toA = rows.filter((r) => r.stepId === steps[1]!.id);
        const toB = rows.filter((r) => r.stepId === steps[2]!.id);
        expect(toA.length + toB.length, `ronda ${i}: se encoló exactamente un destino`).toBe(1);
        expect(run!.status, `ronda ${i}`).toBe("running");
        expect(run!.waitingFor).toBeNull();
        expect(rows.filter((r) => r.stepId === steps[0]!.id && r.status !== "completed"), `ronda ${i}: sin tareas del paso de espera vivas`).toHaveLength(0);
        // El resultado de la respuesta es coherente con quién ganó.
        expect(resumed === 1, `ronda ${i}`).toBe(toA.length === 1);
        if (toA.length === 1) wins.reply += 1;
        else wins.timeout += 1;
      }
      expect(wins.reply + wins.timeout).toBe(16);
    });

    it("la respuesta que llega con el temporizador YA resuelto no hace nada", async () => {
      const { contactId } = await mkContact();
      const { flowId } = await makeFlow("manual", withTags(WAIT_FLOW));
      await enterWait(flowId, contactId);
      const [run] = await runsOf(flowId, contactId);
      const first = await queue.resolveReplyWait({ organizationId: org, runId: run!.id, handle: "timeout" });
      const second = await queue.resolveReplyWait({ organizationId: org, runId: run!.id, handle: "confirmed" });
      expect(first.resolved).toBe(true);
      expect(second.resolved).toBe(false);
      expect((await queueOf(flowId, contactId)).filter((r) => r.status === "pending")).toHaveLength(1);
    });
  });

  describe("con una cita", () => {
    it("«confirmo» confirma la cita (igual que el botón de la Agenda)", async () => {
      const { contactId } = await mkContact();
      const bookingId = await mkBooking(contactId);
      const { flowId } = await makeFlow("booking_created", withTags(WAIT_FLOW));
      await start(flowId, contactId, "cita:1", { bookingId });
      await drain(flowId, contactId);
      expect((await runsOf(flowId, contactId))[0]!.context).toEqual({ bookingId });

      expect(await say(contactId, "confirmo")).toBe(1);
      const [b] = await db.select().from(schema.booking).where(eq(schema.booking.id, bookingId));
      expect(b!.confirmedAt).not.toBeNull();
    });

    it("«no puedo» no confirma la cita; con confirmBooking apagado, «sí» tampoco", async () => {
      const a = await mkContact();
      const bookingA = await mkBooking(a.contactId);
      const fa = await makeFlow("booking_created", withTags(WAIT_FLOW));
      await start(fa.flowId, a.contactId, "cita:2", { bookingId: bookingA });
      await drain(fa.flowId, a.contactId);
      await say(a.contactId, "no puedo");
      expect((await db.select().from(schema.booking).where(eq(schema.booking.id, bookingA)))[0]!.confirmedAt).toBeNull();

      const b = await mkContact();
      const bookingB = await mkBooking(b.contactId);
      const specs = withTags(WAIT_FLOW);
      specs[0] = { ...specs[0]!, config: { ...specs[0]!.config, confirmBooking: false } };
      const fb = await makeFlow("booking_created", specs);
      await start(fb.flowId, b.contactId, "cita:3", { bookingId: bookingB });
      await drain(fb.flowId, b.contactId);
      await say(b.contactId, "sí");
      expect((await db.select().from(schema.booking).where(eq(schema.booking.id, bookingB)))[0]!.confirmedAt).toBeNull();
    });

    it("cancelar la cita mientras se espera cancela la ejecución: la respuesta ya no reanuda nada", async () => {
      const { contactId } = await mkContact();
      const bookingId = await mkBooking(contactId);
      const { flowId } = await makeFlow("booking_created", withTags(WAIT_FLOW));
      await start(flowId, contactId, "cita:4", { bookingId });
      await drain(flowId, contactId);
      expect((await runsOf(flowId, contactId))[0]).toMatchObject({ status: "waiting" });

      await store.dbTriggerStore.cancelPendingForBooking(org, bookingId, "booking_cancelled");
      expect((await runsOf(flowId, contactId))[0]).toMatchObject({ status: "cancelled" });
      expect(await say(contactId, "sí")).toBe(0);
      expect(await tagsOf(contactId)).toEqual([]);
    });
  });

  describe("disparador ad_referral", () => {
    async function mkService(name: string) {
      const id = `srv_r${uid}${seq++}`;
      await db.insert(schema.service).values({ id, organizationId: org, name, priceCents: 4500, durationMinutes: 45 });
      created.services.push(id);
      return id;
    }
    const anuncio = (sourceId: string, headline = "Corte 2x1") => ({
      sourceId,
      sourceType: "ad",
      sourceUrl: null,
      headline,
      body: null,
      mediaType: null,
      ctwaClid: null,
      imageUrl: null,
      raw: {},
    });
    const SEND_AND_TAG: Spec[] = [
      { stepType: "send_whatsapp", config: { content: "Hola {{name}}, vi que te interesa {{servicio}}" } },
      { stepType: "add_tag", config: { tagId: "A" } },
    ];

    it("un anuncio nuevo arranca el flujo acotado a ese anuncio, con el servicio en el contexto y en el mensaje", async () => {
      const src = `ad${uid}1`;
      const serviceId = await mkService(`Corte clásico ${uid}`);
      const adFlowId = `adf_r${uid}1`;
      await db.insert(schema.adFlow).values({ id: adFlowId, organizationId: org, sourceId: src, serviceId, active: true });
      created.adFlows.push(adFlowId);
      const { flowId } = await makeFlow("ad_referral", withTags(SEND_AND_TAG), { sourceId: src });
      const { contactId, conversationId } = await mkContact();

      await attribution.registrarAnuncioDeOrigen({ organizationId: org, contactId, conversationId, anuncio: anuncio(src) });

      const [run] = await runsOf(flowId, contactId);
      expect(run).toMatchObject({ status: "running" });
      expect(run!.context).toMatchObject({ adSourceId: src, headline: "Corte 2x1", serviceName: `Corte clásico ${uid}` });
      expect(run!.dedupeKey).toBe(`ad_referral:${src}`);

      const t = deps();
      await drain(flowId, contactId, t.d);
      expect(t.sent).toEqual([`Hola Cliente Resp, vi que te interesa Corte clásico ${uid}`]);
      expect(await tagsOf(contactId)).toEqual([tagA]);
      expect((await runsOf(flowId, contactId))[0]).toMatchObject({ status: "completed" });
    });

    it("una reentrega del webhook (mismo anuncio) no arranca otra ejecución", async () => {
      const src = `ad${uid}2`;
      const { flowId } = await makeFlow("ad_referral", withTags(SEND_AND_TAG), { sourceId: src });
      const { contactId, conversationId } = await mkContact();
      const input = { organizationId: org, contactId, conversationId, anuncio: anuncio(src) };
      await attribution.registrarAnuncioDeOrigen(input);
      await attribution.registrarAnuncioDeOrigen(input);
      await attribution.registrarAnuncioDeOrigen(input);
      expect(await runsOf(flowId, contactId)).toHaveLength(1);
      expect(await queueOf(flowId, contactId)).toHaveLength(1);
    });

    it("un anuncio distinto no arranca un flujo acotado a otro; uno sin acotar reacciona a cualquiera", async () => {
      const only = await makeFlow("ad_referral", withTags(SEND_AND_TAG), { sourceId: `ad${uid}-solo` });
      const any = await makeFlow("ad_referral", withTags(SEND_AND_TAG));
      const { contactId, conversationId } = await mkContact();
      await attribution.registrarAnuncioDeOrigen({ organizationId: org, contactId, conversationId, anuncio: anuncio(`ad${uid}-otro`) });
      expect(await runsOf(only.flowId, contactId)).toHaveLength(0);
      expect(await runsOf(any.flowId, contactId)).toHaveLength(1);
    });

    it("sin servicio configurado el flujo arranca igual y {{servicio}} queda vacío", async () => {
      const src = `ad${uid}4`;
      const { flowId } = await makeFlow("ad_referral", withTags(SEND_AND_TAG), { sourceId: src });
      const { contactId, conversationId } = await mkContact();
      await attribution.registrarAnuncioDeOrigen({ organizationId: org, contactId, conversationId, anuncio: anuncio(src) });
      const [run] = await runsOf(flowId, contactId);
      expect(run!.context).toEqual({ adSourceId: src, headline: "Corte 2x1" });
      const t = deps();
      await drain(flowId, contactId, t.d);
      expect(t.sent).toEqual(["Hola Cliente Resp, vi que te interesa"]);
    });

    it("sin referral (sin source_id) no arranca nada; con el flujo apagado tampoco", async () => {
      const { flowId } = await makeFlow("ad_referral", withTags(SEND_AND_TAG));
      await flows.updateFlow(org, flowId, { active: false });
      const a = await mkContact();
      await attribution.registrarAnuncioDeOrigen({ organizationId: org, contactId: a.contactId, conversationId: a.conversationId, anuncio: anuncio(`ad${uid}5`) });
      expect(await runsOf(flowId, a.contactId)).toHaveLength(0);
      const b = await mkContact();
      await attribution.registrarAnuncioDeOrigen({
        organizationId: org,
        contactId: b.contactId,
        conversationId: b.conversationId,
        anuncio: { ...anuncio("x"), sourceId: null },
      });
      expect(await runsOf(flowId, b.contactId)).toHaveLength(0);
    });

    it("un contacto sin chat de WhatsApp real no arranca nada", async () => {
      const src = `ad${uid}6`;
      const { flowId } = await makeFlow("ad_referral", withTags(SEND_AND_TAG), { sourceId: src });
      const contactId = `ct_r${uid}nochat`;
      await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Sin chat", waIdentity: `nc-${uid}` });
      created.contacts.push(contactId);
      const { emitAdReferral } = await import("@/server/automation/ad-referral");
      expect(await emitAdReferral({ organizationId: org, contactId, sourceId: src })).toBe(0);
      expect(await runsOf(flowId, contactId)).toHaveLength(0);
    });
  });
});
