import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { getEnv } from "@/lib/env";
import { dayIsoInTz } from "@/lib/time/slots";
import { getSettings } from "@/server/agenda/settings";
import { eventPath, eventsPath, googleRequest, moveEvent } from "@/server/agenda/connectors/google";
import {
  getGoogleCredentials,
  markGoogleError,
  markGoogleOk,
  noteGoogleError,
} from "@/server/agenda/connectors/google-credentials";
import { ConnectorError } from "@/server/agenda/connectors/types";
import {
  buildCalendarEvent,
  calendarEventIdFor,
  decideCalendarSync,
  nextSyncDelayMs,
} from "@/server/agenda/calendar-sync/event";
import { notify } from "@/server/notifications/service";

/**
 * Paso 3 — Publicar las citas en el Google Calendar del negocio, SEPARADO de la entrega de la reunión (Meet
 * solo con el conector `google`). Conector opcional (constitución II): apagado por defecto
 * (`calendar_settings.google_sync`), y su fallo jamás bloquea la agenda.
 *
 * POR ESTADO, no por evento: cada cambio de una cita (crear, mover, cancelar, cerrar, confirmar, cambiar de
 * profesional) solo llama a `requestCalendarSync`, que la marca `pending`. El intento lee la cita COMO ESTÁ
 * AHORA y deja el evento igual; así el orden de las llamadas y las carreras dan igual: gana el último estado.
 *
 * Idempotencia: el id del evento sale de la cita (`calendarEventIdFor`). Crear dos veces = 409 → actualizar.
 *
 * Concurrencia: un intento «arrienda» la fila poniendo `calendar_sync_next_at` en el futuro, y al terminar
 * solo escribe si ese valor sigue igual. Si la cita cambió mientras tanto, `requestCalendarSync` lo puso en
 * «ahora» y el resultado viejo no se guarda: el siguiente intento publica el estado nuevo.
 *
 * Reintentos: 1 min, 5 min, 30 min, 2 h, 6 h y se rinde (queda «error», con botón de reintentar). Un 401 /
 * `invalid_grant` marca la conexión como rota, avisa UNA vez y pausa la sincronización hasta reconectar.
 *
 * Mejora 2 — Cada cita anota en qué calendario vive su evento (`calendar_event_calendar_id`). Si el negocio
 * cambia el calendario de publicación, `relocateUpcomingEvents` pide la sincronización de las citas que
 * vienen y cada intento MUEVE el evento (`events.move`: mismo id, mismo Meet) antes de dejarlo al día. Con
 * la publicación apagada se mueven igual los eventos de Meet (si no, el conector los buscaría en el
 * calendario nuevo y no los encontraría).
 */

/** Cuánto «arrienda» un intento la fila (más que el peor caso de las llamadas a Google). */
const LEASE_MS = 2 * 60_000;
/** Filas por barrida: el barrido es secuencial y cada intento son una o dos llamadas a Google. */
const SWEEP_BATCH = 25;

type Db = ReturnType<typeof getDb>;

/* ---------- pedir ---------- */

/**
 * Marca la cita para publicarse y lanza un intento inmediato EN SEGUNDO PLANO (no se espera: la agenda no
 * depende de Google). Sin la sincronización encendida no hace nada. Nunca lanza.
 */
export async function requestCalendarSync(
  organizationId: string,
  bookingId: string,
  opts: { immediate?: boolean } = {}
): Promise<void> {
  try {
    const settings = await getSettings(organizationId);
    if (!settings.googleSync) return;
    const marked = await markPending(getDb(), organizationId, [bookingId]);
    if (marked > 0 && opts.immediate !== false) kick(organizationId, bookingId);
  } catch (err) {
    console.warn(`[calendario] no pude pedir la sincronización de ${bookingId}: ${msg(err)}`);
  }
}

/**
 * Al encender la sincronización o reconectar Google: las citas activas desde ayer se vuelven a publicar
 * (el barrido las recoge en tandas). Devuelve cuántas quedaron pendientes. Nunca lanza.
 */
export async function resyncUpcomingBookings(organizationId: string, now = new Date()): Promise<number> {
  try {
    const settings = await getSettings(organizationId);
    if (!settings.googleSync) return 0;
    const db = getDb();
    const rows = await db
      .select({ id: schema.booking.id })
      .from(schema.booking)
      .where(
        scoped(
          schema.booking.organizationId,
          organizationId,
          eq(schema.booking.kind, "session"),
          eq(schema.booking.isTest, false),
          inArray(schema.booking.status, ["agendada", "realizada", "no_show"]),
          gte(schema.booking.scheduledAt, new Date(now.getTime() - 86_400_000))
        )
      );
    return await markPending(db, organizationId, rows.map((r) => r.id), now);
  } catch (err) {
    console.warn(`[calendario] no pude preparar la resincronización: ${msg(err)}`);
    return 0;
  }
}

