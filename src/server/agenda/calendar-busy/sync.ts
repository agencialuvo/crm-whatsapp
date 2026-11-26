import { and, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { getSettings } from "@/server/agenda/settings";
import { dayIsoInTz, labelInTz, timeInTz } from "@/lib/time/slots";
import { eventsPath, googleRequest } from "@/server/agenda/connectors/google";
import {
  getGoogleCredentials,
  markGoogleError,
  markGoogleOk,
  type GoogleCreds,
} from "@/server/agenda/connectors/google-credentials";
import { ConnectorError } from "@/server/agenda/connectors/types";
import { lockAgenda } from "@/server/agenda/service";
import {
  BUSY_REFRESH_MS,
  busyRetryDelayMs,
  busyWindow,
  computeBusyBlocks,
  detectConflicts,
  diffBusyBlocks,
  durationMinutesOf,
  isScopeError,
  type GoogleBusyEvent,
  type Interval,
} from "@/server/agenda/calendar-busy/intervals";
import { stopWatchesFor } from "@/server/agenda/calendar-watch/channels";
import { publish } from "@/server/events/bus";
import { notify } from "@/server/notifications/service";

/**
 * Paso 4 — Lo ocupado en el Google Calendar conectado, como BLOQUEOS de la agenda (Google → Vocero).
 *
 * La regla que no se negocia (ADR-002, punto 4): la disponibilidad NO llama a Google al ofrecer horarios.
 * Un barrido (y el botón «Leer ahora») lista los eventos de la ventana reservable, calcula los tramos
 * ocupados (`intervals.ts`: ignora lo que publicó Vocero, lo «Disponible», lo rechazado…) y deja en la
 * base exactamente esos bloqueos (`booking.kind = 'block'`, `busy_source = 'google'`). Ofrecer horarios
 * sigue leyendo solo la base, así que Google caído = la agenda funciona con lo último que se leyó.
 *
 * Nunca pisa lo del negocio: solo crea y borra filas `busy_source = 'google'`; las citas y los bloqueos
 * puestos a mano no se tocan (un evento de Google encima de una cita es un aviso, no una cancelación).
 *
 * Fallos:
 *  - Google caído / 5xx / 429 → `busy_status = error`, se reintenta (1 min → 60 min) y los bloqueos ya
 *    guardados se quedan como estaban. Una lectura incompleta (una página que falla) no escribe nada.
 *  - Token revocado o vencido (401 / `invalid_grant`) → la conexión pasa a «se perdió» (la misma marca del
 *    Paso 3), se avisa UNA vez y se pausa hasta reconectar. Los bloqueos se quedan.
 *  - 403 de permiso insuficiente → `needs_reconnect`: hay que reconectar dando permiso de lectura.
 *
 * Mejora 2 — Lee TODOS los calendarios elegidos (`busy_calendars`, por defecto el de publicar) y suma lo
 * ocupado. Todo o nada: si uno falla, no se aplica la lectura y el error dice QUÉ calendario falló.
 *
 * Mejora 3 — Las mismas piezas sirven para el calendario de cada profesional (`staff-calendar/busy.ts`):
 * `applyBusyBlocks` escribe los bloqueos de UNA fuente (el negocio, `staff_id` null; o un profesional,
 * `staff_id` = él) sin tocar los de las demás, y `reconcileConflicts` cruza cada cita con lo ocupado del
 * negocio y con lo de SU profesional.
 *
 * Mejora 1 — Choques: si lo ocupado en Google se pisa con una cita activa que viene, la cita se marca
 * (`booking.google_conflict_start/end`) y se avisa UNA vez por choque (varios en la misma lectura = un solo
 * aviso). La cita nunca se cancela ni se mueve; la marca se limpia sola cuando el choque desaparece.
 */

/** Páginas de 250 eventos: 20 son 5 000 eventos en la ventana (60 días como mucho). Más es un error. */
const PAGE_SIZE = 250;
const MAX_PAGES = 20;
/** Negocios por barrida: cada lectura son una o pocas llamadas a Google. */
const SWEEP_BATCH = 10;

export const GOOGLE_BUSY_NOTE = "Ocupado en Google Calendar";

export type BusyOutcome =
  | { outcome: "synced"; blocks: number; inserted: number; deleted: number; conflicts: number; newConflicts: number }
  | { outcome: "disabled" | "not_connected" | "auth_error" | "needs_reconnect" | "error"; error?: string };

/* ---------- una lectura a la vez por negocio (y para esperar en pruebas) ---------- */

const g = globalThis as unknown as { __voceroBusyInflight?: Map<string, Promise<BusyOutcome>> };
const inflight = (): Map<string, Promise<BusyOutcome>> => (g.__voceroBusyInflight ??= new Map());

/**
 * Lee Google y deja los bloqueos al día. Si ya hay una lectura de ese negocio en curso, devuelve la misma
 * (dos clics seguidos en «Leer ahora» no llaman dos veces). Nunca lanza.
 */
export function syncGoogleBusy(organizationId: string, now = new Date()): Promise<BusyOutcome> {
  const running = inflight().get(organizationId);
  if (running) return running;
  const p = runSync(organizationId, now).catch((err): BusyOutcome => {
    console.error(`[calendario] la lectura de lo ocupado falló sin control: ${msg(err)}`);
    return { outcome: "error", error: msg(err) };
  });
  inflight().set(organizationId, p);
  void p.finally(() => inflight().delete(organizationId));
  return p;
}

/** Mejora 4: la lectura en curso de ese negocio, si hay (un aviso de Google la espera y lee otra vez). */
export function busySyncInflight(organizationId: string): Promise<BusyOutcome> | undefined {
  return inflight().get(organizationId);
}

/** Espera a que terminen las lecturas en curso (pruebas y apagado ordenado). */
export async function waitForBusySyncIdle(): Promise<void> {
  while (inflight().size > 0) await Promise.allSettled([...inflight().values()]);
}

/**
 * Pide una lectura YA (al encender la opción, al reconectar, al cambiar los días reservables): la deja
 * vencida para el barrido y la lanza en segundo plano. Nunca lanza.
 */
export async function requestBusySync(organizationId: string, opts: { ensureWatch?: boolean } = {}): Promise<void> {
  try {
    const settings = await getSettings(organizationId);
    if (!settings.googleBusy) return;
    // Mejora 4: con la lectura encendida (o recién reconectada / con otros calendarios), los avisos al instante
    // se ponen al día. Import diferido: `reconcile` depende de módulos que dependen de este.
    if (opts.ensureWatch !== false) {
      void import("@/server/agenda/calendar-watch/reconcile")
        .then((m) => m.ensureWatches(organizationId))
        .catch(() => {});
    }
    await getDb()
      .update(schema.googleCredentials)
      .set({ busyNextAt: new Date(), busyAttempts: 0 })
      .where(scoped(schema.googleCredentials.organizationId, organizationId));
    void syncGoogleBusy(organizationId);
  } catch (err) {
    console.warn(`[calendario] no pude pedir la lectura de lo ocupado: ${msg(err)}`);
  }
}

/**
 * Quita TODO lo que se trajo de Google (al apagar la opción o desconectar): sin lectura, esos bloqueos
 * dejarían de corresponder a nada. Las citas y los bloqueos propios no se tocan. Nunca lanza.
 */
export async function clearGoogleBusyBlocks(organizationId: string): Promise<number> {
  try {
    // Mejora 4: sin lectura no hace falta que Google avise. Se detienen sus canales ANTES de que quien llama
    // revoque el permiso (`channels.stop` necesita el token vigente).
    await stopWatchesFor(organizationId, null, await getGoogleCredentials(organizationId).catch(() => null));
    const db = getDb();
    const removed = await db.transaction(async (tx) => {
      await lockAgenda(tx, organizationId);
      // Solo lo del negocio: lo de cada profesional (Mejora 3) tiene su propia conexión.
      const deleted = await tx
        .delete(schema.booking)
        .where(
          scoped(
            schema.booking.organizationId,
            organizationId,
            eq(schema.booking.busySource, "google"),
            isNull(schema.booking.staffId)
          )
        )
        .returning({ id: schema.booking.id });
      // Sin eso ya no hay con qué chocar (salvo lo de cada profesional): se recalculan las marcas.
      await reconcileConflicts(tx, organizationId, new Date());
      return deleted;
    });
    await db
      .update(schema.googleCredentials)
      .set({ busyStatus: null, busyError: null, busyAttempts: 0, busyNextAt: null, busyBlocks: 0 })
      .where(scoped(schema.googleCredentials.organizationId, organizationId));
    if (removed[0]) publish(organizationId, { type: "booking.updated", data: { bookingId: removed[0].id } });
    return removed.length;
  } catch (err) {
    console.warn(`[calendario] no pude quitar los bloqueos de Google: ${msg(err)}`);
    return 0;
  }
}

/* ---------- una lectura ---------- */

async function runSync(organizationId: string, now: Date): Promise<BusyOutcome> {
  const db = getDb();
  const settings = await getSettings(organizationId);
  if (!settings.googleBusy) return { outcome: "disabled" };

  const [row] = await db
    .select({ status: schema.googleCredentials.status, busyStatus: schema.googleCredentials.busyStatus, attempts: schema.googleCredentials.busyAttempts })
    .from(schema.googleCredentials)
    .where(scoped(schema.googleCredentials.organizationId, organizationId))
    .limit(1);
  if (!row) return { outcome: "not_connected" };
  // Conexión rota (token revocado): pausado hasta reconectar. Los bloqueos guardados siguen valiendo.
  if (row.status !== "connected") return { outcome: "auth_error", error: "Google Calendar no está conectado." };

  const creds = await getGoogleCredentials(organizationId);
  if (!creds) {
    // La conexión existe pero no hay con qué hablar (la app OAuth de la instancia ya no está configurada).
    const error = "Google Calendar no está disponible en este servidor: revisa la conexión en Ajustes → Agenda.";
    await saveState(organizationId, {
      busyStatus: "error",
      busyError: error,
      busyNextAt: new Date(now.getTime() + BUSY_REFRESH_MS),
    });
    return { outcome: "not_connected", error };
  }

  const window = busyWindow(now, settings);
  try {
    const events = await listAllCalendars(creds, window);
    const ownEventIds = await knownOwnEventIds(organizationId, window);
    const { blocks } = computeBusyBlocks(events, { timezone: settings.timezone, window, ownEventIds });

    const applied = await db.transaction(async (tx) => {
      await lockAgenda(tx, organizationId);
      // Bajo el candado: si mientras se leía se desconectó o se apagó la opción, no se escribe nada (el
      // borrado de `clearGoogleBusyBlocks` toma el mismo candado, así que no puede colarse en medio).
      const [still] = await tx
        .select({ busy: schema.calendarSettings.googleBusy })
        .from(schema.calendarSettings)
        .innerJoin(
          schema.googleCredentials,
          eq(schema.googleCredentials.organizationId, schema.calendarSettings.organizationId)
        )
        .where(scoped(schema.calendarSettings.organizationId, organizationId))
        .limit(1);
      if (!still?.busy) return null;

      const written = await applyBusyBlocks(tx, organizationId, { staffId: null, note: GOOGLE_BUSY_NOTE }, blocks, window);
      const conflicts = await reconcileConflicts(tx, organizationId, now);
      return { ...written, conflicts };
    });
    if (!applied) return { outcome: "disabled" };

    await saveState(organizationId, {
      busyStatus: "ok",
      busySyncedAt: new Date(),
      busyError: null,
      busyAttempts: 0,
      busyNextAt: new Date(Date.now() + BUSY_REFRESH_MS),
      busyBlocks: blocks.length,
    });
    await markGoogleOk(organizationId).catch(() => {});
    const { conflicts } = applied;
    const changed =
      applied.inserted[0] ?? applied.deleted[0] ?? conflicts.changedIds[0];
    if (changed) publish(organizationId, { type: "booking.updated", data: { bookingId: changed } });
    if (conflicts.newIds.length > 0) await notifyConflicts(organizationId, conflicts.newIds, settings.timezone);
    return {
      outcome: "synced",
      blocks: blocks.length,
      inserted: applied.inserted.length,
      deleted: applied.deleted.length,
      conflicts: conflicts.active,
      newConflicts: conflicts.newIds.length,
    };
  } catch (err) {
    return await handleFailure(organizationId, err, { previous: row.busyStatus, attempts: row.attempts });
  }
}

async function handleFailure(
  organizationId: string,
  err: unknown,
  ctx: { previous: string | null; attempts: number }
): Promise<BusyOutcome> {
  const text = msg(err);
  const status = err instanceof ConnectorError ? err.status ?? undefined : undefined;

  if (err instanceof ConnectorError && err.isAuthError) {
    const error = "Google rechazó la conexión: reconecta en Ajustes → Agenda. Mientras tanto se usa lo último que se leyó.";
    const justBroke = await markGoogleError(organizationId, text).catch(() => false);
    if (justBroke) {
      await notify(organizationId, {
        title: "Google Calendar se desconectó",
        message:
          "Google rechazó la conexión. La agenda sigue funcionando con lo último que se leyó de tu calendario; reconecta en Ajustes → Agenda.",
        category: "sistema",
        link: "/ajustes/calendario",
      });
    }
    await saveState(organizationId, { busyStatus: "error", busyError: error, busyNextAt: null });
    return { outcome: "auth_error", error };
  }

  if (isScopeError(status, text)) {
    const error =
      "Google no dio permiso para leer tu calendario. Vuelve a conectar Google y acepta el permiso del calendario.";
    await saveState(organizationId, { busyStatus: "needs_reconnect", busyError: error, busyNextAt: null });
    if (ctx.previous !== "needs_reconnect") {
      await notify(organizationId, {
        title: "Falta un permiso de Google Calendar",
        message: "Vocero no puede leer lo ocupado en tu calendario. Reconecta Google en Ajustes → Agenda.",
        category: "sistema",
        link: "/ajustes/calendario",
      });
    }
    return { outcome: "needs_reconnect", error };
  }

  const failed = ctx.attempts + 1;
  await saveState(organizationId, {
    busyStatus: "error",
    busyError: text.slice(0, 500),
    busyAttempts: failed,
    busyNextAt: new Date(Date.now() + busyRetryDelayMs(failed)),
  });
  console.warn(`[calendario] no pude leer lo ocupado en Google (intento ${failed}): ${text}`);
  return { outcome: "error", error: text };
}

export type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Deja en la base EXACTAMENTE los bloqueos leídos de una fuente: el negocio (`staffId: null`) o un
 * profesional (Mejora 3). Solo toca filas de Google de ESA fuente y de hoy en adelante (lo de días pasados
 * queda como historia). Lo que ya está igual no se toca. Se llama con el candado de la agenda tomado.
 */
export async function applyBusyBlocks(
  tx: Tx,
  organizationId: string,
  scope: { staffId: string | null; note: string },
  blocks: Interval[],
  window: Interval
): Promise<{ inserted: string[]; deleted: string[] }> {
  const ofScope = scope.staffId ? eq(schema.booking.staffId, scope.staffId) : isNull(schema.booking.staffId);
  const existing = await tx
    .select({
      id: schema.booking.id,
      scheduledAt: schema.booking.scheduledAt,
      durationMinutes: schema.booking.durationMinutes,
    })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.busySource, "google"),
        ofScope,
        gte(schema.booking.scheduledAt, new Date(window.startMs))
      )
    );
  const diff = diffBusyBlocks(
    existing.map((r) => ({ id: r.id, startMs: r.scheduledAt.getTime(), durationMinutes: r.durationMinutes })),
    blocks
  );
  if (diff.toDelete.length > 0) {
    await tx
      .delete(schema.booking)
      .where(
        scoped(
          schema.booking.organizationId,
          organizationId,
          eq(schema.booking.busySource, "google"),
          ofScope,
          inArray(schema.booking.id, diff.toDelete)
        )
      );
  }
  const inserted: string[] = [];
  if (diff.toInsert.length > 0) {
    const values = diff.toInsert.map((iv: Interval) => {
      const id = newId("booking");
      inserted.push(id);
      return {
        id,
        organizationId,
        kind: "block" as const,
        source: "manual" as const,
        status: "agendada" as const,
        busySource: "google" as const,
        staffId: scope.staffId,
        scheduledAt: new Date(iv.startMs),
        durationMinutes: durationMinutesOf(iv),
        notes: scope.note,
      };
    });
    await tx.insert(schema.booking).values(values);
  }
  return { inserted, deleted: diff.toDelete };
}

