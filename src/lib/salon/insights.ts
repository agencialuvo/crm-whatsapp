/**
 * Módulo SALON — métricas de negocio del Panel: el ticket de los servicios sueltos contra el de las
 * ofertas, y el ciclo de recompra de los clientes. Solo cuentas puras (sin base de datos), para poder
 * probarlas; las consultas viven en `src/server/business/business-insights.ts`.
 *
 * Todo el dinero va en centavos enteros.
 */

/* --------------------------- ticket: servicios vs ofertas --------------------------- */

export type TicketSideDto = {
  /** Ventas de este grupo en el periodo. */
  count: number;
  revenueCents: number;
  /** Ticket promedio (ingresos ÷ ventas), en centavos; `null` sin ventas. */
  avgCents: number | null;
};

export type TicketSplitDto = {
  /** Ventas SIN ninguna oferta: solo servicios sueltos. */
  services: TicketSideDto;
  /** Ventas que llevan al menos una oferta (sola o con servicios). */
  offers: TicketSideDto;
  /** Cuánto más (o menos) deja cada visita con oferta que con servicios sueltos; `null` si falta un lado. */
  liftCents: number | null;
  liftPercent: number | null;
};

export type TicketSideInput = { count: number; revenueCents: number };

function side({ count, revenueCents }: TicketSideInput): TicketSideDto {
  return { count, revenueCents, avgCents: count > 0 ? Math.round(revenueCents / count) : null };
}

export function computeTicketSplit(input: { services: TicketSideInput; offers: TicketSideInput }): TicketSplitDto {
  const services = side(input.services);
  const offers = side(input.offers);
  const both = services.avgCents !== null && offers.avgCents !== null && services.avgCents > 0;
  return {
    services,
    offers,
    liftCents: both ? offers.avgCents! - services.avgCents! : null,
    liftPercent: both ? Math.round(((offers.avgCents! - services.avgCents!) / services.avgCents!) * 100) : null,
  };
}

/* ------------------------------ ciclo de recompra ------------------------------ */

/** Con menos intervalos entre visitas que esto, el promedio no es de fiar y no se avisa a nadie. */
export const MIN_CYCLE_INTERVALS = 5;
/** Desde qué fracción del ciclo un cliente ya está «por vencer». */
export const CYCLE_SOON_FROM = 0.8;
/** Pasado este múltiplo del ciclo se da al cliente por perdido (ya no es un recordatorio, es reconquista). */
export const CYCLE_LOST_AFTER = 2;
export const MAX_REMINDER_LIST = 5;

/** Un cliente con los días (AAAA-MM-DD, en la zona del negocio) en que vino; cada día cuenta una visita. */
export type CycleClientInput = { id: string; name: string; phone: string | null; days: string[] };

export type ReminderStatus = "soon" | "due" | "lost";

export type ReminderClientDto = {
  id: string;
  name: string;
  phone: string | null;
  lastVisit: string;
  /** Días desde su última visita. */
  daysSince: number;
  status: Exclude<ReminderStatus, "lost">;
};

export type RepurchaseDto = {
  /** Cada cuántos días vuelve un cliente, en promedio (1 decimal); `null` sin visitas repetidas. */
  avgDays: number | null;
  /** La mediana: el ciclo típico, que no se deja arrastrar por quien volvió tras un año. */
  medianDays: number | null;
  /** Clientes con 2 o más visitas. */
  clients: number;
  /** Intervalos medidos entre visitas consecutivas. */
  intervals: number;
  /** Hay intervalos suficientes (`MIN_CYCLE_INTERVALS`) para fiarse del ciclo y avisar. */
  reliable: boolean;
  reminders: {
    /** Ya casi les toca volver (80 a 100 % del ciclo). */
    soon: number;
    /** Ya pasaron su ciclo (100 a 200 %). */
    due: number;
    /** Pasaron más del doble del ciclo. */
    lost: number;
    /** Los más urgentes entre «por vencer» y «vencidos» (el de mayor retraso primero). */
    list: ReminderClientDto[];
  };
};

