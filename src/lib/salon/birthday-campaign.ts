import { calendarDaysBetween } from "@/lib/automation";
import type { automationStep } from "@/lib/db/schema";
import { matchesQuery } from "@/lib/search";

/**
 * Cumpleaños del mes — reglas PURAS de estados, KPIs, desglose por automatización, filtros y búsqueda. Las
 * comparten el servidor (que junta los hechos de la base) y la tarjeta del Panel (que filtra y busca).
 *
 * Ventana del cumpleaños: el MES del cumpleaños en la zona del negocio (del día 1 al último), la misma de la
 * campaña de descuento de Caja (`isBirthdayMonth`): la estrategia es de todo el mes, no solo del día.
 *
 * Estados de una fila, del más avanzado al menos (cada cliente muestra solo el más avanzado):
 *  - `aprovecho`  — se atendió (cita `realizada`) o tuvo una venta en Caja dentro de la ventana;
 *  - `agendado`   — tiene una cita reservada en la ventana (agendada o no asistió; las canceladas no cuentan);
 *  - `enviado`    — recibió el saludo (automatización sin fallo de entrega, o saludo manual registrado);
 *  - `fallido`    — se intentó el saludo automático y ningún envío llegó (y nadie lo saludó a mano);
 *  - `sin_enviar` — nada de lo anterior.
 */

export const BIRTHDAY_STATUSES = ["aprovecho", "agendado", "enviado", "fallido", "sin_enviar"] as const;
export type BirthdayStatus = (typeof BIRTHDAY_STATUSES)[number];

export const BIRTHDAY_STATUS_LABEL: Record<BirthdayStatus, string> = {
  aprovecho: "Aprovechó",
  agendado: "Agendado",
  enviado: "Saludado",
  fallido: "Envío fallido",
  sin_enviar: "Sin enviar",
};

/** Los pasos de una automatización que mandan un mensaje al cliente (`send_whatsapp` = texto o plantilla). */
export const BIRTHDAY_SEND_STEP_TYPES = ["send_whatsapp", "send_media"] as const satisfies readonly (typeof automationStep.$inferSelect)["stepType"][];

/** Un intento de envío de una automatización de cumpleaños a un cliente. */
export type BirthdaySendAttempt = {
  flowId: string;
  /** El paso registró éxito (el canal aceptó el mensaje) y el mensaje NO terminó `failed`. */
  delivered: boolean;
};

/** Rescate de fin de mes de un cliente: encolado, entregado o fallido. */
export type RescueState = "pending" | "delivered" | "failed";

/** Lo que se sabe de un cliente en su ventana de cumpleaños. */
export type BirthdayFacts = {
  /** Paso 3 — el rescate de fin de mes de este mes (si se le lanzó). */
  rescue?: RescueState | null;
  sends: readonly BirthdaySendAttempt[];
  /** Alguien lo saludó a mano desde el Panel este año. */
  manual: boolean;
  /** Tiene una cita reservada (no cancelada) en la ventana. */
  booked: boolean;
  /** Tiene una cita `realizada` en la ventana. */
  attended: boolean;
  /** Ventas en Caja dentro de la ventana. */
  sales: number;
  salesCents: number;
};

export type BirthdayRowState = {
  status: BirthdayStatus;
  /** Por dónde se lo contactó; `null` si no se lo contactó. */
  contactedBy: "auto" | "manual" | "both" | null;
  /** Algún envío automático falló (aunque otro llegara o lo saludaran a mano). */
  sendFailed: boolean;
  booked: boolean;
  converted: boolean;
  /** Lo cobrado en Caja dentro de la ventana. */
  windowRevenueCents: number;
  /** Flujos de cumpleaños que le entregaron el saludo. */
  flowIds: string[];
  /** Paso 3 — el rescate de este mes, o `null` si no se le lanzó. */
  rescue: RescueState | null;
};

