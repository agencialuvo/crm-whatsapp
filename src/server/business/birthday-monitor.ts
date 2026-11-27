import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { birthdayDedupeKey, parseTriggerConfig } from "@/lib/automation";
import {
  BIRTHDAY_SEND_STEP_TYPES,
  birthdayRescueDedupeKey,
  inClosingWindow,
  rescuePeriodOf,
} from "@/lib/salon/birthday-campaign";
import {
  birthdayAlertCopy,
  birthdayAlertKey,
  collectFailureAlerts,
  expectedGreetingMisses,
  launchErrorReason,
  type AlertReason,
  type BirthdayAlertKind,
  type MonitorRunRow,
  type MonitorSendRow,
} from "@/lib/salon/birthday-rescue";
import { todayInTz } from "@/lib/time/slots";
import { businessTimezone } from "@/server/analytics/period";
import { AutomationError } from "@/server/automation/http";
import { getBirthdayCampaign } from "@/server/business/birthday-campaign";
import { launchBirthdayRescue } from "@/server/business/birthday-rescue";
import { getRescueSettings } from "@/server/business/birthday-rescue-settings";
import { notify } from "@/server/notifications/service";

/**
 * Cumpleaños — el vigilante: (1) lanza el rescate AUTOMÁTICO de fin de mes y (2) avisa en la campanita cuando una
 * automatización de cumpleaños (saludo o rescate) falla o no se dispara, con el flujo, cuántos clientes y el motivo.
 *
 * Corre en el barrido de disparadores (cada 30 min). Nada aquí lanza: un fallo de una organización no frena a las
 * demás. Los avisos se controlan con `birthday_alert` (uno por tipo + flujo + mes; otro solo si CRECEN los
 * afectados), así una pasada repetida nunca repite la campanita. Nada del Laboratorio: los saludos y rescates solo
 * salen a chats reales y los mensajes de conversaciones de prueba no cuentan.
 */

/* ------------------------------ avisos ------------------------------ */

/** Reclama el aviso: `true` si es nuevo o si ahora hay MÁS afectados que en el último aviso. */
export async function claimBirthdayAlert(organizationId: string, key: string, count: number): Promise<boolean> {
  const t = schema.birthdayAlert;
  const rows = await getDb()
    .insert(t)
    .values({ id: newId("birthdayAlert"), organizationId, key, count })
    .onConflictDoUpdate({
      target: [t.organizationId, t.key],
      set: { count, updatedAt: new Date() },
      setWhere: sql`${t.count} < ${count}`,
    })
    .returning({ id: t.id });
  return rows.length > 0;
}

