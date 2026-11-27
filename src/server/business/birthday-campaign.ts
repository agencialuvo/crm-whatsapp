import { and, asc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { birthdayDedupeKey } from "@/lib/automation";
import {
  BIRTHDAY_SEND_STEP_TYPES,
  birthdayRescueDedupeKey,
  buildBirthdayCampaign,
  computeRescueSummary,
  rescuePeriodOf,
  type BirthdayContactRow,
  type BirthdayFlowRef,
  type BirthdayRescueRows,
} from "@/lib/salon/birthday-campaign";
import { sortBirthdaysByProximity } from "@/lib/salon/insights";
import type { SalonDashboardDto } from "@/lib/salon/types";
import { addDaysISO } from "@/lib/time/slots";
import { resolvePeriod } from "@/server/analytics/period";
import { automationsEnabled } from "@/server/automation/flag";

/**
 * Módulo SALON — cumpleaños del mes en el Panel: quién cumple, a quién se saludó (automatización o a mano), quién
 * reservó y quién APROVECHÓ (se atendió o compró en su ventana), con el desglose por automatización. Las reglas
 * viven en `lib/salon/birthday-campaign.ts`; aquí solo se juntan los hechos de la base, siempre por `scoped()`, y
 * sin nada del Laboratorio (`is_test`).
 *
 * Todas las consultas se acotan con un `join` a los cumpleañeros del mes (no con una lista de ids): el tamaño de
 * la consulta no crece con el número de clientes.
 */

/** Los cumpleañeros del mes: clientes del salón con `birthday_month` = mes. */
function birthdayContactJoin(organizationId: string, month: number, contactIdCol: PgColumn) {
  const c = schema.contact;
  return and(
    eq(c.id, contactIdCol),
    eq(c.organizationId, organizationId),
    eq(c.salonClient, true),
    eq(c.birthdayMonth, month)
  );
}

async function listContacts(organizationId: string, month: number): Promise<BirthdayContactRow[]> {
  const sale = schema.serviceSale;
  const rows = await getDb()
    .select({
      id: schema.contact.id,
      name: schema.contact.name,
      phone: schema.contact.phone,
      day: schema.contact.birthdayDay,
      visits: sql<number>`count(${sale.id})::int`,
      totalCents: sql<number>`coalesce(sum(${sale.amountCents}), 0)::float8`,
      optedOut: sql<boolean>`(${schema.contact.optedOutAt} is not null)`,
      // Un chat REAL de WhatsApp (lo mismo que exige el disparo manual): ni del Laboratorio ni de otro canal.
      reachable: sql<boolean>`exists (select 1 from ${schema.conversation} cv where cv.contact_id = ${schema.contact.id} and cv.organization_id = ${organizationId} and cv.channel = 'whatsapp' and cv.is_test = false)`,
    })
    .from(schema.contact)
    .leftJoin(sale, and(eq(sale.contactId, schema.contact.id), eq(sale.organizationId, organizationId)))
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        eq(schema.contact.salonClient, true),
        eq(schema.contact.birthdayMonth, month)
      )
    )
    .groupBy(schema.contact.id)
    .orderBy(asc(schema.contact.birthdayDay), asc(schema.contact.name));
  return rows.flatMap((r) => (r.day == null ? [] : [{ ...r, day: r.day }]));
}

async function listBirthdayFlows(organizationId: string): Promise<BirthdayFlowRef[]> {
  const f = schema.automationFlow;
  return getDb()
    .select({ id: f.id, name: f.name, active: f.active })
    .from(f)
    .where(scoped(f.organizationId, organizationId, eq(f.triggerType, "birthday")));
}

/**
 * Los pasos de ENVÍO de las ejecuciones con esa llave (`birthday:AAAA` del saludo, la misma con que el barrido los
 * encola; `birthday_rescue:AAAA-MM` del rescate), con el estado final de su mensaje. Un mensaje de una
 * conversación de prueba no cuenta. `flowIds` acota a esos flujos (`null` = cualquiera).
 */
