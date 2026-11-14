import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Fase 2 contra PostgreSQL REAL (`pnpm test:db`): etiquetas (únicas sin distinguir mayúsculas, asignación
 * idempotente, cascadas, aislamiento entre organizaciones), los pasos `add_tag`/`remove_tag`/`set_stage`/
 * `condition` con la cola de verdad, y el anti-bucle: un `set_stage` NO dispara un flujo `stage_changed`,
 * mientras que un movimiento manual sí. Nada toca la API de WhatsApp. Crea y borra lo suyo.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("etiquetas y acciones de CRM contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let tags: typeof import("@/server/tags/store");
  let flows: typeof import("@/server/automation/flows");
  let worker: typeof import("@/server/automation/worker");
  let engine: typeof import("@/server/automation/engine");
  let schemas: typeof import("@/lib/automation-schemas");
  let stageHistory: typeof import("@/server/leads/stage-history");

  const uid = Date.now().toString(36);
  let org = "";
  let otherOrg = "";
  let contactId = "";
  let otherContactId = "";
  let leadId = "";
  let stageA = "";
  let stageB = "";
  let stageLost = "";
  const created = { flows: [] as string[], tags: [] as string[] };

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    ({ eq, inArray } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    tags = await import("@/server/tags/store");
    flows = await import("@/server/automation/flows");
    worker = await import("@/server/automation/worker");
    engine = await import("@/server/automation/engine");
    schemas = await import("@/lib/automation-schemas");
    stageHistory = await import("@/server/leads/stage-history");

    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    expect(orgs.length, "hacen falta dos organizaciones").toBeGreaterThanOrEqual(2);
    org = orgs[0]!.id;
    otherOrg = orgs[1]!.id;

    contactId = `ct_t${uid}`;
    otherContactId = `ct_u${uid}`;
    await db.insert(schema.contact).values([
      { id: contactId, organizationId: org, name: "Cliente Etiquetas", waIdentity: `tg-${uid}`, phone: "5215558880" },
      { id: otherContactId, organizationId: otherOrg, name: "Otro negocio", waIdentity: `tg2-${uid}`, phone: "5215558881" },
    ]);
    await db.insert(schema.conversation).values({ id: `cv_t${uid}`, organizationId: org, contactId, lastInboundAt: new Date() });

    stageA = `stg_ta${uid}`;
    stageB = `stg_tb${uid}`;
    stageLost = `stg_tl${uid}`;
    await db.insert(schema.pipelineStage).values([
      { id: stageA, organizationId: org, name: `A ${uid}`, position: 900, kind: "open" },
      { id: stageB, organizationId: org, name: `B ${uid}`, position: 901, kind: "open" },
      { id: stageLost, organizationId: org, name: `Perdido ${uid}`, position: 902, kind: "lost" },
    ]);
    leadId = `ld_t${uid}`;
    await db.insert(schema.lead).values({ id: leadId, organizationId: org, contactId, stageId: stageA });
  });

  afterAll(async () => {
    if (!db) return;
    if (created.flows.length) await db.delete(schema.automationFlow).where(inArray(schema.automationFlow.id, created.flows));
    if (created.tags.length) await db.delete(schema.tag).where(inArray(schema.tag.id, created.tags));
    await db.delete(schema.lead).where(eq(schema.lead.id, leadId));
    await db.delete(schema.pipelineStage).where(inArray(schema.pipelineStage.id, [stageA, stageB, stageLost]));
    await db.delete(schema.conversation).where(eq(schema.conversation.id, `cv_t${uid}`));
    await db.delete(schema.contact).where(inArray(schema.contact.id, [contactId, otherContactId]));
  });

  const mkTag = async (name: string, organization = org, color = "blue") => {
    const t = await tags.createTag(organization, { name: `${name} ${uid}`, color });
    created.tags.push(t.id);
    return t;
  };

  async function makeFlow(triggerType: string, steps: { stepType: string; config: Record<string, unknown> }[], triggerConfig?: unknown) {
    const flow = await flows.createFlow(
      org,
      schemas.flowCreateSchema.parse({ name: `F2 ${uid}${created.flows.length}`, triggerType, ...(triggerConfig ? { triggerConfig } : {}) })
    );
    created.flows.push(flow.id);
    for (const [i, s] of steps.entries()) {
      await flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ ...s, positionY: i * 100 }));
    }
    await flows.updateFlow(org, flow.id, { active: true });
    return flow.id;
  }

  const rowsOf = (flowId: string) =>
    db.select().from(schema.automationQueue).where(eq(schema.automationQueue.flowId, flowId)).orderBy(schema.automationQueue.createdAt);

  /** Corre la cola del flujo hasta vaciarla, con el envío simulado y todo lo demás real. */
  async function drain(flowId: string) {
    const sendText = vi.fn(async () => ({ messageId: "msg_fake" }));
    const deps: import("@/server/automation/engine").Deps = {
      ...worker.defaultDeps(),
      sendText,
      sendTemplate: vi.fn(async () => ({ messageId: "msg_fake" })),
      waMessageIdOf: async () => null,
    };
    for (let guard = 0; guard < 12; guard++) {
      const pending = (await rowsOf(flowId)).find((r) => r.status === "pending");
      if (!pending) break;
      await engine.processRow(pending as never, deps);
    }
    return { sendText };
  }

  const logsOf = (flowId: string) =>
    db.select().from(schema.automationExecutionLog).where(eq(schema.automationExecutionLog.flowId, flowId));

  const resetContact = async () => {
    await db.delete(schema.contactTag).where(eq(schema.contactTag.contactId, contactId));
    await db.update(schema.lead).set({ stageId: stageA }).where(eq(schema.lead.id, leadId));
  };

  describe("etiquetas", () => {
    it("el nombre es único por organización sin distinguir mayúsculas, y el mismo nombre vale en otra", async () => {
      const t = await mkTag("Vip");
      await expect(tags.createTag(org, { name: ` VIP ${uid} `, color: "red" })).rejects.toMatchObject({ code: "duplicate" });
      await expect(tags.createTag(org, { name: `vip ${uid}`, color: "red" })).rejects.toMatchObject({ code: "duplicate" });
      const other = await mkTag("Vip", otherOrg);
      expect(other.id).not.toBe(t.id);
      // «al vuelo» reutiliza la existente en vez de duplicar.
      expect((await tags.ensureTag(org, { name: `VIP ${uid}`, color: "green" })).id).toBe(t.id);
    });

    it("asignar es idempotente y quitar lo que no está no falla", async () => {
      await resetContact();
      const t = await mkTag("Idem");
      expect(await tags.assignTag(org, contactId, t.id)).toBe(true);
      expect(await tags.assignTag(org, contactId, t.id)).toBe(false);
      expect((await tags.tagsOfContact(org, contactId)).map((x) => x.id)).toEqual([t.id]);
      expect(await tags.unassignTag(org, contactId, t.id)).toBe(true);
      expect(await tags.unassignTag(org, contactId, t.id)).toBe(false);
      expect(await tags.tagsOfContact(org, contactId)).toEqual([]);
    });

    it("aislamiento: no se asigna una etiqueta ajena ni a un contacto ajeno", async () => {
      const mine = await mkTag("Mia");
      const theirs = await mkTag("Suya", otherOrg);
      await expect(tags.assignTag(org, contactId, theirs.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(tags.assignTag(org, otherContactId, mine.id)).rejects.toMatchObject({ code: "contact_not_found" });
      await expect(tags.updateTag(org, theirs.id, { name: "Hackeada" })).rejects.toMatchObject({ code: "not_found" });
      await expect(tags.deleteTag(org, theirs.id)).rejects.toMatchObject({ code: "not_found" });
      expect((await tags.listTags(org)).some((x) => x.id === theirs.id)).toBe(false);
      expect(await tags.tagIdsOfContact(otherOrg, contactId)).toEqual([]);
    });

    it("renombrar respeta la unicidad y borrar limpia las asignaciones (cascada); la lista cuenta contactos", async () => {
      await resetContact();
      const a = await mkTag("Alfa");
      const b = await mkTag("Beta");
      await tags.assignTag(org, contactId, a.id);
      expect((await tags.listTags(org)).find((x) => x.id === a.id)?.contactCount).toBe(1);
      await expect(tags.updateTag(org, b.id, { name: `ALFA ${uid}` })).rejects.toMatchObject({ code: "duplicate" });
      expect(await tags.updateTag(org, b.id, { color: "pink" })).toMatchObject({ id: b.id, color: "pink" });
      await tags.deleteTag(org, a.id);
      expect(await tags.tagIdsOfContact(org, contactId)).toEqual([]);
    });

    it("borrar un contacto se lleva sus asignaciones", async () => {
      const t = await mkTag("Cascada");
      const id = `ct_c${uid}`;
      await db.insert(schema.contact).values({ id, organizationId: org, name: "Efímero", waIdentity: `eph-${uid}` });
      await tags.assignTag(org, id, t.id);
      await db.delete(schema.contact).where(eq(schema.contact.id, id));
      const left = await db.select().from(schema.contactTag).where(eq(schema.contactTag.contactId, id));
      expect(left).toEqual([]);
    });
  });

  describe("validación al guardar pasos", () => {
    it("rechaza etiquetas y etapas de otra organización", async () => {
      const theirs = await mkTag("Ajena", otherOrg);
      const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `V ${uid}`, triggerType: "lead_created" }));
      created.flows.push(flow.id);
      const add = (stepType: string, config: Record<string, unknown>) =>
        flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ stepType, config }));
      await expect(add("add_tag", { tagId: theirs.id })).rejects.toMatchObject({ code: "tag_not_found" });
      await expect(add("condition", { rule: { type: "tag_has", tagId: theirs.id } })).rejects.toMatchObject({ code: "tag_not_found" });
      await expect(add("set_stage", { stageId: "stg_inexistente" })).rejects.toMatchObject({ code: "stage_not_found" });
      await expect(add("condition", { rule: { type: "stage_is", stageId: "stg_inexistente" } })).rejects.toMatchObject({
        code: "stage_not_found",
      });
      // Los propios sí pasan.
      const mine = await mkTag("Propia");
      await expect(add("add_tag", { tagId: mine.id })).resolves.toMatchObject({ stepType: "add_tag" });
      await expect(add("set_stage", { stageId: stageB })).resolves.toMatchObject({ stepType: "set_stage" });
    });

    it("«la cita está confirmada» solo en flujos que empiezan con una cita", async () => {
      const lead = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `C1 ${uid}`, triggerType: "lead_created" }));
      const book = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `C2 ${uid}`, triggerType: "booking_created" }));
      created.flows.push(lead.id, book.id);
      const cond = schemas.stepCreateSchema.parse({ stepType: "condition", config: { rule: { type: "booking_confirmed" } } });
      await expect(flows.createStep(org, lead.id, cond)).rejects.toMatchObject({ code: "condition_requires_booking" });
      await expect(flows.createStep(org, book.id, cond)).resolves.toMatchObject({ stepType: "condition" });
    });
  });

  describe("pasos de CRM con la cola real", () => {
    it("add_tag → condition → set_stage → condition falsa que termina; sin enviar nada", async () => {
      await resetContact();
      const a = await mkTag("Flujo A");
      const b = await mkTag("Flujo B");
      const flowId = await makeFlow("lead_created", [
        { stepType: "add_tag", config: { tagId: a.id } },
        { stepType: "condition", config: { rule: { type: "tag_has", tagId: a.id } } }, // verdadero → continúa
        { stepType: "set_stage", config: { stageId: stageB } },
        { stepType: "condition", config: { rule: { type: "tag_has", tagId: b.id } } }, // falso → termina
        { stepType: "send_whatsapp", config: { content: "no debe salir" } },
      ]);
      const { onLeadCreated } = await import("@/server/automation/triggers");
      expect(await onLeadCreated({ organizationId: org, leadId, contactId })).toBeGreaterThanOrEqual(1);

      const { sendText } = await drain(flowId);
      expect(sendText).not.toHaveBeenCalled();

      expect(await tags.tagIdsOfContact(org, contactId)).toEqual([a.id]);
      const [lead] = await db.select().from(schema.lead).where(eq(schema.lead.id, leadId));
      expect(lead!.stageId).toBe(stageB);

      const rows = await rowsOf(flowId);
      expect(rows).toHaveLength(4); // el 5.º (envío) nunca se encola
      expect(rows.every((r) => r.status === "completed")).toBe(true);
      const logs = await logsOf(flowId);
      expect(logs.filter((l) => l.status === "success")).toHaveLength(4);
      const last = logs.find((l) => (l.metadata as { branch?: string }).branch === "false");
      expect(last?.metadata).toMatchObject({ result: false, handle: "false" });
    });

    it("set_stage deja el evento en la bitácora como «sistema» con el origen y el destino", async () => {
      await resetContact();
      const flowId = await makeFlow("lead_created", [{ stepType: "set_stage", config: { stageId: stageB } }]);
      const { onLeadCreated } = await import("@/server/automation/triggers");
      // El disparo es único por lead: lo repetimos con otro lead sería otro caso; aquí solo ejecutamos la fila.
      await onLeadCreated({ organizationId: org, leadId, contactId });
      await drain(flowId);
      const events = await db
        .select()
        .from(schema.leadStageEvent)
        .where(eq(schema.leadStageEvent.leadId, leadId))
        .orderBy(schema.leadStageEvent.occurredAt);
      const last = events.at(-1)!;
      expect(last).toMatchObject({ toStageId: stageB, fromStageId: stageA, source: "sistema" });
    });

    it("skip_next omite el paso siguiente y sigue con el que viene después", async () => {
      await resetContact();
      const a = await mkTag("Skip A");
      const c = await mkTag("Skip C");
      const d = await mkTag("Skip D");
      await tags.assignTag(org, contactId, a.id);
      const flowId = await makeFlow("manual", [
        { stepType: "condition", config: { rule: { type: "tag_has", tagId: a.id }, ifTrue: "skip_next" } },
        { stepType: "add_tag", config: { tagId: c.id } }, // omitido
        { stepType: "add_tag", config: { tagId: d.id } },
      ]);
      const store = await import("@/server/automation/trigger-store");
      const flow = (await store.dbTriggerStore.activeFlows(org, "manual")).find((f) => f.id === flowId)!;
      await store.dbTriggerStore.enqueueFirstStep({ organizationId: org, flowId: flow.id, contactId, dedupeKey: `t:${uid}:skip`, scheduledFor: new Date() });
      await drain(flowId);
      const mine = (await tags.tagIdsOfContact(org, contactId)).sort();
      expect(mine).toEqual([a.id, d.id].sort());
    });

    it("un paso con la etiqueta borrada falla a la vista y no encola el siguiente", async () => {
      await resetContact();
      const gone = await mkTag("Efímera");
      const flowId = await makeFlow("lead_created", [
        { stepType: "add_tag", config: { tagId: gone.id } },
        { stepType: "set_stage", config: { stageId: stageB } },
      ]);
      await tags.deleteTag(org, gone.id);
      const { onLeadCreated } = await import("@/server/automation/triggers");
      await onLeadCreated({ organizationId: org, leadId, contactId });
      await drain(flowId);
      const rows = await rowsOf(flowId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "failed", error: "tag_not_found" });
      const [lead] = await db.select().from(schema.lead).where(eq(schema.lead.id, leadId));
      expect(lead!.stageId).toBe(stageA); // el set_stage jamás corrió
    });

    it("set_stage a una etapa perdida no falla por falta de motivo", async () => {
      await resetContact();
      const flowId = await makeFlow("manual", [{ stepType: "set_stage", config: { stageId: stageLost } }]);
      const store = await import("@/server/automation/trigger-store");
      await store.dbTriggerStore.enqueueFirstStep({ organizationId: org, flowId, contactId, dedupeKey: `t:${uid}:lost`, scheduledFor: new Date() });
      await drain(flowId);
      expect((await rowsOf(flowId))[0]).toMatchObject({ status: "completed" });
      const [ev] = await db
        .select()
        .from(schema.leadStageEvent)
        .where(eq(schema.leadStageEvent.toStageId, stageLost));
      expect(ev).toMatchObject({ lossReason: "otro", lossNote: "Automatización", source: "sistema" });
    });

    it("un contacto sin lead hace fallar set_stage a la vista", async () => {
      await resetContact();
      const id = `ct_n${uid}`;
      await db.insert(schema.contact).values({ id, organizationId: org, name: "Sin lead", waIdentity: `nl-${uid}` });
      try {
        const flowId = await makeFlow("manual", [{ stepType: "set_stage", config: { stageId: stageB } }]);
        const store = await import("@/server/automation/trigger-store");
        await store.dbTriggerStore.enqueueFirstStep({ organizationId: org, flowId, contactId: id, dedupeKey: `t:${uid}:nl`, scheduledFor: new Date() });
        await drain(flowId);
        expect((await rowsOf(flowId))[0]).toMatchObject({ status: "failed", error: "contact_has_no_lead" });
      } finally {
        await db.delete(schema.contact).where(eq(schema.contact.id, id));
      }
    });
  });

  describe("anti-bucle", () => {
    it("un set_stage NO dispara un flujo stage_changed; un movimiento manual SÍ", async () => {
      await resetContact();
      const watcher = await makeFlow("stage_changed", [{ stepType: "add_tag", config: { tagId: (await mkTag("Vigilante")).id } }], {
        toStageId: stageB,
      });

      // 1) Lo mueve una automatización: el flujo vigilante no se entera (si se enterara, podría encadenarse sin fin).
      const moved = await (await import("@/server/automation/actions")).moveContactToStage(org, contactId, stageB);
      expect(moved).toMatchObject({ status: "moved", toStageId: stageB, fromStageId: stageA });
      expect(await rowsOf(watcher)).toHaveLength(0);

      // 2) Lo mueve una persona (de A a B de nuevo): el flujo vigilante sí corre.
      await db.update(schema.lead).set({ stageId: stageA }).where(eq(schema.lead.id, leadId));
      const manual = await stageHistory.moveLeadToStage({ organizationId: org, leadId, toStageId: stageB, source: "dueno" });
      expect(manual).toMatchObject({ ok: true, changed: true });
      expect(await rowsOf(watcher)).toHaveLength(1);
    });
  });

  describe("condition con la cita", () => {
    it("booking_confirmed lee confirmed_at al ejecutar: confirmada corta, sin confirmar continúa", async () => {
      await resetContact();
      const pend = await mkTag("Pendiente");
      const flowId = await makeFlow("booking_created", [
        { stepType: "condition", config: { rule: { type: "booking_confirmed" }, ifTrue: "stop", ifFalse: "continue" } },
        { stepType: "add_tag", config: { tagId: pend.id } },
      ]);
      const { onBookingCreated } = await import("@/server/automation/triggers");
      const mkBooking = async (n: number, confirmed: boolean) => {
        const id = `bk_t${uid}${n}`;
        const at = new Date(Date.now() + (3 + n) * 86_400_000);
        await db.insert(schema.booking).values({
          id,
          organizationId: org,
          kind: "session",
          status: "agendada",
          source: "manual",
          contactId,
          scheduledAt: at,
          durationMinutes: 30,
          connector: "enlace-fijo",
          ...(confirmed ? { confirmedAt: new Date() } : {}),
        });
        await onBookingCreated({ organizationId: org, bookingId: id, contactId, scheduledAt: at });
        return id;
      };
      const ids: string[] = [];
      try {
        ids.push(await mkBooking(0, true));
        await drain(flowId);
        expect(await tags.tagIdsOfContact(org, contactId)).toEqual([]); // confirmada → terminó, no etiquetó

        ids.push(await mkBooking(1, false));
        await drain(flowId);
        expect(await tags.tagIdsOfContact(org, contactId)).toEqual([pend.id]); // sin confirmar → siguió
      } finally {
        await db.delete(schema.automationFlow).where(eq(schema.automationFlow.id, flowId));
        created.flows = created.flows.filter((f) => f !== flowId);
        if (ids.length) await db.delete(schema.booking).where(inArray(schema.booking.id, ids));
      }
    });
  });
});