async function flowNames(organizationId: string, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const f = schema.automationFlow;
  const rows = await getDb()
    .select({ id: f.id, name: f.name })
    .from(f)
    .where(scoped(f.organizationId, organizationId, inArray(f.id, [...ids])));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Avisa en la campanita (si el control lo permite). Devuelve si avisó. Nunca lanza. */
export async function raiseBirthdayAlert(
  organizationId: string,
  input: {
    kind: BirthdayAlertKind;
    period: string;
    flowId: string | null;
    flowName: string | null;
    count: number;
    reasons: readonly AlertReason[];
    /** Distingue avisos del mismo tipo y flujo (p. ej. el motivo de un rescate automático que no salió). */
    extra?: string;
  }
): Promise<boolean> {
  if (input.count <= 0) return false;
  try {
    const key = birthdayAlertKey(input.kind, input.flowId, input.period, input.extra);
    if (!(await claimBirthdayAlert(organizationId, key, input.count))) return false;
    const copy = birthdayAlertCopy(input.kind, input);
    await notify(organizationId, {
      ...copy,
      category: "whatsapp",
      link: input.flowId ? `/automatizaciones/${input.flowId}` : "/panel",
    });
    return true;
  } catch (err) {
    console.warn(`[cumpleaños] no pude registrar el aviso: ${err}`);
    return false;
  }
}

/* ------------------------------ fallos y saludos que no salieron ------------------------------ */

/** Pasos de envío de las ejecuciones de cumpleaños del mes (saludo del año y rescate del mes), sin el Laboratorio. */
async function monitorSends(organizationId: string, month: number, keys: string[]): Promise<MonitorSendRow[]> {
  const l = schema.automationExecutionLog;
  const q = schema.automationQueue;
  const r = schema.automationRun;
  const m = schema.message;
  const cv = schema.conversation;
  const c = schema.contact;
  return getDb()
    .select({
      flowId: l.flowId,
      contactId: l.contactId,
      key: r.dedupeKey,
      logStatus: l.status,
      messageStatus: m.status,
      error: sql<string | null>`${l.metadata}->>'error'`,
    })
    .from(l)
    .innerJoin(c, and(eq(c.id, l.contactId), eq(c.organizationId, organizationId), eq(c.birthdayMonth, month)))
    .innerJoin(q, and(eq(q.id, l.queueId), eq(q.organizationId, organizationId)))
    .innerJoin(r, and(eq(r.id, q.runId), eq(r.organizationId, organizationId), inArray(r.dedupeKey, keys)))
    .leftJoin(m, and(eq(m.id, sql`${l.metadata}->>'messageId'`), eq(m.organizationId, organizationId)))
    .leftJoin(cv, eq(cv.id, m.conversationId))
    .where(
      scoped(
        l.organizationId,
        organizationId,
        inArray(sql`${l.metadata}->'step'->>'stepType'`, [...BIRTHDAY_SEND_STEP_TYPES]),
        or(isNull(cv.id), eq(cv.isTest, false))
      )
    ) as Promise<MonitorSendRow[]>;
}

/** Ejecuciones de cumpleaños del mes con el error de su última tarea cerrada. */
async function monitorRuns(organizationId: string, month: number, keys: string[]): Promise<MonitorRunRow[]> {
  const r = schema.automationRun;
  const c = schema.contact;
  const rows = await getDb()
    .select({
      flowId: r.flowId,
      contactId: r.contactId,
      key: r.dedupeKey,
      status: r.status,
      error: sql<string | null>`(select q.error from ${schema.automationQueue} q where q.run_id = ${r.id} and q.organization_id = ${organizationId} and q.status in ('failed', 'cancelled') order by q.created_at desc limit 1)`,
    })
    .from(r)
    .innerJoin(c, and(eq(c.id, r.contactId), eq(c.organizationId, organizationId), eq(c.birthdayMonth, month)))
    .where(scoped(r.organizationId, organizationId, inArray(r.dedupeKey, keys)));
  return rows.flatMap((x) => (x.key ? [{ ...x, key: x.key }] : []));
}

/** Los saludos que ya tocaban y no salieron, por flujo. */
async function greetingMisses(organizationId: string, today: string, timezone: string) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const f = schema.automationFlow;
  const flows = await getDb()
    .select({ id: f.id, createdAt: f.createdAt, triggerConfig: f.triggerConfig })
    .from(f)
    .where(scoped(f.organizationId, organizationId, eq(f.triggerType, "birthday"), eq(f.active, true)));
  if (flows.length === 0) return [];
  const c = schema.contact;
  const contacts = await getDb()
    .select({
      id: c.id,
      day: c.birthdayDay,
      month: c.birthdayMonth,
      createdAt: c.createdAt,
      optedOut: sql<boolean>`(${c.optedOutAt} is not null)`,
      // Columna calificada a mano: en una consulta de UNA tabla, Drizzle escribe `"id"` a secas y dentro de la
      // subconsulta apuntaría a `conversation.id`.
      reachable: sql<boolean>`exists (select 1 from ${schema.conversation} cv where cv.contact_id = "contact"."id" and cv.organization_id = ${organizationId} and cv.channel = 'whatsapp' and cv.is_test = false)`,
    })
    .from(c)
    .where(scoped(c.organizationId, organizationId, eq(c.birthdayMonth, month)));
  const r = schema.automationRun;
  const runs = await getDb()
    .select({ flowId: r.flowId, contactId: r.contactId })
    .from(r)
    .where(scoped(r.organizationId, organizationId, eq(r.dedupeKey, birthdayDedupeKey(year)), inArray(r.flowId, flows.map((x) => x.id))));
  return expectedGreetingMisses({
    today,
    year,
    flows: flows.map((x) => ({
      id: x.id,
      createdOn: todayInTz(x.createdAt, timezone),
      daysOffset: parseTriggerConfig(x.triggerConfig).daysOffset ?? 0,
    })),
    contacts: contacts.flatMap((x) =>
      x.day && x.month
        ? [{ id: x.id, day: x.day, month: x.month, createdOn: todayInTz(x.createdAt, timezone), reachable: x.reachable, optedOut: x.optedOut }]
        : []
    ),
    started: new Set(runs.map((x) => `${x.flowId}|${x.contactId}`)),
  });
}

