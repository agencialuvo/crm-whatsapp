import { and, asc, eq, gte, inArray, lte, max } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  addDaysISO,
  eachDateInRange,
  expandWorkingDayToUtc,
  labelInTz,
  overlaps,
  todayInTz,
  weekdayKeyOf,
  zonedWallClockToUtc,
  type SlotUtc,
} from "@/lib/time/slots";
import { getSettings, type CalendarSettings } from "@/server/agenda/settings";
import {
  dayLoadMinutes,
  evaluateSlot,
  orderStaffForAssignment,
  type CapacityMember,
  type CapacitySession,
  type StaffShift,
} from "@/lib/agenda/capacity";

/**
 * 015 — Motor de disponibilidad:
 *   horario semanal del negocio − bloqueos manuales − tramos sin nadie libre.
 *
 * Cupos (`src/lib/agenda/capacity.ts`): una hora tiene tantos cupos como profesionales que reciben citas,
 * dan ese servicio, trabajan TODA la duración de la cita y no tienen otra encima. Sin equipo, una silla.
 *
 * Limitación v1 documentada (Constitución VII): NO lee calendarios externos.
 * Es una decisión, no un olvido: meter al proveedor en este camino acoplaría su
 * latencia y sus caídas a la pantalla que más se usa. Los compromisos de fuera
 * se reflejan con bloqueos manuales.
 */

export type AvailableSlot = SlotUtc & { label: string };

/**
 * PURA: expande el horario semanal a slots candidatos en UTC. Sin BD, sin
 * reloj — se testea sola (tests/unit/availability.test.ts).
 */
export function buildCandidateSlots(
  settings: CalendarSettings,
  fromISO: string,
  toISO: string
): SlotUtc[] {
  const tz = settings.timezone;
  const candidates: SlotUtc[] = [];
  for (const date of eachDateInRange(fromISO, toISO)) {
    const weekday = weekdayKeyOf(date, tz);
    if (!weekday) continue;
    const intervals = settings.weeklyHours[weekday] ?? [];
    if (intervals.length === 0) continue; // día cerrado
    candidates.push(
      ...expandWorkingDayToUtc(
        date,
        intervals,
        tz,
        settings.slotMinutes,
        settings.bufferMinutes
      )
    );
  }
  return candidates;
}

/**
 * PURA: descarta lo que ya pasó (con aviso mínimo) y lo que se solapa con algo
 * ocupado, ordena y etiqueta.
 */
export function filterFreeSlots(
  candidates: SlotUtc[],
  busy: SlotUtc[],
  opts: { now: Date; minNoticeHours: number; timezone: string }
): AvailableSlot[] {
  const minStartMs = opts.now.getTime() + opts.minNoticeHours * 3_600_000;
  return candidates
    .filter((c) => Date.parse(c.startUtc) >= minStartMs)
    .filter(
      (c) =>
        !busy.some((b) => overlaps(c.startUtc, c.endUtc, b.startUtc, b.endUtc))
    )
    .sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc))
    .map((c) => ({ ...c, label: labelInTz(c.startUtc, opts.timezone) }));
}

/**
 * Qué cita se quiere poner: cuánto dura, de qué servicio u oferta (para saber quién lo da) y, si se pidió,
 * con qué profesional. Todo opcional: sin nada es una franja estándar con cualquiera del equipo.
 */
export type SlotTarget = {
  /** Duración real de la cita; sin ella, una franja (`slotMinutes`). */
  durationMinutes?: number;
  serviceId?: string | null;
  comboId?: string | null;
  /** Persona específica («con Ana»). */
  staffId?: string | null;
  /** El operador asigna a mano: vale aunque la persona tenga «Recibe citas» apagado. */
  allowExcludedStaff?: boolean;
};

/** Un hueco reservable con los profesionales que lo pueden tomar, en el orden en que se intentan. */
export type BookableSlot = AvailableSlot & { staffIds: string[] };

/** Lo mínimo que se necesita para leer: la base o una transacción (la reserva lee DENTRO de su candado). */
type Reader = Pick<ReturnType<typeof getDb>, "select">;

type AvailabilityOpts = SlotTarget & {
  fromISO?: string;
  toISO?: string;
  excludeBookingId?: string;
  now?: Date;
  settings?: CalendarSettings;
  db?: Reader;
};

/** Una cita de hasta 600 min que empezó el día anterior todavía ocupa el principio del rango. */
const LOOKBACK_MS = 24 * 3_600_000;

/** Lo que se lee de la base para calcular cupos. */
export type AgendaSnapshot = {
  members: CapacityMember[];
  sessions: CapacitySession[];
  blocks: { startMs: number; endMs: number }[];
  /** Quiénes dan el servicio u oferta pedido; `null` = todo el equipo. */
  providers: string[] | null;
};