async function listSends(organizationId: string, month: number, dedupeKey: string, flowIds: string[] | null) {
  if (flowIds?.length === 0) return [];
  const l = schema.automationExecutionLog;
  const q = schema.automationQueue;
  const r = schema.automationRun;
  const m = schema.message;
  const cv = schema.conversation;
  return getDb()
    .select({ contactId: l.contactId, flowId: l.flowId, logStatus: l.status, messageStatus: m.status })
    .from(l)
    .innerJoin(schema.contact, birthdayContactJoin(organizationId, month, l.contactId))
    .innerJoin(q, and(eq(q.id, l.queueId), eq(q.organizationId, organizationId)))
    .innerJoin(r, and(eq(r.id, q.runId), eq(r.organizationId, organizationId), eq(r.dedupeKey, dedupeKey)))
    .leftJoin(m, and(eq(m.id, sql`${l.metadata}->>'messageId'`), eq(m.organizationId, organizationId)))
    .leftJoin(cv, eq(cv.id, m.conversationId))
    .where(
      scoped(
        l.organizationId,
        organizationId,
        flowIds ? inArray(l.flowId, flowIds) : undefined,
        inArray(sql`${l.metadata}->'step'->>'stepType'`, [...BIRTHDAY_SEND_STEP_TYPES]),
        or(isNull(cv.id), eq(cv.isTest, false))
      )
    );
}

async function listManualGreetings(organizationId: string, month: number, year: number): Promise<Set<string>> {
  const g = schema.birthdayGreeting;
  const rows = await getDb()
    .select({ contactId: g.contactId })
    .from(g)
    .innerJoin(schema.contact, birthdayContactJoin(organizationId, month, g.contactId))
    .where(scoped(g.organizationId, organizationId, eq(g.year, year)));
  return new Set(rows.map((x) => x.contactId));
}

/** Paso 3 — el rescate del mes: el control reclamado, sus ejecuciones y sus envíos. */
async function listRescue(organizationId: string, month: number, period: string): Promise<BirthdayRescueRows> {
  const br = schema.birthdayRescue;
  const r = schema.automationRun;
  const key = birthdayRescueDedupeKey(period);
  const [claims, runs, sends] = await Promise.all([
    getDb()
      .select({ contactId: br.contactId })
      .from(br)
      .innerJoin(schema.contact, birthdayContactJoin(organizationId, month, br.contactId))
      .where(scoped(br.organizationId, organizationId, eq(br.period, period))),
    getDb()
      .select({ contactId: r.contactId, status: r.status })
      .from(r)
      .innerJoin(schema.contact, birthdayContactJoin(organizationId, month, r.contactId))
      .where(scoped(r.organizationId, organizationId, eq(r.dedupeKey, key))),
    listSends(organizationId, month, key, null),
  ]);
  return { claimed: new Set(claims.map((c) => c.contactId)), runs, sends };
}

/** Paso 3 — flujos MANUALES encendidos: con ellos se envía el rescate (ellos definen el mensaje o la plantilla). */
export async function listRescueFlows(organizationId: string): Promise<{ id: string; name: string }[]> {
  const f = schema.automationFlow;
  return getDb()
    .select({ id: f.id, name: f.name })
    .from(f)
    .where(scoped(f.organizationId, organizationId, eq(f.triggerType, "manual"), eq(f.active, true)))
    .orderBy(asc(f.name));
}

/** Citas reales (ni bloqueos, ni de prueba, ni canceladas) dentro de la ventana. */
async function listBookings(organizationId: string, month: number, start: Date, end: Date) {
  const b = schema.booking;
  const rows = await getDb()
    .select({ contactId: b.contactId, status: b.status })
    .from(b)
    .innerJoin(schema.contact, birthdayContactJoin(organizationId, month, b.contactId))
    .where(
      scoped(
        b.organizationId,
        organizationId,
        eq(b.kind, "session"),
        eq(b.isTest, false),
        ne(b.status, "cancelada"),
        gte(b.scheduledAt, start),
        lt(b.scheduledAt, end)
      )
    );
  return rows.flatMap((x) => (x.contactId ? [{ contactId: x.contactId, status: x.status }] : []));
}

/** Ventas de Caja dentro de la ventana (una venta que nació de una cita de prueba no cuenta). */
async function listSales(organizationId: string, month: number, start: Date, end: Date) {
  const s = schema.serviceSale;
  const b = schema.booking;
  const rows = await getDb()
    .select({
      contactId: s.contactId,
      count: sql<number>`count(*)::int`,
      cents: sql<number>`coalesce(sum(${s.amountCents}), 0)::float8`,
    })
    .from(s)
    .innerJoin(schema.contact, birthdayContactJoin(organizationId, month, s.contactId))
    .leftJoin(b, eq(b.id, s.bookingId))
    .where(
      scoped(s.organizationId, organizationId, gte(s.createdAt, start), lt(s.createdAt, end), or(isNull(b.id), eq(b.isTest, false)))
    )
    .groupBy(s.contactId);
  return rows.flatMap((x) => (x.contactId ? [{ contactId: x.contactId, count: x.count, cents: x.cents }] : []));
}

