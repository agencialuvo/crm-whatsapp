import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Condiciones de citas y disparadores «Cita realizada» / «Venta cobrada» contra PostgreSQL REAL (`pnpm test:db`):
 *  - `contactFacts` con citas de verdad (confirmada futura, días hasta la próxima, sin venir, visitas) y su aislamiento;
 *  - los DOS caminos que cierran una cita (marcarla en la Agenda y cobrarla en Caja) arrancan «Cita realizada» una sola vez;
 *  - un cobro en Caja arranca «Venta cobrada» con o sin tarjeta de fidelidad, y por el motor sale `{{monto}}` y `{{servicio}}`;
 *  - una condición con cada regla nueva por el motor, con la cola real.
 * Crea su propia organización (con una segunda para el aislamiento) y las borra. Los envíos son falsos.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("citas, cita realizada y venta cobrada contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: typeof import("drizzle-orm").eq;
  let flows: typeof import("@/server/automation/flows");
  let engine: typeof import("@/server/automation/engine");
  let worker: typeof import("@/server/automation/worker");
  let schemas: typeof import("@/lib/automation-schemas");
  let actions: typeof import("@/server/automation/actions");
  let agenda: typeof import("@/server/agenda/service");
  let sales: typeof import("@/server/business/sales-service");
  let saleInputSchema: (typeof import("@/lib/salon/schemas"))["saleInputSchema"];

  const uid = Date.now().toString(36);
  const org = `org_ci${uid}`;
  const otraOrg = `org_ci2${uid}`;
  const servicio = `srv_ci${uid}`;
  let seq = 0;
  let slot = 0;
  const DAY = 86_400_000;
  // Margen: la cita se desplaza unos minutos hacia delante (una hora distinta por cita); sin él, «hace 10 días» sería 9 días y pico.
  const HORA = 3_600_000;

  async function mkContact(organizationId = org, nombre = "Cliente Cita") {
    const n = seq++;
    const contactId = `ct_ci${uid}${n}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId, name: nombre, waIdentity: `ci-${uid}${n}` });
    await db.insert(schema.conversation).values({ id: `cv_ci${uid}${n}`, organizationId, contactId, lastInboundAt: new Date() });
    return contactId;
  }
  /** Una cita del contacto, en un instante distinto cada vez (la agenda no admite dos citas activas a la misma hora). */
  async function mkBooking(contactId: string, at: Date, over: Record<string, unknown> = {}, organizationId = org) {
    const id = `bk_ci${uid}${seq++}`;
    await db.insert(schema.booking).values({
      id,
      organizationId,
      kind: "session",
      status: "agendada",
      source: "manual",
      contactId,
      scheduledAt: new Date(at.getTime() + (slot++) * 60_000),
      durationMinutes: 30,
      connector: "enlace-fijo",
      ...over,
    });
    return id;
  }
  async function mkFlow(triggerType: string, specs: { stepType: string; config: Record<string, unknown> }[]) {
    const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `CI ${uid}${seq++}`, triggerType }));
    for (const [i, s] of specs.entries()) await flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ ...s, positionY: i * 100 }));
    await flows.updateFlow(org, flow.id, { active: true });
    return flow.id;
  }
  const runsOf = (flowId: string) => db.select().from(schema.automationRun).where(eq(schema.automationRun.flowId, flowId));
  const queueOf = (flowId: string) => db.select().from(schema.automationQueue).where(eq(schema.automationQueue.flowId, flowId)).orderBy(schema.automationQueue.createdAt);

  const sent: string[] = [];
  const deps = () =>
    ({
      ...worker.defaultDeps(),
      sendText: vi.fn(async (i: { text: string }) => (sent.push(i.text), { messageId: "msg_fake" })),
      sendTemplate: vi.fn(async () => ({ messageId: "msg_fake" })),
      waMessageIdOf: async () => null,
    }) as import("@/server/automation/engine").Deps;
  async function drain(flowId: string) {
    const d = deps();
    for (let guard = 0; guard < 20; guard++) {
      const pending = (await queueOf(flowId)).find((r) => r.status === "pending" && r.scheduledFor.getTime() <= Date.now() + 1000);
      if (!pending) break;
      await engine.processRow(pending as never, d);
    }
  }
  const msg = (content: string) => ({ stepType: "send_whatsapp", config: { content } });
  const cobra = (contactId: string, extra: Record<string, unknown> = {}) =>
    sales.registerServiceSale(org, saleInputSchema.parse({ paymentMethod: "efectivo", amountCents: 125_050, serviceId: servicio, contactId, ...extra }));

  let cita: string; // «Cita realizada»
  let venta: string; // «Venta cobrada»

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    process.env.SALON = "on";
    delete process.env.AUTOMATION_CODE_JS;
    ({ eq } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    flows = await import("@/server/automation/flows");
    engine = await import("@/server/automation/engine");
    worker = await import("@/server/automation/worker");
    schemas = await import("@/lib/automation-schemas");
    actions = await import("@/server/automation/actions");
    agenda = await import("@/server/agenda/service");
    sales = await import("@/server/business/sales-service");
    ({ saleInputSchema } = await import("@/lib/salon/schemas"));

    await db.insert(schema.organization).values([
      { id: org, name: `Citas live ${uid}` },
      { id: otraOrg, name: `Otra ${uid}` },
    ]);
    await db.insert(schema.service).values({ id: servicio, organizationId: org, name: "Corte", priceCents: 125_050 });
    cita = await mkFlow("booking_completed", [msg("Gracias por venir, {{name}}")]);
    venta = await mkFlow("sale_completed", [msg("Pagaste ${{monto}} por {{servicio}}")]);
  });

  afterAll(async () => {
    if (!db) return;
    // El borrado en cascada de la organización se lleva flujos, citas, ventas, contactos y conversaciones.
    await db.delete(schema.organization).where(eq(schema.organization.id, org));
    await db.delete(schema.organization).where(eq(schema.organization.id, otraOrg));
  });

  describe("contactFacts", () => {
    it("cita futura confirmada: solo cuenta agendada + futura + confirmada, de este contacto y de esta organización", async () => {
      const c = await mkContact();
      const sin = await actions.contactFacts(org, c);
      expect(sin).toMatchObject({ hasUpcomingBooking: false, hasConfirmedUpcomingBooking: false, daysToNextBooking: null, visitCount: 0, daysSinceLastVisit: null });

      // Agendada sin confirmar: cita próxima sí, confirmada no.
      await mkBooking(c, new Date(Date.now() + 3 * DAY));
      expect(await actions.contactFacts(org, c)).toMatchObject({ hasUpcomingBooking: true, hasConfirmedUpcomingBooking: false });

      // Confirmada pero PASADA, cancelada o del Laboratorio: no cuentan.
      await mkBooking(c, new Date(Date.now() - 2 * DAY), { confirmedAt: new Date() });
      await mkBooking(c, new Date(Date.now() + 4 * DAY), { confirmedAt: new Date(), status: "cancelada" });
      await mkBooking(c, new Date(Date.now() + 5 * DAY), { confirmedAt: new Date(), isTest: true });
      await mkBooking(c, new Date(Date.now() + 6 * DAY), { confirmedAt: new Date(), kind: "block", contactId: null });
      expect((await actions.contactFacts(org, c)).hasConfirmedUpcomingBooking).toBe(false);

      // Una futura confirmada (aunque NO sea la más cercana) la activa.
      await mkBooking(c, new Date(Date.now() + 9 * DAY), { confirmedAt: new Date() });
      expect(await actions.contactFacts(org, c)).toMatchObject({ hasUpcomingBooking: true, hasConfirmedUpcomingBooking: true });
    });

    it("días hasta la próxima cita: de calendario del negocio (hoy = 0) y siempre sobre la más cercana", async () => {
      const c = await mkContact();
      await mkBooking(c, new Date(Date.now() + 10 * DAY));
      await mkBooking(c, new Date(Date.now() + 3 * DAY));
      const f = await actions.contactFacts(org, c);
      expect(f.daysToNextBooking).toBeGreaterThanOrEqual(2);
      expect(f.daysToNextBooking).toBeLessThanOrEqual(3);
      // Una cita en unos minutos es «hoy» (0) o, si el reloj cruza la medianoche del negocio, «1»; nunca negativa.
      const d = await mkContact();
      await mkBooking(d, new Date(Date.now() + 10 * 60_000));
      const g = await actions.contactFacts(org, d);
      expect([0, 1]).toContain(g.daysToNextBooking);
      expect(g.hasUpcomingBooking).toBe(true);
    });

    it("visitas y días sin venir: solo cuentan las realizadas y ya pasadas; las canceladas, no-show, futuras y de prueba, no", async () => {
      const c = await mkContact();
      await mkBooking(c, new Date(Date.now() - 40 * DAY - HORA), { status: "realizada" });
      await mkBooking(c, new Date(Date.now() - 10 * DAY - HORA), { status: "realizada" });
      await mkBooking(c, new Date(Date.now() - 5 * DAY), { status: "cancelada" });
      await mkBooking(c, new Date(Date.now() - 4 * DAY), { status: "no_show" });
      await mkBooking(c, new Date(Date.now() - 3 * DAY), { status: "realizada", isTest: true });
      await mkBooking(c, new Date(Date.now() + 2 * DAY), { status: "realizada" });
      const f = await actions.contactFacts(org, c);
      expect(f.visitCount).toBe(2);
      expect(f.daysSinceLastVisit).toBe(10);
    });

    it("aislamiento: las citas de otra organización con el mismo contacto no cuentan", async () => {
      const c = await mkContact();
      const ajeno = await mkContact(otraOrg, "Ajeno");
      await mkBooking(ajeno, new Date(Date.now() + DAY), { confirmedAt: new Date() }, otraOrg);
      await mkBooking(ajeno, new Date(Date.now() - DAY), { status: "realizada" }, otraOrg);
      expect(await actions.contactFacts(org, c)).toMatchObject({ hasUpcomingBooking: false, hasConfirmedUpcomingBooking: false, visitCount: 0 });
      // Preguntar por el contacto de la otra organización DESDE esta no devuelve sus citas.
      expect(await actions.contactFacts(org, ajeno)).toMatchObject({ hasUpcomingBooking: false, visitCount: 0, daysSinceLastVisit: null });
    });
  });

  describe("por el motor, con la cola real", () => {
    /** Un flujo manual «condición → mensaje» con la regla pedida; devuelve si el mensaje salió. */
    async function pasa(rule: Record<string, unknown>, contactId: string) {
      const flowId = await mkFlow("manual", [{ stepType: "condition", config: { rule, ifTrue: "continue", ifFalse: "stop" } }, msg("SI")]);
      const manual = await import("@/server/automation/manual");
      sent.length = 0;
      await manual.triggerManualFlow({ organizationId: org, flowId, contactId, batchId: `b_${uid}${seq++}`, triggeredBy: "u" });
      await drain(flowId);
      return sent.includes("SI");
    }

    it("las cuatro reglas leen los datos de AHORA del contacto", async () => {
      const c = await mkContact();
      expect(await pasa({ type: "has_confirmed_upcoming_booking" }, c)).toBe(false);
      expect(await pasa({ type: "visits_gte", visits: 1 }, c)).toBe(false);
      expect(await pasa({ type: "inactive_for_days_gte", days: 1 }, c)).toBe(false); // nunca vino: no se cumple
      expect(await pasa({ type: "upcoming_booking_days_lte", days: 30 }, c)).toBe(false);

      await mkBooking(c, new Date(Date.now() + 2 * DAY), { confirmedAt: new Date() });
      await mkBooking(c, new Date(Date.now() - 45 * DAY - HORA), { status: "realizada" });
      await mkBooking(c, new Date(Date.now() - 50 * DAY - HORA), { status: "realizada" });
      expect(await pasa({ type: "has_confirmed_upcoming_booking" }, c)).toBe(true);
      expect(await pasa({ type: "upcoming_booking_days_lte", days: 3 }, c)).toBe(true);
      expect(await pasa({ type: "upcoming_booking_days_lte", days: 0 }, c)).toBe(false);
      expect(await pasa({ type: "visits_gte", visits: 2 }, c)).toBe(true);
      expect(await pasa({ type: "visits_gte", visits: 3 }, c)).toBe(false);
      expect(await pasa({ type: "inactive_for_days_gte", days: 45 }, c)).toBe(true);
      expect(await pasa({ type: "inactive_for_days_gte", days: 46 }, c)).toBe(false);
    });
  });

  describe("«Cita realizada»", () => {
    it("marcarla como realizada en la Agenda arranca el flujo, anclado a la cita, una sola vez aunque se repita", async () => {
      const c = await mkContact();
      const bookingId = await mkBooking(c, new Date(Date.now() - DAY));
      await agenda.markBookingStatus({ organizationId: org, bookingId, status: "realizada" });
      await agenda.markBookingStatus({ organizationId: org, bookingId, status: "realizada" });
      const filas = (await queueOf(cita)).filter((r) => r.contactId === c);
      expect(filas).toHaveLength(1);
      expect(filas[0]).toMatchObject({ bookingId, status: "pending", dedupeKey: `booking_completed:${bookingId}` });
      sent.length = 0;
      await drain(cita);
      expect(sent).toContain("Gracias por venir, Cliente Cita");
      const run = (await runsOf(cita)).find((r) => r.contactId === c)!;
      expect(run.status).toBe("completed");
    });

    it("cobrarla en Caja la cierra y arranca el mismo flujo, y cobrarla tras marcarla NO lo repite", async () => {
      const a = await mkContact();
      const b1 = await mkBooking(a, new Date(Date.now() - 2 * DAY));
      await cobra(a, { bookingId: b1 });
      expect((await db.select().from(schema.booking).where(eq(schema.booking.id, b1)))[0]!.status).toBe("realizada");
      expect((await queueOf(cita)).filter((r) => r.contactId === a)).toHaveLength(1);

      // Marcada primero en la Agenda y cobrada después: la venta no reabre nada, el flujo ya corrió.
      const b = await mkContact();
      const b2 = await mkBooking(b, new Date(Date.now() - 3 * DAY));
      await agenda.markBookingStatus({ organizationId: org, bookingId: b2, status: "realizada" });
      await cobra(b, { bookingId: b2 });
      expect((await queueOf(cita)).filter((r) => r.contactId === b)).toHaveLength(1);
    });

    it("«No asistió», cancelar, un bloqueo y una cita del Laboratorio NO arrancan «Cita realizada»", async () => {
      const c = await mkContact();
      const noShow = await mkBooking(c, new Date(Date.now() - DAY));
      await agenda.markBookingStatus({ organizationId: org, bookingId: noShow, status: "no_show" });
      const cancelada = await mkBooking(c, new Date(Date.now() + DAY));
      await agenda.cancelBooking({ organizationId: org, bookingId: cancelada });
      const prueba = await mkBooking(c, new Date(Date.now() - 2 * DAY), { isTest: true });
      await agenda.markBookingStatus({ organizationId: org, bookingId: prueba, status: "realizada" });
      const bloqueo = await mkBooking(c, new Date(Date.now() - 3 * DAY), { kind: "block", contactId: null });
      await agenda.markBookingStatus({ organizationId: org, bookingId: bloqueo, status: "realizada" });
      expect((await queueOf(cita)).filter((r) => r.contactId === c)).toHaveLength(0);
    });

    it("cancela los recordatorios pendientes de esa cita (los de «Cita agendada») pero no las tareas de los flujos de «Cita realizada»", async () => {
      const recordatorio = await mkFlow("booking_created", [{ stepType: "delay", config: { amount: 1, unit: "days" } }, msg("Recordatorio")]);
      const c = await mkContact();
      const bookingId = await mkBooking(c, new Date(Date.now() + 2 * 3_600_000));
      const { onBookingCreated } = await import("@/server/automation/triggers");
      const [cb] = await db.select().from(schema.booking).where(eq(schema.booking.id, bookingId));
      await onBookingCreated({ organizationId: org, bookingId, contactId: c, scheduledAt: cb!.scheduledAt });
      expect((await queueOf(recordatorio)).filter((r) => r.contactId === c)[0]).toMatchObject({ status: "pending" });
      await agenda.markBookingStatus({ organizationId: org, bookingId, status: "realizada" });
      expect((await queueOf(recordatorio)).filter((r) => r.contactId === c)[0]).toMatchObject({ status: "cancelled", error: "booking_completed" });
      expect((await queueOf(cita)).filter((r) => r.contactId === c)[0]).toMatchObject({ status: "pending" });
    });

    it("la guardia al ejecutar: si la cita se cancela antes de que corra la tarea, la tarea se cancela", async () => {
      const c = await mkContact();
      const bookingId = await mkBooking(c, new Date(Date.now() - DAY));
      await agenda.markBookingStatus({ organizationId: org, bookingId, status: "realizada" });
      await db.update(schema.booking).set({ status: "cancelada" }).where(eq(schema.booking.id, bookingId));
      await drain(cita);
      expect((await queueOf(cita)).filter((r) => r.contactId === c)[0]).toMatchObject({ status: "cancelled", error: "booking_no_longer_completed" });
    });
  });

  describe("«Venta cobrada»", () => {
    it("un cobro sin cita ni tarjeta arranca el flujo con el contexto y los mensajes llevan {{monto}} y {{servicio}}", async () => {
      const c = await mkContact();
      const r = await cobra(c);
      const filas = (await queueOf(venta)).filter((x) => x.contactId === c);
      expect(filas).toHaveLength(1);
      expect(filas[0]).toMatchObject({ status: "pending", dedupeKey: `sale_completed:${r.sale.id}` });
      expect(filas[0]!.bookingId).toBeNull();
      const run = (await runsOf(venta)).find((x) => x.contactId === c)!;
      expect(run.context).toMatchObject({
        serviceName: "Corte",
        sale: { saleId: r.sale.id, amountCents: 125_050, paymentMethod: "efectivo", itemName: "Corte", bookingId: null },
      });
      sent.length = 0;
      await drain(venta);
      expect(sent).toContain("Pagaste $1250.50 por Corte");
      expect((await runsOf(venta)).find((x) => x.contactId === c)!.status).toBe("completed");
    });

    it("un cobro de una cita arranca los DOS flujos (cita realizada y venta cobrada) y el de venta NO se cancela por la guardia", async () => {
      const c = await mkContact();
      const bookingId = await mkBooking(c, new Date(Date.now() - DAY));
      const r = await cobra(c, { bookingId });
      expect((await queueOf(cita)).filter((x) => x.contactId === c)).toHaveLength(1);
      const venta1 = (await queueOf(venta)).filter((x) => x.contactId === c);
      expect(venta1).toHaveLength(1);
      sent.length = 0;
      await drain(venta);
      expect(sent).toContain("Pagaste $1250.50 por Corte");
      expect((await queueOf(venta)).find((x) => x.contactId === c)).toMatchObject({ status: "completed" });
      expect((await runsOf(venta)).find((x) => x.contactId === c)!.context).toMatchObject({ sale: { saleId: r.sale.id, bookingId } });
    });

    it("cada venta dispara una vez: dos cobros del mismo cliente son dos ejecuciones", async () => {
      const c = await mkContact();
      await cobra(c);
      await cobra(c);
      expect((await queueOf(venta)).filter((x) => x.contactId === c)).toHaveLength(2);
    });

    it("un cobro a un cliente sin identificar (mostrador) no dispara nada", async () => {
      const antes = (await queueOf(venta)).length;
      await sales.registerServiceSale(org, saleInputSchema.parse({ paymentMethod: "efectivo", amountCents: 5000, serviceId: servicio }));
      expect((await queueOf(venta)).length).toBe(antes);
    });

    it("si el cobro falla (cita de otra organización) no queda ni la venta ni el disparo", async () => {
      const c = await mkContact();
      const ajeno = await mkContact(otraOrg, "Ajeno");
      const ajena = await mkBooking(ajeno, new Date(Date.now() - DAY), {}, otraOrg);
      await expect(cobra(c, { bookingId: ajena })).rejects.toMatchObject({ status: 404 });
      expect((await queueOf(venta)).filter((x) => x.contactId === c)).toHaveLength(0);
      expect((await queueOf(cita)).filter((x) => x.contactId === ajeno)).toHaveLength(0);
      expect((await db.select().from(schema.booking).where(eq(schema.booking.id, ajena)))[0]!.status).toBe("agendada");
    });

    it("independiente de la fidelidad: con tarjeta (y sello) también dispara, una vez", async () => {
      const milestones = [{ stamps: 2, title: "20% de descuento", rewardType: "percentage_discount", discountPercentage: 20 }] as never;
      await db
        .insert(schema.loyaltySettings)
        .values({ id: `lgs_ci${uid}`, organizationId: org, milestones })
        .onConflictDoUpdate({ target: schema.loyaltySettings.organizationId, set: { milestones } });
      const c = await mkContact();
      await cobra(c);
      await cobra(c); // cruza el premio del sello 2
      expect((await queueOf(venta)).filter((x) => x.contactId === c)).toHaveLength(2);
    });

    it("aislamiento: el cobro de otra organización no arranca los flujos de esta", async () => {
      const antes = (await queueOf(venta)).length;
      const ajeno = await mkContact(otraOrg, "Ajeno");
      const servicioAjeno = `srv_ci2${uid}`;
      await db.insert(schema.service).values({ id: servicioAjeno, organizationId: otraOrg, name: "Otro", priceCents: 1000 });
      await sales.registerServiceSale(otraOrg, saleInputSchema.parse({ paymentMethod: "efectivo", amountCents: 1000, serviceId: servicioAjeno, contactId: ajeno }));
      expect((await queueOf(venta)).length).toBe(antes);
    });
  });
});
