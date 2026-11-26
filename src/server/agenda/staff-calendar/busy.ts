import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { getSettings } from "@/server/agenda/settings";
import { ConnectorError } from "@/server/agenda/connectors/types";
import { lockAgenda } from "@/server/agenda/service";
import {
  BUSY_REFRESH_MS,
  busyRetryDelayMs,
  busyWindow,
  computeBusyBlocks,
  isScopeError,
} from "@/server/agenda/calendar-busy/intervals";
import {
  applyBusyBlocks,
  GOOGLE_BUSY_NOTE,
  knownOwnEventIds,
  listAllCalendars,
  notifyConflicts,
  reconcileConflicts,
} from "@/server/agenda/calendar-busy/sync";
import { getStaffCreds, markStaffError, saveStaffState } from "@/server/agenda/staff-calendar/connection";
import { staffCalendarsEnabled } from "@/server/agenda/staff-calendar/flag";
import { publish } from "@/server/events/bus";
import { notify } from "@/server/notifications/service";

/**
 * Mejora 3 — Lo ocupado en el Google Calendar de UN profesional → bloqueos de ESE profesional
 * (`booking.busy_source = 'google'`, `staff_id` = él). Mismas reglas que el Paso 4 (`intervals.ts`: ignora lo
 * de Vocero, lo «Disponible», lo rechazado…), misma ventana, mismo todo-o-nada y mismos reintentos; la
 * disponibilidad sigue leyendo SOLO la base.
 *
 *  - Google caído → `error`, reintento 1 → 60 min, se conservan sus bloqueos.
 *  - Permiso revocado / caducado → la conexión queda `error`, se conservan sus bloqueos y se avisa UNA vez al
 *    dueño («envíale un enlace nuevo»). El barrido no insiste.
 *  - 403 de permiso → `needs_reconnect` (otro enlace).
 */

const SWEEP_BATCH = 10;

export type StaffBusyOutcome =
  | { outcome: "synced"; blocks: number; inserted: number; deleted: number; newConflicts: number }
  | { outcome: "disabled" | "not_connected" | "auth_error" | "needs_reconnect" | "error"; error?: string };

const g = globalThis as unknown as { __voceroStaffBusyInflight?: Map<string, Promise<StaffBusyOutcome>> };
const inflight = (): Map<string, Promise<StaffBusyOutcome>> => (g.__voceroStaffBusyInflight ??= new Map());

/** Lee el calendario del profesional y deja sus bloqueos al día. Una lectura a la vez por profesional. Nunca lanza. */
export function syncStaffBusy(organizationId: string, staffId: string, now = new Date()): Promise<StaffBusyOutcome> {
  const key = `${organizationId}:${staffId}`;
  const running = inflight().get(key);
  if (running) return running;
  const p = runStaffSync(organizationId, staffId, now).catch((err): StaffBusyOutcome => {
    console.error(`[calendario] la lectura del calendario del profesional falló sin control: ${msg(err)}`);
    return { outcome: "error", error: msg(err) };
  });
  inflight().set(key, p);
  void p.finally(() => inflight().delete(key));
  return p;
}

/** Mejora 4: la lectura en curso de ese profesional, si hay (un aviso de Google la espera y lee otra vez). */
export function staffBusySyncInflight(organizationId: string, staffId: string): Promise<StaffBusyOutcome> | undefined {
  return inflight().get(`${organizationId}:${staffId}`);
}

export async function waitForStaffBusyIdle(): Promise<void> {
  while (inflight().size > 0) await Promise.allSettled([...inflight().values()]);
}

/** Lectura ya, en segundo plano (al conectar). Mejora 4: y sus avisos al instante. Nunca lanza. */
export function requestStaffBusySync(organizationId: string, staffId: string): void {
  void syncStaffBusy(organizationId, staffId);
  void import("@/server/agenda/calendar-watch/reconcile")
    .then((m) => m.ensureWatches(organizationId))
    .catch(() => {});
}