/**
 * Mejora 2 — Se cambió el calendario de publicación: las citas que vienen y tienen evento se mueven al nuevo
 * (lo hace cada intento de sincronización). `fromCalendarId` es el calendario anterior: las citas con evento
 * que no lo tenían anotado (un Meet creado con la publicación apagada) vivían ahí. Nunca lanza.
 */
export async function relocateUpcomingEvents(
  organizationId: string,
  fromCalendarId: string,
  now = new Date()
): Promise<number> {
  try {
    const db = getDb();
    const withEvent = or(
      isNotNull(schema.booking.calendarEventId),
      and(eq(schema.booking.connector, "google"), isNotNull(schema.booking.externalRef))
    );
    await db
      .update(schema.booking)
      .set({ calendarEventCalendarId: fromCalendarId })
      .where(scoped(schema.booking.organizationId, organizationId, isNull(schema.booking.calendarEventCalendarId), withEvent));
    const rows = await db
      .select({ id: schema.booking.id })
      .from(schema.booking)
      .where(
        scoped(
          schema.booking.organizationId,
          organizationId,
          eq(schema.booking.kind, "session"),
          eq(schema.booking.isTest, false),
          inArray(schema.booking.status, ["agendada", "realizada", "no_show"]),
          gte(schema.booking.scheduledAt, new Date(now.getTime() - 86_400_000)),
          withEvent
        )
      );
    const marked = await markPending(db, organizationId, rows.map((r) => r.id), now);
    if (marked > 0) {
      // Una barrida ya (en segundo plano); el temporizador sigue con el resto en tandas.
      const p = sweepCalendarSync(now).catch(() => {});
      inflight().add(p);
      void p.finally(() => inflight().delete(p));
    }
    return marked;
  } catch (err) {
    console.warn(`[calendario] no pude preparar el cambio de calendario: ${msg(err)}`);
    return 0;
  }
}

async function markPending(db: Db, organizationId: string, ids: string[], now = new Date()): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(schema.booking)
    .set({ calendarSyncStatus: "pending", calendarSyncAttempts: 0, calendarSyncNextAt: now, calendarSyncError: null })
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        inArray(schema.booking.id, ids),
        // Sandbox y bloqueos: nunca se marcan.
        eq(schema.booking.isTest, false),
        eq(schema.booking.kind, "session")
      )
    )
    .returning({ id: schema.booking.id });
  return rows.length;
}

/* ---------- intentos en curso (para esperar en pruebas y no duplicar el inmediato) ---------- */

const g = globalThis as unknown as { __voceroCalendarSyncInflight?: Set<Promise<unknown>> };
const inflight = (): Set<Promise<unknown>> => (g.__voceroCalendarSyncInflight ??= new Set());

function kick(organizationId: string, bookingId: string): void {
  const p = syncBookingNow(organizationId, bookingId).catch(() => {});
  inflight().add(p);
  void p.finally(() => inflight().delete(p));
}

/** Espera a que terminen los intentos inmediatos en curso (pruebas y apagado ordenado). */
export async function waitForCalendarSyncIdle(): Promise<void> {
  while (inflight().size > 0) await Promise.allSettled([...inflight()]);
}

/* ---------- un intento ---------- */

export type SyncOutcome =
  | "synced"
  | "deleted"
  | "moved"
  | "skipped"
  | "busy"
  | "retry"
  | "failed"
  | "auth_error"
  | "stale";

/**
 * Un intento de dejar el evento de la cita igual que la cita. Solo corre si la fila está pendiente (o en
 * error) y le toca (`calendar_sync_next_at` vencido); si otro intento la tiene arrendada, devuelve `busy`.
 */