/**
 * Mejora 1 — Deja la marca de choque de cada cita igual a lo que dicen los bloqueos de Google GUARDADOS. Mira
 * las citas activas que aún no terminan y, para limpiar, cualquier cita que tuviera marca (se canceló, se
 * cerró o ya pasó). Devuelve las que chocan por PRIMERA vez (lo que se avisa).
 *
 * Mejora 3: cada cita se cruza con lo ocupado del negocio (bloqueos sin profesional) y con lo de SU
 * profesional; lo de otro profesional no le choca.
 */
export async function reconcileConflicts(
  tx: Tx,
  organizationId: string,
  now: Date
): Promise<{ newIds: string[]; changedIds: string[]; active: number }> {
  const blockRows = await tx
    .select({
      staffId: schema.booking.staffId,
      scheduledAt: schema.booking.scheduledAt,
      durationMinutes: schema.booking.durationMinutes,
    })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.busySource, "google"),
        gt(schema.booking.scheduledAt, new Date(now.getTime() - 2 * 86_400_000))
      )
    );
  const blocksFor = (staffId: string | null): Interval[] =>
    blockRows
      .filter((b) => b.staffId === null || (staffId !== null && b.staffId === staffId))
      .map((b) => ({ startMs: b.scheduledAt.getTime(), endMs: b.scheduledAt.getTime() + b.durationMinutes * 60_000 }));

  const rows = await tx
    .select({
      id: schema.booking.id,
      staffId: schema.booking.staffId,
      status: schema.booking.status,
      scheduledAt: schema.booking.scheduledAt,
      durationMinutes: schema.booking.durationMinutes,
      conflictStart: schema.booking.googleConflictStart,
      conflictEnd: schema.booking.googleConflictEnd,
    })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.kind, "session"),
        eq(schema.booking.isTest, false),
        or(
          and(
            eq(schema.booking.status, "agendada"),
            // Las que pueden terminar después de ahora (la más larga empezó, como mucho, ayer).
            gt(schema.booking.scheduledAt, new Date(now.getTime() - 86_400_000))
          ),
          isNotNull(schema.booking.googleConflictStart)
        )
      )
    );

  const live = rows.filter(
    (r) => r.status === "agendada" && r.scheduledAt.getTime() + r.durationMinutes * 60_000 > now.getTime()
  );
  // Por profesional: cada grupo de citas contra lo del negocio + lo de su profesional.
  const groups = new Map<string | null, typeof live>();
  for (const r of live) groups.set(r.staffId, [...(groups.get(r.staffId) ?? []), r]);
  const changes: ReturnType<typeof detectConflicts> = { set: [], cleared: [] };
  for (const [staffId, group] of groups) {
    const part = detectConflicts(
      group.map((r) => ({
        id: r.id,
        startMs: r.scheduledAt.getTime(),
        endMs: r.scheduledAt.getTime() + r.durationMinutes * 60_000,
        conflict:
          r.conflictStart && r.conflictEnd ? { startMs: r.conflictStart.getTime(), endMs: r.conflictEnd.getTime() } : null,
      })),
      blocksFor(staffId)
    );
    changes.set.push(...part.set);
    changes.cleared.push(...part.cleared);
  }
  // Cerradas, canceladas o ya pasadas con marca: se limpian.
  const liveIds = new Set(live.map((r) => r.id));
  const stale = rows.filter((r) => r.conflictStart && !liveIds.has(r.id)).map((r) => r.id);
  const toClear = [...changes.cleared, ...stale];

  for (const s of changes.set) {
    await tx
      .update(schema.booking)
      .set({ googleConflictStart: new Date(s.conflict.startMs), googleConflictEnd: new Date(s.conflict.endMs) })
      .where(scoped(schema.booking.organizationId, organizationId, eq(schema.booking.id, s.id)));
  }
  if (toClear.length > 0) {
    await tx
      .update(schema.booking)
      .set({ googleConflictStart: null, googleConflictEnd: null })
      .where(scoped(schema.booking.organizationId, organizationId, inArray(schema.booking.id, toClear)));
  }

  const stillConflicting = live.filter((r) => r.conflictStart && !changes.cleared.includes(r.id)).length;
  return {
    newIds: changes.set.filter((s) => s.isNew).map((s) => s.id),
    changedIds: [...changes.set.map((s) => s.id), ...toClear],
    active: stillConflicting + changes.set.filter((s) => s.isNew).length,
  };
}

