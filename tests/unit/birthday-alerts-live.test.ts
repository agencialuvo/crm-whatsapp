import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Cumpleaños — el vigilante contra PostgreSQL REAL (`pnpm test:db`): avisos en la campanita cuando un saludo o un
 * rescate falla o no se dispara (con flujo, cuántos clientes y motivo, sin repetirse), el rescate AUTOMÁTICO de fin
 * de mes (una pasada por día, bloqueado si el mensaje felicita fuera de fecha), el margen sin atención reciente, la
 * cita vigente y que nada se duplique con el botón manual. Usa el mes REAL de hoy y su último día. Crea y borra lo suyo.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("vigilante de cumpleaños contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let monitor: typeof import("@/server/business/birthday-monitor");
  let rescue: typeof import("@/server/business/birthday-rescue");
  let settingsMod: typeof import("@/server/business/birthday-rescue-settings");
  let campaign: typeof import("@/server/business/birthday-campaign");
  let flowsMod: typeof import("@/server/automation/flows");

  const tag = Date.now().toString(36);
  const org = `org_bm${tag}`;
  const ct = (k: string) => `ct_bm${k}${tag}`;
  let seq = 0;
  const id = (p: string) => `${p}_bm${tag}${seq++}`;
  let tz = "";
  let year = 0;
  let month = 0;
  let period = "";
  /** 21:00 del último día del mes, hora del negocio: dentro de la ventana y después de la hora de envío. */
  let late = new Date();
  let lastDay = "";
  let monthStart = new Date();
  let flowGreeting = "";
  let greetingStep = "";
  let flowRescue = "";
  let rescueStep = "";
  const old = new Date("2024-01-01T12:00:00Z");

  async function contact(k: string, day: number, over: Record<string, unknown> = {}) {
    await db.insert(schema.contact).values({
      id: ct(k),
      organizationId: org,
      name: k,
      waIdentity: `bm-${k}-${tag}`,
      phone: "51999000111",
      salonClient: true,
      birthdayDay: day,
      birthdayMonth: month,
      createdAt: old,
      ...over,
    });
  }
  async function chat(k: string, isTest = false) {
    const cv = id("cv");
    await db.insert(schema.conversation).values({ id: cv, organizationId: org, contactId: ct(k), isTest, lastInboundAt: new Date() });
    return cv;
  }
  /** Un saludo de cumpleaños ya enviado por el motor, con el estado final de su mensaje. */
  async function greetingSent(k: string, cv: string, messageStatus: "delivered" | "failed") {
    const runId = id("arn");
    await db.insert(schema.automationRun).values({ id: runId, organizationId: org, flowId: flowGreeting, contactId: ct(k), status: "completed", dedupeKey: `birthday:${year}` });
    const queueId = id("que");
    await db.insert(schema.automationQueue).values({ id: queueId, organizationId: org, flowId: flowGreeting, contactId: ct(k), stepId: greetingStep, status: "completed", scheduledFor: new Date(), runId });
    const msg = id("msg");
    await db.insert(schema.message).values({ id: msg, organizationId: org, conversationId: cv, direction: "out", status: messageStatus, text: "¡Feliz cumpleaños!" });
    await db.insert(schema.automationExecutionLog).values({ id: id("log"), organizationId: org, flowId: flowGreeting, stepId: greetingStep, contactId: ct(k), queueId, status: "success", metadata: { step: { stepType: "send_whatsapp" }, messageId: msg } });
  }
  const notifications = () =>
    db
      .select({ title: schema.notifications.title, message: schema.notifications.message, link: schema.notifications.link })
      .from(schema.notifications)
      .where(eq(schema.notifications.organizationId, org));

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    process.env.SALON = "on";
    ({ eq, and } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    monitor = await import("@/server/business/birthday-monitor");
    rescue = await import("@/server/business/birthday-rescue");
    settingsMod = await import("@/server/business/birthday-rescue-settings");
    campaign = await import("@/server/business/birthday-campaign");
    flowsMod = await import("@/server/automation/flows");
    const schemas = await import("@/lib/automation-schemas");
    const { businessTimezone } = await import("@/server/analytics/period");
    const { todayInTz } = await import("@/lib/time/slots");

    await db.insert(schema.organization).values({ id: org, name: `Vigilante ${tag}`, slug: `vigilante-${tag}` });
    tz = await businessTimezone(org);
    const today = todayInTz(new Date(), tz);
    year = Number(today.slice(0, 4));
    month = Number(today.slice(5, 7));
    period = today.slice(0, 7);
    const w = campaign.birthdayWindow(year, month, tz);
    monthStart = w.start;
    late = new Date(w.end.getTime() - 3 * 3_600_000);
    lastDay = todayInTz(late, tz);

    const makeFlow = async (name: string, triggerType: string, content: string) => {
      const f = await flowsMod.createFlow(org, schemas.flowCreateSchema.parse({ name, triggerType }));
      const st = await flowsMod.createStep(org, f.id, schemas.stepCreateSchema.parse({ stepType: "send_whatsapp", config: { content }, positionY: 0 }));
      await flowsMod.updateFlow(org, f.id, { active: true });
      await db.update(schema.automationFlow).set({ createdAt: old }).where(eq(schema.automationFlow.id, f.id));
      return { flowId: f.id, stepId: st.id };
    };
    ({ flowId: flowGreeting, stepId: greetingStep } = await makeFlow(`Saludo ${tag}`, "birthday", "¡Feliz cumpleaños, {{nombre}}!"));
    // El flujo del rescate empieza MAL: felicita como si fuera el día.
    ({ flowId: flowRescue, stepId: rescueStep } = await makeFlow(`Última oportunidad ${tag}`, "manual", "¡Feliz cumpleaños {{nombre}}! 🎉"));

    await contact("rebote", 1);
    await contact("sinChat", 2);
    await contact("olvidado", 3);
    await contact("ok", 4);
    await contact("lab", 5);
    await contact("reciente", 6);
    await contact("vigente", 7);
    await contact("baja", 8, { optedOutAt: new Date(), optOutSource: "keyword" });
    const cvRebote = await chat("rebote");
    await chat("olvidado");
    const cvOk = await chat("ok");
    const cvLab = await chat("lab", true);
    for (const k of ["reciente", "vigente", "baja"]) await chat(k);

    await greetingSent("rebote", cvRebote, "failed"); // WhatsApp no lo entregó
    await greetingSent("ok", cvOk, "delivered");
    await greetingSent("lab", cvLab, "failed"); // del Laboratorio: no cuenta
    for (const k of ["reciente", "vigente", "baja"]) {
      const [cv] = await db.select({ id: schema.conversation.id }).from(schema.conversation).where(eq(schema.conversation.contactId, ct(k)));
      await greetingSent(k, cv!.id, "delivered");
    }
    // «reciente»: se atendió 35 días antes del último día (el mes pasado). Con un margen de 40 días, queda fuera.
    await db.insert(schema.booking).values({ id: id("bk"), organizationId: org, kind: "session", status: "realizada", source: "manual", contactId: ct("reciente"), scheduledAt: new Date(monthStart.getTime() - 5 * 86_400_000), durationMinutes: 30 });
    // «vigente»: reservó para el mes que viene (fuera de su mes): no se le manda un «se te acaba».
    await db.insert(schema.booking).values({ id: id("bk"), organizationId: org, kind: "session", status: "agendada", source: "manual", contactId: ct("vigente"), scheduledAt: new Date(late.getTime() + 5 * 86_400_000), durationMinutes: 30 });
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.organization).where(eq(schema.organization.id, org));
  });

  it("avisa una vez por flujo: el saludo que rebotó y los que no se dispararon (con motivo); el Laboratorio no cuenta", async () => {
    const r = await monitor.checkBirthdayAlerts(org, lastDay, tz);
    expect(r.alerts).toBe(2);
    const list = await notifications();
    const failed = list.find((n) => n.title === "Falló el saludo de cumpleaños")!;
    expect(failed.message).toContain(`«Saludo ${tag}»`);
    expect(failed.message).toContain("1 cliente ");
    expect(failed.message).toContain("WhatsApp no entregó el mensaje");
    expect(failed.link).toBe(`/automatizaciones/${flowGreeting}`);
    const notFired = list.find((n) => n.title === "Un saludo de cumpleaños no salió")!;
    expect(notFired.message).toContain("2 clientes");
    expect(notFired.message).toContain("el cliente no tiene un chat de WhatsApp (1)");
    expect(notFired.message).toContain("no entró a la cola");
  });

  it("no repite el aviso en la siguiente pasada; vuelve a avisar solo si crecen los afectados", async () => {
    expect((await monitor.checkBirthdayAlerts(org, lastDay, tz)).alerts).toBe(0);
    expect(await notifications()).toHaveLength(2);
    await contact("rebote2", 9);
    const cv = await chat("rebote2");
    await greetingSent("rebote2", cv, "failed");
    expect((await monitor.checkBirthdayAlerts(org, lastDay, tz)).alerts).toBe(1);
    const list = await notifications();
    expect(list).toHaveLength(3);
    expect(list.filter((n) => n.title === "Falló el saludo de cumpleaños").map((n) => n.message).some((m) => m.includes("2 clientes"))).toBe(true);
  });

  it("margen sin atención reciente y cita vigente quedan fuera de la audiencia del rescate", async () => {
    await settingsMod.saveRescueSettings(org, { autoEnabled: true, flowId: flowRescue, windowDays: 7, minGapDays: 40, sendHour: 10, benefitText: "un postre de cortesía" });
    const b = await campaign.getBirthdayCampaign(org, lastDay, tz);
    const block = Object.fromEntries(b.clients.map((c) => [c.name, c.rescueBlock]));
    expect(block).toMatchObject({ reciente: "recent_visit", vigente: "booked", baja: "opted_out", sinChat: "no_conversation", lab: "no_conversation" });
    expect(block.olvidado).toBeNull();
    expect(b.rescue).toMatchObject({ suggested: true, windowDays: 7, benefit: "un postre de cortesía", excluded: { recent_visit: 1 } });
    expect(b.rescue.flows.find((f) => f.id === flowRescue)?.greetingCopy).toBe(true);
    // Con margen 0 la regla se apaga.
    await settingsMod.saveRescueSettings(org, { autoEnabled: true, flowId: flowRescue, windowDays: 7, minGapDays: 0, sendHour: 10, benefitText: "un postre de cortesía" });
    const sinMargen = await campaign.getBirthdayCampaign(org, lastDay, tz);
    expect(sinMargen.clients.find((c) => c.name === "reciente")!.rescueBlock).toBeNull();
    await settingsMod.saveRescueSettings(org, { autoEnabled: true, flowId: flowRescue, windowDays: 7, minGapDays: 40, sendHour: 10, benefitText: "un postre de cortesía" });
  });

  it("rescate automático con un mensaje que felicita: no sale, avisa en la campanita y no reintenta el mismo día", async () => {
    const before = new Date(late.getTime() - 14 * 3_600_000); // 07:00 del último día: antes de la hora
    expect(await monitor.runAutoRescue(org, before)).toEqual({ status: "before_hour" });
    const r = await monitor.runAutoRescue(org, late);
    expect(r).toMatchObject({ status: "not_fired", reason: "greeting_copy" });
    const alert = (await notifications()).find((n) => n.title === "El rescate automático no salió")!;
    expect(alert.message).toContain(`Última oportunidad ${tag}`);
    expect(alert.message).toContain("felicita como si fuera el día del cumpleaños");
    expect(await monitor.runAutoRescue(org, late)).toEqual({ status: "already_ran" });
    const runs = await db.select().from(schema.automationRun).where(and(eq(schema.automationRun.organizationId, org), eq(schema.automationRun.dedupeKey, `birthday_rescue:${period}`)));
    expect(runs).toHaveLength(0);
  });

  it("con el mensaje corregido sale solo a los elegibles, con el beneficio y el plazo; el botón manual no duplica", async () => {
    await db
      .update(schema.automationStep)
      .set({ config: { content: "Hola {{nombre}}, tu beneficio sigue activo: {{beneficio}}, hasta el {{cierre_mes}} ({{plazo}})." } })
      .where(eq(schema.automationStep.id, rescueStep));
    await db.update(schema.birthdayRescueSettings).set({ lastAutoRunOn: null }).where(eq(schema.birthdayRescueSettings.organizationId, org));
    const r = await monitor.runAutoRescue(org, late);
    expect(r).toMatchObject({ status: "launched", errors: 0 });
    const runs = await db
      .select({ contactId: schema.automationRun.contactId, context: schema.automationRun.context })
      .from(schema.automationRun)
      .where(and(eq(schema.automationRun.organizationId, org), eq(schema.automationRun.dedupeKey, `birthday_rescue:${period}`)));
    const who = runs.map((x) => x.contactId).sort();
    expect(who).toEqual([ct("ok"), ct("olvidado"), ct("rebote"), ct("rebote2")].sort());
    const ctx = runs.find((x) => x.contactId === ct("olvidado"))!.context as { mode: string; birthday: Record<string, unknown> };
    expect(ctx.mode).toBe("auto");
    expect(ctx.birthday).toMatchObject({ benefit: "un postre de cortesía", daysLeft: 0, birthdayPassed: true });
    const claims = await db.select({ userId: schema.birthdayRescue.userId }).from(schema.birthdayRescue).where(eq(schema.birthdayRescue.organizationId, org));
    expect(claims).toHaveLength(4);
    expect(claims.every((c) => c.userId === null)).toBe(true);

    // El botón (respaldo) el mismo día: nadie recibe dos.
    const manual = await rescue.launchBirthdayRescue({ organizationId: org, flowId: flowRescue, triggeredBy: null, now: late });
    expect(manual.enqueued).toBe(0);
    expect(await monitor.runAutoRescue(org, late)).toEqual({ status: "already_ran" });
  });

  it("un rescate que falla avisa con su motivo", async () => {
    const [run] = await db
      .select({ id: schema.automationRun.id })
      .from(schema.automationRun)
      .where(and(eq(schema.automationRun.contactId, ct("olvidado")), eq(schema.automationRun.dedupeKey, `birthday_rescue:${period}`)));
    await db.update(schema.automationRun).set({ status: "failed" }).where(eq(schema.automationRun.id, run!.id));
    await db.update(schema.automationQueue).set({ status: "failed", error: "out_of_window_requires_template: fuera de 24 h" }).where(eq(schema.automationQueue.runId, run!.id));
    expect((await monitor.checkBirthdayAlerts(org, lastDay, tz)).alerts).toBe(1);
    const alert = (await notifications()).find((n) => n.title === "Falló el rescate de cumpleaños")!;
    expect(alert.message).toContain("1 cliente");
    expect(alert.message).toContain("pasaron las 24 h");
    expect(alert.link).toBe(`/automatizaciones/${flowRescue}`);
  });

  it("flujo apagado: el automático avisa; fuera de la ventana no hace nada", async () => {
    // Un cumpleañero nuevo queda elegible: hay a quién dejar sin rescate.
    await contact("nuevo", 10);
    await chat("nuevo");
    await db.update(schema.automationFlow).set({ active: false }).where(eq(schema.automationFlow.id, flowRescue));
    const nextDay = new Date(late.getTime() + 24 * 3_600_000); // primer día del mes siguiente: fuera de la ventana
    expect(await monitor.runAutoRescue(org, nextDay)).toEqual({ status: "outside_window" });
    await db.update(schema.birthdayRescueSettings).set({ lastAutoRunOn: null }).where(eq(schema.birthdayRescueSettings.organizationId, org));
    expect(await monitor.runAutoRescue(org, late)).toMatchObject({ status: "not_fired", reason: "flow_inactive" });
    const alert = (await notifications()).find((n) => n.message.includes("el flujo está apagado"))!;
    expect(alert.message).toContain("1 cliente");
  });

  it("guardar ajustes exige un flujo manual de esta organización", async () => {
    await expect(
      settingsMod.saveRescueSettings(org, { autoEnabled: true, flowId: flowGreeting, windowDays: 7, minGapDays: 7, sendHour: 10, benefitText: null })
    ).rejects.toMatchObject({ code: "not_manual_flow" });
    await expect(
      settingsMod.saveRescueSettings(org, { autoEnabled: true, flowId: "aut_ajeno", windowDays: 7, minGapDays: 7, sendHour: 10, benefitText: null })
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
