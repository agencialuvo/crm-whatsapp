import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Disparadores de automatizaciones contra PostgreSQL REAL: el barrido de cumpleaños, el enganche de la
 * puerta del embudo (`moveLeadToStage` / `recordLeadCreated`) y que el índice único evita duplicados.
 *
 * Necesita una base con las migraciones aplicadas, así que NO corre con `pnpm test`:
 *   pnpm test:db   (secuencial: estas suites comparten la base y la cola)
 * Crea sus propios contactos, flujos y leads y los borra al terminar (borrar el contacto y el flujo
 * arrastra cola, bitácora de etapas y conversación por cascada).
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("disparadores contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let triggers: typeof import("@/server/automation/triggers");
  let moveLeadToStage: (typeof import("@/server/leads/stage-history"))["moveLeadToStage"];
  let recordLeadCreated: (typeof import("@/server/leads/stage-history"))["recordLeadCreated"];
  let todayInTz: (typeof import("@/lib/time/slots"))["todayInTz"];
  let businessTimezone: (typeof import("@/server/analytics/period"))["businessTimezone"];

  let orgId = "";
  let stageA = "";
  let stageB = "";
  const tag = Date.now().toString(36);
  const contactIds: string[] = [];
  const flowIds: string[] = [];
  const prevFlag = process.env.AUTOMATIONS;

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    ({ eq, inArray } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    triggers = await import("@/server/automation/triggers");
    ({ moveLeadToStage, recordLeadCreated } = await import("@/server/leads/stage-history"));
    ({ todayInTz } = await import("@/lib/time/slots"));
    ({ businessTimezone } = await import("@/server/analytics/period"));

    const [org] = await db.select({ id: schema.organization.id }).from(schema.organization).limit(1);
    orgId = org!.id;
    const open = (
      await db
        .select({ id: schema.pipelineStage.id, kind: schema.pipelineStage.kind })
        .from(schema.pipelineStage)
        .where(eq(schema.pipelineStage.organizationId, orgId))
        .orderBy(schema.pipelineStage.position)
    ).filter((s) => s.kind === "open");
    expect(open.length, "la organización necesita al menos 2 etapas abiertas").toBeGreaterThanOrEqual(2);
    stageA = open[0]!.id;
    stageB = open[1]!.id;
  });

  afterAll(async () => {
    if (prevFlag === undefined) delete process.env.AUTOMATIONS;
    else process.env.AUTOMATIONS = prevFlag;
    if (flowIds.length) await db.delete(schema.automationFlow).where(inArray(schema.automationFlow.id, flowIds));
    if (contactIds.length) await db.delete(schema.contact).where(inArray(schema.contact.id, contactIds));
  });

  let seq = 0;
  async function makeContact(opts: { birthday?: { day: number; month: number }; conversation?: boolean } = {}) {
    const id = `ct_t${tag}${seq++}`;
    contactIds.push(id);
    await db.insert(schema.contact).values({
      id,
      organizationId: orgId,
      name: "Prueba disparadores",
      waIdentity: `t-${id}`,
      birthdayDay: opts.birthday?.day ?? null,
      birthdayMonth: opts.birthday?.month ?? null,
    });
    if (opts.conversation !== false) {
      await db.insert(schema.conversation).values({ id: `cv_t${tag}${seq++}`, organizationId: orgId, contactId: id });
    }
    return id;
  }

  async function makeFlow(
    triggerType: "birthday" | "stage_changed" | "lead_created",
    triggerConfig: unknown = null,
    steps = 2
  ) {
    const id = `aut_t${tag}${seq++}`;
    flowIds.push(id);
    await db.insert(schema.automationFlow).values({ id, organizationId: orgId, name: "t", triggerType, triggerConfig });
    const stepIds: string[] = [];
    for (let i = 0; i < steps; i++) {
      const sid = `stp_t${tag}${seq++}`;
      stepIds.push(sid);
      await db.insert(schema.automationStep).values({
        id: sid,
        organizationId: orgId,
        flowId: id,
        stepType: "send_whatsapp",
        config: { content: "Hola" },
        // El primero en el orden del lienzo es el de menor Y: se inserta en desorden a propósito.
        positionY: (steps - i) * 100,
      });
    }
    // El de menor `positionY` es el último insertado.
    return { id, firstStepId: stepIds[steps - 1] ?? null };
  }

  const queueRows = (flowId: string, contactId?: string) =>
    db
      .select()
      .from(schema.automationQueue)
      .where(eq(schema.automationQueue.flowId, flowId))
      .then((rows) => (contactId ? rows.filter((r) => r.contactId === contactId) : rows));

  describe("cumpleaños", () => {
    it("encola el primer paso para quien cumple hoy (en la zona del negocio), a las 10:00, y no duplica", async () => {
      const tz = await businessTimezone(orgId);
      const now = new Date();
      const today = todayInTz(now, tz);
      const [, m, d] = today.split("-").map(Number);
      const flow = await makeFlow("birthday");
      const hoy = await makeContact({ birthday: { day: d!, month: m! } });
      await makeContact({ birthday: { day: d! === 1 ? 2 : 1, month: m! === 12 ? 1 : (m! % 12) + 1 } });
      await makeContact({ birthday: { day: d!, month: m! }, conversation: false });

      const first = await triggers.runBirthdayTrigger(now);
      expect(first.enqueued).toBeGreaterThanOrEqual(1);

      const rows = await queueRows(flow.id);
      expect(rows.map((r) => r.contactId)).toEqual([hoy]); // ni «otro día» ni quien no tiene chat
      expect(rows[0]).toMatchObject({
        status: "pending",
        stepId: flow.firstStepId,
        dedupeKey: `birthday:${today.slice(0, 4)}`,
      });
      expect(rows[0]!.scheduledFor.toISOString()).toBe(
        (await import("@/lib/automation")).birthdaySendAt(today, undefined, tz)!.toISOString()
      );

      // Repetir el barrido (o reiniciar la app) no duplica.
      const second = await triggers.runBirthdayTrigger(now);
      expect(second.enqueued).toBe(0);
      expect(await queueRows(flow.id)).toHaveLength(1);
    });

    it("la hora configurada en el flujo manda", async () => {
      const tz = await businessTimezone(orgId);
      const now = new Date();
      const today = todayInTz(now, tz);
      const [, m, d] = today.split("-").map(Number);
      const flow = await makeFlow("birthday", { hour: 8 });
      const mine = await makeContact({ birthday: { day: d!, month: m! } });
      await triggers.runBirthdayTrigger(now);
      // Los cumpleañeros de otros tests de esta suite también están en la base: se mira solo el propio.
      const rows = await queueRows(flow.id, mine);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.scheduledFor.toISOString()).toBe(
        (await import("@/lib/automation")).birthdaySendAt(today, 8, tz)!.toISOString()
      );
    });

    it("un flujo apagado o sin pasos no encola", async () => {
      const tz = await businessTimezone(orgId);
      const now = new Date();
      const [, m, d] = todayInTz(now, tz).split("-").map(Number);
      const off = await makeFlow("birthday");
      await db.update(schema.automationFlow).set({ active: false }).where(eq(schema.automationFlow.id, off.id));
      const empty = await makeFlow("birthday", null, 0);
      await makeContact({ birthday: { day: d!, month: m! } });
      await triggers.runBirthdayTrigger(now);
      expect(await queueRows(off.id)).toHaveLength(0);
      expect(await queueRows(empty.id)).toHaveLength(0);
    });
  });

  describe("embudo (moveLeadToStage / recordLeadCreated)", () => {
    async function makeLead(contactId: string, stageId: string) {
      const id = `ld_t${tag}${seq++}`;
      await db.insert(schema.lead).values({ id, organizationId: orgId, contactId, stageId });
      return id;
    }

    it("entrar a una etapa encola el primer paso de los flujos que reaccionan, una vez por lead y etapa", async () => {
      const any = await makeFlow("stage_changed");
      const toB = await makeFlow("stage_changed", { toStageId: stageB });
      const toA = await makeFlow("stage_changed", { toStageId: stageA });
      const ct = await makeContact();
      const lead = await makeLead(ct, stageA);
      const move = (to: string) =>
        moveLeadToStage({ organizationId: orgId, leadId: lead, toStageId: to, source: "sistema" });

      expect((await move(stageB)).ok).toBe(true);
      expect(await queueRows(any.id, ct)).toHaveLength(1);
      expect(await queueRows(toB.id, ct)).toHaveLength(1);
      expect(await queueRows(toA.id, ct)).toHaveLength(0);
      expect((await queueRows(toB.id, ct))[0]).toMatchObject({
        stepId: toB.firstStepId,
        dedupeKey: `stage:${lead}:${stageB}`,
        status: "pending",
      });

      // Reordenar dentro de la misma etapa no es un cambio: no dispara.
      await move(stageB);
      expect(await queueRows(any.id, ct)).toHaveLength(1);

      // A → B → A → B: volver a B no repite; A dispara una vez.
      await move(stageA);
      expect(await queueRows(toA.id, ct)).toHaveLength(1);
      await move(stageB);
      expect(await queueRows(any.id, ct)).toHaveLength(2); // una por etapa (B y A), no una por movimiento
      expect(await queueRows(toB.id, ct)).toHaveLength(1);
    });

    it("un lead nuevo dispara los flujos lead_created, una sola vez", async () => {
      const flow = await makeFlow("lead_created");
      const stage = await makeFlow("stage_changed"); // este no debe dispararse con el nacimiento
      const ct = await makeContact();
      const lead = await makeLead(ct, stageA);
      const born = { organizationId: orgId, leadId: lead, contactId: ct, stageId: stageA };
      await recordLeadCreated(born);
      await recordLeadCreated(born);
      expect(await queueRows(flow.id, ct)).toHaveLength(1);
      expect((await queueRows(flow.id, ct))[0]).toMatchObject({ dedupeKey: `lead_created:${lead}` });
      expect(await queueRows(stage.id, ct)).toHaveLength(0);
    });

    it("sin chat de WhatsApp real no encola, y con las automatizaciones apagadas tampoco", async () => {
      const flow = await makeFlow("stage_changed");
      const sinChat = await makeContact({ conversation: false });
      const l1 = await makeLead(sinChat, stageA);
      await moveLeadToStage({ organizationId: orgId, leadId: l1, toStageId: stageB, source: "sistema" });
      expect(await queueRows(flow.id, sinChat)).toHaveLength(0);

      const conChat = await makeContact();
      const l2 = await makeLead(conChat, stageA);
      process.env.AUTOMATIONS = "off";
      try {
        await moveLeadToStage({ organizationId: orgId, leadId: l2, toStageId: stageB, source: "sistema" });
      } finally {
        process.env.AUTOMATIONS = "on";
      }
      expect(await queueRows(flow.id, conChat)).toHaveLength(0);
    });

    it("el movimiento del lead se guarda aunque el disparador falle", async () => {
      const flow = await makeFlow("stage_changed", { toStageId: stageB });
      const ct = await makeContact();
      const lead = await makeLead(ct, stageA);
      // Un flujo cuyo paso se borra a mitad no rompe el movimiento: simplemente no encola.
      await db.delete(schema.automationStep).where(eq(schema.automationStep.flowId, flow.id));
      const res = await moveLeadToStage({ organizationId: orgId, leadId: lead, toStageId: stageB, source: "sistema" });
      expect(res.ok && res.changed).toBe(true);
      const [row] = await db.select({ stageId: schema.lead.stageId }).from(schema.lead).where(eq(schema.lead.id, lead));
      expect(row?.stageId).toBe(stageB);
      expect(await queueRows(flow.id, ct)).toHaveLength(0);
    });
  });
});