export function birthdayRowState(f: BirthdayFacts): BirthdayRowState {
  const deliveredFlows = [...new Set(f.sends.filter((s) => s.delivered).map((s) => s.flowId))];
  const rescue = f.rescue ?? null;
  // Un rescate entregado también es un contacto automático (salió por el motor, con su estado de entrega).
  const auto = deliveredFlows.length > 0 || rescue === "delivered";
  const contactedBy = auto && f.manual ? "both" : auto ? "auto" : f.manual ? "manual" : null;
  const sendFailed = f.sends.some((s) => !s.delivered) || rescue === "failed";
  const converted = f.attended || f.sales > 0;
  const booked = f.booked || f.attended;
  const status: BirthdayStatus = converted
    ? "aprovecho"
    : booked
      ? "agendado"
      : contactedBy
        ? "enviado"
        : f.sends.length > 0 || rescue === "failed"
          ? "fallido"
          : "sin_enviar";
  return {
    status,
    contactedBy,
    sendFailed,
    booked,
    converted,
    windowRevenueCents: f.salesCents,
    flowIds: deliveredFlows,
    rescue,
  };
}

/** Porcentaje entero (0-100) o `null` sin base. */
export function rateOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

export type BirthdayKpis = {
  /** Cumpleañeros del mes. */
  total: number;
  /** Recibieron el saludo (automático sin fallo de entrega o manual). */
  contacted: number;
  contactedAuto: number;
  contactedManual: number;
  /** Nadie los saludó y no hubo intento automático. */
  notSent: number;
  /** Se intentó el saludo automático y no llegó (y nadie los saludó a mano). */
  failed: number;
  /** Con cita reservada en su ventana. */
  booked: number;
  /** Se atendieron o compraron en su ventana (criterio principal). */
  converted: number;
  /** De los contactados, cuántos aprovecharon. */
  convertedContacted: number;
  /** `convertedContacted / contacted` en %, o `null` si nadie fue contactado. */
  conversionRate: number | null;
  /** Cobrado en Caja a quienes aprovecharon, dentro de su ventana. */
  revenueCents: number;
};

export function computeBirthdayKpis(rows: readonly BirthdayRowState[]): BirthdayKpis {
  const k: BirthdayKpis = {
    total: rows.length,
    contacted: 0,
    contactedAuto: 0,
    contactedManual: 0,
    notSent: 0,
    failed: 0,
    booked: 0,
    converted: 0,
    convertedContacted: 0,
    conversionRate: null,
    revenueCents: 0,
  };
  for (const r of rows) {
    if (r.contactedBy) k.contacted += 1;
    if (r.contactedBy === "auto" || r.contactedBy === "both") k.contactedAuto += 1;
    if (r.contactedBy === "manual" || r.contactedBy === "both") k.contactedManual += 1;
    if (r.status === "sin_enviar") k.notSent += 1;
    if (r.status === "fallido") k.failed += 1;
    if (r.booked) k.booked += 1;
    if (r.converted) {
      k.converted += 1;
      k.revenueCents += r.windowRevenueCents;
      if (r.contactedBy) k.convertedContacted += 1;
    }
  }
  k.conversionRate = rateOf(k.convertedContacted, k.contacted);
  return k;
}

export type BirthdayFlowRef = { id: string; name: string; active: boolean };

export type BirthdayFlowStats = BirthdayFlowRef & {
  /** Clientes a los que este flujo les entregó el saludo. */
  sent: number;
  /** Clientes con intento de este flujo y ninguna entrega de él. */
  failed: number;
  /** De los `sent`: con cita en la ventana. */
  booked: number;
  /** De los `sent`: aprovecharon. */
  converted: number;
  /** `converted / sent` en %, o `null` sin envíos. */
  conversionRate: number | null;
  revenueCents: number;
};

/**
 * Desglose por automatización de cumpleaños. Un cliente saludado por dos flujos cuenta en los dos (cada flujo
 * responde «¿a quién le llegó lo mío y qué hizo?»); por eso las filas no se suman al total del mes.
 * Entran los flujos activos y los apagados que este año ya enviaron algo.
 */
