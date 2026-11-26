import { asc, eq, gte, inArray, lt } from "drizzle-orm";
import { staffCanGive } from "@/lib/salon/providers";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type { BoardBooking, BoardDto, BoardSlot } from "@/lib/salon/types";
import { hhmm, wallClock } from "@/lib/time/calendar";
import {
  addDaysISO,
  dayIsoInTz,
  overlaps,
  timeInTz,
  todayInTz,
  weekdayKeyOf,
  zonedWallClockToUtc,
  type WeekdayKey,
} from "@/lib/time/slots";
import { shiftCovers, type StaffShift } from "@/lib/agenda/capacity";
import { buildCandidateSlots } from "@/server/agenda/availability";
import { BookingError, createSessionBooking } from "@/server/agenda/service";
import { getSettings } from "@/server/agenda/settings";
import { catalogStaffMaps } from "@/server/business/catalog-staff";
import { SalonError, isPgError, UNIQUE_VIOLATION } from "@/server/business/http";
import { publish } from "@/server/events/bus";
import { requestCalendarSync } from "@/server/agenda/calendar-sync/sync";

/**
 * Módulo SALON — el tablero de la agenda por sillas.
 *
 * Parte de las MISMAS franjas que ofrece el motor de disponibilidad (horario
 * semanal del negocio, `buildCandidateSlots`) y les pone encima lo que el
 * motor no dibuja: cuántos profesionales atienden en cada franja (su horario y
 * días libres), qué citas la ocupan y cuántos cupos quedan.
 *
 *   cupos libres = profesionales de turno − citas que ocupan la franja
 *
 * Es la misma regla multicupo del motor (`getBusyIntervals`): una franja se
 * llena cuando las citas igualan a las sillas. Sin ningún profesional dado de
 * alta el negocio tiene una silla, igual que allí.
 */

/** 0 = domingo … 6 = sábado, como `staff_schedule.day_of_week`. */
const DAY_INDEX: Record<WeekdayKey, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** Un bloqueo de hasta 600 min que empezó ayer sigue ocupando la madrugada de hoy. */
const LOOKBACK_MS = 24 * 3_600_000;

