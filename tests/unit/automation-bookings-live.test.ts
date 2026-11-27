import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Automatizaciones de citas contra PostgreSQL REAL (`pnpm test:db`): el disparo desde la agenda, la tarea
 * que lleva la cita, `wait_until` con la cola de verdad, la cancelación al cancelar o reprogramar, la
 * revalidación al ejecutar, la confirmación idempotente y el aislamiento entre organizaciones. Nada toca la
 * API de WhatsApp: el envío es un doble. Crea y borra lo suyo.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("automatizaciones de citas contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let flows: typeof import("@/server/automation/flows");
  let worker: typeof import("@/server/automation/worker");
  let engine: typeof import("@/server/automation/engine");
  let agenda: typeof import("@/server/agenda/service");
  let availability: typeof import("@/server/agenda/availability");
  let store: typeof import("@/server/automation/trigger-store");
  let schemas: typeof import("@/lib/automation-schemas");

  const tag = Date.now().toString(36);
  let org = "";
  let otherOrg = "";
  let contactId = "";
  const created = { flows: [] as string[], bookings: [] as string[], convs: [] as string[], contacts: [] as string[] };
  let slotCursor = 4;

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    ({ eq, and, inArray } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    flows = await import("@/server/automation/flows");
    worker = await import("@/server/automation/worker");
    engine = await import("@/server/automation/engine");
    agenda = await import("@/server/agenda/service");
    availability = await import("@/server/agenda/availability");
    store = await import("@/server/automation/trigger-store");
    schemas = await import("@/lib/automation-schemas");

    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    expect(orgs.length, "hacen falta dos organizaciones").toBeGreaterThanOrEqual(2);
    org = orgs[0]!.id;
    otherOrg = orgs[1]!.id;

    contactId = `ct_b${tag}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Cliente Cita", waIdentity: `bk-${tag}`, phone: "5215559990" });
    // El cliente escribió hace poco: la ventana de 24 h de WhatsApp está abierta y el texto libre puede salir.
    await db.insert(schema.conversation).values({ id: `cv_b${tag}`, organizationId: org, contactId, lastInboundAt: new Date() });
    created.contacts.push(contactId);
    created.convs.push(`cv_b${tag}`);
    // Importa el motor, la agenda y el worker en frío: con el equipo cargado supera los 10 s por defecto.
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    // Flujos primero (su cola y su historial se van por cascada), luego citas, chats y contactos.
    if (created.flows.length) await db.delete(schema.automationFlow).where(inArray(schema.automationFlow.id, created.flows));
    if (created.bookings.length) await db.delete(schema.booking).where(inArray(schema.booking.id, created.bookings));
    if (created.convs.length) await db.delete(schema.conversation).where(inArray(schema.conversation.id, created.convs));
    if (created.contacts.length) await db.delete(schema.contact).where(inArray(schema.contact.id, created.contacts));
  });

  /** Un hueco libre real de la agenda, distinto en cada llamada. */
  async function freeSlot(): Promise<Date> {
    const slots = await availability.computeAvailability(org, { now: new Date() });
    const s = slots[slotCursor++ % Math.max(slots.length, 1)];
    if (!s) throw new Error("la agenda de la prueba no tiene huecos libres");
    return new Date(s.startUtc);
  }

  async function makeBooking(scheduledAt: Date, over: Record<string, unknown> = {}) {
    const id = `bk_b${tag}${created.bookings.length}`;
    await db.insert(schema.booking).values({
      id,
      organizationId: org,
      kind: "session",
      status: "agendada",
      source: "manual",
      contactId,
      scheduledAt,
      durationMinutes: 30,
      connector: "enlace-fijo",
      ...over,
    });
    created.bookings.push(id);
    return id;
  }

  /** Un flujo ENCENDIDO con los pasos dados (en orden de arriba abajo). */
  async function makeFlow(triggerType: string, steps: { stepType: string; config: Record<string, unknown> }[]) {
    const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `Cita ${tag}${created.flows.length}`, triggerType }));
    created.flows.push(flow.id);
    for (const [i, s] of steps.entries()) {
      await flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ ...s, positionY: i * 100 }));
    }
    await flows.updateFlow(org, flow.id, { active: true });
    return flow.id;
  }

  const rowsOf = (flowId: string) =>
    db.select().from(schema.automationQueue).where(eq(schema.automationQueue.flowId, flowId)).orderBy(schema.automationQueue.createdAt);

  /** Los dobles del envío; todo lo demás (cola, citas, zona horaria) es real. */
  function deps(nowAt?: Date) {
    const sendText = vi.fn(async () => ({ messageId: "msg_fake" }));
    const d: import("@/server/automation/engine").Deps = {
      ...worker.defaultDeps(),
      sendText,
      sendTemplate: vi.fn(async () => ({ messageId: "msg_fake" })),
      waMessageIdOf: async () => null,
      ...(nowAt ? { now: () => nowAt } : {}),
    };
    return { d, sendText };
  }

  const WAIT = { anchor: "booking.scheduledAt", offsetMinutes: -60 };
  const SEND = (text = "Recordatorio {{fecha}} a las {{hora}}") => ({ stepType: "send_whatsapp", config: { content: text } });

  it("el flujo completo: cita creada → espera anclada → mensaje con fecha y hora, y la cita viaja en la cola", async () => {
    const flowId = await makeFlow("booking_created", [{ stepType: "wait_until", config: WAIT }, SEND()]);
    const startsAt = new Date(Date.now() + 5 * 3_600_000);
    const bookingId = await makeBooking(startsAt);

    // Lo que hace la agenda al crear la cita.
    const { onBookingCreated } = await import("@/server/automation/triggers");
    expect(await onBookingCreated({ organizationId: org, bookingId, contactId, scheduledAt: startsAt })).toBe(1);
    // Idempotente: el mismo disparo no duplica.
    expect(await onBookingCreated({ organizationId: org, bookingId, contactId, scheduledAt: startsAt })).toBe(0);

    const [first] = await rowsOf(flowId);
    expect(first).toMatchObject({ status: "pending", bookingId, contactId });
    expect(first!.dedupeKey).toContain(`booking_created:${bookingId}`);

    // 1.º paso: la espera. El siguiente queda para una hora antes de la cita y conserva la cita.
    const t1 = deps();
    expect(await engine.processRow(first as never, t1.d)).toBe("completed");
    const afterWait = await rowsOf(flowId);
    expect(afterWait).toHaveLength(2);
    const second = afterWait[1]!;
    expect(second.bookingId).toBe(bookingId);
    expect(second.scheduledFor.getTime()).toBe(startsAt.getTime() - 60 * 60_000);
    expect(t1.sendText).not.toHaveBeenCalled();

    // 2.º paso, a su hora: sale el mensaje con la fecha y la hora de la cita.
    const t2 = deps(new Date(second.scheduledFor.getTime() + 1000));
    expect(await engine.processRow(second as never, t2.d)).toBe("completed");
    expect(t2.sendText).toHaveBeenCalledTimes(1);
    const sent = (t2.sendText.mock.calls[0] as unknown as [{ text: string }])[0].text;
    expect(sent).toMatch(/^Recordatorio .+ a las \d{2}:\d{2}$/);
    expect(sent).not.toContain("{{");
  });

  it("ya es tarde para «1 día antes»: omite el mensaje ligado y sigue con el resto del flujo", async () => {
    const flowId = await makeFlow("booking_created", [
      { stepType: "wait_until", config: { anchor: "booking.scheduledAt", offsetMinutes: -1440, lateAction: "skip_next" } },
      SEND("Mañana tienes cita"),
      { stepType: "wait_until", config: WAIT },
      SEND("En una hora tu cita"),
    ]);
    const startsAt = new Date(Date.now() + 5 * 3_600_000); // «1 día antes» ya pasó
    const bookingId = await makeBooking(startsAt);
    const { onBookingCreated } = await import("@/server/automation/triggers");
    await onBookingCreated({ organizationId: org, bookingId, contactId, scheduledAt: startsAt });

    const [first] = await rowsOf(flowId);
    expect(await engine.processRow(first as never, deps().d)).toBe("completed");
    const all = await rowsOf(flowId);
    expect(all).toHaveLength(2);
    // Saltó el mensaje de «mañana» y cayó en la segunda espera.
    const steps = await db.select().from(schema.automationStep).where(eq(schema.automationStep.flowId, flowId)).orderBy(schema.automationStep.positionY);
    expect(all[1]!.stepId).toBe(steps[2]!.id);
    expect(all[1]!.bookingId).toBe(bookingId);
  });

  it("«terminar» corta el flujo: no encola nada más", async () => {
    const flowId = await makeFlow("booking_created", [
      { stepType: "wait_until", config: { anchor: "booking.scheduledAt", offsetMinutes: -1440, lateAction: "stop" } },
      SEND(),
    ]);
    const startsAt = new Date(Date.now() + 5 * 3_600_000);
    const bookingId = await makeBooking(startsAt);
    const { onBookingCreated } = await import("@/server/automation/triggers");
    await onBookingCreated({ organizationId: org, bookingId, contactId, scheduledAt: startsAt });
    const [first] = await rowsOf(flowId);
    expect(await engine.processRow(first as never, deps().d)).toBe("completed");
    const all = await rowsOf(flowId);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("completed");
  });

  it("al cancelar la cita se cancelan sus tareas pendientes, con su motivo", async () => {
    const flowId = await makeFlow("booking_created", [{ stepType: "wait_until", config: WAIT }, SEND()]);
    const startsAt = await freeSlot();
    const bookingId = await makeBooking(startsAt);
    const { onBookingCreated } = await import("@/server/automation/triggers");
    await onBookingCreated({ organizationId: org, bookingId, contactId, scheduledAt: startsAt });
    expect((await rowsOf(flowId))[0]!.status).toBe("pending");

    await agenda.cancelBooking({ organizationId: org, bookingId });
    const [row] = await rowsOf(flowId);
    expect(row).toMatchObject({ status: "cancelled", error: "booking_cancelled" });
  });

  it("red de seguridad: si la cita cambia sin pasar por la agenda, la tarea se cancela al ejecutarse", async () => {
    const flowId = await makeFlow("booking_created", [SEND()]);
    const startsAt = new Date(Date.now() + 8 * 3_600_000);
    const bookingId = await makeBooking(startsAt);
    const { onBookingCreated } = await import("@/server/automation/triggers");
    await onBookingCreated({ organizationId: org, bookingId, contactId, scheduledAt: startsAt });
    // Alguien la marca como realizada directamente en la base (p. ej. un cobro en Caja).
    await db.update(schema.booking).set({ status: "realizada" }).where(eq(schema.booking.id, bookingId));

    const [row] = await rowsOf(flowId);
    const t = deps();
    expect(await engine.processRow(row as never, t.d)).toBe("cancelled");
    expect(t.sendText).not.toHaveBeenCalled();
    expect((await rowsOf(flowId))[0]).toMatchObject({ status: "cancelled", error: "booking_not_active" });
  });

  it("Bloque 3 — la ejecución queda anclada a la hora de la cita (context.bookingAt)", async () => {
    const flowId = await makeFlow("booking_created", [SEND()]);
    const startsAt = new Date(Date.now() + 9 * 3_600_000);
    const bookingId = await makeBooking(startsAt);
    const { onBookingCreated } = await import("@/server/automation/triggers");
    await onBookingCreated({ organizationId: org, bookingId, contactId, scheduledAt: startsAt });
    const [run] = await db.select().from(schema.automationRun).where(eq(schema.automationRun.flowId, flowId));
    expect(run?.context).toMatchObject({ bookingId, bookingAt: startsAt.toISOString() });
  });

  it("Bloque 3 — red de seguridad: si la cita se MOVIÓ sin cancelar lo pendiente, la tarea vieja se cancela (booking_rescheduled) y no envía", async () => {
    const flowId = await makeFlow("booking_created", [SEND()]);
    const startsAt = new Date(Date.now() + 10 * 3_600_000);
    const bookingId = await makeBooking(startsAt);
    const { onBookingCreated } = await import("@/server/automation/triggers");
    await onBookingCreated({ organizationId: org, bookingId, contactId, scheduledAt: startsAt });
    // Se mueve directo en la base: la cancelación inmediata de `onBookingRescheduled` nunca corrió.
    await db
      .update(schema.booking)
      .set({ scheduledAt: new Date(startsAt.getTime() + 2 * 3_600_000) })
      .where(eq(schema.booking.id, bookingId));

    const [row] = await rowsOf(flowId);
    const t = deps();
    expect(await engine.processRow(row as never, t.d)).toBe("cancelled");
    expect(t.sendText).not.toHaveBeenCalled();
    expect((await rowsOf(flowId))[0]).toMatchObject({ status: "cancelled", error: "booking_rescheduled" });
  });

  it("crear la cita desde la agenda dispara el flujo (camino real: createSessionBooking)", async () => {
    const flowId = await makeFlow("booking_created", [{ stepType: "wait_until", config: WAIT }, SEND()]);
    const startsAt = await freeSlot();
    const result = await agenda.createSessionBooking({
      organizationId: org,
      startUtc: startsAt.toISOString(),
      source: "manual",
      contactId,
      requireOffer: false,
    });
    created.bookings.push(result.booking.id);
    const rows = await rowsOf(flowId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bookingId: result.booking.id, contactId, status: "pending" });
  });

  it("reprogramar: cancela lo pendiente, rearma con la hora nueva y limpia la confirmación", async () => {
    const flowId = await makeFlow("booking_created", [{ stepType: "wait_until", config: WAIT }, SEND()]);
    const from = await freeSlot();
    const to = await freeSlot();
    const created1 = await agenda.createSessionBooking({
      organizationId: org,
      startUtc: from.toISOString(),
      source: "manual",
      contactId,
      requireOffer: false,
    });
    const bookingId = created1.booking.id;
    created.bookings.push(bookingId);
    await agenda.confirmBooking({ organizationId: org, bookingId });
    expect((await rowsOf(flowId))).toHaveLength(1);

    await agenda.rescheduleBooking({ organizationId: org, bookingId, startUtc: to.toISOString() });

    const rows = await rowsOf(flowId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: "cancelled", error: "booking_rescheduled" });
    expect(rows[1]).toMatchObject({ status: "pending", bookingId });
    expect(rows[1]!.dedupeKey).toBe(`booking_created:${bookingId}:${to.getTime()}`);
    const [b] = await db.select().from(schema.booking).where(eq(schema.booking.id, bookingId));
    expect(b!.confirmedAt).toBeNull();
  });

  it("«No asistió» cancela los recordatorios y arranca los flujos de no-show, una sola vez", async () => {
    const reminder = await makeFlow("booking_created", [{ stepType: "wait_until", config: WAIT }, SEND()]);
    const noShow = await makeFlow("booking_no_show", [SEND("Te extrañamos")]);
    const startsAt = await freeSlot();
    const res = await agenda.createSessionBooking({ organizationId: org, startUtc: startsAt.toISOString(), source: "manual", contactId, requireOffer: false });
    const bookingId = res.booking.id;
    created.bookings.push(bookingId);

    await agenda.markBookingStatus({ organizationId: org, bookingId, status: "no_show" });
    await agenda.markBookingStatus({ organizationId: org, bookingId, status: "no_show" }); // repetido

    expect((await rowsOf(reminder))[0]).toMatchObject({ status: "cancelled", error: "booking_no_show" });
    const nsRows = await rowsOf(noShow);
    expect(nsRows).toHaveLength(1);
    expect(nsRows[0]).toMatchObject({ bookingId, status: "pending", dedupeKey: `booking_no_show:${bookingId}` });

    // El flujo de no-show sí se ejecuta aunque la cita ya no esté «agendada».
    const t = deps();
    expect(await engine.processRow(nsRows[0] as never, t.d)).toBe("completed");
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it("confirmar es idempotente y dispara el flujo una sola vez, aunque dos confirmen a la vez", async () => {
    const flowId = await makeFlow("booking_confirmed", [SEND("¡Gracias por confirmar!")]);
    const startsAt = await freeSlot();
    const res = await agenda.createSessionBooking({ organizationId: org, startUtc: startsAt.toISOString(), source: "manual", contactId, requireOffer: false });
    const bookingId = res.booking.id;
    created.bookings.push(bookingId);

    const [a, b] = await Promise.all([
      agenda.confirmBooking({ organizationId: org, bookingId }),
      agenda.confirmBooking({ organizationId: org, bookingId }),
    ]);
    expect([a.alreadyConfirmed, b.alreadyConfirmed].filter(Boolean)).toHaveLength(1);
    expect(await rowsOf(flowId)).toHaveLength(1);
    const again = await agenda.confirmBooking({ organizationId: org, bookingId });
    expect(again.alreadyConfirmed).toBe(true);
    expect(await rowsOf(flowId)).toHaveLength(1);
    const [row] = await db.select().from(schema.booking).where(eq(schema.booking.id, bookingId));
    expect(row!.confirmedAt).not.toBeNull();
  });

  it("solo se confirma una cita agendada, y no un bloqueo", async () => {
    const startsAt = new Date(Date.now() + 9 * 3_600_000);
    const done = await makeBooking(startsAt, { status: "cancelada" });
    await expect(agenda.confirmBooking({ organizationId: org, bookingId: done })).rejects.toMatchObject({ code: "invalid" });
    const block = await makeBooking(new Date(startsAt.getTime() + 3_600_000), { kind: "block", contactId: null });
    await expect(agenda.confirmBooking({ organizationId: org, bookingId: block })).rejects.toMatchObject({ code: "invalid" });
    await expect(agenda.confirmBooking({ organizationId: otherOrg, bookingId: done })).rejects.toMatchObject({ code: "not_found" });
  });

  it("una cita de prueba o un contacto sin chat real no encolan nada", async () => {
    const flowId = await makeFlow("booking_created", [SEND()]);
    const { onBookingCreated } = await import("@/server/automation/triggers");
    const t1 = new Date(Date.now() + 10 * 3_600_000);
    const prueba = await makeBooking(t1, { isTest: true });
    expect(await onBookingCreated({ organizationId: org, bookingId: prueba, contactId, scheduledAt: t1, isTest: true })).toBe(0);

    const lonely = `ct_b${tag}x`;
    await db.insert(schema.contact).values({ id: lonely, organizationId: org, name: "Sin chat", waIdentity: `bk-${tag}-x` });
    created.contacts.push(lonely);
    const t2 = new Date(Date.now() + 11 * 3_600_000);
    const sinChat = await makeBooking(t2, { contactId: lonely });
    expect(await onBookingCreated({ organizationId: org, bookingId: sinChat, contactId: lonely, scheduledAt: t2 })).toBe(0);
    expect(await rowsOf(flowId)).toHaveLength(0);
  });

  it("aislamiento: otra organización no puede cancelar las tareas de esta, y borrar la cita se lleva su cola", async () => {
    const flowId = await makeFlow("booking_created", [SEND()]);
    const startsAt = new Date(Date.now() + 12 * 3_600_000);
    const bookingId = await makeBooking(startsAt);
    const { onBookingCreated } = await import("@/server/automation/triggers");
    await onBookingCreated({ organizationId: org, bookingId, contactId, scheduledAt: startsAt });

    expect(await store.dbTriggerStore.cancelPendingForBooking(otherOrg, bookingId, "x")).toBe(0);
    expect((await rowsOf(flowId))[0]!.status).toBe("pending");

    await db.delete(schema.booking).where(and(eq(schema.booking.id, bookingId), eq(schema.booking.organizationId, org)));
    expect(await rowsOf(flowId)).toHaveLength(0);
  });
});
