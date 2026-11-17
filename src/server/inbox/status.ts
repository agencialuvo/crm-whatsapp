import { and, eq, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { describeSendError } from "@/lib/meta/send-errors";
import { publish } from "@/server/events/bus";
import type { WebhookStatus } from "@/server/inbox/webhook";

/** Orden monotónico de estados: nunca degradar (un delivered tardío no pisa read). */
const STATUS_RANK: Record<string, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

type MessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";
type ParkedStatus = Exclude<MessageStatus, "pending">;

export function isUpgrade(current: string, next: string): boolean {
  if (next === "failed") return current !== "failed";
  const c = STATUS_RANK[current];
  const n = STATUS_RANK[next];
  if (c === undefined || n === undefined) return false;
  return n > c;
}

/** El rango de una columna de estado, calculado en SQL con la MISMA tabla que `isUpgrade`. */
function rankSql(column: SQL | AnyColumn, withFailed = false): SQL {
  const table: Record<string, number> = withFailed ? { ...STATUS_RANK, failed: 4 } : STATUS_RANK;
  const cases = Object.entries(table).map(([name, rank]) => sql`when ${name} then ${rank}`);
  return sql`(case ${column} ${sql.join(cases, sql` `)} else -1 end)`;
}

/**
 * 041 — Aplica un estado a la fila con ese `wa_message_id`, en UNA sola sentencia.
 *
 * La regla es la de `isUpgrade` (monótona; `failed` desde cualquier estado, una vez), pero
 * comparada en la base: dos acuses simultáneos (`delivered` y `read`) ya no pueden pisarse
 * porque cada uno lee y escribe el estado en el mismo instante.
 */
async function aplicarEstado(
  organizationId: string,
  waMessageId: string,
  next: MessageStatus,
  error: string | null
): Promise<{ id: string; conversationId: string } | null> {
  const m = schema.message;
  const rows = await getDb()
    .update(m)
    .set({ status: next, error: next === "failed" ? error : null })
    .where(
      and(
        eq(m.organizationId, organizationId),
        eq(m.waMessageId, waMessageId),
        ne(m.status, "failed"),
        next === "failed"
          ? undefined
          : sql`${STATUS_RANK[next] ?? -1}::int > ${rankSql(m.status)}`
      )
    )
    .returning({ id: m.id, conversationId: m.conversationId });
  return rows[0] ?? null;
}

async function existeMensaje(organizationId: string, waMessageId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.organizationId, organizationId),
        eq(schema.message.waMessageId, waMessageId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

function publicarEstado(
  organizationId: string,
  fila: { id: string; conversationId: string },
  status: string,
  error: string | null
): void {
  publish(organizationId, {
    type: "message.status",
    data: {
      conversationId: fila.conversationId,
      messageId: fila.id,
      status,
      // Sin esto el operador ve el triángulo de fallo pero nunca el motivo.
      error,
    },
  });
}

/**
 * 041 — Estaciona un estado que llegó antes que su mensaje. Uno por mensaje: se queda el de
 * mayor rango (`failed` gana a todo y nunca se reemplaza).
 */
async function estacionar(
  organizationId: string,
  waMessageId: string,
  status: ParkedStatus,
  error: string | null
): Promise<void> {
  const o = schema.messageStatusOrphan;
  await getDb()
    .insert(o)
    .values({
      id: newId("messageStatusOrphan"),
      organizationId,
      waMessageId,
      status,
      error,
    })
    .onConflictDoUpdate({
      target: o.waMessageId,
      set: { status, error, receivedAt: new Date() },
      setWhere: sql`${rankSql(sql`excluded.status`, true)} > ${rankSql(o.status, true)}`,
    });
}

/**
 * 041 — Aplica y retira el estado que esperaba a este mensaje, si lo hay. Lo llama quien
 * acaba de guardar el `wa_message_id` (el emisor, o la ingesta de un eco). Devuelve si
 * había algo.
 */
export async function reclaimOrphanStatus(
  organizationId: string,
  waMessageId: string
): Promise<boolean> {
  const o = schema.messageStatusOrphan;
  const [orphan] = await getDb()
    .delete(o)
    .where(and(eq(o.organizationId, organizationId), eq(o.waMessageId, waMessageId)))
    .returning();
  if (!orphan) return false;
  const fila = await aplicarEstado(organizationId, waMessageId, orphan.status, orphan.error);
  if (fila) publicarEstado(organizationId, fila, orphan.status, orphan.error);
  return true;
}

/** Puntos de intercalación de las pruebas de concurrencia; en producción no se usan. */
export type StatusHooks = { afterPark?: () => Promise<void> };

/**
 * Aplica un estado de entrega del webhook.
 *
 * 041 — Si el mensaje todavía no está (el CRM no guardó aún su `wa_message_id`), el estado
 * se ESTACIONA y se vuelve a buscar la fila. Cada lado escribe y luego lee —el webhook
 * estaciona y busca; el emisor guarda el id y busca lo estacionado—, así que al menos uno
 * ve al otro. Si los dos lo ven se aplica dos veces, y es inocuo: la aplicación es monótona.
 */
export async function applyStatusUpdate(
  organizationId: string,
  status: WebhookStatus,
  hooks: StatusHooks = {}
): Promise<void> {
  const next = status.status;
  if (!(next in STATUS_RANK) && next !== "failed") return; // estado desconocido
  if (next === "pending") return; // nunca es una mejora

  const failure = status.errors?.[0];
  const error =
    next === "failed"
      ? describeSendError(failure?.code, failure?.message ?? failure?.title)
      : null;

  const fila = await aplicarEstado(organizationId, status.id, next as MessageStatus, error);
  if (fila) {
    publicarEstado(organizationId, fila, next, error);
    return;
  }
  // Sin cambio: o el mensaje ya estaba igual o más avanzado, o todavía no existe. Y ojo, hay
  // un tercer caso: el emisor guardó el id ENTRE las dos consultas. Por eso, si ahora existe,
  // se aplica de nuevo en vez de darlo por aplicado: esta segunda pasada es la que decide.
  if (await existeMensaje(organizationId, status.id)) {
    const otra = await aplicarEstado(organizationId, status.id, next as MessageStatus, error);
    if (otra) publicarEstado(organizationId, otra, next, error);
    return;
  }

  await estacionar(organizationId, status.id, next as ParkedStatus, error);
  await hooks.afterPark?.();
  if (await existeMensaje(organizationId, status.id)) {
    // El emisor ganó la carrera mientras estacionábamos: se aplica lo MÁS alto que haya
    // esperando (otro webhook pudo subirlo), no solo lo nuestro.
    await reclaimOrphanStatus(organizationId, status.id);
  }
}