async function loadSnapshot(
  db: Reader,
  organizationId: string,
  input: { fromUtc: Date; toUtc: Date; target: SlotTarget }
): Promise<AgendaSnapshot> {
  const { target } = input;
  const [members, schedules, rows, providerRows] = await Promise.all([
    db
      .select({
        id: schema.staff.id,
        acceptsBookings: schema.staff.acceptsBookings,
        createdAt: schema.staff.createdAt,
      })
      .from(schema.staff)
      .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.active, true))),
    db
      .select({
        staffId: schema.staffSchedule.staffId,
        dayOfWeek: schema.staffSchedule.dayOfWeek,
        isOff: schema.staffSchedule.isOff,
        startTime: schema.staffSchedule.startTime,
        endTime: schema.staffSchedule.endTime,
      })
      .from(schema.staffSchedule)
      .where(scoped(schema.staffSchedule.organizationId, organizationId)),
    db
      .select({
        id: schema.booking.id,
        kind: schema.booking.kind,
        staffId: schema.booking.staffId,
        scheduledAt: schema.booking.scheduledAt,
        durationMinutes: schema.booking.durationMinutes,
      })
      .from(schema.booking)
      .where(
        scoped(
          schema.booking.organizationId,
          organizationId,
          and(
            // Canceladas y no-show liberan el hueco.
            inArray(schema.booking.status, ["agendada", "realizada"]),
            // Sandbox: una cita de prueba no consume la agenda real.
            eq(schema.booking.isTest, false),
            gte(schema.booking.scheduledAt, new Date(input.fromUtc.getTime() - LOOKBACK_MS)),
            lte(schema.booking.scheduledAt, input.toUtc)
          )
        )
      ),
    target.serviceId
      ? db
          .select({ staffId: schema.serviceStaff.staffId })
          .from(schema.serviceStaff)
          .where(
            scoped(
              schema.serviceStaff.organizationId,
              organizationId,
              eq(schema.serviceStaff.serviceId, target.serviceId)
            )
          )
      : target.comboId
        ? db
            .select({ staffId: schema.comboStaff.staffId })
            .from(schema.comboStaff)
            .where(
              scoped(schema.comboStaff.organizationId, organizationId, eq(schema.comboStaff.comboId, target.comboId))
            )
        : Promise.resolve([] as { staffId: string }[]),
  ]);

  const shiftsBy = new Map<string, Map<number, StaffShift>>();
  for (const s of schedules) {
    const map = shiftsBy.get(s.staffId) ?? new Map<number, StaffShift>();
    map.set(s.dayOfWeek, { isOff: s.isOff, startTime: s.startTime, endTime: s.endTime });
    shiftsBy.set(s.staffId, map);
  }

  const sessions: CapacitySession[] = [];
  const blocks: AgendaSnapshot["blocks"] = [];
  for (const r of rows) {
    const startMs = r.scheduledAt.getTime();
    const endMs = startMs + r.durationMinutes * 60_000;
    if (r.kind === "block") blocks.push({ startMs, endMs });
    else sessions.push({ id: r.id, staffId: r.staffId, startMs, endMs });
  }

  return {
    members: members.map((m) => ({
      id: m.id,
      acceptsBookings: m.acceptsBookings,
      createdAtMs: m.createdAt.getTime(),
      shifts: shiftsBy.get(m.id) ?? new Map(),
    })),
    sessions,
    blocks,
    providers: providerRows.length > 0 ? providerRows.map((r) => r.staffId) : null,
  };
}

/**
 * PURA: los tramos en que el negocio abre, en UTC, para cada día de [from, to]. Una cita tiene que caber
 * ENTERA en uno de ellos: un servicio de 60 min no empieza media hora antes de cerrar.
 */
export function openIntervals(
  settings: Pick<CalendarSettings, "weeklyHours" | "timezone">,
  fromISO: string,
  toISO: string
): { startMs: number; endMs: number }[] {
  const out: { startMs: number; endMs: number }[] = [];
  for (const date of eachDateInRange(fromISO, toISO)) {
    const weekday = weekdayKeyOf(date, settings.timezone);
    if (!weekday) continue;
    for (const iv of settings.weeklyHours[weekday] ?? []) {
      const start = zonedWallClockToUtc(date, iv.start, settings.timezone);
      const end = zonedWallClockToUtc(date, iv.end, settings.timezone);
      if (start && end && end > start) out.push({ startMs: start.getTime(), endMs: end.getTime() });
    }
  }
  return out;
}

/**
 * PURA: de las franjas candidatas, las que se pueden reservar para esta cita: con aviso mínimo, enteras
 * dentro del horario, sin bloqueo encima en toda su duración y con alguien que la pueda atender.
 */