export async function syncBookingNow(
  organizationId: string,
  bookingId: string,
  now = new Date()
): Promise<SyncOutcome> {
  const db = getDb();
  const lease = new Date(now.getTime() + LEASE_MS);
  const claimed = await db
    .update(schema.booking)
    .set({ calendarSyncNextAt: lease })
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.id, bookingId),
        inArray(schema.booking.calendarSyncStatus, ["pending", "error"]),
        isNotNull(schema.booking.calendarSyncNextAt),
        lte(schema.booking.calendarSyncNextAt, now)
      )
    )
    .returning({ attempts: schema.booking.calendarSyncAttempts });
  if (claimed.length === 0) return "busy";
  const attempts = claimed[0]!.attempts;

  /** Escribe el resultado solo si nadie volvió a pedir la sincronización mientras tanto. */
  const finish = async (set: Partial<typeof schema.booking.$inferInsert>): Promise<boolean> => {
    const rows = await db
      .update(schema.booking)
      .set(set)
      .where(
        scoped(
          schema.booking.organizationId,
          organizationId,
          eq(schema.booking.id, bookingId),
          eq(schema.booking.calendarSyncNextAt, lease)
        )
      )
      .returning({ id: schema.booking.id });
    return rows.length > 0;
  };

  try {
    const [row] = await db
      .select({
        booking: schema.booking,
        contactName: schema.contact.name,
        contactPhone: schema.contact.phone,
        serviceName: schema.service.name,
        comboName: schema.combo.name,
        staffName: schema.staff.name,
      })
      .from(schema.booking)
      .leftJoin(schema.contact, eq(schema.booking.contactId, schema.contact.id))
      .leftJoin(schema.service, eq(schema.booking.serviceId, schema.service.id))
      .leftJoin(schema.combo, eq(schema.booking.comboId, schema.combo.id))
      .leftJoin(schema.staff, eq(schema.booking.staffId, schema.staff.id))
      .where(scoped(schema.booking.organizationId, organizationId, eq(schema.booking.id, bookingId)))
      .limit(1);
    if (!row) return "skipped";
    const b = row.booking;

    const settings = await getSettings(organizationId);
    const creds = await getGoogleCredentials(organizationId);
    const decision = decideCalendarSync({
      enabled: settings.googleSync,
      connected: !!creds && creds.status === "connected",
      kind: b.kind,
      isTest: b.isTest,
      status: b.status,
    });

    // El evento de la cita: el que ya tiene, el de Meet (citas viejas con id de Google) o el determinista.
    const hasEvent = !!b.calendarEventId || (b.connector === "google" && !!b.externalRef);
    const eventId =
      b.calendarEventId ??
      (b.connector === "google" && b.externalRef ? b.externalRef : calendarEventIdFor(b.id));
    // Mejora 2: dónde vive hoy el evento y dónde debería vivir.
    const target = creds?.calendarId ?? "primary";
    const livesIn = b.calendarEventCalendarId ?? target;
    const mustMove = hasEvent && livesIn !== target;

    if (decision.action === "skip") {
      // Publicación apagada pero el evento (un Meet) quedó en el calendario anterior: solo se mueve.
      if (decision.reason === "disabled" && mustMove && creds?.status === "connected" && b.status !== "cancelada") {
        await moveEvent(creds, eventId, livesIn, target);
        const wrote = await finish({
          calendarSyncStatus: null,
          calendarSyncNextAt: null,
          calendarSyncError: null,
          calendarEventCalendarId: target,
        });
        await markGoogleOk(organizationId).catch(() => {});
        return wrote ? "moved" : "stale";
      }
      if (decision.reason === "not_connected") {
        // Esperando a que se (re)conecte Google: al hacerlo, `resyncUpcomingBookings` la vuelve a pedir.
        await finish({
          calendarSyncStatus: "error",
          calendarSyncNextAt: null,
          calendarSyncError: "Google Calendar no está conectado.",
        });
        return "skipped";
      }
      await finish({ calendarSyncStatus: null, calendarSyncNextAt: null, calendarSyncError: null });
      return "skipped";
    }

    const c = creds!;

    if (decision.action === "delete") {
      // Se borra de donde vive (aunque se haya cambiado el calendario de publicación).
      await googleRequest(c, eventPath(c, eventId, "?sendUpdates=none", livesIn), {
        method: "DELETE",
        accept: [404, 410],
      });
      const wrote = await finish({
        calendarSyncStatus: "synced",
        calendarSyncAttempts: 0,
        calendarSyncNextAt: null,
        calendarSyncedAt: new Date(),
        calendarSyncError: null,
        calendarEventId: eventId,
        calendarEventCalendarId: livesIn,
      });
      await markGoogleOk(organizationId).catch(() => {});
      return wrote ? "deleted" : "stale";
    }

    const startUtc = b.scheduledAt.toISOString();
    const body = buildCalendarEvent({
      bookingId: b.id,
      organizationId,
      status: b.status,
      confirmed: !!b.confirmedAt,
      startUtc,
      durationMinutes: b.durationMinutes,
      timezone: settings.timezone,
      clientName: row.contactName,
      clientPhone: row.contactPhone,
      includePhone: settings.googleSyncPhone,
      itemName: row.comboName ?? row.serviceName,
      staffName: row.staffName,
      notes: b.notes,
      meetingLink: b.meetingLink,
      source: b.source,
      crmLink: `${getEnv().APP_BASE_URL.replace(/\/+$/, "")}/citas?pestana=sillas&fecha=${dayIsoInTz(b.scheduledAt, settings.timezone)}&cita=${b.id}`,
    });
    // Mejora 2: primero se lleva el evento al calendario de publicación (mismo id, mismo Meet). Si ya no
    // estaba en el anterior, se crea en el nuevo.
    let known = hasEvent;
    if (mustMove) known = await moveEvent(c, eventId, livesIn, target);
    await upsertEvent(c, eventId, body, { known });

    const wrote = await finish({
      calendarSyncStatus: "synced",
      calendarSyncAttempts: 0,
      calendarSyncNextAt: null,
      calendarSyncedAt: new Date(),
      calendarSyncError: null,
      calendarEventId: eventId,
      calendarEventCalendarId: target,
    });
    await markGoogleOk(organizationId).catch(() => {});
    return wrote ? "synced" : "stale";
  } catch (err) {
    const text = msg(err);
    if (err instanceof ConnectorError && err.isAuthError) {
      // Token revocado o vencido: reintentar no sirve. Se pausa hasta reconectar y se avisa una vez.
      const justBroke = await markGoogleError(organizationId, text).catch(() => false);
      if (justBroke) {
        await notify(organizationId, {
          title: "Google Calendar se desconectó",
          message: "Google rechazó la conexión. Las citas se siguen agendando; reconecta en Ajustes → Agenda para volver a publicarlas.",
          category: "sistema",
          link: "/ajustes/calendario",
        });
      }
      await finish({
        calendarSyncStatus: "error",
        calendarSyncNextAt: null,
        calendarSyncError: "Google rechazó la conexión: reconecta en Ajustes → Agenda.",
      });
      return "auth_error";
    }
    const failed = attempts + 1;
    const delay = nextSyncDelayMs(failed);
    await noteGoogleError(organizationId, text).catch(() => {});
    await finish({
      calendarSyncStatus: "error",
      calendarSyncAttempts: failed,
      calendarSyncNextAt: delay === null ? null : new Date(Date.now() + delay),
      calendarSyncError: text.slice(0, 500),
    });
    console.warn(`[calendario] la cita ${bookingId} no se publicó (intento ${failed}): ${text}`);
    return delay === null ? "failed" : "retry";
  }
}

