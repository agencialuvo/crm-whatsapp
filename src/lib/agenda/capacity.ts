import { wallClock } from "@/lib/time/calendar";
import { weekdayKeyOf, type WeekdayKey } from "@/lib/time/slots";

/**
 * Cupos de la agenda: quién puede atender una cita y a quién se le asigna.
 *
 * Módulo PURO (sin BD ni reloj): lo usan el motor de disponibilidad, la reserva y el tablero por sillas,
 * así que lo que se ofrece, lo que se reserva y lo que se dibuja siguen la misma regla.
 *
 * Un profesional PUEDE atender el tramo [inicio, fin) si:
 *   - está activo (quien llama solo pasa activos) y tiene «Recibe citas» encendido,
 *   - da ese servicio u oferta (sin lista en el servicio = lo da todo el equipo),
 *   - su turno de ese día cubre TODO el tramo y no es su día libre (sin turno guardado = horario del negocio),
 *   - no tiene una cita propia que se cruce con el tramo,
 *   - Mejora 3: no está ocupado en SU Google Calendar (`staffBusy`: bloqueos con profesional). Un bloqueo
 *     así lo saca solo a él; los bloqueos del negocio (sin profesional) apagan el tramo para todos y se
 *     aplican antes, fuera de este módulo.
 *
 *   cupos libres = profesionales que pueden − citas SIN asignar que se cruzan con el tramo
 *
 * Las citas sin asignar (de antes de la asignación automática) se cuentan como cupos ya consumidos: no se
 * sabe a quién tocan, así que se supone lo peor. Sin equipo dado de alta, el negocio tiene UNA silla.
 */

/** El turno de un profesional un día de la semana (una fila de `staff_schedule`). */
export type StaffShift = { isOff: boolean; startTime: string; endTime: string };

/** 0 = domingo … 6 = sábado, como `staff_schedule.day_of_week`. */
export const DAY_INDEX: Record<WeekdayKey, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export type CapacityMember = {
  id: string;
  acceptsBookings: boolean;
  /** Orden de alta (desempate final). */
  createdAtMs: number;
  /** Turno por día de la semana (0..6); sin entrada = sigue el horario del negocio. */
  shifts: ReadonlyMap<number, StaffShift>;
};

export type CapacitySession = { id: string; staffId: string | null; startMs: number; endMs: number };

/** Mejora 3: un tramo en que UN profesional está ocupado (su Google Calendar). */
export type StaffBusy = { staffId: string; startMs: number; endMs: number };

/** ¿Ese profesional está ocupado (por su calendario) en algún momento de [startMs, endMs)? */
export function staffIsBusy(busy: readonly StaffBusy[] | undefined, staffId: string, startMs: number, endMs: number): boolean {
  return !!busy?.some((b) => b.staffId === staffId && b.startMs < endMs && startMs < b.endMs);
}

export type SlotQuery = {
  startMs: number;
  endMs: number;
  /** Quiénes dan el servicio u oferta; `null` o vacío = todo el equipo. */
  providers: readonly string[] | null;
  /** Persona específica. */
  staffId?: string | null;
  /** El operador asigna a mano: la persona pedida cuenta aunque tenga «Recibe citas» apagado. */
  allowExcludedStaff?: boolean;
  /** Reprogramar: la propia cita no se estorba a sí misma. */
  excludeBookingId?: string | null;
};

export type SlotVerdict = {
  /** ¿Se puede reservar en este tramo (con esa persona, si se pidió)? */
  ok: boolean;
  /** Cupos libres que quedan en el tramo (≥ 0). */
  free: number;
  /** Quiénes podrían atenderla, sin orden; vacío sin equipo (la cita queda sin profesional). */
  staffIds: string[];
};

