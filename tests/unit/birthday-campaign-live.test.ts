import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Cumpleaños del Panel contra PostgreSQL REAL (`pnpm test:db`): las consultas de `getBirthdayCampaign` (envíos de
 * las ejecuciones `birthday:AAAA` con el estado final de su mensaje, saludos manuales, citas y ventas en la
 * ventana del mes) acotadas a la organización y sin nada del Laboratorio. Crea dos organizaciones y las borra.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("cumpleaños del Panel contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let svc: typeof import("@/server/business/birthday-campaign");

  const TZ = "America/Lima";
  const TODAY = "2026-11-15";
  const tag = Date.now().toString(36);
  const org = `org_bd${tag}`;
  const other = `org_bdx${tag}`;
  const ct = (k: string) => `ct_bd${k}${tag}`;
  const FLOW_A = `aut_bda${tag}`;
  const FLOW_B = `aut_bdb${tag}`;
  const STEP_A = `stp_bda${tag}`;
  const STEP_B = `stp_bdb${tag}`;
  const STEP_TAG = `stp_bdt${tag}`;
  const SERVICE = `svc_bd${tag}`;
  let seq = 0;
  const id = (p: string) => `${p}_bd${tag}${seq++}`;
  /** Un instante a una hora local de Lima (UTC−5). */
  const lima = (ymd: string, hh = 15) => new Date(`${ymd}T${String(hh).padStart(2, "0")}:00:00-05:00`);

  async function contact(k: string, over: Record<string, unknown> = {}, orgId = org) {
    await db.insert(schema.contact).values({
      id: ct(k),
      organizationId: orgId,
      name: k,
      waIdentity: `bd-${k}-${tag}`,
      phone: "51999000111",
      salonClient: true,
      birthdayDay: 10,
      birthdayMonth: 11,
      ...over,
    });
  }

  async function conversation(contactId: string, isTest = false) {
    const cv = id("cv");
    await db.insert(schema.conversation).values({ id: cv, organizationId: org, contactId, isTest });
    return cv;
  }

  /** Una ejecución de cumpleaños con un paso registrado (y su mensaje, si se pasa el estado). */
  async function send(input: {
    contactId: string;
    flowId: string;
    stepId: string;
    stepType?: string;
    year?: number;
    logStatus: "success" | "failed" | "skipped_rate_limit" | "skipped_opt_out";
    messageStatus?: "sent" | "delivered" | "read" | "failed";
    testConversation?: boolean;
  }) {
    // Una ejecución por contacto, flujo y año (la llave única del barrido): varios pasos la comparten.
    const dedupeKey = `birthday:${input.year ?? 2026}`;
    await db
      .insert(schema.automationRun)
      .values({ id: id("arn"), organizationId: org, flowId: input.flowId, contactId: input.contactId, status: "completed", dedupeKey })
      .onConflictDoNothing();
    const [run] = await db
      .select({ id: schema.automationRun.id })
      .from(schema.automationRun)
      .where(
        and(
          eq(schema.automationRun.flowId, input.flowId),
          eq(schema.automationRun.contactId, input.contactId),
          eq(schema.automationRun.dedupeKey, dedupeKey)
        )
      );
    const runId = run!.id;
    const queueId = id("que");
    await db.insert(schema.automationQueue).values({
      id: queueId,
      organizationId: org,
      flowId: input.flowId,
      contactId: input.contactId,
      stepId: input.stepId,
      status: input.logStatus === "failed" ? "failed" : "completed",
      scheduledFor: lima("2026-11-10", 10),
      runId,
    });
    let messageId: string | null = null;
    if (input.messageStatus) {
      const cv = await conversation(input.contactId, input.testConversation);
      messageId = id("msg");
      await db.insert(schema.message).values({
        id: messageId,
        organizationId: org,
        conversationId: cv,
        direction: "out",
        status: input.messageStatus,
        text: "¡Feliz cumpleaños!",
      });
    }
    await db.insert(schema.automationExecutionLog).values({
      id: id("log"),
      organizationId: org,
      flowId: input.flowId,
      stepId: input.stepId,
      contactId: input.contactId,
      queueId,
      status: input.logStatus,
      metadata: { step: { stepType: input.stepType ?? "send_whatsapp" }, ...(messageId ? { messageId } : {}) },
    });
  }

  async function booking(contactId: string, at: Date, status: "agendada" | "realizada" | "no_show" | "cancelada", isTest = false) {
    const b = id("bk");
    await db.insert(schema.booking).values({
      id: b,
      organizationId: org,
      kind: "session",
      status,
      source: "manual",
      contactId,
      scheduledAt: at,
      durationMinutes: 30,
      isTest,
    });
    return b;
  }

  async function sale(contactId: string, at: Date, cents: number, bookingId: string | null = null) {
    await db.insert(schema.serviceSale).values({
      id: id("sls"),
      organizationId: org,
      contactId,
      bookingId,
      customerName: contactId,
      serviceId: SERVICE,
      amountCents: cents,
      staffCommissionCents: 0,
      businessNetCents: cents,
      paymentMethod: "efectivo",
      createdAt: at,
    });
  }

  beforeAll(async () => {
    ({ eq, and, inArray } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    svc = await import("@/server/business/birthday-campaign");

    await db.insert(schema.organization).values([
      { id: org, name: `Cumple ${tag}`, slug: `cumple-${tag}` },
      { id: other, name: `Cumple otra ${tag}`, slug: `cumple-otra-${tag}` },
    ]);
    await db.insert(schema.service).values({ id: SERVICE, organizationId: org, name: "Corte", priceCents: 5000 });
    await db.insert(schema.automationFlow).values([
      { id: FLOW_A, organizationId: org, name: "Saludo del día", triggerType: "birthday", active: true },
      { id: FLOW_B, organizationId: org, name: "Aviso 3 días antes", triggerType: "birthday", active: true },
    ]);
    await db.insert(schema.automationStep).values([
      { id: STEP_A, organizationId: org, flowId: FLOW_A, stepType: "send_whatsapp" as const, config: { content: "¡Feliz cumple!" } },
      { id: STEP_B, organizationId: org, flowId: FLOW_B, stepType: "send_whatsapp" as const, config: { content: "¡Se viene!" } },
      { id: STEP_TAG, organizationId: org, flowId: FLOW_A, stepType: "add_tag" as const, config: { tagId: "tag_x" } },
    ]);

    for (const k of ["ana", "beto", "carla", "dani", "eva", "fito"]) await contact(k);
    await contact("dic", { birthdayMonth: 12 }); // cumple en diciembre: no es de este mes
    await contact("nocliente", { salonClient: false }); // contacto que no es cliente del salón
    await contact("ajeno", {}, other); // cumpleañero de OTRA organización

    // Ana: le llegó el saludo de A, se atendió el 12 y pagó S/ 50 → aprovechó.
    await send({ contactId: ct("ana"), flowId: FLOW_A, stepId: STEP_A, logStatus: "success", messageStatus: "read" });
    const bkAna = await booking(ct("ana"), lima("2026-11-12"), "realizada");
    await sale(ct("ana"), lima("2026-11-12", 16), 5000, bkAna);
    // Beto: el canal aceptó pero el mensaje rebotó → fallido.
    await send({ contactId: ct("beto"), flowId: FLOW_A, stepId: STEP_A, logStatus: "success", messageStatus: "failed" });
    // Carla: saludo manual; su cita cancelada y la de diciembre no cuentan.
    await db.insert(schema.birthdayGreeting).values({ id: id("bgr"), organizationId: org, contactId: ct("carla"), year: 2026 });
    await booking(ct("carla"), lima("2026-11-20"), "cancelada");
    await booking(ct("carla"), lima("2026-12-02"), "agendada");
    // Dani: todo lo suyo es del Laboratorio → sin enviar.
    await send({ contactId: ct("dani"), flowId: FLOW_A, stepId: STEP_A, logStatus: "success", messageStatus: "delivered", testConversation: true });
    const bkTest = await booking(ct("dani"), lima("2026-11-11"), "realizada", true);
    await sale(ct("dani"), lima("2026-11-11", 16), 7000, bkTest);
    // Eva: saludo del AÑO PASADO, un paso que no es de envío este año, saludo manual de 2025 y una venta de
    // octubre → sin enviar.
    await send({ contactId: ct("eva"), flowId: FLOW_A, stepId: STEP_A, year: 2025, logStatus: "success", messageStatus: "read" });
    await send({ contactId: ct("eva"), flowId: FLOW_A, stepId: STEP_TAG, stepType: "add_tag", logStatus: "success" });
    await db.insert(schema.birthdayGreeting).values({ id: id("bgr"), organizationId: org, contactId: ct("eva"), year: 2025 });
    await sale(ct("eva"), lima("2026-10-31", 18), 4000);
    // Fito: le llegó el aviso de B (con un intento postergado por el tope antes) y reservó para el 28 → agendado.
    await send({ contactId: ct("fito"), flowId: FLOW_B, stepId: STEP_B, logStatus: "skipped_rate_limit" });
    await send({ contactId: ct("fito"), flowId: FLOW_B, stepId: STEP_B, logStatus: "success", messageStatus: "delivered" });
    await booking(ct("fito"), lima("2026-11-28"), "agendada");
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    // Todo cae con las organizaciones (cascada).
    await db.delete(schema.organization).where(inArray(schema.organization.id, [org, other]));
  });

  it("lista solo a los cumpleañeros del mes de ESTA organización, con su estado", async () => {
    const b = await svc.getBirthdayCampaign(org, TODAY, TZ);
    expect(b).toMatchObject({ month: 11, today: 15, year: 2026 });
    const status = Object.fromEntries(b.clients.map((c) => [c.name, c.status]));
    expect(status).toEqual({
      ana: "aprovecho",
      beto: "fallido",
      carla: "enviado",
      dani: "sin_enviar",
      eva: "sin_enviar",
      fito: "agendado",
    });
    const ana = b.clients.find((c) => c.name === "ana")!;
    expect(ana).toMatchObject({ contactedBy: "auto", windowRevenueCents: 5000, flowIds: [FLOW_A] });
    expect(b.clients.find((c) => c.name === "carla")).toMatchObject({ contactedBy: "manual", booked: false });
  });

  it("KPIs del mes", async () => {
    const { kpis } = await svc.getBirthdayCampaign(org, TODAY, TZ);
    expect(kpis).toEqual({
      total: 6,
      contacted: 3,
      contactedAuto: 2,
      contactedManual: 1,
      notSent: 2,
      failed: 1,
      booked: 2,
      converted: 1,
      convertedContacted: 1,
      conversionRate: 33,
      revenueCents: 5000,
    });
  });

  it("desglose por automatización", async () => {
    const { flows } = await svc.getBirthdayCampaign(org, TODAY, TZ);
    expect(flows.find((f) => f.id === FLOW_A)).toMatchObject({ sent: 1, failed: 1, booked: 1, converted: 1, conversionRate: 100, revenueCents: 5000 });
    expect(flows.find((f) => f.id === FLOW_B)).toMatchObject({ sent: 1, failed: 0, booked: 1, converted: 0, conversionRate: 0 });
  });

  it("saludo manual: idempotente, se puede quitar, y no acepta un cliente de otra organización", async () => {
    const before = await svc.getBirthdayCampaign(org, TODAY, TZ);
    expect(before.clients.find((c) => c.name === "dani")?.status).toBe("sin_enviar");

    await svc.recordManualGreeting({ organizationId: org, contactId: ct("dani"), year: 2026, userId: null });
    await svc.recordManualGreeting({ organizationId: org, contactId: ct("dani"), year: 2026, userId: null });
    const rows = await db.select().from(schema.birthdayGreeting).where(eq(schema.birthdayGreeting.contactId, ct("dani")));
    expect(rows).toHaveLength(1);
    const after = await svc.getBirthdayCampaign(org, TODAY, TZ);
    expect(after.clients.find((c) => c.name === "dani")).toMatchObject({ status: "enviado", contactedBy: "manual" });
    expect(after.kpis.contacted).toBe(4);

    await svc.removeManualGreeting({ organizationId: org, contactId: ct("dani"), year: 2026 });
    expect((await svc.getBirthdayCampaign(org, TODAY, TZ)).kpis.contacted).toBe(3);

    await expect(
      svc.recordManualGreeting({ organizationId: org, contactId: ct("ajeno"), year: 2026, userId: null })
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("la otra organización no ve nada de esta", async () => {
    const b = await svc.getBirthdayCampaign(other, TODAY, TZ);
    expect(b.clients.map((c) => c.name)).toEqual(["ajeno"]);
    expect(b.kpis).toMatchObject({ total: 1, contacted: 0, booked: 0, converted: 0 });
    expect(b.flows).toEqual([]);
  });

  it("la ventana es el mes en la zona del negocio", () => {
    const w = svc.birthdayWindow(2026, 11, TZ);
    expect(w.start.toISOString()).toBe("2026-11-01T05:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-12-01T05:00:00.000Z");
    const dic = svc.birthdayWindow(2026, 12, TZ);
    expect(dic.end.toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });
});