/**
 * Crea o actualiza el evento con su id propio. Si la cita ya tenía evento se intenta actualizar primero;
 * si no existe (404) se crea; si al crear ya existía (409: un reintento, o el evento de Meet), se actualiza.
 */
async function upsertEvent(
  creds: NonNullable<Awaited<ReturnType<typeof getGoogleCredentials>>>,
  eventId: string,
  body: ReturnType<typeof buildCalendarEvent>,
  opts: { known: boolean }
): Promise<void> {
  const patch = () =>
    googleRequest(creds, eventPath(creds, eventId, "?sendUpdates=none"), {
      method: "PATCH",
      accept: [404],
      body: JSON.stringify(body),
    });
  if (opts.known) {
    const res = await patch();
    if (res.status !== 404) return;
  }
  const created = await googleRequest(creds, `${eventsPath(creds)}?sendUpdates=none`, {
    method: "POST",
    accept: [409],
    body: JSON.stringify({ id: eventId, ...body }),
  });
  if (created.status === 409) {
    const res = await patch();
    if (res.status === 404) throw new ConnectorError("google", "Google dice que el evento existe y a la vez que no existe");
  }
}

/* ---------- barrido ---------- */

/** Una barrida: los pendientes y los reintentos que ya tocan, de todos los negocios. Nunca lanza. */
export async function sweepCalendarSync(now = new Date()): Promise<{ tried: number; synced: number }> {
  let tried = 0;
  let synced = 0;
  try {
    const due = await getDb()
      .select({ id: schema.booking.id, organizationId: schema.booking.organizationId })
      .from(schema.booking)
      .where(
        and(
          inArray(schema.booking.calendarSyncStatus, ["pending", "error"]),
          isNotNull(schema.booking.calendarSyncNextAt),
          lte(schema.booking.calendarSyncNextAt, now)
        )
      )
      .orderBy(asc(schema.booking.calendarSyncNextAt))
      .limit(SWEEP_BATCH);
    for (const r of due) {
      tried += 1;
      const out = await syncBookingNow(r.organizationId, r.id, now).catch(() => "failed" as const);
      if (out === "synced" || out === "deleted") synced += 1;
    }
  } catch (err) {
    console.error("[calendario] la barrida falló:", msg(err));
  }
  return { tried, synced };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