export type MonitorResult = { alerts: number };

/** Revisa el mes de una organización y avisa lo nuevo: fallos de saludo y de rescate, y saludos que no salieron. */
export async function checkBirthdayAlerts(organizationId: string, today: string, timezone: string): Promise<MonitorResult> {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const period = rescuePeriodOf(today);
  const keys = [birthdayDedupeKey(year), birthdayRescueDedupeKey(period)];
  const [sends, runs, misses] = await Promise.all([
    monitorSends(organizationId, month, keys),
    monitorRuns(organizationId, month, keys),
    greetingMisses(organizationId, today, timezone),
  ]);
  const failures = collectFailureAlerts({ sends, runs });
  const missByFlow = new Map<string, { contactIds: string[]; reasons: AlertReason[] }>();
  for (const m of misses) {
    const g = missByFlow.get(m.flowId) ?? { contactIds: [], reasons: [] };
    g.contactIds.push(m.contactId);
    g.reasons.push(m.reason);
    missByFlow.set(m.flowId, g);
  }
  const names = await flowNames(organizationId, [...new Set([...failures.map((x) => x.flowId), ...missByFlow.keys()])]);
  let alerts = 0;
  for (const f of failures) {
    const raised = await raiseBirthdayAlert(organizationId, {
      kind: f.kind,
      period,
      flowId: f.flowId,
      flowName: names.get(f.flowId) ?? null,
      count: f.contactIds.length,
      reasons: f.reasons,
    });
    if (raised) alerts += 1;
  }
  for (const [flowId, g] of missByFlow) {
    const raised = await raiseBirthdayAlert(organizationId, {
      kind: "greeting_not_fired",
      period,
      flowId,
      flowName: names.get(flowId) ?? null,
      count: g.contactIds.length,
      reasons: g.reasons,
    });
    if (raised) alerts += 1;
  }
  return { alerts };
}

/* ------------------------------ rescate automático ------------------------------ */

/** La hora (0-23) en la zona del negocio. */
export function hourInTz(now: Date, timezone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now);
  return Number(h) % 24;
}

/** Reclama la pasada del día: `true` solo la primera vez que se llama con ese día. */
async function claimAutoRunDay(organizationId: string, today: string): Promise<boolean> {
  const t = schema.birthdayRescueSettings;
  const rows = await getDb()
    .update(t)
    .set({ lastAutoRunOn: today, updatedAt: new Date() })
    .where(scoped(t.organizationId, organizationId, or(isNull(t.lastAutoRunOn), ne(t.lastAutoRunOn, today))))
    .returning({ id: t.id });
  return rows.length > 0;
}

export type AutoRescueResult =
  | { status: "off" | "outside_window" | "before_hour" | "already_ran" }
  | { status: "not_fired"; reason: AlertReason; eligible: number }
  | { status: "launched"; enqueued: number; errors: number };