async function runStaffSync(organizationId: string, staffId: string, now: Date): Promise<StaffBusyOutcome> {
  if (!staffCalendarsEnabled()) return { outcome: "disabled" };
  const db = getDb();
  const [row] = await db
    .select({
      status: schema.staffGoogleConnection.status,
      busyStatus: schema.staffGoogleConnection.busyStatus,
      attempts: schema.staffGoogleConnection.busyAttempts,
      staffName: schema.staff.name,
      staffActive: schema.staff.active,
    })
    .from(schema.staffGoogleConnection)
    .innerJoin(schema.staff, eq(schema.staff.id, schema.staffGoogleConnection.staffId))
    .where(
      scoped(
        schema.staffGoogleConnection.organizationId,
        organizationId,
        eq(schema.staffGoogleConnection.staffId, staffId)
      )
    )
    .limit(1);
  if (!row || !row.staffActive) return { outcome: "not_connected" };
  if (row.status !== "connected") return { outcome: "auth_error", error: "La conexión de Google se perdió." };
  const creds = await getStaffCreds(organizationId, staffId);
  if (!creds) return { outcome: "not_connected" };

  const settings = await getSettings(organizationId);
  const window = busyWindow(now, settings);
  try {
    const events = await listAllCalendars(creds, window);
    const ownEventIds = await knownOwnEventIds(organizationId, window);
    const { blocks } = computeBusyBlocks(events, { timezone: settings.timezone, window, ownEventIds });

    const applied = await db.transaction(async (tx) => {
      await lockAgenda(tx, organizationId);
      // Bajo el candado: si mientras se leía se desconectó o se desactivó al profesional, no se escribe nada.
      const [still] = await tx
        .select({ active: schema.staff.active })
        .from(schema.staffGoogleConnection)
        .innerJoin(schema.staff, eq(schema.staff.id, schema.staffGoogleConnection.staffId))
        .where(
          scoped(
            schema.staffGoogleConnection.organizationId,
            organizationId,
            eq(schema.staffGoogleConnection.staffId, staffId)
          )
        )
        .limit(1);
      if (!still?.active) return null;
      const written = await applyBusyBlocks(
        tx,
        organizationId,
        { staffId, note: `${GOOGLE_BUSY_NOTE} · ${row.staffName}` },
        blocks,
        window
      );
      const conflicts = await reconcileConflicts(tx, organizationId, now);
      return { ...written, conflicts };
    });
    if (!applied) return { outcome: "not_connected" };

    await saveStaffState(organizationId, staffId, {
      busyStatus: "ok",
      busySyncedAt: new Date(),
      busyError: null,
      busyAttempts: 0,
      busyNextAt: new Date(Date.now() + BUSY_REFRESH_MS),
      busyBlocks: blocks.length,
      lastOkAt: new Date(),
      lastError: null,
    });
    const changed = applied.inserted[0] ?? applied.deleted[0] ?? applied.conflicts.changedIds[0];
    if (changed) publish(organizationId, { type: "booking.updated", data: { bookingId: changed } });
    if (applied.conflicts.newIds.length > 0) {
      await notifyConflicts(organizationId, applied.conflicts.newIds, settings.timezone);
    }
    return {
      outcome: "synced",
      blocks: blocks.length,
      inserted: applied.inserted.length,
      deleted: applied.deleted.length,
      newConflicts: applied.conflicts.newIds.length,
    };
  } catch (err) {
    return handleFailure(organizationId, staffId, row.staffName, err, { previous: row.busyStatus, attempts: row.attempts });
  }
}

async function handleFailure(
  organizationId: string,
  staffId: string,
  staffName: string,
  err: unknown,
  ctx: { previous: string | null; attempts: number }
): Promise<StaffBusyOutcome> {
  const text = msg(err);
  const status = err instanceof ConnectorError ? (err.status ?? undefined) : undefined;

  if (err instanceof ConnectorError && err.isAuthError) {
    const error = `Google rechazó la conexión de ${staffName}: envíale un enlace nuevo. Mientras tanto se usa lo último que se leyó.`;
    const justBroke = await markStaffError(organizationId, staffId, text).catch(() => false);
    if (justBroke) {
      await notify(organizationId, {
        title: `Se perdió el Google Calendar de ${staffName}`,
        message: `Google rechazó la conexión del calendario de ${staffName}. La agenda sigue con lo último que se leyó; envíale un enlace nuevo desde Equipo.`,
        category: "sistema",
        link: "/equipo",
      });
    }
    await saveStaffState(organizationId, staffId, { busyStatus: "error", busyError: error, busyNextAt: null });
    return { outcome: "auth_error", error };
  }

  if (isScopeError(status, text)) {
    const error = `Google no dio permiso para leer el calendario de ${staffName}: envíale un enlace nuevo y que acepte el permiso.`;
    await saveStaffState(organizationId, staffId, { busyStatus: "needs_reconnect", busyError: error, busyNextAt: null });
    if (ctx.previous !== "needs_reconnect") {
      await notify(organizationId, {
        title: `Falta un permiso del Google Calendar de ${staffName}`,
        message: `Vocero no puede leer lo ocupado en el calendario de ${staffName}. Envíale un enlace nuevo desde Equipo.`,
        category: "sistema",
        link: "/equipo",
      });
    }
    return { outcome: "needs_reconnect", error };
  }

  const failed = ctx.attempts + 1;
  await saveStaffState(organizationId, staffId, {
    busyStatus: "error",
    busyError: text.slice(0, 500),
    busyAttempts: failed,
    busyNextAt: new Date(Date.now() + busyRetryDelayMs(failed)),
  });
  console.warn(`[calendario] no pude leer el calendario de ${staffName} (intento ${failed}): ${text}`);
  return { outcome: "error", error: text };
}

/**
 * Una barrida: los profesionales conectados, activos, sin pausa por permiso y a los que ya les toca. Secuencial.
 * Nunca lanza. Sin la bandera no hace nada.
 */
export async function sweepStaffBusy(now = new Date()): Promise<{ tried: number; synced: number }> {
  let tried = 0;
  let synced = 0;
  if (!staffCalendarsEnabled()) return { tried, synced };
  try {
    const due = await getDb()
      .select({
        organizationId: schema.staffGoogleConnection.organizationId,
        staffId: schema.staffGoogleConnection.staffId,
      })
      .from(schema.staffGoogleConnection)
      .innerJoin(schema.staff, eq(schema.staff.id, schema.staffGoogleConnection.staffId))
      .where(
        and(
          eq(schema.staff.active, true),
          eq(schema.staffGoogleConnection.status, "connected"),
          or(
            isNull(schema.staffGoogleConnection.busyStatus),
            ne(schema.staffGoogleConnection.busyStatus, "needs_reconnect")
          ),
          or(isNull(schema.staffGoogleConnection.busyNextAt), lte(schema.staffGoogleConnection.busyNextAt, now))
        )
      )
      .orderBy(sql`${schema.staffGoogleConnection.busyNextAt} asc nulls first`)
      .limit(SWEEP_BATCH);
    for (const r of due) {
      tried += 1;
      const out = await syncStaffBusy(r.organizationId, r.staffId, now);
      if (out.outcome === "synced") synced += 1;
    }
  } catch (err) {
    console.error("[calendario] la barrida de los calendarios del equipo falló:", msg(err));
  }
  return { tried, synced };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