const validDate = (d: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(d) &&
  new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** El turno de un profesional un día de la semana (una fila de `staff_schedule`). */
export type { StaffShift };

/**
 * PURA: pone cupos a las franjas de un día.
 *
 *  - Trabaja en la franja quien no tiene fila ese día (sigue al negocio) o
 *    tiene una con horas que la contienen; un día libre no trabaja.
 *  - Los cupos son los de turno que RECIBEN CITAS (`acceptsBookings`, por defecto sí): quien lo tiene apagado
 *    sigue en el tablero (el operador puede asignarle a mano) pero no suma capacidad.
 *  - `booked` cuenta las citas que ocupan la franja, estén asignadas o no; los cupos libres solo descuentan
 *    las que gastan un cupo: las sin asignar y las de quien suma capacidad. Es la regla del motor
 *    (`evaluateSlot`, `src/lib/agenda/capacity.ts`).
 *  - Un bloqueo apaga la franja entera.
 *  - Sin ningún profesional dado de alta hay una silla (como el motor).
 */
export function buildBoardSlots(input: {
  candidates: { startUtc: string; endUtc: string }[];
  members: { id: string; acceptsBookings?: boolean }[];
  shifts: Map<string, StaffShift>;
  sessions: (Pick<BoardBooking, "startUtc" | "endUtc"> & { staffId?: string | null })[];
  blocks: Pick<BoardBooking, "startUtc" | "endUtc">[];
  date: string;
  timezone: string;
  now: Date;
}): BoardSlot[] {
  const { members, shifts, date, timezone: tz, now } = input;
  return input.candidates.map((c) => {
    const startMin = wallClock(c.startUtc, tz).minutes;
    const endClock = wallClock(c.endUtc, tz);
    const endMin = endClock.day === date ? endClock.minutes : 1440;

    // Sin fila ese día: sigue el horario del negocio; día libre: no trabaja.
    const workingMembers = members.filter((m) => shiftCovers(shifts.get(m.id), startMin, endMin));
    const working = workingMembers.map((m) => m.id);
    const seats = new Set(workingMembers.filter((m) => m.acceptsBookings !== false).map((m) => m.id));

    const crossing = input.sessions.filter((b) =>
      overlaps(c.startUtc, c.endUtc, b.startUtc, b.endUtc)
    );
    const booked = crossing.length;
    const consumed =
      members.length === 0 ? booked : crossing.filter((b) => !b.staffId || seats.has(b.staffId)).length;
    const blocked = input.blocks.some((b) =>
      overlaps(c.startUtc, c.endUtc, b.startUtc, b.endUtc)
    );
    const capacity = members.length === 0 ? 1 : seats.size;

    return {
      startUtc: c.startUtc,
      endUtc: c.endUtc,
      time: timeInTz(c.startUtc, tz),
      workingStaffIds: working,
      capacity,
      booked,
      free: blocked ? 0 : Math.max(0, capacity - consumed),
      blocked,
      past: Date.parse(c.endUtc) <= now.getTime(),
    };
  });
}

export async function getBoard(
  organizationId: string,
  dateISO?: string,
  now: Date = new Date()
): Promise<BoardDto> {
  const db = getDb();
  const settings = await getSettings(organizationId);
  const tz = settings.timezone;
  const today = todayInTz(now, tz);
  const date = dateISO ?? today;
  if (!validDate(date)) {
    throw new SalonError("invalid_date", 422, "Fecha no válida (AAAA-MM-DD)");
  }

  const dayStart = zonedWallClockToUtc(date, "00:00", tz)!;
  const dayEnd = zonedWallClockToUtc(addDaysISO(date, 1), "00:00", tz)!;

  const weekday = weekdayKeyOf(date, tz);
  const dayIndex = weekday ? DAY_INDEX[weekday] : -1;
  const open = weekday ? (settings.weeklyHours[weekday] ?? []).length > 0 : false;
  const candidates = buildCandidateSlots(settings, date, date);

  const [members, schedules, rows] = await Promise.all([
    db
      .select({ id: schema.staff.id, name: schema.staff.name, acceptsBookings: schema.staff.acceptsBookings })
      .from(schema.staff)
      .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.active, true)))
      .orderBy(asc(schema.staff.createdAt), asc(schema.staff.name)),
    db
      .select()
      .from(schema.staffSchedule)
      .where(
        scoped(
          schema.staffSchedule.organizationId,
          organizationId,
          eq(schema.staffSchedule.dayOfWeek, dayIndex)
        )
      ),
    db
      .select({
        booking: schema.booking,
        contactId: schema.contact.id,
        contactName: schema.contact.name,
        contactBirthdayDay: schema.contact.birthdayDay,
        contactBirthdayMonth: schema.contact.birthdayMonth,
        saleId: schema.serviceSale.id,
        serviceName: schema.service.name,
        comboName: schema.combo.name,
      })
      .from(schema.booking)
      .leftJoin(schema.contact, eq(schema.booking.contactId, schema.contact.id))
      .leftJoin(schema.service, eq(schema.booking.serviceId, schema.service.id))
      .leftJoin(schema.combo, eq(schema.booking.comboId, schema.combo.id))
      .leftJoin(schema.serviceSale, eq(schema.serviceSale.bookingId, schema.booking.id))
      .where(
        scoped(
          schema.booking.organizationId,
          organizationId,
          // Canceladas y no-show liberan el hueco; las de prueba no existen para la agenda real.
          inArray(schema.booking.status, ["agendada", "realizada"]),
          eq(schema.booking.isTest, false),
          gte(schema.booking.scheduledAt, new Date(dayStart.getTime() - LOOKBACK_MS)),
          lt(schema.booking.scheduledAt, dayEnd)
        )
      )
      .orderBy(asc(schema.booking.scheduledAt)),
  ]);

  const bookings: BoardBooking[] = rows
    .filter(
      (r) =>
        r.booking.scheduledAt.getTime() + r.booking.durationMinutes * 60_000 >
        dayStart.getTime()
    )
    .map((r) => {
      const startUtc = r.booking.scheduledAt.toISOString();
      return {
        id: r.booking.id,
        kind: r.booking.kind,
        status: r.booking.status,
        source: r.booking.source,
        startUtc,
        endUtc: new Date(
          r.booking.scheduledAt.getTime() + r.booking.durationMinutes * 60_000
        ).toISOString(),
        time: timeInTz(startUtc, tz),
        durationMinutes: r.booking.durationMinutes,
        contact:
          r.contactId && r.contactName
            ? {
                id: r.contactId,
                name: r.contactName,
                birthdayDay: r.contactBirthdayDay,
                birthdayMonth: r.contactBirthdayMonth,
              }
            : null,
        staffId: r.booking.staffId,
        notes: r.booking.notes,
        itemName: r.comboName ?? r.serviceName ?? null,
        sold: r.saleId !== null,
      };
    });

  const sessions = bookings.filter((b) => b.kind === "session");
  const blocks = bookings.filter((b) => b.kind === "block");

  const slots = buildBoardSlots({
    candidates,
    members,
    shifts: new Map(schedules.map((s) => [s.staffId, s])),
    sessions,
    blocks,
    date,
    timezone: tz,
    now,
  });

  return {
    date,
    timezone: tz,
    slotMinutes: settings.slotMinutes,
    open,
    chairs: members,
    slots,
    bookings,
    nowTime: date === today ? hhmm(wallClock(now, tz).minutes) : null,
  };
}