/** Un aviso por lectura: una cita con detalle; varias, juntas (unas vacaciones no son diez avisos). */
export async function notifyConflicts(organizationId: string, ids: string[], timezone: string): Promise<void> {
  try {
    const rows = await getDb()
      .select({
        id: schema.booking.id,
        scheduledAt: schema.booking.scheduledAt,
        conflictStart: schema.booking.googleConflictStart,
        conflictEnd: schema.booking.googleConflictEnd,
        contactName: schema.contact.name,
        staffName: schema.staff.name,
      })
      .from(schema.booking)
      .leftJoin(schema.contact, eq(schema.booking.contactId, schema.contact.id))
      .leftJoin(schema.staff, eq(schema.booking.staffId, schema.staff.id))
      .where(scoped(schema.booking.organizationId, organizationId, inArray(schema.booking.id, ids)))
      .orderBy(schema.booking.scheduledAt);
    const first = rows[0];
    if (!first) return;
    // «Ana» o, si la cita tiene profesional, «Ana con Carla» (Mejora 3: el choque puede ser de su calendario).
    const who = (r: (typeof rows)[number]) =>
      `${r.contactName?.trim() || "Sin contacto"}${r.staffName ? ` con ${r.staffName}` : ""}`;
    if (rows.length === 1) {
      const range =
        first.conflictStart && first.conflictEnd
          ? ` (${timeInTz(first.conflictStart.toISOString(), timezone)}–${timeInTz(first.conflictEnd.toISOString(), timezone)})`
          : "";
      await notify(organizationId, {
        title: "Una cita choca con tu Google Calendar",
        message: `La cita de ${who(first)} del ${labelInTz(first.scheduledAt.toISOString(), timezone)} cae sobre un horario ocupado en tu Google Calendar${range}. La cita sigue en pie: muévela o libera ese horario en Google.`,
        category: "cita",
        link: `/citas?pestana=sillas&fecha=${dayIsoInTz(first.scheduledAt, timezone)}&cita=${first.id}`,
      });
      return;
    }
    const names = rows.slice(0, 3).map((r) => `${who(r)} (${labelInTz(r.scheduledAt.toISOString(), timezone)})`);
    const more = rows.length > 3 ? ` y ${rows.length - 3} más` : "";
    await notify(organizationId, {
      title: `${rows.length} citas chocan con tu Google Calendar`,
      message: `Caen sobre horarios ocupados en tu Google Calendar: ${names.join(", ")}${more}. Siguen en pie: muévelas o libera esos horarios en Google.`,
      category: "cita",
      link: "/citas",
    });
  } catch (err) {
    console.warn(`[calendario] no pude avisar de los choques con Google: ${msg(err)}`);
  }
}

