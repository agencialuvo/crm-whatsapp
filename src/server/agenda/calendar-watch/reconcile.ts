import { and, eq, isNull, ne, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { effectiveBusyCalendars } from "@/lib/google-calendar";
import {
  planWatchChanges,
  summarizeWatch,
  type WatchChannelRow,
  type WatchStatus,
  type WatchTarget,
} from "@/lib/google-watch";
import { getGoogleCredentials, type GoogleCreds } from "@/server/agenda/connectors/google-credentials";
import { getStaffCreds } from "@/server/agenda/staff-calendar/connection";
import { staffCalendarsEnabled } from "@/server/agenda/staff-calendar/flag";
import { createChannel, listChannels, stopChannelRows } from "@/server/agenda/calendar-watch/channels";
import { watchAvailability } from "@/server/agenda/calendar-watch/flag";

/**
 * Mejora 4 — Mantiene los canales de avisos al día: lo que DEBE estar vigilado (los calendarios que se leen como
 * ocupado: los del negocio con la lectura encendida y el de cada profesional conectado y activo) contra lo que
 * HAY (`planWatchChanges`). Crea los que faltan, renueva con solapamiento los que vencen en menos de 24 h y
 * detiene los que sobran (lectura apagada, permiso perdido, calendario quitado de la lista, bandera apagada).
 *
 * Corre en el temporizador de 60 s (`sweepWatchChannels`, como mucho 20 llamadas a Google por vuelta) y al
 * momento cuando cambia algo (`ensureWatches`: encender la lectura, reconectar, elegir calendarios, conectar un
 * profesional). Una pasada a la vez por negocio. Nada de esto toca la agenda: si Google falla, se lee cada 5 min
 * como siempre.
 */

const SWEEP_BUDGET = 20;

type Source = { organizationId: string; staffId: string | null; calendars: string[] };

/** Los calendarios del NEGOCIO que se leen como ocupado (lectura encendida, conectado, sin pausa por permiso). */
async function businessSources(organizationId?: string): Promise<Source[]> {
  const rows = await getDb()
    .select({
      organizationId: schema.googleCredentials.organizationId,
      calendarId: schema.googleCredentials.calendarId,
      busyCalendars: schema.googleCredentials.busyCalendars,
    })
    .from(schema.googleCredentials)
    .innerJoin(schema.calendarSettings, eq(schema.calendarSettings.organizationId, schema.googleCredentials.organizationId))
    .where(
      and(
        organizationId ? eq(schema.googleCredentials.organizationId, organizationId) : undefined,
        eq(schema.calendarSettings.googleBusy, true),
        eq(schema.googleCredentials.status, "connected"),
        or(isNull(schema.googleCredentials.busyStatus), ne(schema.googleCredentials.busyStatus, "needs_reconnect"))
      )
    );
  return rows.map((r) => ({
    organizationId: r.organizationId,
    staffId: null,
    calendars: [...new Set(effectiveBusyCalendars({ id: r.calendarId, summary: "" }, r.busyCalendars).map((c) => c.id))],
  }));
}

/** El calendario de cada profesional conectado y activo (Mejora 3), sin pausa por permiso. */
async function staffSources(organizationId?: string): Promise<Source[]> {
  if (!staffCalendarsEnabled()) return [];
  const rows = await getDb()
    .select({ organizationId: schema.staffGoogleConnection.organizationId, staffId: schema.staffGoogleConnection.staffId })
    .from(schema.staffGoogleConnection)
    .innerJoin(schema.staff, eq(schema.staff.id, schema.staffGoogleConnection.staffId))
    .where(
      and(
        organizationId ? eq(schema.staffGoogleConnection.organizationId, organizationId) : undefined,
        eq(schema.staff.active, true),
        eq(schema.staffGoogleConnection.status, "connected"),
        or(
          isNull(schema.staffGoogleConnection.busyStatus),
          ne(schema.staffGoogleConnection.busyStatus, "needs_reconnect")
        )
      )
    );
  // El profesional lee su calendario principal (`getStaffCreds`).
  return rows.map((r) => ({ organizationId: r.organizationId, staffId: r.staffId, calendars: ["primary"] }));
}

/** Lo que DEBE estar vigilado (de un negocio o de todos). */
export async function desiredWatches(organizationId?: string): Promise<WatchTarget[]> {
  const sources = [...(await businessSources(organizationId)), ...(await staffSources(organizationId))];
  return sources.flatMap((s) => s.calendars.map((calendarId) => ({ organizationId: s.organizationId, staffId: s.staffId, calendarId })));
}

/* ---------- una pasada por negocio ---------- */

const g = globalThis as unknown as { __voceroWatchInflight?: Map<string, Promise<number>> };
const inflight = (): Map<string, Promise<number>> => (g.__voceroWatchInflight ??= new Map());

/**
 * Deja los canales de un negocio al día. Devuelve cuántas llamadas a Google hizo. Si ya hay una pasada de ese
 * negocio en curso, devuelve la misma (así el barrido y un `ensureWatches` no piden dos canales). Nunca lanza.
 */
export function reconcileWatches(
  organizationId: string,
  opts: { budget?: number; now?: Date } = {}
): Promise<number> {
  const running = inflight().get(organizationId);
  if (running) return running;
  const p = runReconcile(organizationId, opts.budget ?? SWEEP_BUDGET, opts.now ?? new Date()).catch((err) => {
    console.warn(`[calendario] no pude poner al día los avisos de Google: ${msg(err)}`);
    return 0;
  });
  inflight().set(organizationId, p);
  void p.finally(() => inflight().delete(organizationId));
  return p;
}

/** Ponerlos al día YA, en segundo plano. Nunca lanza. */
export function ensureWatches(organizationId: string): void {
  void reconcileWatches(organizationId);
}

export async function waitForWatchReconcileIdle(): Promise<void> {
  while (inflight().size > 0) await Promise.allSettled([...inflight().values()]);
}

async function runReconcile(organizationId: string, budget: number, now: Date): Promise<number> {
  const avail = watchAvailability();
  const desired = avail.ok ? await desiredWatches(organizationId) : [];
  const existing = await listChannels(organizationId);
  if (desired.length === 0 && existing.length === 0) return 0;

  const plan = planWatchChanges(desired, existing as WatchChannelRow[], now);
  const creds = new Map<string, Promise<GoogleCreds | null>>();
  const credsFor = (staffId: string | null): Promise<GoogleCreds | null> => {
    const key = staffId ?? "-";
    if (!creds.has(key)) {
      creds.set(
        key,
        (staffId === null ? getGoogleCredentials(organizationId) : getStaffCreds(organizationId, staffId)).catch(() => null)
      );
    }
    return creds.get(key)!;
  };

  let calls = 0;
  // Primero lo que sobra (también sin HTTPS o con la bandera apagada: limpieza).
  const bySource = new Map<string, WatchChannelRow[]>();
  for (const r of plan.stop) bySource.set(r.staffId ?? "-", [...(bySource.get(r.staffId ?? "-") ?? []), r]);
  for (const rows of bySource.values()) calls += await stopChannelRows(await credsFor(rows[0]!.staffId), rows);

  if (!avail.ok) return calls;
  for (const { target, retry } of plan.create) {
    if (calls >= budget) break;
    const c = await credsFor(target.staffId);
    if (!c) continue;
    calls += 1;
    await createChannel(c, target, retry, avail.address, now);
  }
  return calls;
}

/* ---------- barrido ---------- */

/**
 * Una vuelta del temporizador: todos los negocios con algo que vigilar o con canales guardados, secuencial, con
 * un tope de llamadas a Google. Nunca lanza.
 */
export async function sweepWatchChannels(now = new Date()): Promise<{ organizations: number; calls: number }> {
  let calls = 0;
  let organizations = 0;
  try {
    const avail = watchAvailability();
    const orgs = new Set<string>();
    if (avail.ok) for (const t of await desiredWatches()) orgs.add(t.organizationId);
    // Lectura de mantenimiento entre negocios (como los demás barridos): solo para saber a quién limpiar.
    const withRows = await getDb()
      .selectDistinct({ organizationId: schema.googleWatchChannel.organizationId })
      .from(schema.googleWatchChannel);
    for (const r of withRows) orgs.add(r.organizationId);
    for (const org of orgs) {
      if (calls >= SWEEP_BUDGET) break;
      organizations += 1;
      calls += await reconcileWatches(org, { budget: SWEEP_BUDGET - calls, now });
    }
  } catch (err) {
    console.error("[calendario] la barrida de los avisos de Google falló:", msg(err));
  }
  return { organizations, calls };
}

/* ---------- estado para la pantalla ---------- */

/**
 * Cómo llegan los cambios: del negocio y de cada profesional. `off` = no se muestra nada (bandera apagada, o
 * esa fuente no se lee).
 */
export async function getWatchStatuses(
  organizationId: string,
  now = new Date()
): Promise<{ business: WatchStatus; staff: Map<string, WatchStatus> }> {
  const staff = new Map<string, WatchStatus>();
  const avail = watchAvailability();
  if (!avail.ok && avail.reason === "off") return { business: { status: "off" }, staff };
  const sources = [...(await businessSources(organizationId)), ...(await staffSources(organizationId))];
  const rows = (await listChannels(organizationId)) as WatchChannelRow[];
  let business: WatchStatus = { status: "off" };
  for (const s of sources) {
    const status: WatchStatus = !avail.ok
      ? { status: "unavailable", reason: "no_https" }
      : summarizeWatch(s.calendars, rows.filter((r) => r.staffId === s.staffId), now);
    if (s.staffId === null) business = status;
    else staff.set(s.staffId, status);
  }
  return { business, staff };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