/**
 * Asigna (o quita, con `null`) el profesional de una cita.
 *
 * La base impide que un mismo profesional tenga dos citas activas a la misma
 * hora (índice único por instante y silla): ese choque llega como 23505 y se
 * traduce a un 409 con el nombre de quien ya está ocupado.
 */
export async function assignBookingStaff(
  organizationId: string,
  bookingId: string,
  staffId: string | null
): Promise<void> {
  const db = getDb();

  const [bk] = await db
    .select({
      id: schema.booking.id,
      kind: schema.booking.kind,
      status: schema.booking.status,
      isTest: schema.booking.isTest,
    })
    .from(schema.booking)
    .where(
      scoped(schema.booking.organizationId, organizationId, eq(schema.booking.id, bookingId))
    )
    .limit(1);
  if (!bk) throw new SalonError("not_found", 404, "La cita no existe");
  if (bk.kind !== "session" || bk.isTest || !["agendada", "realizada"].includes(bk.status)) {
    throw new SalonError("not_assignable", 409, "Esa cita no admite un profesional.");
  }

  let staffName = "";
  if (staffId) {
    const [member] = await db
      .select({ name: schema.staff.name, active: schema.staff.active })
      .from(schema.staff)
      .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.id, staffId)))
      .limit(1);
    if (!member) throw new SalonError("staff_not_found", 404, "El profesional no existe");
    if (!member.active) {
      throw new SalonError("staff_inactive", 409, `${member.name} está inactivo.`);
    }
    staffName = member.name;
  }

  try {
    await db
      .update(schema.booking)
      .set({ staffId, updatedAt: new Date() })
      .where(
        scoped(schema.booking.organizationId, organizationId, eq(schema.booking.id, bookingId))
      );
  } catch (err) {
    if (isPgError(err, UNIQUE_VIOLATION)) {
      throw new SalonError(
        "staff_busy",
        409,
        staffId
          ? `${staffName} ya tiene una cita a esa hora.`
          : "Ya hay una cita sin asignar a esa hora."
      );
    }
    throw err;
  }

  // El evento de Google Calendar muestra quién atiende.
  await requestCalendarSync(organizationId, bookingId);
  publish(organizationId, { type: "booking.updated", data: { bookingId } });
}

/**
 * Agendar una cita desde la agenda por sillas: cliente + servicio u oferta +
 * hora + profesional.
 *
 * Valida contra el MISMO tablero que ve quien agenda para decir con claridad por
 * qué no cabe, y delega la creación al motor de citas de siempre (conectores,
 * enlace de reunión, lead y evento en vivo). La cita dura lo que dura el
 * servicio u oferta: puede abarcar varias franjas, y TODAS deben estar libres
 * (sin bloqueo, con cupo y, si hay profesional, que atienda toda la duración y no
 * tenga otra cita encima). Sin profesional («Cualquiera disponible») el motor
 * asigna a quien esté libre (`createSessionBooking`). Si dos personas agendan a
 * la vez el mismo hueco, el candado de la agenda y el índice único cierran la
 * carrera: la perdedora recibe `slot_taken`/`staff_busy`.
 */
