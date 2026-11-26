import { addDaysISO, dayIsoInTz, zonedWallClockToUtc } from "@/lib/time/slots";

/**
 * Paso 4 — De los eventos de Google Calendar a tramos ocupados. PURO (sin base ni red).
 *
 * Qué cuenta como ocupado (lo mismo que mira `freeBusy` de Google, más la regla anti-bucle):
 *  - Cuenta: un evento confirmado o tentativo, «Ocupado» (`transparency` ≠ `transparent`), con hora o de
 *    día completo, incluido «Fuera de la oficina» y «Tiempo de concentración».
 *  - No cuenta: cancelado, marcado «Disponible», una invitación que la cuenta RECHAZÓ, la «Ubicación de
 *    trabajo», y —anti-bucle— todo evento que publicó Vocero: con la marca
 *    `extendedProperties.private.voceroBookingId`/`voceroOrg`, o cuyo id es el de una cita conocida
 *    (`calendar_event_id`, o el `external_ref` de un Meet anterior al Paso 3, que no llevaba marca).
 *
 * Los tramos se unen (dos eventos que se pisan son UN tramo), se recortan a la ventana que se lee y se
 * parten a la medianoche del negocio: cada bloqueo vive en un solo día (así lo pintan la agenda y el
 * tablero, que miran 24 h hacia atrás) y unas vacaciones de una semana son siete bloqueos de un día.
 */

export type GoogleBusyEvent = {
  id?: string;
  status?: string;
  transparency?: string;
  eventType?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  attendees?: { self?: boolean; responseStatus?: string }[];
};

export type Interval = { startMs: number; endMs: number };

export type IgnoredReason = "own" | "free" | "cancelled" | "declined" | "working_location" | "invalid";

export type EventVerdict = { busy: true; interval: Interval } | { busy: false; reason: IgnoredReason };

const MINUTE = 60_000;
const DAY_MS = 24 * 3_600_000;

/** ¿Lo publicó Vocero? (la marca de la sincronización del Paso 3, o el id de una cita conocida). */
export function isOwnEvent(event: GoogleBusyEvent, ownEventIds: ReadonlySet<string>): boolean {
  const priv = event.extendedProperties?.private ?? {};
  if (priv.voceroBookingId || priv.voceroOrg) return true;
  return !!event.id && ownEventIds.has(event.id);
}

/** El instante de un extremo del evento: con hora (trae su desfase) o de día completo (medianoche del negocio). */
function edgeMs(edge: GoogleBusyEvent["start"], timezone: string): number | null {
  if (edge?.dateTime) {
    const ms = Date.parse(edge.dateTime);
    return Number.isNaN(ms) ? null : ms;
  }
  if (edge?.date && /^\d{4}-\d{2}-\d{2}$/.test(edge.date)) {
    return zonedWallClockToUtc(edge.date, "00:00", timezone)?.getTime() ?? null;
  }
  return null;
}

/** Qué hace un evento con la agenda. */
export function classifyEvent(
  event: GoogleBusyEvent,
  ctx: { timezone: string; ownEventIds: ReadonlySet<string> }
): EventVerdict {
  // Primero la regla anti-bucle: un evento nuestro nunca bloquea, esté como esté.
  if (isOwnEvent(event, ctx.ownEventIds)) return { busy: false, reason: "own" };
  if (event.status === "cancelled") return { busy: false, reason: "cancelled" };
  if (event.transparency === "transparent") return { busy: false, reason: "free" };
  if (event.eventType === "workingLocation") return { busy: false, reason: "working_location" };
  if (event.attendees?.some((a) => a.self && a.responseStatus === "declined")) {
    return { busy: false, reason: "declined" };
  }
  const startMs = edgeMs(event.start, ctx.timezone);
  const endMs = edgeMs(event.end, ctx.timezone);
  if (startMs === null || endMs === null || endMs <= startMs) return { busy: false, reason: "invalid" };
  return { busy: true, interval: { startMs, endMs } };
}

/**
 * La ventana que se lee: desde la medianoche de HOY (un evento en curso sigue ocupando) hasta el final del
 * último día que se puede reservar. Sus bordes caen en medianoche para que los bloqueos no «bailen» de una
 * lectura a otra según la hora en que se lea.
 */
export function busyWindow(now: Date, settings: { timezone: string; maxDaysAhead: number }): Interval {
  const today = dayIsoInTz(now, settings.timezone);
  const startMs = zonedWallClockToUtc(today, "00:00", settings.timezone)!.getTime();
  const lastDay = addDaysISO(today, Math.max(1, settings.maxDaysAhead) + 1);
  const endMs = zonedWallClockToUtc(lastDay, "00:00", settings.timezone)!.getTime();
  return { startMs, endMs };
}