/**
 * El rescate automático de una organización: con el automático encendido, dentro de la ventana de cierre y desde la
 * hora elegida, UNA pasada por día (cada día de la ventana suma a quien recién quedó elegible; nadie recibe dos).
 * Si no puede salir (sin flujo, flujo borrado, apagado, no manual o que felicita fuera de fecha) avisa en la
 * campanita a cuántos cumpleañeros dejó sin rescate y por qué.
 */
export async function runAutoRescue(organizationId: string, now: Date = new Date()): Promise<AutoRescueResult> {
  const settings = await getRescueSettings(organizationId);
  if (!settings.autoEnabled) return { status: "off" };
  const timezone = await businessTimezone(organizationId);
  const today = todayInTz(now, timezone);
  if (!inClosingWindow(today, settings.windowDays)) return { status: "outside_window" };
  if (hourInTz(now, timezone) < settings.sendHour) return { status: "before_hour" };
  if (!(await claimAutoRunDay(organizationId, today))) return { status: "already_ran" };

  const period = rescuePeriodOf(today);
  const names = settings.flowId ? await flowNames(organizationId, [settings.flowId]) : new Map<string, string>();
  const flowName = settings.flowId ? (names.get(settings.flowId) ?? null) : null;
  const notFired = async (reason: AlertReason, count?: number): Promise<AutoRescueResult> => {
    const eligible = count ?? (await getBirthdayCampaign(organizationId, today, timezone)).rescue.eligible;
    await raiseBirthdayAlert(organizationId, {
      kind: "rescue_not_fired",
      period,
      flowId: flowName ? settings.flowId : null,
      flowName,
      count: eligible,
      reasons: [reason],
      extra: reason,
    });
    return { status: "not_fired", reason, eligible };
  };

  if (!settings.flowId || !flowName) return notFired("flow_missing");
  try {
    const r = await launchBirthdayRescue({ organizationId, flowId: settings.flowId, triggeredBy: null, source: "auto", now });
    const errors = r.skipped.filter((s) => s.reason === "error").length;
    if (errors > 0) await notFired("send_error", errors);
    return { status: "launched", enqueued: r.enqueued, errors };
  } catch (err) {
    if (err instanceof AutomationError) return notFired(launchErrorReason(err.code));
    throw err;
  }
}

/* ------------------------------ el barrido ------------------------------ */

/** Organizaciones con algo de cumpleaños que vigilar: flujos de cumpleaños activos o ajustes del rescate. */
async function organizationsToWatch(): Promise<string[]> {
  // Recorre organizaciones (como el barrido de disparadores): no es una lectura de datos de un negocio.
  const f = schema.automationFlow;
  const t = schema.birthdayRescueSettings;
  const [flows, settings] = await Promise.all([
    getDb().selectDistinct({ id: f.organizationId }).from(f).where(and(eq(f.triggerType, "birthday"), eq(f.active, true))),
    getDb().select({ id: t.organizationId }).from(t),
  ]);
  return [...new Set([...flows, ...settings].map((x) => x.id))];
}

export type BirthdayMonitorRun = { organizations: number; autoLaunched: number; alerts: number };

/** Una pasada del vigilante para todas las organizaciones. Nunca lanza. */
export async function runBirthdayMonitor(now: Date = new Date()): Promise<BirthdayMonitorRun> {
  const out: BirthdayMonitorRun = { organizations: 0, autoLaunched: 0, alerts: 0 };
  let orgs: string[] = [];
  try {
    orgs = await organizationsToWatch();
  } catch (err) {
    console.error("[cumpleaños] el vigilante no pudo listar organizaciones:", err);
    return out;
  }
  for (const organizationId of orgs) {
    out.organizations += 1;
    try {
      const auto = await runAutoRescue(organizationId, now);
      if (auto.status === "launched") out.autoLaunched += auto.enqueued;
      const timezone = await businessTimezone(organizationId);
      const r = await checkBirthdayAlerts(organizationId, todayInTz(now, timezone), timezone);
      out.alerts += r.alerts;
    } catch (err) {
      console.error(`[cumpleaños] el vigilante falló en ${organizationId}:`, err);
    }
  }
  return out;
}
