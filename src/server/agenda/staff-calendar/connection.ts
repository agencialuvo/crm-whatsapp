import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  clearGoogleTokenCache,
  instanceOAuthApp,
  type GoogleCreds,
} from "@/server/agenda/connectors/google-credentials";
import { revokeToken } from "@/server/agenda/google-oauth";
import { lockAgenda } from "@/server/agenda/service";
import { reconcileConflicts } from "@/server/agenda/calendar-busy/sync";
import { openInvites, revokeInvites } from "@/server/agenda/staff-calendar/invite";
import { stopWatchesFor } from "@/server/agenda/calendar-watch/channels";
import { publish } from "@/server/events/bus";

/**
 * Mejora 3 — La conexión de Google Calendar de UN profesional (solo lectura). El refresh token va cifrado
 * (AES-256-GCM); el client id/secret son los de la app de la instancia y no se copian a la base.
 *
 * Desconectar (a mano, al desactivar o al borrar al profesional) revoca el permiso en Google (si se puede),
 * borra la conexión y SUS bloqueos de Google, anula sus enlaces pendientes y recalcula los choques. Lo del
 * negocio y lo de los demás profesionales no se toca.
 */

type Row = typeof schema.staffGoogleConnection.$inferSelect;

async function readRow(organizationId: string, staffId: string): Promise<Row | null> {
  const [row] = await getDb()
    .select()
    .from(schema.staffGoogleConnection)
    .where(
      scoped(
        schema.staffGoogleConnection.organizationId,
        organizationId,
        eq(schema.staffGoogleConnection.staffId, staffId)
      )
    )
    .limit(1);
  return row ?? null;
}

/** Las credenciales para leer su calendario, o `null` si no está conectado (o la instancia no tiene app). */
export async function getStaffCreds(
  organizationId: string,
  staffId: string
): Promise<(GoogleCreds & { accountEmail: string | null }) | null> {
  const row = await readRow(organizationId, staffId);
  const app = instanceOAuthApp();
  if (!row || !app) return null;
  return {
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    refreshToken: decryptSecret({ cipher: row.refreshTokenCipher, iv: row.refreshTokenIv, tag: row.refreshTokenTag }),
    calendarId: "primary",
    status: row.status,
    busyCalendars: [{ id: "primary", summary: "su calendario" }],
    source: "oauth",
    grantedScopes: row.grantedScopes,
    accountEmail: row.accountEmail,
  };
}

/** Guarda (o reemplaza) la conexión: la lectura empieza de cero y vence ya. */
export async function saveStaffConnection(input: {
  organizationId: string;
  staffId: string;
  refreshToken: string;
  accountEmail: string | null;
  grantedScopes: string | null;
}): Promise<void> {
  const secret = encryptSecret(input.refreshToken);
  const now = new Date();
  const values = {
    refreshTokenCipher: secret.cipher,
    refreshTokenIv: secret.iv,
    refreshTokenTag: secret.tag,
    accountEmail: input.accountEmail,
    grantedScopes: input.grantedScopes,
    status: "connected" as const,
    connectedAt: now,
    lastError: null,
    lastOkAt: now,
    busyStatus: null,
    busyError: null,
    busyAttempts: 0,
    busyNextAt: null,
    busyBlocks: 0,
  };
  await getDb()
    .insert(schema.staffGoogleConnection)
    .values({ id: newId("staffGoogleConnection"), organizationId: input.organizationId, staffId: input.staffId, ...values })
    .onConflictDoUpdate({
      target: [schema.staffGoogleConnection.organizationId, schema.staffGoogleConnection.staffId],
      set: { ...values, updatedAt: now },
    });
  clearGoogleTokenCache();
}

/** Guarda el estado de la lectura / de la conexión (sin lanzar). */
export async function saveStaffState(
  organizationId: string,
  staffId: string,
  set: Partial<typeof schema.staffGoogleConnection.$inferInsert>
): Promise<void> {
  await getDb()
    .update(schema.staffGoogleConnection)
    .set(set)
    .where(
      scoped(
        schema.staffGoogleConnection.organizationId,
        organizationId,
        eq(schema.staffGoogleConnection.staffId, staffId)
      )
    )
    .catch((err) => console.warn(`[calendario] no pude guardar el estado del calendario del profesional: ${err}`));
}

/**
 * Marca la conexión como rota. Devuelve `true` solo si ACABA de romperse (estaba `connected`): el aviso al
 * dueño sale una vez.
 */