/** Une tramos que se pisan o se tocan. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.startMs <= last.endMs) last.endMs = Math.max(last.endMs, iv.endMs);
    else out.push({ ...iv });
  }
  return out;
}

/** Parte un tramo en la medianoche del negocio (y, en el día de 25 h del cambio de horario, a la mitad). */
export function splitByLocalDay(iv: Interval, timezone: string): Interval[] {
  const out: Interval[] = [];
  let cursor = iv.startMs;
  while (cursor < iv.endMs) {
    const day = dayIsoInTz(new Date(cursor), timezone);
    const nextMidnight = zonedWallClockToUtc(addDaysISO(day, 1), "00:00", timezone)!.getTime();
    const end = Math.min(iv.endMs, nextMidnight > cursor ? nextMidnight : cursor + DAY_MS);
    if (end - cursor > DAY_MS) {
      const mid = cursor + Math.floor((end - cursor) / 2 / MINUTE) * MINUTE;
      out.push({ startMs: cursor, endMs: mid }, { startMs: mid, endMs: end });
    } else {
      out.push({ startMs: cursor, endMs: end });
    }
    cursor = end;
  }
  return out;
}

export type BusyComputation = {
  /** Los bloqueos que deberían existir, ordenados, cada uno dentro de un día y en minutos enteros. */
  blocks: Interval[];
  /** Cuántos eventos contaron y por qué se ignoró el resto (para el estado y las pruebas). */
  counted: number;
  ignored: Record<IgnoredReason, number>;
};

/** De la lista de eventos de la ventana a los bloqueos que deberían existir. */
export function computeBusyBlocks(
  events: GoogleBusyEvent[],
  ctx: { timezone: string; window: Interval; ownEventIds: ReadonlySet<string> }
): BusyComputation {
  const ignored: Record<IgnoredReason, number> = {
    own: 0,
    free: 0,
    cancelled: 0,
    declined: 0,
    working_location: 0,
    invalid: 0,
  };
  const raw: Interval[] = [];
  for (const ev of events) {
    const verdict = classifyEvent(ev, ctx);
    if (!verdict.busy) {
      ignored[verdict.reason] += 1;
      continue;
    }
    // Recortado a la ventana y a minutos enteros (hacia fuera: nunca se ofrece un minuto ocupado).
    const startMs = Math.floor(Math.max(verdict.interval.startMs, ctx.window.startMs) / MINUTE) * MINUTE;
    const endMs = Math.ceil(Math.min(verdict.interval.endMs, ctx.window.endMs) / MINUTE) * MINUTE;
    if (endMs <= startMs) continue;
    raw.push({ startMs, endMs });
  }
  const blocks = mergeIntervals(raw).flatMap((iv) => splitByLocalDay(iv, ctx.timezone));
  return { blocks, counted: raw.length, ignored };
}

/** La llave de un bloqueo: su inicio y su duración (así se compara lo guardado con lo leído). */
export function blockKey(startMs: number, durationMinutes: number): string {
  return `${startMs}:${durationMinutes}`;
}

export function durationMinutesOf(iv: Interval): number {
  return Math.round((iv.endMs - iv.startMs) / MINUTE);
}

/**
 * Qué cambiar para que lo guardado sea igual a lo leído: los que sobran se borran y los que faltan se crean.
 * Los que ya están igual no se tocan (una lectura sin cambios no escribe nada).
 */
export function diffBusyBlocks(
  existing: { id: string; startMs: number; durationMinutes: number }[],
  desired: Interval[]
): { toDelete: string[]; toInsert: Interval[] } {
  const want = new Map(desired.map((iv) => [blockKey(iv.startMs, durationMinutesOf(iv)), iv]));
  const toDelete: string[] = [];
  const seen = new Set<string>();
  for (const row of existing) {
    const key = blockKey(row.startMs, row.durationMinutes);
    // Un duplicado (no debería haberlo) también sobra.
    if (want.has(key) && !seen.has(key)) seen.add(key);
    else toDelete.push(row.id);
  }
  const toInsert = [...want.entries()].filter(([key]) => !seen.has(key)).map(([, iv]) => iv);
  return { toDelete, toInsert };
}

/** Cada cuánto se vuelve a leer con todo bien. */
export const BUSY_REFRESH_MS = 5 * 60_000;
/** Espera tras N fallos seguidos: 1, 5, 15, 30 y 60 min (y se queda en 60: leer nunca se rinde). */
export const BUSY_RETRY_MS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000] as const;

export function busyRetryDelayMs(failedAttempts: number): number {
  const i = Math.min(Math.max(failedAttempts, 1), BUSY_RETRY_MS.length) - 1;
  return BUSY_RETRY_MS[i]!;
}

/**
 * ¿Google dijo que el permiso no alcanza para leer? (403 con `insufficientPermissions` /
 * `ACCESS_TOKEN_SCOPE_INSUFFICIENT`). Reintentar no sirve: hay que reconectar.
 */
export function isScopeError(status: number | undefined, detail: string): boolean {
  if (status !== 403) return false;
  return /insufficient|scope/i.test(detail);
}