export function computeFlowBreakdown(
  flows: readonly BirthdayFlowRef[],
  clients: readonly { facts: BirthdayFacts; state: BirthdayRowState }[]
): BirthdayFlowStats[] {
  const stats = new Map<string, BirthdayFlowStats>(
    flows.map((f) => [f.id, { ...f, sent: 0, failed: 0, booked: 0, converted: 0, conversionRate: null, revenueCents: 0 }])
  );
  for (const { facts, state } of clients) {
    const byFlow = new Map<string, boolean>();
    for (const s of facts.sends) byFlow.set(s.flowId, (byFlow.get(s.flowId) ?? false) || s.delivered);
    for (const [flowId, delivered] of byFlow) {
      const st = stats.get(flowId);
      if (!st) continue;
      if (!delivered) {
        st.failed += 1;
        continue;
      }
      st.sent += 1;
      if (state.booked) st.booked += 1;
      if (state.converted) {
        st.converted += 1;
        st.revenueCents += state.windowRevenueCents;
      }
    }
  }
  return [...stats.values()]
    .filter((s) => s.active || s.sent > 0 || s.failed > 0)
    .map((s) => ({ ...s, conversionRate: rateOf(s.converted, s.sent) }))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.sent - a.sent || a.name.localeCompare(b.name));
}

/* ------------------------------ filtros rápidos y búsqueda ------------------------------ */

export const BIRTHDAY_FILTERS = ["todos", "pendientes", "enviados_sin_cita", "agendados", "aprovecharon", "rescatar"] as const;
export type BirthdayFilter = (typeof BIRTHDAY_FILTERS)[number];

export const BIRTHDAY_FILTER_LABEL: Record<BirthdayFilter, string> = {
  todos: "Todos",
  pendientes: "Sin enviar / Fallidos",
  enviados_sin_cita: "Enviados sin cita",
  agendados: "Agendados",
  aprovecharon: "Aprovecharon",
  rescatar: "Para rescatar",
};

/** Lo que miran los filtros de una fila (`rescueBlock` solo existe con los datos del Paso 3). */
type FilterRow = Pick<BirthdayRowState, "status" | "booked"> & { rescueBlock?: RescueBlock | null };

/**
 * `agendados` incluye a quienes ya aprovecharon con su cita (reservaron); `aprovecharon` es el criterio
 * principal. `enviados_sin_cita` son los saludados que todavía no reservan ni compraron: a quién insistir.
 */
export function matchesBirthdayFilter(row: FilterRow, filter: BirthdayFilter): boolean {
  switch (filter) {
    case "todos":
      return true;
    case "pendientes":
      return row.status === "sin_enviar" || row.status === "fallido";
    case "enviados_sin_cita":
      return row.status === "enviado";
    case "agendados":
      return row.booked;
    case "aprovecharon":
      return row.status === "aprovecho";
    case "rescatar":
      return row.rescueBlock === null;
  }
}

export function filterBirthdays<T extends FilterRow & { name: string; phone: string | null }>(
  rows: readonly T[],
  { filter, query }: { filter: BirthdayFilter; query: string }
): T[] {
  return rows.filter((r) => matchesBirthdayFilter(r, filter) && matchesQuery(query, { text: [r.name], phone: r.phone }));
}

export function countByFilter(rows: readonly FilterRow[]): Record<BirthdayFilter, number> {
  const out = Object.fromEntries(BIRTHDAY_FILTERS.map((f) => [f, 0])) as Record<BirthdayFilter, number>;
  for (const r of rows) for (const f of BIRTHDAY_FILTERS) if (matchesBirthdayFilter(r, f)) out[f] += 1;
  return out;
}

/* ------------------------------ armado desde las filas de la base ------------------------------ */

/** Una fila del historial de una automatización de cumpleaños en un paso de envío. */
export type BirthdaySendRow = {
  contactId: string;
  flowId: string;
  /** Estado del registro del paso (`automation_execution_log.status`). */
  logStatus: string;
  /** Estado final del mensaje enviado (`message.status`); `null` si no hay mensaje enlazado. */
  messageStatus: string | null;
};

/**
 * ¿Ese registro es una entrega, un fallo, o no dice nada todavía?
 *  - `success` con el mensaje sin `failed` → entregado (lo aceptó el canal y no rebotó);
 *  - `success` con el mensaje `failed`, `failed` o `skipped_opt_out` (se dio de baja) → fallido;
 *  - `skipped_rate_limit` es una POSTERGACIÓN (la tarea vuelve más tarde): no cuenta como intento.
 */