export function bookableSlots(input: {
  candidates: SlotUtc[];
  open: { startMs: number; endMs: number }[];
  snapshot: AgendaSnapshot;
  durationMinutes: number;
  target: SlotTarget;
  excludeBookingId?: string | null;
  now: Date;
  minNoticeHours: number;
  timezone: string;
}): BookableSlot[] {
  const minStartMs = input.now.getTime() + input.minNoticeHours * 3_600_000;
  const span = input.durationMinutes * 60_000;
  const out: BookableSlot[] = [];
  for (const c of input.candidates) {
    const startMs = Date.parse(c.startUtc);
    const endMs = startMs + span;
    if (Number.isNaN(startMs) || startMs < minStartMs) continue;
    if (!input.open.some((o) => startMs >= o.startMs && endMs <= o.endMs)) continue;
    if (input.snapshot.blocks.some((b) => b.startMs < endMs && startMs < b.endMs)) continue;
    const verdict = evaluateSlot(
      { members: input.snapshot.members, sessions: input.snapshot.sessions, timezone: input.timezone },
      {
        startMs,
        endMs,
        providers: input.snapshot.providers,
        staffId: input.target.staffId ?? null,
        allowExcludedStaff: input.target.allowExcludedStaff,
        excludeBookingId: input.excludeBookingId,
      }
    );
    if (!verdict.ok) continue;
    const startUtc = new Date(startMs).toISOString();
    out.push({
      startUtc,
      endUtc: new Date(endMs).toISOString(),
      label: labelInTz(startUtc, input.timezone),
      staffIds: verdict.staffIds,
    });
  }
  return out.sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
}

/** Duración de la cita: la pedida o, sin ella, una franja. */
const durationOf = (target: SlotTarget, settings: CalendarSettings): number =>
  target.durationMinutes && target.durationMinutes > 0 ? target.durationMinutes : settings.slotMinutes;

export async function computeAvailability(
  organizationId: string,
  opts?: AvailabilityOpts
): Promise<AvailableSlot[]> {
  return (await bookable(organizationId, opts)).map(({ startUtc, endUtc, label }) => ({ startUtc, endUtc, label }));
}

async function bookable(organizationId: string, opts?: AvailabilityOpts): Promise<BookableSlot[]> {
  const settings = opts?.settings ?? (await getSettings(organizationId));
  const now = opts?.now ?? new Date();
  const tz = settings.timezone;

  const from = opts?.fromISO ?? todayInTz(now, tz);
  const to = opts?.toISO ?? addDaysISO(from, settings.maxDaysAhead);

  const candidates = buildCandidateSlots(settings, from, to);
  if (candidates.length === 0) return [];

  const target: SlotTarget = opts ?? {};
  const snapshot = await loadSnapshot(opts?.db ?? getDb(), organizationId, {
    fromUtc: zonedWallClockToUtc(from, "00:00", tz) ?? new Date(0),
    toUtc:
      zonedWallClockToUtc(addDaysISO(to, 1), "00:00", tz) ??
      new Date(now.getTime() + 86_400_000 * 61),
    target,
  });

  return bookableSlots({
    candidates,
    open: openIntervals(settings, from, to),
    snapshot,
    durationMinutes: durationOf(target, settings),
    target,
    excludeBookingId: opts?.excludeBookingId,
    now,
    minNoticeHours: settings.minNoticeHours,
    timezone: tz,
  });
}

/**
 * Re-valida que un instante concreto siga libre para ESTA cita (su duración, su servicio y, si se pidió, su
 * profesional) y devuelve quiénes la pueden tomar, en el orden en que se intentan. Se llama AL CONFIRMAR,
 * nunca al ofrecer. `excludeBookingId` permite reprogramar sin que la propia cita se bloquee a sí misma.
 *
 * Solo recalcula ±1 día alrededor del instante pedido. La reserva lo llama con la transacción que tiene el
 * candado de la agenda (`db`): lo que lee ya incluye lo que confirmó la reserva anterior.
 */