const DAY_MS = 86_400_000;

/** Días enteros entre dos fechas AAAA-MM-DD (sin zona: las dos ya son días del negocio). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Cómo va un cliente respecto a su ciclo: el cociente días-sin-venir ÷ ciclo decide el estado. */
export function reminderStatus(daysSince: number, cycleDays: number): ReminderStatus | null {
  if (cycleDays <= 0) return null;
  const ratio = daysSince / cycleDays;
  if (ratio >= CYCLE_LOST_AFTER) return "lost";
  if (ratio >= 1) return "due";
  if (ratio >= CYCLE_SOON_FROM) return "soon";
  return null;
}

/**
 * El ciclo de recompra: los intervalos en días entre visitas consecutivas de cada cliente. Varias
 * ventas el mismo día son UNA visita. `asOf` (AAAA-MM-DD) es «hoy» para contar los días sin venir.
 */
export function computeRepurchase(clients: CycleClientInput[], asOf: string): RepurchaseDto {
  const gaps: number[] = [];
  const visited: { client: CycleClientInput; last: string }[] = [];
  for (const client of clients) {
    const days = [...new Set(client.days)].sort();
    if (days.length < 2) continue;
    for (let i = 1; i < days.length; i++) gaps.push(daysBetween(days[i - 1]!, days[i]!));
    visited.push({ client, last: days[days.length - 1]! });
  }

  const empty = { soon: 0, due: 0, lost: 0, list: [] as ReminderClientDto[] };
  if (gaps.length === 0) {
    return { avgDays: null, medianDays: null, clients: 0, intervals: 0, reliable: false, reminders: empty };
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const avg = Math.round((gaps.reduce((n, g) => n + g, 0) / gaps.length) * 10) / 10;
  const med = median(sorted);
  const reliable = gaps.length >= MIN_CYCLE_INTERVALS;

  const reminders = { ...empty, list: [] as (ReminderClientDto & { ratio: number })[] };
  if (reliable) {
    // Un ciclo de «0 días» (visitas el mismo día no cuentan, pero por redondeo) no sirve de referencia.
    const cycle = Math.max(1, med);
    for (const { client, last } of visited) {
      const daysSince = Math.max(0, daysBetween(last, asOf));
      const status = reminderStatus(daysSince, cycle);
      if (status === null) continue;
      reminders[status] += 1;
      if (status !== "lost") {
        reminders.list.push({
          id: client.id,
          name: client.name,
          phone: client.phone,
          lastVisit: last,
          daysSince,
          status,
          ratio: daysSince / cycle,
        });
      }
    }
    reminders.list.sort((a, b) => b.ratio - a.ratio || a.name.localeCompare(b.name));
  }

  return {
    avgDays: avg,
    medianDays: med,
    clients: visited.length,
    intervals: gaps.length,
    reliable,
    reminders: {
      soon: reminders.soon,
      due: reminders.due,
      lost: reminders.lost,
      list: reminders.list.slice(0, MAX_REMINDER_LIST).map(({ ratio: _ratio, ...c }) => c),
    },
  };
}

/* ------------------------------ cumpleaños del mes ------------------------------ */

/**
 * Los cumpleaños por cercanía a hoy: primero hoy y los que vienen (el más próximo arriba) y, al final,
 * los que ya pasaron este mes, del más reciente al más antiguo. Empate de día: por nombre.
 * `todayDay` es el día del mes de hoy en la zona del negocio.
 */
export function sortBirthdaysByProximity<T extends { day: number; name: string }>(clients: readonly T[], todayDay: number): T[] {
  const rank = (c: T) => (c.day >= todayDay ? c.day - todayDay : Number.MAX_SAFE_INTEGER - c.day);
  return [...clients].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