export function sendOutcome(row: Pick<BirthdaySendRow, "logStatus" | "messageStatus">): "delivered" | "failed" | null {
  if (row.logStatus === "success") return row.messageStatus === "failed" ? "failed" : "delivered";
  if (row.logStatus === "failed" || row.logStatus === "skipped_opt_out") return "failed";
  return null;
}

export type BirthdayContactRow = {
  id: string;
  name: string;
  phone: string | null;
  day: number;
  visits: number;
  totalCents: number;
  /** Paso 3 — se dio de baja de los mensajes automáticos. Sin dato: no. */
  optedOut?: boolean;
  /** Paso 3 — tiene un chat REAL de WhatsApp (no del Laboratorio) al que enviar. Sin dato: no. */
  reachable?: boolean;
  /** Rescate — última atención (cita `realizada` o venta), día del negocio `AAAA-MM-DD`. Sin dato: ninguna. */
  lastVisit?: string | null;
  /** Rescate — tiene una cita vigente (agendada, de hoy en adelante), aunque sea del mes que viene. */
  upcomingBooking?: boolean;
};

/** Paso 3 — lo que se sabe del rescate del mes de un cliente, tal como sale de la base. */
export type BirthdayRescueRows = {
  /** Clientes con el control del rescate del mes reclamado (`birthday_rescue`). */
  claimed: ReadonlySet<string>;
  /** Pasos de envío de las ejecuciones `birthday_rescue:AAAA-MM`. */
  sends: readonly Pick<BirthdaySendRow, "contactId" | "logStatus" | "messageStatus">[];
  /** Estado de esas ejecuciones. */
  runs: readonly { contactId: string; status: string }[];
};

/**
 * Estado del rescate de un cliente: alguna entrega → entregado; un envío fallido, o la ejecución terminó
 * `failed`/`cancelled` sin entregar (baja, sin saldo, flujo sin envío posible) → fallido; reclamado o en marcha →
 * en cola. Sin control ni ejecución → `null` (no se le lanzó).
 */
export function rescueStateOf(input: {
  claimed: boolean;
  outcomes: readonly ("delivered" | "failed")[];
  runStatuses: readonly string[];
}): RescueState | null {
  if (input.outcomes.includes("delivered")) return "delivered";
  if (input.outcomes.includes("failed")) return "failed";
  if (input.runStatuses.some((st) => st === "failed" || st === "cancelled")) return "failed";
  if (input.claimed || input.runStatuses.length > 0) return "pending";
  return null;
}