export async function findSlot(
  organizationId: string,
  whenISO: string,
  opts?: SlotTarget & { excludeBookingId?: string; now?: Date; settings?: CalendarSettings; db?: Reader }
): Promise<BookableSlot | null> {
  const target = Date.parse(whenISO);
  if (Number.isNaN(target)) return null;

  const settings = opts?.settings ?? (await getSettings(organizationId));
  const db = opts?.db ?? getDb();
  const dayInTz = todayInTz(new Date(target), settings.timezone);

  const slots = await bookable(organizationId, {
    ...opts,
    fromISO: addDaysISO(dayInTz, -1),
    toISO: addDaysISO(dayInTz, 1),
    settings,
    db,
  });
  const slot = slots.find((s) => Date.parse(s.startUtc) === target);
  if (!slot || slot.staffIds.length <= 1) return slot ?? null;

  // Varios libres: se ordenan por carga del día y por quién lleva más tiempo sin recibir una cita.
  const dayStart = zonedWallClockToUtc(dayInTz, "00:00", settings.timezone)!.getTime();
  const dayEnd = zonedWallClockToUtc(addDaysISO(dayInTz, 1), "00:00", settings.timezone)!.getTime();
  const snapshot = await loadSnapshot(db, organizationId, {
    fromUtc: new Date(dayStart),
    toUtc: new Date(dayEnd),
    target: {},
  });
  const last = await db
    .select({ staffId: schema.booking.staffId, at: max(schema.booking.createdAt) })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.kind, "session"),
        eq(schema.booking.isTest, false),
        inArray(schema.booking.staffId, slot.staffIds)
      )
    )
    .groupBy(schema.booking.staffId);

  return {
    ...slot,
    staffIds: orderStaffForAssignment(slot.staffIds, {
      members: snapshot.members,
      loadMinutes: dayLoadMinutes(snapshot.sessions, dayStart, dayEnd, opts?.excludeBookingId),
      lastAssignedMs: new Map(
        last.flatMap((r) => (r.staffId && r.at ? [[r.staffId, r.at.getTime()] as const] : []))
      ),
    }),
  };
}

/**
 * Los profesionales que reciben citas (activos y con «Recibe citas»), para decirle al agente a quién puede
 * nombrar. Vacío = sin equipo: la cita no lleva profesional.
 */
export async function bookableStaff(organizationId: string): Promise<{ id: string; name: string }[]> {
  return getDb()
    .select({ id: schema.staff.id, name: schema.staff.name })
    .from(schema.staff)
    .where(
      scoped(
        schema.staff.organizationId,
        organizationId,
        eq(schema.staff.active, true),
        eq(schema.staff.acceptsBookings, true)
      )
    )
    .orderBy(asc(schema.staff.createdAt), asc(schema.staff.name));
}

/** Una cita o un bloqueo, ya con sus instantes (lo que necesita el cálculo de ocupación). */
export type BusyRow = { kind: "session" | "block"; startUtc: string; endUtc: string };

/**
 * PURA: qué intervalos NO se pueden ofrecer, dadas las citas del rango y el
 * número de sillas. Es la vista AGREGADA del multicupo (sin mirar quién atiende cada cita); el motor ya
 * decide por profesional con `evaluateSlot` (`src/lib/agenda/capacity.ts`).
 *
 *  - Un BLOQUEO manual ocupa su intervalo completo sea cual sea el número de
 *    sillas: es tiempo que el negocio no atiende, no una cita más.
 *  - Con N sillas, el negocio solo se llena cuando N citas coinciden EN EL
 *    TIEMPO: se barre la línea de tiempo y se devuelven los tramos donde hay N
 *    o más citas a la vez, con su duración real. (Contar solo las que empiezan
 *    a la misma hora dejaba pasar citas de distinta duración que sí se pisan, y
 *    ignoraba cuánto dura cada una.)
 *  - Con una sola silla es exactamente lo de siempre: cada cita ocupa su
 *    intervalo.
 */
export function buildBusyIntervals(rows: BusyRow[], chairs: number): SlotUtc[] {
  const capacity = Math.max(1, Math.floor(chairs));
  const busy: SlotUtc[] = rows
    .filter((r) => r.kind === "block")
    .map((r) => ({ startUtc: r.startUtc, endUtc: r.endUtc }));

  // Barrido: +1 al empezar una cita, −1 al terminar. Al empatar en el tiempo,
  // primero se cierran las que terminan: dos citas pegadas (10:00–10:30 y
  // 10:30–11:00) nunca cuentan como simultáneas.
  const events: { at: number; delta: 1 | -1 }[] = [];
  for (const r of rows) {
    if (r.kind !== "session") continue;
    const start = Date.parse(r.startUtc);
    const end = Date.parse(r.endUtc);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    events.push({ at: start, delta: 1 }, { at: end, delta: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);

  let active = 0;
  let fullSince: number | null = null;
  for (const ev of events) {
    active += ev.delta;
    if (active >= capacity && fullSince === null) {
      fullSince = ev.at;
    } else if (active < capacity && fullSince !== null) {
      if (ev.at > fullSince) {
        busy.push({
          startUtc: new Date(fullSince).toISOString(),
          endUtc: new Date(ev.at).toISOString(),
        });
      }
      fullSince = null;
    }
  }
  return busy;
}