/**
 * Mejora 2 — Los eventos de todos los calendarios que se leen. Uno que falla tumba la lectura ENTERA (nunca se
 * aplica una a medias) y el error lleva su nombre; se conservan el estado HTTP y si es de autenticación, para
 * que el manejo de siempre (reconectar, permiso insuficiente, reintento) siga valiendo.
 */
export async function listAllCalendars(creds: GoogleCreds, window: Interval): Promise<GoogleBusyEvent[]> {
  const calendars = creds.busyCalendars?.length ? creds.busyCalendars : [{ id: creds.calendarId, summary: "Calendario principal" }];
  const out: GoogleBusyEvent[] = [];
  for (const cal of calendars) {
    try {
      out.push(...(await listEvents(creds, window, cal.id)));
    } catch (err) {
      if (calendars.length === 1 && !(err instanceof ConnectorError && (err.status === 404 || err.status === 410))) throw err;
      const status = err instanceof ConnectorError ? err.status : null;
      const why =
        status === 404 || status === 410
          ? "ya no está compartido contigo o se borró. Quítalo de la lista en Ajustes → Agenda o vuelve a compartirlo."
          : msg(err);
      throw new ConnectorError("google", `No se pudo leer «${cal.summary}»: ${why}`, {
        status,
        isAuthError: err instanceof ConnectorError ? err.isAuthError : false,
      });
    }
  }
  return out;
}