export function buildBirthdayCampaign(input: {
  contacts: readonly BirthdayContactRow[];
  flows: readonly BirthdayFlowRef[];
  sends: readonly BirthdaySendRow[];
  /** Clientes saludados a mano este año. */
  manual: ReadonlySet<string>;
  /** Citas (no canceladas) en la ventana. */
  bookings: readonly { contactId: string; status: string }[];
  /** Ventas en Caja en la ventana, agrupadas por cliente. */
  sales: readonly { contactId: string; count: number; cents: number }[];
  /** Paso 3 — el rescate del mes (sin él, nadie fue rescatado). */
  rescue?: BirthdayRescueRows;
  /** Rescate — el día del negocio y el margen sin atención reciente (sin él, no hay margen). */
  rescueRules?: { today: string; minGapDays: number };
}): {
  clients: (BirthdayContactRow &
    BirthdayRowState & { optedOut: boolean; reachable: boolean; rescueBlock: RescueBlock | null })[];
  kpis: BirthdayKpis;
  flows: BirthdayFlowStats[];
} {
  const facts = new Map<string, BirthdayFacts>(
    input.contacts.map((c) => [
      c.id,
      { sends: [], manual: input.manual.has(c.id), booked: false, attended: false, sales: 0, salesCents: 0 },
    ])
  );
  for (const s of input.sends) {
    const f = facts.get(s.contactId);
    const outcome = sendOutcome(s);
    if (!f || !outcome) continue;
    (f.sends as BirthdaySendAttempt[]).push({ flowId: s.flowId, delivered: outcome === "delivered" });
  }
  for (const b of input.bookings) {
    const f = facts.get(b.contactId);
    if (!f || b.status === "cancelada") continue;
    f.booked = true;
    if (b.status === "realizada") f.attended = true;
  }
  for (const s of input.sales) {
    const f = facts.get(s.contactId);
    if (!f) continue;
    f.sales += s.count;
    f.salesCents += s.cents;
  }
  if (input.rescue) {
    const outcomes = new Map<string, ("delivered" | "failed")[]>();
    for (const s of input.rescue.sends) {
      const o = sendOutcome(s);
      if (o) outcomes.set(s.contactId, [...(outcomes.get(s.contactId) ?? []), o]);
    }
    const runs = new Map<string, string[]>();
    for (const r of input.rescue.runs) runs.set(r.contactId, [...(runs.get(r.contactId) ?? []), r.status]);
    for (const [id, f] of facts) {
      f.rescue = rescueStateOf({
        claimed: input.rescue.claimed.has(id),
        outcomes: outcomes.get(id) ?? [],
        runStatuses: runs.get(id) ?? [],
      });
    }
  }
  const joined = input.contacts.map((c) => {
    const f = facts.get(c.id)!;
    return { contact: c, facts: f, state: birthdayRowState(f) };
  });
  return {
    clients: joined.map(({ contact, state }) => {
      const optedOut = contact.optedOut ?? false;
      const reachable = contact.reachable ?? false;
      const rules = input.rescueRules;
      const block = rescueBlock({
        ...state,
        optedOut,
        reachable,
        upcomingBooking: contact.upcomingBooking ?? false,
        recentVisit: rules ? visitedRecently(contact.lastVisit ?? null, rules.today, rules.minGapDays) : false,
      });
      return { ...contact, ...state, optedOut, reachable, rescueBlock: block };
    }),
    kpis: computeBirthdayKpis(joined.map((j) => j.state)),
    flows: computeFlowBreakdown(input.flows, joined),
  };
}

/* ------------------------------ Paso 3: rescate de fin de mes ------------------------------ */

/** El mes del rescate (`AAAA-MM`) de un día del negocio `AAAA-MM-DD`. */
export const rescuePeriodOf = (today: string) => today.slice(0, 7);

/** Llave de la EJECUCIÓN del rescate en el motor: separada del saludo (`birthday:AAAA`), una por mes. */
export const birthdayRescueDedupeKey = (period: string) => `birthday_rescue:${period}`;

/** Días que quedan del mes después de hoy (0 = hoy es el último). */
export function daysLeftInMonth(today: string): number {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return last - Number(today.slice(8, 10));
}

/** Ventana de cierre por defecto: los últimos 7 días del mes (configurable por negocio). */
export const RESCUE_SUGGESTED_DAYS_LEFT = 7;

/** ¿Hoy está dentro de la ventana de cierre? Los últimos `windowDays` días del mes, contando hoy. */
export function inClosingWindow(today: string, windowDays: number): boolean {
  return daysLeftInMonth(today) < windowDays;
}

/** El día del mes en que abre la ventana de cierre. */
export function closingWindowStartDay(today: string, windowDays: number): number {
  const day = Number(today.slice(8, 10));
  return Math.max(1, day + daysLeftInMonth(today) - windowDays + 1);
}

/**
 * ¿Se atendió hace muy poco? Con la última atención (`AAAA-MM-DD`, día del negocio) a menos de `minGapDays` días de
 * hoy, un «se te acaba el beneficio» sobra: acaba de venir. Sin atenciones o con margen 0, no.
 */
export function visitedRecently(lastVisit: string | null, today: string, minGapDays: number): boolean {
  if (!lastVisit || minGapDays <= 0) return false;
  const days = calendarDaysBetween(lastVisit, today);
  return days >= 0 && days < minGapDays;
}

/** Por qué un cumpleañero NO entra al rescate (en orden de prioridad). */
export const RESCUE_BLOCKS = ["converted", "booked", "already_rescued", "recent_visit", "opted_out", "no_conversation"] as const;
export type RescueBlock = (typeof RESCUE_BLOCKS)[number];

