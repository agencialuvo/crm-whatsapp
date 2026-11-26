import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Cupos de la agenda contra PostgreSQL REAL (`pnpm test:db`): la asignación automática de profesional al
 * reservar sin elegir (la IA y el bot), las tres citas de las 9:00 con tres profesionales, la carrera de
 * reservas simultáneas bajo el candado de la agenda, «Recibe citas», turnos y días libres, quién da cada
 * servicio, la duración real, la persona específica y la reprogramación.
 *
 * Crea su PROPIA organización (agenda abierta todos los días de 9 a 18 en Lima, sin aviso mínimo) para que
 * nada de otras pruebas cambie los cupos, y la borra al final (todo cuelga de ella en cascada).
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const TZ = "America/Lima";
const ALL_DAY = [{ start: "09:00", end: "18:00" }];

describe.skipIf(!live)("cupos de la agenda contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let agenda: typeof import("@/server/agenda/service");
  let availability: typeof import("@/server/agenda/availability");
  let agent: typeof import("@/server/agenda/agent");
  let slots: typeof import("@/lib/time/slots");

  const tag = Date.now().toString(36);
  const org = `org_cupos_${tag}`;
  const contactId = `ct_cupos_${tag}`;
  const convId = `cv_cupos_${tag}`;
  const ANA = `stf_ana_${tag}`;
  const BETO = `stf_beto_${tag}`;
  const CARLA = `stf_carla_${tag}`;
  const LARGO = `svc_largo_${tag}`;
  const SOLO_CARLA = `svc_carla_${tag}`;

  beforeAll(async () => {
    ({ eq, and } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    agenda = await import("@/server/agenda/service");
    availability = await import("@/server/agenda/availability");
    agent = await import("@/server/agenda/agent");
    slots = await import("@/lib/time/slots");

    await db.insert(schema.organization).values({ id: org, name: `Cupos ${tag}`, slug: `cupos-${tag}` });
    await db.insert(schema.calendarSettings).values({
      id: `cal_${tag}`,
      organizationId: org,
      weeklyHours: { mon: ALL_DAY, tue: ALL_DAY, wed: ALL_DAY, thu: ALL_DAY, fri: ALL_DAY, sat: ALL_DAY, sun: ALL_DAY },
      slotMinutes: 30,
      bufferMinutes: 0,
      minNoticeHours: 0,
      maxDaysAhead: 14,
      timezone: TZ,
      connector: "enlace-fijo",
      meetingLink: "https://meet.ejemplo.com/sala",
    });
    // Orden de alta: Ana, Beto, Carla.
    const team: [string, string][] = [
      [ANA, "Ana"],
      [BETO, "Beto"],
      [CARLA, "Carla"],
    ];
    for (const [i, [id, name]] of team.entries()) {
      await db.insert(schema.staff).values({ id, organizationId: org, name, createdAt: new Date(Date.UTC(2026, 0, 1 + i)) });
    }
    await db.insert(schema.service).values([
      { id: LARGO, organizationId: org, name: "Corte y barba", priceCents: 5000, durationMinutes: 60 },
      { id: SOLO_CARLA, organizationId: org, name: "Uñas", priceCents: 3000, durationMinutes: 30 },
    ]);
    await db.insert(schema.serviceStaff).values({ organizationId: org, serviceId: SOLO_CARLA, staffId: CARLA });
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Cliente Cupos", waIdentity: `cupos-${tag}` });
    await db.insert(schema.conversation).values({ id: convId, organizationId: org, contactId });
  });

  afterAll(async () => {
    if (!db) return;
    // Las ventas no existen aquí; citas, equipo, servicios, contactos y ajustes caen con la organización.
    await db.delete(schema.organization).where(eq(schema.organization.id, org));
  });

  /** Instante UTC (ISO) de una hora local, `days` días después de hoy en Lima. */
  function local(days: number, hhmm: string): string {
    const day = slots.addDaysISO(slots.todayInTz(new Date(), TZ), days);
    return slots.zonedWallClockToUtc(day, hhmm, TZ)!.toISOString();
  }

  /** Reserva como la IA o el bot: sin elegir profesional, salvo que se pida. */
  function book(startUtc: string, over: Partial<Parameters<typeof agenda.createSessionBooking>[0]> = {}) {
    return agenda.createSessionBooking({
      organizationId: org,
      contactId,
      startUtc,
      source: "ai",
      requireOffer: false,
      ...over,
    });
  }

  const staffOf = async (id: string) =>
    (await db.select({ staffId: schema.booking.staffId }).from(schema.booking).where(eq(schema.booking.id, id)))[0]!.staffId;

  it("tres reservas de la IA a las 9:00 con tres profesionales: entran las tres, cada una con alguien distinto", async () => {
    const at9 = local(2, "09:00");
    const a = await book(at9);
    const b = await book(at9);
    const c = await book(at9);
    expect(new Set([a.booking.staffId, b.booking.staffId, c.booking.staffId])).toEqual(new Set([ANA, BETO, CARLA]));
    // Sin carga previa ese día y sin historial, el orden es el de alta.
    expect([a.booking.staffId, b.booking.staffId, c.booking.staffId]).toEqual([ANA, BETO, CARLA]);

    // La cuarta ya no cabe: slot_taken con alternativas para esa misma cita.
    const fourth = await book(at9).catch((e: unknown) => e);
    expect(fourth).toMatchObject({ code: "slot_taken" });
    expect((fourth as { slots: unknown[] }).slots.length).toBeGreaterThan(0);

    // Y la disponibilidad ya no ofrece las 9:00 de ese día; las 9:30 sí.
    const day = slots.dayIsoInTz(new Date(at9), TZ);
    const free = (await availability.computeAvailability(org, { fromISO: day, toISO: day })).map((s) => s.startUtc);
    expect(free).not.toContain(at9);
    expect(free).toContain(local(2, "09:30"));
  });

  it("reservas simultáneas: el candado las pone en fila y entran exactamente tantas como cupos", async () => {
    const at11 = local(3, "11:00");
    const results = await Promise.allSettled([book(at11), book(at11), book(at11), book(at11), book(at11)]);
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof book>>>[];
    const ko = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(3);
    expect(new Set(ok.map((r) => r.value.booking.staffId))).toEqual(new Set([ANA, BETO, CARLA]));
    expect(ko).toHaveLength(2);
    for (const r of ko) expect(r.reason).toMatchObject({ code: "slot_taken" });
  });

  it("reparte el trabajo: a igual hora, la siguiente cita va a quien tiene menos minutos ese día", async () => {
    // Ana ya tiene una hora ese día; Beto y Carla nada.
    await book(local(4, "09:00"), { staffId: ANA, durationMinutes: 60 });
    const next = await book(local(4, "15:00"));
    expect(next.booking.staffId).not.toBe(ANA);
  });

  it("una cita de 60 min ocupa a su profesional también a la media hora", async () => {
    const r = await book(local(5, "14:00"), { serviceId: LARGO, staffId: ANA });
    expect(r.booking.durationMinutes).toBe(60);
    // Con Ana a las 14:30: ocupada todavía.
    await expect(book(local(5, "14:30"), { staffId: ANA })).rejects.toMatchObject({ code: "slot_taken" });
    // Con Beto, sí.
    expect((await book(local(5, "14:30"), { staffId: BETO })).booking.staffId).toBe(BETO);
    // Sin elegir: no le toca a Ana.
    expect((await book(local(5, "14:30"))).booking.staffId).toBe(CARLA);
  });

  it("un servicio de 60 min no se ofrece a las 17:30 (no cabe antes del cierre)", async () => {
    const day = slots.addDaysISO(slots.todayInTz(new Date(), TZ), 5);
    const largo = (await availability.computeAvailability(org, { fromISO: day, toISO: day, serviceId: LARGO, durationMinutes: 60 })).map(
      (s) => s.startUtc
    );
    expect(largo).toContain(local(5, "17:00"));
    expect(largo).not.toContain(local(5, "17:30"));
    await expect(book(local(5, "17:30"), { serviceId: LARGO })).rejects.toMatchObject({ code: "slot_taken" });
  });

  it("el servicio que solo da Carla se le asigna a ella, y si está ocupada no hay hueco", async () => {
    const at10 = local(6, "10:00");
    expect((await book(at10, { serviceId: SOLO_CARLA })).booking.staffId).toBe(CARLA);
    await expect(book(at10, { serviceId: SOLO_CARLA })).rejects.toMatchObject({ code: "slot_taken" });
    // Para otro servicio aún quedan Ana y Beto.
    expect([ANA, BETO]).toContain((await book(at10)).booking.staffId);
  });

  it("«Recibe citas» apagado: no cuenta para la IA, pero el operador sí puede asignárselo", async () => {
    await db.update(schema.staff).set({ acceptsBookings: false }).where(eq(schema.staff.id, CARLA));
    try {
      const at12 = local(7, "12:00");
      const x = await book(at12);
      const y = await book(at12);
      expect(new Set([x.booking.staffId, y.booking.staffId])).toEqual(new Set([ANA, BETO]));
      await expect(book(at12)).rejects.toMatchObject({ code: "slot_taken" });
      // La IA tampoco puede pedirla por nombre.
      await expect(book(at12, { staffId: CARLA })).rejects.toMatchObject({ code: "slot_taken" });
      // El operador sí, aunque los cupos del equipo estén llenos.
      const manual = await book(at12, { staffId: CARLA, source: "manual" });
      expect(manual.booking.staffId).toBe(CARLA);
      // Y el agente no la ve.
      expect((await availability.bookableStaff(org)).map((m) => m.id)).toEqual([ANA, BETO]);
    } finally {
      await db.update(schema.staff).set({ acceptsBookings: true }).where(eq(schema.staff.id, CARLA));
    }
  });

  it("respeta el día libre y el turno de cada profesional", async () => {
    const at16 = local(8, "16:00");
    const weekday = slots.weekdayKeyOf(slots.dayIsoInTz(new Date(at16), TZ), TZ)!;
    const dayIndex = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[weekday];
    await db.insert(schema.staffSchedule).values([
      { id: `sch_b_${tag}`, organizationId: org, staffId: BETO, dayOfWeek: dayIndex, startTime: "09:00", endTime: "18:00", isOff: true },
      { id: `sch_c_${tag}`, organizationId: org, staffId: CARLA, dayOfWeek: dayIndex, startTime: "09:00", endTime: "13:00", isOff: false },
    ]);
    try {
      // A las 16:00 solo trabaja Ana: un cupo.
      expect((await book(at16)).booking.staffId).toBe(ANA);
      await expect(book(at16)).rejects.toMatchObject({ code: "slot_taken" });
      // A las 12:30, una cita de 60 min no cabe en el turno de Carla (sale a las 13:00): le toca a Ana.
      expect((await book(local(8, "12:30"), { durationMinutes: 60 })).booking.staffId).toBe(ANA);
    } finally {
      await db.delete(schema.staffSchedule).where(eq(schema.staffSchedule.organizationId, org));
    }
  });

  it("una cita SIN asignar de antes gasta un cupo", async () => {
    const at17 = local(9, "17:00");
    await db.insert(schema.booking).values({
      id: `bk_old_${tag}`,
      organizationId: org,
      kind: "session",
      status: "agendada",
      source: "manual",
      contactId,
      scheduledAt: new Date(at17),
      durationMinutes: 30,
      connector: "enlace-fijo",
    });
    await book(at17);
    await book(at17);
    await expect(book(at17)).rejects.toMatchObject({ code: "slot_taken" });
  });

  it("reprogramar: conserva al profesional si sigue libre; si no, pasa a otro libre; pedido ocupado ⇒ slot_taken", async () => {
    const mine = await book(local(10, "09:00"), { staffId: ANA });
    // Libre a las 10:00: se queda con Ana.
    const moved = await agenda.rescheduleBooking({ organizationId: org, bookingId: mine.booking.id, startUtc: local(10, "10:00") });
    expect(moved.booking.staffId).toBe(ANA);

    // Ana ocupada a las 11:00: la cita pasa a otra persona libre.
    await book(local(10, "11:00"), { staffId: ANA });
    const moved2 = await agenda.rescheduleBooking({ organizationId: org, bookingId: mine.booking.id, startUtc: local(10, "11:00") });
    expect([BETO, CARLA]).toContain(moved2.booking.staffId);

    // Pedir a Ana a las 11:00 de forma explícita: no se cambia a otra persona.
    await expect(
      agenda.rescheduleBooking({ organizationId: org, bookingId: mine.booking.id, startUtc: local(10, "11:00"), staffId: ANA })
    ).rejects.toMatchObject({ code: "slot_taken" });
    expect(await staffOf(mine.booking.id)).toBe(moved2.booking.staffId);
  });

  it("la IA: ofrecer y reservar «con Beto» por la conversación", async () => {
    const turn = await agent.offerSlots({ organizationId: org, conversationId: convId, staffId: BETO });
    expect(turn.ok).toBe(true);
    const offers = await db
      .select({ startUtc: schema.offeredSlot.startUtc })
      .from(schema.offeredSlot)
      .where(and(eq(schema.offeredSlot.organizationId, org), eq(schema.offeredSlot.conversationId, convId)));
    expect(offers.length).toBeGreaterThan(0);
    const pick = offers[0]!.startUtc;
    const booked = await agent.bookSlot({
      organizationId: org,
      conversationId: convId,
      startUtc: pick instanceof Date ? pick.toISOString() : String(pick),
      staffId: BETO,
    });
    expect(booked.ok).toBe(true);
    const [row] = await db
      .select({ staffId: schema.booking.staffId })
      .from(schema.booking)
      .where(and(eq(schema.booking.organizationId, org), eq(schema.booking.conversationId, convId)));
    expect(row!.staffId).toBe(BETO);
  });
});
