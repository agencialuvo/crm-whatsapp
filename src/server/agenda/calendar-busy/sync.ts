import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { getSettings } from "@/server/agenda/settings";
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
  diffBusyBlocks,
  durationMinutesOf,
  isScopeError,
  type GoogleBusyEvent,
  type Interval,
} from "@/server/agenda/calendar-busy/intervals";
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
 */

/** Páginas de 250 eventos: 20 son 5 000 eventos en la ventana (60 días como mucho). Más es un error. */
const PAGE_SIZE = 250;
const MAX_PAGES = 20;
/** Negocios por barrida: cada lectura son una o pocas llamadas a Google. */
const SWEEP_BATCH = 10;

export const GOOGLE_BUSY_NOTE = "Ocupado en Google Calendar";

export type BusyOutcome =
  | { outcome: "synced"; blocks: number; inserted: number; deleted: number }
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

/** Espera a que terminen las lecturas en curso (pruebas y apagado ordenado). */
export async function waitForBusySyncIdle(): Promise<void> {
  while (inflight().size > 0) await Promise.allSettled([...inflight().values()]);
}

/**
 * Pide una lectura YA (al encender la opción, al reconectar, al cambiar los días reservables): la deja
 * vencida para el barrido y la lanza en segundo plano. Nunca lanza.
 */
export async function requestBusySync(organizationId: string): Promise<void> {
  try {
    const settings = await getSettings(organizationId);
    if (!settings.googleBusy) return;
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
    const db = getDb();
    const removed = await db.transaction(async (tx) => {
      await lockAgenda(tx, organizationId);
      return tx
        .delete(schema.booking)
        .where(scoped(schema.booking.organizationId, organizationId, eq(schema.booking.busySource, "google")))
        .returning({ id: schema.booking.id });
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
    const events = await listEvents(creds, window);
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
            // Lo de días pasados queda como estaba (historia); se administra de hoy en adelante.
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
              inArray(schema.booking.id, diff.toDelete)
            )
          );
      }
      const insertedIds: string[] = [];
      if (diff.toInsert.length > 0) {
        const values = diff.toInsert.map((iv: Interval) => {
          const id = newId("booking");
          insertedIds.push(id);
          return {
            id,
            organizationId,
            kind: "block" as const,
            source: "manual" as const,
            status: "agendada" as const,
            busySource: "google" as const,
            scheduledAt: new Date(iv.startMs),
            durationMinutes: durationMinutesOf(iv),
            notes: GOOGLE_BUSY_NOTE,
          };
        });
        await tx.insert(schema.booking).values(values);
      }
      return { inserted: insertedIds, deleted: diff.toDelete };
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
    const changed = applied.inserted[0] ?? applied.deleted[0];
    if (changed) publish(organizationId, { type: "booking.updated", data: { bookingId: changed } });
    return { outcome: "synced", blocks: blocks.length, inserted: applied.inserted.length, deleted: applied.deleted.length };
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

/** Todos los eventos de la ventana, página por página. Una página que falla tumba la lectura ENTERA. */
async function listEvents(creds: GoogleCreds, window: Interval): Promise<GoogleBusyEvent[]> {
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
    const res = await googleRequest(creds, eventsPath(creds, `?${params.toString()}`));
    const body = (res.body ?? {}) as { items?: GoogleBusyEvent[]; nextPageToken?: string };
    out.push(...(body.items ?? []));
    if (!body.nextPageToken) return out;
    pageToken = body.nextPageToken;
  }
  throw new Error(`Tu calendario tiene más de ${PAGE_SIZE * MAX_PAGES} eventos en los días reservables; no se leyó.`);
}

/** Los ids de evento que publicó Vocero (por si alguno perdió su marca o es un Meet de antes del Paso 3). */
async function knownOwnEventIds(organizationId: string, window: Interval): Promise<Set<string>> {
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