export async function markStaffError(organizationId: string, staffId: string, message: string): Promise<boolean> {
  const rows = await getDb()
    .update(schema.staffGoogleConnection)
    .set({ status: "error", lastError: message.slice(0, 500), updatedAt: new Date() })
    .where(
      scoped(
        schema.staffGoogleConnection.organizationId,
        organizationId,
        eq(schema.staffGoogleConnection.staffId, staffId),
        eq(schema.staffGoogleConnection.status, "connected")
      )
    )
    .returning({ id: schema.staffGoogleConnection.id });
  return rows.length > 0;
}

/**
 * Desconecta el calendario de un profesional. `revoke`: pedir a Google que anule el permiso (best-effort).
 * Nunca lanza por Google; sí por la base (quien llama decide).
 */
export async function disconnectStaffCalendar(
  organizationId: string,
  staffId: string,
  opts: { revoke?: boolean } = {}
): Promise<{ hadConnection: boolean; revoked: boolean; removedBlocks: number }> {
  const creds = await getStaffCreds(organizationId, staffId).catch(() => null);
  const row = await readRow(organizationId, staffId);
  // Mejora 4: sus avisos al instante se detienen ANTES de revocar (`channels.stop` necesita el token vigente).
  await stopWatchesFor(organizationId, staffId, creds);
  const revoked = creds && opts.revoke !== false ? await revokeToken(creds.refreshToken) : false;
  const removed = await getDb().transaction(async (tx) => {
    await lockAgenda(tx, organizationId);
    const deleted = await deleteStaffBusyBlocks(tx, organizationId, staffId);
    await tx
      .delete(schema.staffGoogleConnection)
      .where(
        scoped(
          schema.staffGoogleConnection.organizationId,
          organizationId,
          eq(schema.staffGoogleConnection.staffId, staffId)
        )
      );
    await reconcileConflicts(tx, organizationId, new Date());
    return deleted;
  });
  await revokeInvites(organizationId, staffId);
  if (removed[0]) publish(organizationId, { type: "booking.updated", data: { bookingId: removed[0] } });
  return { hadConnection: !!row, revoked, removedBlocks: removed.length };
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Borra TODOS los bloqueos de Google de un profesional. Hay que hacerlo ANTES de borrarlo: `booking.staff_id`
 * pasa a null al borrar al profesional y esos bloqueos quedarían bloqueando a todo el negocio.
 */
export async function deleteStaffBusyBlocks(tx: Tx, organizationId: string, staffId: string): Promise<string[]> {
  const rows = await tx
    .delete(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.busySource, "google"),
        eq(schema.booking.staffId, staffId)
      )
    )
    .returning({ id: schema.booking.id });
  return rows.map((r) => r.id);
}

/* ---------- lo que ve la pantalla Equipo ---------- */

export type StaffCalendarStatus = {
  staffId: string;
  staffName: string;
  phone: string | null;
  connection: null | {
    status: "connected" | "error";
    accountEmail: string | null;
    connectedAt: string | null;
    lastError: string | null;
    busy: {
      status: "ok" | "error" | "needs_reconnect" | null;
      syncedAt: string | null;
      error: string | null;
      blocks: number;
    };
  };
  /** Enlace pendiente (sin usar y vigente). */
  invite: null | { expiresAt: string };
};

export async function listStaffCalendarStatus(organizationId: string, now = new Date()): Promise<StaffCalendarStatus[]> {
  const rows = await getDb()
    .select({ staff: schema.staff, conn: schema.staffGoogleConnection })
    .from(schema.staff)
    .leftJoin(
      schema.staffGoogleConnection,
      and(
        eq(schema.staffGoogleConnection.staffId, schema.staff.id),
        eq(schema.staffGoogleConnection.organizationId, schema.staff.organizationId)
      )
    )
    .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.active, true)))
    .orderBy(asc(schema.staff.createdAt), asc(schema.staff.name));
  const invites = await openInvites(organizationId, now);
  return rows.map(({ staff, conn }) => ({
    staffId: staff.id,
    staffName: staff.name,
    phone: staff.phone,
    connection: conn
      ? {
          status: conn.status,
          accountEmail: conn.accountEmail,
          connectedAt: conn.connectedAt?.toISOString() ?? null,
          lastError: conn.lastError,
          busy: {
            status: conn.busyStatus,
            syncedAt: conn.busySyncedAt?.toISOString() ?? null,
            error: conn.busyError,
            blocks: conn.busyBlocks,
          },
        }
      : null,
    invite: invites.has(staff.id) ? { expiresAt: invites.get(staff.id)!.toISOString() } : null,
  }));
}