export async function createBoardBooking(
  organizationId: string,
  input: {
    contactId: string;
    startUtc: string;
    serviceId?: string | null;
    comboId?: string | null;
    staffId?: string | null;
    notes?: string | null;
  }
): Promise<{ bookingId: string }> {
  const staffId = input.staffId ?? null;
  const startMs = Date.parse(input.startUtc);
  if (Number.isNaN(startMs)) throw new SalonError("invalid_start", 422, "La hora no es válida");
  if (!input.serviceId === !input.comboId) {
    throw new SalonError("item_required", 422, "Elige el servicio u oferta");
  }
  const db = getDb();

  // El cliente tiene que ser de ESTE negocio: sin esto, un id ajeno o inventado
  // llegaba a la base como una violación de llave foránea (un 500).
  const [contact] = await db
    .select({ id: schema.contact.id })
    .from(schema.contact)
    .where(scoped(schema.contact.organizationId, organizationId, eq(schema.contact.id, input.contactId)))
    .limit(1);
  if (!contact) throw new SalonError("contact_not_found", 404, "El cliente no existe.");

  // El servicio u oferta: activo, de este negocio, y de él sale la duración.
  const item = input.serviceId
    ? (
        await db
          .select({
            id: schema.service.id,
            name: schema.service.name,
            durationMinutes: schema.service.durationMinutes,
          })
          .from(schema.service)
          .where(
            scoped(
              schema.service.organizationId,
              organizationId,
              eq(schema.service.id, input.serviceId),
              eq(schema.service.active, true)
            )
          )
          .limit(1)
      )[0]
    : (
        await db
          .select({
            id: schema.combo.id,
            name: schema.combo.name,
            durationMinutes: schema.combo.durationMinutes,
          })
          .from(schema.combo)
          .where(
            scoped(
              schema.combo.organizationId,
              organizationId,
              eq(schema.combo.id, input.comboId!),
              eq(schema.combo.active, true)
            )
          )
          .limit(1)
      )[0];
  if (!item) throw new SalonError("item_not_found", 404, "El servicio u oferta no existe o está inactivo.");

  const settings = await getSettings(organizationId);
  // Sin duración definida, la cita ocupa la franja estándar de la agenda.
  const durationMinutes = item.durationMinutes ?? settings.slotMinutes;
  const day = dayIsoInTz(new Date(startMs), settings.timezone);
  const board = await getBoard(organizationId, day);

  const slot = board.slots.find((s) => Date.parse(s.startUtc) === startMs);
  if (!slot) throw new SalonError("slot_not_found", 409, "Esa hora no está en la agenda de ese día.");
  if (slot.past) throw new SalonError("slot_past", 409, "Esa hora ya pasó.");

  // Las franjas que la cita ocupa: desde la hora elegida hasta que acaba el servicio.
  const endMs = startMs + durationMinutes * 60_000;
  const span = board.slots.filter(
    (s) => Date.parse(s.startUtc) < endMs && Date.parse(s.endUtc) > startMs
  );
  if (span.length === 0 || Date.parse(span[span.length - 1]!.endUtc) < endMs) {
    throw new SalonError(
      "slot_too_short",
      409,
      `${item.name} dura ${durationMinutes} min y no cabe: el negocio cierra antes. Elige una hora más temprana.`
    );
  }
  if (span.some((s) => s.blocked)) {
    throw new SalonError("slot_blocked", 409, "Parte de ese horario está bloqueada.");
  }
  // Quien no recibe citas no gasta un cupo del equipo: asignárselo a mano no depende de que queden cupos.
  const chosen = staffId ? board.chairs.find((c) => c.id === staffId) : undefined;
  if (!(chosen && !chosen.acceptsBookings) && span.some((s) => s.free <= 0)) {
    throw new SalonError("slot_full", 409, "Ya no quedan cupos para toda la duración del servicio.");
  }

  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const busyIn = (chairId: string) =>
    board.bookings.some(
      (b) => b.kind === "session" && b.staffId === chairId && overlaps(startIso, endIso, b.startUtc, b.endUtc)
    );
  // Quién da cada servicio u oferta (sin filas = todos).
  const staffBy = await catalogStaffMaps(organizationId);
  const providerItem = {
    kind: input.serviceId ? ("service" as const) : ("combo" as const),
    id: item.id,
    staffIds: (input.serviceId ? staffBy.services : staffBy.combos).get(item.id) ?? [],
  };
  const worksAll = (chairId: string) => span.every((s) => s.workingStaffIds.includes(chairId));

  if (staffId) {
    const chair = chosen;
    if (!chair) {
      throw new SalonError("staff_not_found", 404, "El profesional no existe o está inactivo.");
    }
    if (!worksAll(chair.id)) {
      throw new SalonError("staff_off_shift", 409, `${chair.name} no atiende durante todo ese servicio.`);
    }
    if (busyIn(chair.id)) throw new SalonError("staff_busy", 409, `${chair.name} ya tiene una cita en ese tramo.`);
    if (!staffCanGive(providerItem, { id: chair.id, active: true })) {
      throw new SalonError("staff_not_assigned", 409, `${chair.name} no da ${item.name}.`);
    }
  } else if (board.chairs.length > 0) {
    // «Cualquiera disponible»: el motor elige; aquí solo se explica con claridad si no hay nadie.
    const someone = board.chairs.some(
      (c) => c.acceptsBookings && worksAll(c.id) && !busyIn(c.id) && staffCanGive(providerItem, { id: c.id, active: true })
    );
    if (!someone) {
      throw new SalonError(
        "no_staff_free",
        409,
        `Nadie que dé ${item.name} está libre durante todo ese horario. Elige otra hora o asigna a alguien a mano.`
      );
    }
  }

  try {
    const result = await createSessionBooking({
      organizationId,
      contactId: input.contactId,
      startUtc: slot.startUtc,
      staffId,
      serviceId: input.serviceId ?? null,
      comboId: input.comboId ?? null,
      durationMinutes,
      notes: input.notes ?? null,
      source: "manual",
      requireOffer: false,
    });
    return { bookingId: result.booking.id };
  } catch (err) {
    if (err instanceof BookingError) {
      if (err.code === "not_found") throw new SalonError("contact_not_found", 404, err.message);
      if (err.code === "invalid") throw new SalonError("invalid_booking", 422, err.message);
      throw new SalonError(staffId ? "staff_busy" : "slot_taken", 409, "Ese horario acaba de ocuparse.");
    }
    throw err;
  }
}