export const RESCUE_BLOCK_LABEL: Record<RescueBlock, string> = {
  converted: "Ya aprovechó",
  booked: "Ya tiene cita",
  already_rescued: "Ya recibió el rescate",
  recent_visit: "Se atendió hace poco",
  opted_out: "Se dio de baja",
  no_conversation: "Sin chat de WhatsApp",
};

/**
 * ¿Entra al rescate del mes? Solo quien no aprovechó, no tiene cita (en su mes ni una vigente más adelante), no
 * recibió ya el rescate (aunque haya fallado: nunca se reenvía en el mes), no se atendió dentro del margen, no se dio
 * de baja y tiene un chat REAL de WhatsApp. `null` = entra.
 */
export function rescueBlock(r: {
  converted: boolean;
  booked: boolean;
  rescue: RescueState | null;
  optedOut: boolean;
  reachable: boolean;
  /** Cita vigente fuera de la ventana (p. ej. reservó para el mes que viene). */
  upcomingBooking?: boolean;
  /** Se atendió dentro del margen mínimo. */
  recentVisit?: boolean;
}): RescueBlock | null {
  if (r.converted) return "converted";
  if (r.booked || r.upcomingBooking) return "booked";
  if (r.rescue !== null) return "already_rescued";
  if (r.recentVisit) return "recent_visit";
  if (r.optedOut) return "opted_out";
  if (!r.reachable) return "no_conversation";
  return null;
}

export type RescueSummary = {
  /** `AAAA-MM`. */
  period: string;
  daysLeft: number;
  /** ¿Hoy está dentro de la ventana de cierre? (solo entonces se puede lanzar). */
  suggested: boolean;
  /** Ventana de cierre usada (días) y el día del mes en que abre. */
  windowDays: number;
  windowStartDay: number;
  /** Cumpleañeros a los que se les puede lanzar ahora. */
  eligible: number;
  /** De los que no reservaron ni aprovecharon ni fueron rescatados: cuántos quedan fuera y por qué. */
  excluded: { opted_out: number; no_conversation: number; recent_visit: number };
  /** Rescates lanzados este mes y cómo van. */
  launched: number;
  pending: number;
  delivered: number;
  failed: number;
  /** De los rescatados: reservaron / aprovecharon. */
  booked: number;
  converted: number;
  /** `converted / delivered` en %, o `null` sin entregas. */
  conversionRate: number | null;
  revenueCents: number;
};

type RescueRowLike = Pick<BirthdayRowState, "rescue" | "booked" | "converted" | "windowRevenueCents"> & {
  rescueBlock: RescueBlock | null;
};

export function computeRescueSummary(
  rows: readonly RescueRowLike[],
  today: string,
  windowDays: number = RESCUE_SUGGESTED_DAYS_LEFT
): RescueSummary {
  const daysLeft = daysLeftInMonth(today);
  const s: RescueSummary = {
    period: rescuePeriodOf(today),
    daysLeft,
    suggested: inClosingWindow(today, windowDays),
    windowDays,
    windowStartDay: closingWindowStartDay(today, windowDays),
    eligible: 0,
    excluded: { opted_out: 0, no_conversation: 0, recent_visit: 0 },
    launched: 0,
    pending: 0,
    delivered: 0,
    failed: 0,
    booked: 0,
    converted: 0,
    conversionRate: null,
    revenueCents: 0,
  };
  for (const r of rows) {
    if (r.rescueBlock === null) s.eligible += 1;
    if (r.rescueBlock === "opted_out" || r.rescueBlock === "no_conversation" || r.rescueBlock === "recent_visit") {
      s.excluded[r.rescueBlock] += 1;
    }
    if (r.rescue === null) continue;
    s.launched += 1;
    s[r.rescue] += 1;
    if (r.booked) s.booked += 1;
    if (r.converted) {
      s.converted += 1;
      s.revenueCents += r.windowRevenueCents;
    }
  }
  s.conversionRate = rateOf(s.converted, s.delivered);
  return s;
}