/** Todos los eventos de la ventana de UN calendario, página por página. Una página que falla tumba la lectura ENTERA. */
async function listEvents(creds: GoogleCreds, window: Interval, calendarId: string): Promise<GoogleBusyEvent[]> {
  const out: GoogleBusyEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      timeMin: new Date(window.startMs).toISOString(),
      timeMax: new Date(window.endMs).toISOString(),
      // Las repeticiones, ya expandidas en ocurrencias sueltas (cada una con su hora).
      singleEvents: "true",
      orderBy: "startTime",
      showDeleted: "false",
      maxResults: String(PAGE_SIZE),
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await googleRequest(creds, eventsPath(creds, `?${params.toString()}`, calendarId));
    const body = (res.body ?? {}) as { items?: GoogleBusyEvent[]; nextPageToken?: string };
    out.push(...(body.items ?? []));
    if (!body.nextPageToken) return out;
    pageToken = body.nextPageToken;
  }
  throw new Error(`Tu calendario tiene más de ${PAGE_SIZE * MAX_PAGES} eventos en los días reservables; no se leyó.`);
}

/** Los ids de evento que publicó Vocero (por si alguno perdió su marca o es un Meet de antes del Paso 3). */
export async function knownOwnEventIds(organizationId: string, window: Interval): Promise<Set<string>> {
  const rows = await getDb()
    .select({ eventId: schema.booking.calendarEventId, externalRef: schema.booking.externalRef, connector: schema.booking.connector })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.kind, "session"),
        gte(schema.booking.scheduledAt, new Date(window.startMs - 2 * 86_400_000)),
        lte(schema.booking.scheduledAt, new Date(window.endMs)),
        or(isNotNull(schema.booking.calendarEventId), and(eq(schema.booking.connector, "google"), isNotNull(schema.booking.externalRef)))
      )
    );
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.eventId) ids.add(r.eventId);
    if (r.connector === "google" && r.externalRef) ids.add(r.externalRef);
  }
  return ids;
}

