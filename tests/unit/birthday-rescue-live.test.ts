import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Cumpleaños — Paso 3 contra PostgreSQL REAL (`pnpm test:db`): la audiencia del rescate (sin cita ni compra, sin
 * baja, con chat real; nada del Laboratorio), el lanzamiento por el motor de automatizaciones con la llave
 * `birthday_rescue:AAAA-MM`, la deduplicación del mes (relanzar, otro flujo, dos lanzamientos a la vez) y el
 * resultado en el Panel. Usa el mes REAL de hoy (el lanzamiento lee el día del negocio). Crea y borra lo suyo.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("rescate de cumpleaños contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let campaign: typeof import("@/server/business/birthday-campaign");
  let rescue: typeof import("@/server/business/birthday-rescue");

  const tag = Date.now().toString(36);
  const org = `org_rs${tag}`;
  const other = `org_rsx${tag}`;
  const USER = `usr_rs${tag}`;
  const ct = (k: string) => `ct_rs${k}${tag}`;
  let seq = 0;
  const id = (p: string) => `${p}_rs${tag}${seq++}`;
  let tz = "";
  let today = "";
  let year = 0;
  let month = 0;
  let period = "";
  let inWindow = new Date();
  let flowManual = "";
  let flowManual2 = "";
  let flowBirthday = "";

  async function contact(k: string, over: Record<string, unknown> = {}, orgId = org) {
    await db.insert(schema.contact).values({
      id: ct(k),
      organizationId: orgId,
      name: k,
      waIdentity: `rs-${k}-${tag}`,
      phone: "51999000111",
      salonClient: true,
      birthdayDay: 1,
      birthdayMonth: month,
      ...over,
    });
  }
  async function chat(k: string, isTest = false, orgId = org) {
    const cv = id("cv");
    await db.insert(schema.conversation).values({ id: cv, organizationId: orgId, contactId: ct(k), isTest, lastInboundAt: new Date() });
    return cv;
  }
  const rescueRuns = () =>
    db
      .select({ contactId: schema.automationRun.contactId, flowId: schema.automationRun.flowId })
      .from(schema.automationRun)
      .where(and(eq(schema.automationRun.organizationId, org), eq(schema.automationRun.dedupeKey, `birthday_rescue:${period}`)));

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    ({ eq, and, inArray } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    campaign = await import("@/server/business/birthday-campaign");
    rescue = await import("@/server/business/birthday-rescue");
    const flows = await import("@/server/automation/flows");
    const schemas = await import("@/lib/automation-schemas");
    const { businessTimezone } = await import("@/server/analytics/period");
    const { todayInTz } = await import("@/lib/time/slots");

    await db.insert(schema.organization).values([
      { id: org, name: `Rescate ${tag}`, slug: `rescate-${tag}` },
      { id: other, name: `Rescate otra ${tag}`, slug: `rescate-otra-${tag}` },
    ]);
    await db.insert(schema.user).values({ id: USER, name: "Dueña", email: `rs-${tag}@example.test` });
    tz = await businessTimezone(org);
    today = todayInTz(new Date(), tz);
    year = Number(today.slice(0, 4));
    month = Number(today.slice(5, 7));
    period = today.slice(0, 7);
    inWindow = new Date(campaign.birthdayWindow(year, month, tz).start.getTime() + 12 * 3_600_000);

    const makeFlow = async (name: string, triggerType: string) => {
      const f = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name, triggerType }));
      await flows.createStep(org, f.id, schemas.stepCreateSchema.parse({ stepType: "send_whatsapp", config: { content: "¡Última oportunidad!" }, positionY: 0 }));
      await flows.updateFlow(org, f.id, { active: true });
      return f.id;
    };
    flowManual = await makeFlow(`Rescate ${tag}`, "manual");
    flowManual2 = await makeFlow(`Rescate B ${tag}`, "manual");
    flowBirthday = await makeFlow(`Saludo ${tag}`, "birthday");

    const svc = await db.insert(schema.service).values({ id: id("svc"), organizationId: org, name: "Corte", priceCents: 5000 }).returning();

    for (const k of ["libre", "saludado", "cita", "citaTest", "aprovecho", "baja", "soloLab"]) await contact(k);
    await contact("otroMes", { birthdayMonth: (month % 12) + 1 });
    for (const k of ["libre", "saludado", "cita", "citaTest", "aprovecho", "baja", "otroMes"]) await chat(k);
    await chat("soloLab", true); // solo un chat del Laboratorio: no hay a dónde enviar
    await db.update(schema.contact).set({ optedOutAt: new Date(), optOutSource: "keyword" }).where(eq(schema.contact.id, ct("baja")));

    // «saludado»: le llegó el saludo de cumpleaños de este año (sigue sin cita → entra al rescate).
    const runId = id("arn");
    await db.insert(schema.automationRun).values({ id: runId, organizationId: org, flowId: flowBirthday, contactId: ct("saludado"), status: "completed", dedupeKey: `birthday:${year}` });
    const [step] = await db.select({ id: schema.automationStep.id }).from(schema.automationStep).where(eq(schema.automationStep.flowId, flowBirthday));
    const queueId = id("que");
    await db.insert(schema.automationQueue).values({ id: queueId, organizationId: org, flowId: flowBirthday, contactId: ct("saludado"), stepId: step!.id, status: "completed", scheduledFor: new Date(), runId });
    await db.insert(schema.automationExecutionLog).values({ id: id("log"), organizationId: org, flowId: flowBirthday, stepId: step!.id, contactId: ct("saludado"), queueId, status: "success", metadata: { step: { stepType: "send_whatsapp" } } });

    const booking = (k: string, isTest: boolean) =>
      db.insert(schema.booking).values({ id: id("bk"), organizationId: org, kind: "session", status: "agendada", source: "manual", contactId: ct(k), scheduledAt: inWindow, durationMinutes: 30, isTest });
    await booking("cita", false);
    await booking("citaTest", true); // cita del Laboratorio: no cuenta, sigue sin cita
    await db.insert(schema.serviceSale).values({ id: id("sls"), organizationId: org, contactId: ct("aprovecho"), customerName: "aprovecho", serviceId: svc[0]!.id, amountCents: 5000, staffCommissionCents: 0, businessNetCents: 5000, paymentMethod: "efectivo", createdAt: inWindow });

    // Otra organización con un cumpleañero elegible: nunca debe tocarse.
    await contact("ajeno", {}, other);
    await chat("ajeno", false, other);
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.organization).where(inArray(schema.organization.id, [org, other]));
    await db.delete(schema.user).where(eq(schema.user.id, USER));
  });

  it("audiencia: sin cita ni compra, sin baja y con chat real; nada del Laboratorio cuenta", async () => {
    const b = await campaign.getBirthdayCampaign(org, today, tz);
    expect(Object.fromEntries(b.clients.map((c) => [c.name, c.rescueBlock]))).toEqual({
      libre: null,
      saludado: null,
      citaTest: null,
      cita: "booked",
      aprovecho: "converted",
      baja: "opted_out",
      soloLab: "no_conversation",
    });
    expect(b.rescue).toMatchObject({ period, available: true, eligible: 3, launched: 0, excluded: { opted_out: 1, no_conversation: 1 } });
    expect(b.rescue.flows.map((f) => f.id).sort()).toEqual([flowManual, flowManual2].sort());
  });

  it("lanzar encola por el motor con la llave del mes, sin tocar el saludo del año", async () => {
    const r = await rescue.launchBirthdayRescue({ organizationId: org, flowId: flowManual, triggeredBy: USER });
    expect(r).toMatchObject({ period, attempted: 3, enqueued: 3, skipped: [], remaining: 0 });
    const runs = await rescueRuns();
    expect(runs.map((x) => x.contactId).sort()).toEqual([ct("citaTest"), ct("libre"), ct("saludado")].sort());
    const queue = await db
      .select({ status: schema.automationQueue.status })
      .from(schema.automationQueue)
      .where(and(eq(schema.automationQueue.organizationId, org), eq(schema.automationQueue.flowId, flowManual)));
    expect(queue).toHaveLength(3);
    const claims = await db.select().from(schema.birthdayRescue).where(eq(schema.birthdayRescue.organizationId, org));
    expect(claims.map((c) => [c.period, c.flowId])).toEqual(Array(3).fill([period, flowManual]));
    // El saludo de cumpleaños (`birthday:AAAA`) sigue siendo uno solo.
    const greeting = await db.select().from(schema.automationRun).where(and(eq(schema.automationRun.organizationId, org), eq(schema.automationRun.dedupeKey, `birthday:${year}`)));
    expect(greeting).toHaveLength(1);
  });

  it("no hay reenvío en el mes: relanzar, otro flujo o pedir a esos clientes no crea más ejecuciones", async () => {
    const again = await rescue.launchBirthdayRescue({ organizationId: org, flowId: flowManual, triggeredBy: USER });
    expect(again.enqueued).toBe(0);
    const otherFlow = await rescue.launchBirthdayRescue({ organizationId: org, flowId: flowManual2, triggeredBy: USER });
    expect(otherFlow.enqueued).toBe(0);
    const explicit = await rescue.launchBirthdayRescue({ organizationId: org, flowId: flowManual2, contactIds: [ct("libre"), ct("cita")], triggeredBy: USER });
    expect(explicit.enqueued).toBe(0);
    expect(explicit.skipped).toEqual(
      expect.arrayContaining([
        { contactId: ct("libre"), reason: "already_rescued" },
        { contactId: ct("cita"), reason: "booked" },
      ])
    );
    expect(await rescueRuns()).toHaveLength(3);
  });

  it("dos lanzamientos a la vez (con flujos distintos) no le mandan dos rescates al mismo cliente", async () => {
    await contact("nuevo");
    await chat("nuevo");
    const [a, b] = await Promise.all([
      rescue.launchBirthdayRescue({ organizationId: org, flowId: flowManual, triggeredBy: USER }),
      rescue.launchBirthdayRescue({ organizationId: org, flowId: flowManual2, triggeredBy: USER }),
    ]);
    expect(a.enqueued + b.enqueued).toBe(1);
    const runs = (await rescueRuns()).filter((x) => x.contactId === ct("nuevo"));
    expect(runs).toHaveLength(1);
  });

  it("el Panel refleja el resultado: en cola, entregado y fallido (un fallo nunca cuenta como enviado)", async () => {
    // «libre»: el motor envió y el mensaje llegó. «citaTest»: la ejecución falló sin enviar.
    const [runLibre] = await db
      .select({ id: schema.automationRun.id, flowId: schema.automationRun.flowId })
      .from(schema.automationRun)
      .where(and(eq(schema.automationRun.contactId, ct("libre")), eq(schema.automationRun.dedupeKey, `birthday_rescue:${period}`)));
    const [q] = await db.select({ id: schema.automationQueue.id, stepId: schema.automationQueue.stepId }).from(schema.automationQueue).where(eq(schema.automationQueue.runId, runLibre!.id));
    const [cvRow] = await db
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .where(and(eq(schema.conversation.contactId, ct("libre")), eq(schema.conversation.isTest, false)));
    const cv = cvRow!.id;
    const msg = id("msg");
    await db.insert(schema.message).values({ id: msg, organizationId: org, conversationId: cv, direction: "out", status: "delivered", text: "¡Última oportunidad!" });
    await db.insert(schema.automationExecutionLog).values({ id: id("log"), organizationId: org, flowId: runLibre!.flowId, stepId: q!.stepId, contactId: ct("libre"), queueId: q!.id, status: "success", metadata: { step: { stepType: "send_whatsapp" }, messageId: msg } });
    await db.update(schema.automationRun).set({ status: "failed" }).where(and(eq(schema.automationRun.contactId, ct("citaTest")), eq(schema.automationRun.dedupeKey, `birthday_rescue:${period}`)));

    const b = await campaign.getBirthdayCampaign(org, today, tz);
    const row = (k: string) => b.clients.find((c) => c.name === k)!;
    expect(row("libre")).toMatchObject({ rescue: "delivered", status: "enviado", contactedBy: "auto", rescueBlock: "already_rescued" });
    expect(row("citaTest")).toMatchObject({ rescue: "failed", status: "fallido", rescueBlock: "already_rescued" });
    expect(row("saludado")).toMatchObject({ rescue: "pending" });
    expect(b.rescue).toMatchObject({ eligible: 0, launched: 4, delivered: 1, failed: 1, pending: 2 });
  });

  it("el flujo de cumpleaños (no manual) no sirve para el rescate; la otra organización queda intacta", async () => {
    await expect(rescue.launchBirthdayRescue({ organizationId: org, flowId: flowBirthday, triggeredBy: USER })).rejects.toMatchObject({
      code: "not_manual_flow",
    });
    // Un flujo de OTRA organización no existe para esta.
    await expect(rescue.launchBirthdayRescue({ organizationId: other, flowId: flowManual, triggeredBy: USER })).rejects.toMatchObject({
      code: "not_found",
    });
    const ajenos = await db.select().from(schema.birthdayRescue).where(eq(schema.birthdayRescue.organizationId, other));
    expect(ajenos).toEqual([]);
    const ajeno = await campaign.getBirthdayCampaign(other, today, tz);
    expect(ajeno.clients.map((c) => [c.name, c.rescueBlock])).toEqual([["ajeno", null]]);
  });
});