const minutesOf = (text: string): number => {
  const [h, m] = text.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

/** ¿Un turno cubre [startMin, endMin) en minutos del día? Sin turno = sigue al negocio (sí). */
export function shiftCovers(shift: StaffShift | undefined, startMin: number, endMin: number): boolean {
  if (!shift) return true;
  if (shift.isOff) return false;
  return startMin >= minutesOf(shift.startTime) && endMin <= minutesOf(shift.endTime);
}

/** ¿Trabaja este profesional durante todo [startMs, endMs)? Se mira en la zona del negocio. */
export function memberWorks(member: CapacityMember, startMs: number, endMs: number, timezone: string): boolean {
  const start = wallClock(new Date(startMs), timezone);
  const end = wallClock(new Date(endMs), timezone);
  // Un tramo que cruza la medianoche se mide contra el turno del día en que empieza.
  const endMin = end.day === start.day ? end.minutes : 1440 + end.minutes;
  const weekday = weekdayKeyOf(start.day, timezone);
  if (!weekday) return false;
  return shiftCovers(member.shifts.get(DAY_INDEX[weekday]), start.minutes, endMin);
}

const gives = (providers: readonly string[] | null, id: string): boolean =>
  !providers || providers.length === 0 || providers.includes(id);

/** ¿Quién puede atender el tramo y cuántos cupos quedan? */
export function evaluateSlot(
  ctx: {
    members: readonly CapacityMember[];
    sessions: readonly CapacitySession[];
    timezone: string;
    /** Mejora 3: lo ocupado en el Google Calendar de cada profesional. */
    staffBusy?: readonly StaffBusy[];
  },
  q: SlotQuery
): SlotVerdict {
  const crossing = ctx.sessions.filter(
    (s) => s.id !== q.excludeBookingId && s.startMs < q.endMs && q.startMs < s.endMs
  );

  // Sin equipo: una silla, la cita queda sin profesional.
  if (ctx.members.length === 0) {
    const free = Math.max(0, 1 - crossing.length);
    return { ok: !q.staffId && free > 0, free, staffIds: [] };
  }

  const busy = new Set(crossing.flatMap((s) => (s.staffId ? [s.staffId] : [])));
  const unassigned = crossing.filter((s) => s.staffId === null).length;
  const canServe = (m: CapacityMember): boolean =>
    gives(q.providers, m.id) &&
    !busy.has(m.id) &&
    !staffIsBusy(ctx.staffBusy, m.id, q.startMs, q.endMs) &&
    memberWorks(m, q.startMs, q.endMs, ctx.timezone);

  const pool = ctx.members.filter((m) => m.acceptsBookings && canServe(m));
  const free = Math.max(0, pool.length - unassigned);

  if (q.staffId) {
    const m = ctx.members.find((x) => x.id === q.staffId);
    if (!m || !canServe(m)) return { ok: false, free, staffIds: [] };
    if (m.acceptsBookings) return free > 0 ? { ok: true, free, staffIds: [m.id] } : { ok: false, free, staffIds: [] };
    // Fuera de los cupos: solo a mano, y no gasta un cupo del equipo.
    return q.allowExcludedStaff ? { ok: true, free, staffIds: [m.id] } : { ok: false, free, staffIds: [] };
  }

  return free > 0 ? { ok: true, free, staffIds: pool.map((m) => m.id) } : { ok: false, free, staffIds: [] };
}

/**
 * Orden en que se intenta asignar entre varios libres (el primero se lleva la cita):
 *   1. menos minutos de citas ese día (reparte el trabajo),
 *   2. quien lleva más tiempo sin que se le asigne una cita (nunca = primero),
 *   3. orden de alta y, al final, el id (resultado estable y probable).
 */
export function orderStaffForAssignment(
  staffIds: readonly string[],
  input: {
    members: readonly CapacityMember[];
    loadMinutes: ReadonlyMap<string, number>;
    lastAssignedMs: ReadonlyMap<string, number>;
  }
): string[] {
  const created = new Map(input.members.map((m) => [m.id, m.createdAtMs]));
  const key = (id: string) => ({
    load: input.loadMinutes.get(id) ?? 0,
    last: input.lastAssignedMs.get(id) ?? Number.NEGATIVE_INFINITY,
    created: created.get(id) ?? Number.POSITIVE_INFINITY,
  });
  return [...staffIds].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka.load !== kb.load) return ka.load - kb.load;
    if (ka.last !== kb.last) return ka.last < kb.last ? -1 : 1;
    if (ka.created !== kb.created) return ka.created - kb.created;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Minutos de citas por profesional que caen en [dayStartMs, dayEndMs) (la carga de ese día). */
export function dayLoadMinutes(
  sessions: readonly CapacitySession[],
  dayStartMs: number,
  dayEndMs: number,
  excludeBookingId?: string | null
): Map<string, number> {
  const load = new Map<string, number>();
  for (const s of sessions) {
    if (!s.staffId || s.id === excludeBookingId) continue;
    const from = Math.max(s.startMs, dayStartMs);
    const to = Math.min(s.endMs, dayEndMs);
    if (to <= from) continue;
    load.set(s.staffId, (load.get(s.staffId) ?? 0) + Math.round((to - from) / 60_000));
  }
  return load;
}