/** Del día 1 al último del mes, en la zona del negocio, como instantes UTC [inicio, fin). */
export function birthdayWindow(year: number, month: number, timezone: string): { start: Date; end: Date } {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextFirst = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const p = resolvePeriod({ from: first, to: addDaysISO(nextFirst, -1), timezone });
  return { start: p.start, end: p.end };
}

/**
 * La sección de cumpleaños del Panel para el mes de `today` (AAAA-MM-DD, día del negocio): filas con su estado
 * (ordenadas por cercanía a hoy), KPIs y desglose por automatización.
 */
export async function getBirthdayCampaign(
  organizationId: string,
  today: string,
  timezone: string
): Promise<SalonDashboardDto["birthdays"]> {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const todayDay = Number(today.slice(8, 10));
  const { start, end } = birthdayWindow(year, month, timezone);
  const period = rescuePeriodOf(today);
  const rescueAvailable = automationsEnabled();
  const [contacts, flows, rescueFlows] = await Promise.all([
    listContacts(organizationId, month),
    listBirthdayFlows(organizationId),
    rescueAvailable ? listRescueFlows(organizationId) : Promise.resolve([]),
  ]);
  const noRescue: BirthdayRescueRows = { claimed: new Set(), runs: [], sends: [] };
  const [sends, manual, bookings, sales, rescue] =
    contacts.length === 0
      ? [[], new Set<string>(), [], [], noRescue]
      : await Promise.all([
          listSends(organizationId, month, birthdayDedupeKey(year), flows.map((f) => f.id)),
          listManualGreetings(organizationId, month, year),
          listBookings(organizationId, month, start, end),
          listSales(organizationId, month, start, end),
          listRescue(organizationId, month, period),
        ]);
  const built = buildBirthdayCampaign({ contacts, flows, sends, manual, bookings, sales, rescue });
  return {
    month,
    today: todayDay,
    year,
    // Lo más próximo a hoy primero (no por día del mes): quien cumple hoy o mañana es a quien hay que saludar.
    clients: sortBirthdaysByProximity(built.clients, todayDay),
    kpis: built.kpis,
    flows: built.flows,
    rescue: { ...computeRescueSummary(built.clients, today), available: rescueAvailable, flows: rescueFlows },
  };
}

/* ------------------------------ saludo manual ------------------------------ */

export class BirthdayGreetingError extends Error {
  constructor(public readonly code: "not_found") {
    super("Ese cliente no existe en este negocio");
    this.name = "BirthdayGreetingError";
  }
}

/** Registra que alguien saludó a mano a este cliente por su cumpleaños de `year`. Idempotente. */
export async function recordManualGreeting(input: {
  organizationId: string;
  contactId: string;
  year: number;
  userId: string | null;
}): Promise<void> {
  const db = getDb();
  const [c] = await db
    .select({ id: schema.contact.id })
    .from(schema.contact)
    .where(scoped(schema.contact.organizationId, input.organizationId, eq(schema.contact.id, input.contactId)))
    .limit(1);
  if (!c) throw new BirthdayGreetingError("not_found");
  await db
    .insert(schema.birthdayGreeting)
    .values({
      id: newId("birthdayGreeting"),
      organizationId: input.organizationId,
      contactId: input.contactId,
      year: input.year,
      userId: input.userId,
    })
    .onConflictDoNothing({
      target: [schema.birthdayGreeting.organizationId, schema.birthdayGreeting.contactId, schema.birthdayGreeting.year],
    });
}

/** Quita la marca de saludo manual (si se marcó por error). */
export async function removeManualGreeting(input: { organizationId: string; contactId: string; year: number }): Promise<void> {
  const g = schema.birthdayGreeting;
  await getDb()
    .delete(g)
    .where(scoped(g.organizationId, input.organizationId, eq(g.contactId, input.contactId), eq(g.year, input.year)));
}