async function saveState(
  organizationId: string,
  set: Partial<typeof schema.googleCredentials.$inferInsert>
): Promise<void> {
  await getDb()
    .update(schema.googleCredentials)
    .set(set)
    .where(scoped(schema.googleCredentials.organizationId, organizationId))
    .catch((err) => console.warn(`[calendario] no pude guardar el estado de la lectura: ${msg(err)}`));
}

/* ---------- barrido ---------- */

/**
 * Una barrida: los negocios con la lectura encendida, conectados, sin pausa por permiso y a los que ya les
 * toca. Secuencial. Nunca lanza.
 */
export async function sweepGoogleBusy(now = new Date()): Promise<{ tried: number; synced: number }> {
  let tried = 0;
  let synced = 0;
  try {
    const due = await getDb()
      .select({ organizationId: schema.googleCredentials.organizationId })
      .from(schema.googleCredentials)
      .innerJoin(
        schema.calendarSettings,
        eq(schema.calendarSettings.organizationId, schema.googleCredentials.organizationId)
      )
      .where(
        and(
          eq(schema.calendarSettings.googleBusy, true),
          eq(schema.googleCredentials.status, "connected"),
          or(isNull(schema.googleCredentials.busyStatus), ne(schema.googleCredentials.busyStatus, "needs_reconnect")),
          or(isNull(schema.googleCredentials.busyNextAt), lte(schema.googleCredentials.busyNextAt, now))
        )
      )
      .orderBy(sql`${schema.googleCredentials.busyNextAt} asc nulls first`)
      .limit(SWEEP_BATCH);
    for (const r of due) {
      tried += 1;
      const out = await syncGoogleBusy(r.organizationId, now);
      if (out.outcome === "synced") synced += 1;
    }
  } catch (err) {
    console.error("[calendario] la barrida de lo ocupado falló:", msg(err));
  }
  return { tried, synced };
}

/* ---------- estado para Ajustes ---------- */

export type BusyState = {
  status: "ok" | "error" | "needs_reconnect" | null;
  syncedAt: string | null;
  error: string | null;
  blocks: number;
  nextAt: string | null;
};

export async function getBusyState(organizationId: string): Promise<BusyState | null> {
  const [row] = await getDb()
    .select({
      status: schema.googleCredentials.busyStatus,
      syncedAt: schema.googleCredentials.busySyncedAt,
      error: schema.googleCredentials.busyError,
      blocks: schema.googleCredentials.busyBlocks,
      nextAt: schema.googleCredentials.busyNextAt,
    })
    .from(schema.googleCredentials)
    .where(scoped(schema.googleCredentials.organizationId, organizationId))
    .limit(1);
  if (!row) return null;
  return {
    status: row.status,
    syncedAt: row.syncedAt?.toISOString() ?? null,
    error: row.error,
    blocks: row.blocks,
    nextAt: row.nextAt?.toISOString() ?? null,
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
