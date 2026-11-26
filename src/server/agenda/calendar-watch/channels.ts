import { eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  channelToken,
  isPermanentWatchError,
  newChannelId,
  WATCH_TTL_SECONDS,
  watchRetryDelayMs,
  type WatchChannelRow,
  type WatchTarget,
} from "@/lib/google-watch";
import { stopChannel, watchEvents } from "@/server/agenda/connectors/google";
import type { GoogleCreds } from "@/server/agenda/connectors/google-credentials";
import { ConnectorError } from "@/server/agenda/connectors/types";
import { watchSecret } from "@/server/agenda/calendar-watch/flag";

/**
 * Mejora 4 — Las filas `google_watch_channel` y las dos llamadas a Google (crear y detener un canal).
 *
 * No sabe de qué fuente salen las credenciales: quien llama se las pasa. Así lo pueden usar la desconexión del
 * negocio, la del profesional y su borrado (que ya tienen las credenciales en la mano y deben detener los
 * canales ANTES de revocar el permiso: `channels.stop` necesita el token vigente) sin ciclos de importación.
 */

type Row = typeof schema.googleWatchChannel.$inferSelect;

/** Los canales de un negocio; con `staffId` (string o null) solo los de esa fuente. */
export async function listChannels(organizationId: string, staffId?: string | null): Promise<Row[]> {
  return getDb()
    .select()
    .from(schema.googleWatchChannel)
    .where(
      scoped(
        schema.googleWatchChannel.organizationId,
        organizationId,
        staffId === undefined
          ? undefined
          : staffId === null
            ? isNull(schema.googleWatchChannel.staffId)
            : eq(schema.googleWatchChannel.staffId, staffId)
      )
    );
}

/**
 * El canal de un aviso, por su `channel_id` (único en toda la instancia). Es la ÚNICA lectura sin
 * organización: el aviso de Google no la trae; sale de esta fila y todo lo demás va acotado a ella.
 */
export async function findChannel(channelId: string): Promise<Row | null> {
  const [row] = await getDb()
    .select()
    .from(schema.googleWatchChannel)
    .where(eq(schema.googleWatchChannel.channelId, channelId))
    .limit(1);
  return row ?? null;
}

/** Anota el aviso recibido (diagnóstico). Nunca lanza. */
export async function markNotified(row: Row, messageNumber: string | null): Promise<void> {
  await getDb()
    .update(schema.googleWatchChannel)
    .set({ lastNotifiedAt: new Date(), lastMessageNumber: messageNumber ?? row.lastMessageNumber })
    .where(scoped(schema.googleWatchChannel.organizationId, row.organizationId, eq(schema.googleWatchChannel.id, row.id)))
    .catch((err) => console.warn(`[calendario] no pude anotar el aviso de Google: ${msg(err)}`));
}

export type CreateOutcome = { ok: true } | { ok: false; error: string; permanent: boolean };

/**
 * Pide un canal a Google para UN calendario. La fila se escribe ANTES (`pending`): Google manda el primer aviso
 * (`sync`) apenas crea el canal y puede llegar antes que su respuesta. `retry`: la fila fallida a reusar (así
 * cada calendario guarda un solo historial de fallos). Nunca lanza.
 */
export async function createChannel(
  creds: GoogleCreds,
  target: WatchTarget,
  retry: WatchChannelRow | null,
  address: string,
  now = new Date()
): Promise<CreateOutcome> {
  const db = getDb();
  const channelId = newChannelId();
  let rowId: string;
  try {
    if (retry) {
      rowId = retry.id;
      await db
        .update(schema.googleWatchChannel)
        .set({ channelId, status: "pending", resourceId: null, expiresAt: null, createdAt: now, updatedAt: now })
        .where(scoped(schema.googleWatchChannel.organizationId, target.organizationId, eq(schema.googleWatchChannel.id, retry.id)));
    } else {
      rowId = newId("googleWatchChannel");
      await db.insert(schema.googleWatchChannel).values({
        id: rowId,
        organizationId: target.organizationId,
        staffId: target.staffId,
        calendarId: target.calendarId,
        channelId,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
    }
  } catch (err) {
    // Por ejemplo: el profesional se borró mientras tanto (llave foránea). Nada que pedir.
    return { ok: false, error: msg(err), permanent: false };
  }

  const where = scoped(schema.googleWatchChannel.organizationId, target.organizationId, eq(schema.googleWatchChannel.id, rowId));
  try {
    const out = await watchEvents(creds, target.calendarId, {
      id: channelId,
      token: channelToken(watchSecret(), channelId),
      address,
      ttlSeconds: WATCH_TTL_SECONDS,
    });
    await db
      .update(schema.googleWatchChannel)
      .set({
        status: "active",
        resourceId: out.resourceId,
        expiresAt: out.expiresAt,
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(where);
    return { ok: true };
  } catch (err) {
    const text = msg(err).slice(0, 500);
    const status = err instanceof ConnectorError ? err.status : null;
    const permanent = isPermanentWatchError(status, text);
    const attempts = (retry?.attempts ?? 0) + 1;
    await db
      .update(schema.googleWatchChannel)
      .set({
        status: "failed",
        attempts,
        lastError: text,
        nextAttemptAt: new Date(Date.now() + watchRetryDelayMs(attempts, permanent)),
        updatedAt: new Date(),
      })
      .where(where)
      .catch(() => {});
    console.warn(`[calendario] Google no aceptó el canal de avisos (intento ${attempts}): ${text}`);
    return { ok: false, error: text, permanent };
  }
}

/**
 * Detiene en Google los canales dados (los que llegaron a existir y si hay credenciales) y borra sus filas.
 * Si Google no responde, la fila se borra igual: el canal muere solo al vencer (≤ 7 días) y sus avisos, sin
 * fila, se ignoran. Devuelve cuántas llamadas a Google hizo. Nunca lanza.
 */
export async function stopChannelRows(creds: GoogleCreds | null, rows: WatchChannelRow[]): Promise<number> {
  let calls = 0;
  for (const row of rows) {
    if (creds && row.resourceId && row.status !== "failed") {
      calls += 1;
      await stopChannel(creds, row.channelId, row.resourceId).catch((err) =>
        console.warn(`[calendario] no pude detener un canal de avisos de Google: ${msg(err)}`)
      );
    }
  }
  const byOrg = new Map<string, string[]>();
  for (const r of rows) byOrg.set(r.organizationId, [...(byOrg.get(r.organizationId) ?? []), r.id]);
  for (const [org, ids] of byOrg) {
    await getDb()
      .delete(schema.googleWatchChannel)
      .where(scoped(schema.googleWatchChannel.organizationId, org, inArray(schema.googleWatchChannel.id, ids)))
      .catch((err) => console.warn(`[calendario] no pude borrar canales de avisos: ${msg(err)}`));
  }
  return calls;
}

/**
 * Detiene TODOS los canales de una fuente (el negocio: `staffId` null; o un profesional). Va ANTES de revocar el
 * permiso. Nunca lanza.
 */
export async function stopWatchesFor(
  organizationId: string,
  staffId: string | null,
  creds: GoogleCreds | null
): Promise<void> {
  try {
    const rows = await listChannels(organizationId, staffId);
    if (rows.length > 0) await stopChannelRows(creds, rows);
  } catch (err) {
    console.warn(`[calendario] no pude detener los avisos de Google: ${msg(err)}`);
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
