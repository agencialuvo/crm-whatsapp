import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

/**
 * Automatizaciones — la cola en base de datos: reclamar, completar, reintentar, fallar y avanzar.
 *
 * Sin colas externas (constitución II): la fila ES la cola. Lo que la hace segura con varias
 * instancias es que `claimDue` toma las filas en UNA sola sentencia con `FOR UPDATE SKIP LOCKED`,
 * así dos workers jamás reciben la misma fila.
 */

export type QueueRow = typeof schema.automationQueue.$inferSelect;
export type StepRow = Pick<
  typeof schema.automationStep.$inferSelect,
  "id" | "flowId" | "stepType" | "config"
>;

/** Una toma más vieja que esto se da por caída (el worker murió a mitad) y la fila se reclama. */
export const LOCK_TIMEOUT_MS = 10 * 60_000;

/**
 * Toma, de forma atómica, hasta `limit` tareas vencidas y las pasa a `processing`.
 *
 * Elegibles: `pending` con `scheduled_for <= ahora`, o `processing` con la toma vencida (worker
 * caído); y siempre `attempts < max_attempts`. Al tomarlas se fija `locked_at` y se SUMA un intento:
 * contarlo al tomar (y no al fallar) hace que una tarea que mata al worker cada vez termine
 * agotando sus intentos en vez de reintentarse para siempre.
 */
export async function claimDue(
  limit: number,
  now: Date = new Date(),
  lockTimeoutMs: number = LOCK_TIMEOUT_MS
): Promise<QueueRow[]> {
  const db = getDb();
  const q = schema.automationQueue;
  const staleBefore = new Date(now.getTime() - lockTimeoutMs);
  const due = or(
    and(eq(q.status, "pending"), lte(q.scheduledFor, now)),
    and(eq(q.status, "processing"), lte(q.lockedAt, staleBefore))
  )!;
  const eligible = and(due, lt(q.attempts, q.maxAttempts))!;

  const picked = db
    .select({ id: q.id })
    .from(q)
    .where(eligible)
    .orderBy(asc(q.scheduledFor))
    .limit(limit)
    .for("update", { skipLocked: true });

  return db
    .update(q)
    .set({ status: "processing", lockedAt: now, attempts: sql`${q.attempts} + 1` })
    .where(and(inArray(q.id, picked), eligible))
    .returning();
}

/**
 * Tareas que se cayeron con el último intento ya gastado: nadie las va a reclamar (`attempts` llegó
 * a `max_attempts`) y quedarían en `processing` para siempre. Se cierran como fallidas.
 */
export async function failExhausted(now: Date = new Date()): Promise<number> {
  const q = schema.automationQueue;
  const rows = await getDb()
    .update(q)
    .set({ status: "failed", lockedAt: null, error: "max_attempts_exceeded" })
    .where(
      and(
        eq(q.status, "processing"),
        lte(q.lockedAt, new Date(now.getTime() - LOCK_TIMEOUT_MS)),
        sql`${q.attempts} >= ${q.maxAttempts}`
      )
    )
    .returning({ id: q.id });
  return rows.length;
}

export async function loadStep(organizationId: string, stepId: string): Promise<StepRow | null> {
  const s = schema.automationStep;
  const [row] = await getDb()
    .select({ id: s.id, flowId: s.flowId, stepType: s.stepType, config: s.config })
    .from(s)
    .where(scoped(s.organizationId, organizationId, eq(s.id, stepId)))
    .limit(1);
  return row ?? null;
}

export async function isFlowActive(organizationId: string, flowId: string): Promise<boolean> {
  const f = schema.automationFlow;
  const [row] = await getDb()
    .select({ active: f.active })
    .from(f)
    .where(scoped(f.organizationId, organizationId, eq(f.id, flowId)))
    .limit(1);
  return !!row?.active;
}

/**
 * El chat de WhatsApp REAL del contacto (una conversación real por contacto; la de prueba del
 * Laboratorio no cuenta) y su nombre.
 */
export async function loadTarget(organizationId: string, contactId: string) {
  const c = schema.conversation;
  const [row] = await getDb()
    .select({
      conversationId: c.id,
      channel: c.channel,
      isTest: c.isTest,
      lastInboundAt: c.lastInboundAt,
      contactName: schema.contact.name,
    })
    .from(c)
    .innerJoin(schema.contact, eq(schema.contact.id, c.contactId))
    .where(scoped(c.organizationId, organizationId, eq(c.contactId, contactId), eq(c.isTest, false)))
    .limit(1);
  return row ?? null;
}

/** El estado de una plantilla del negocio (`template.status`), o `null` si no existe. */
export async function templateStatus(
  organizationId: string,
  templateId: string
): Promise<string | null> {
  const t = schema.template;
  const [row] = await getDb()
    .select({ status: t.status })
    .from(t)
    .where(scoped(t.organizationId, organizationId, eq(t.id, templateId)))
    .limit(1);
  return row?.status ?? null;
}

/** El id de WhatsApp (wamid) de un mensaje ya guardado. */
export async function waMessageIdOf(organizationId: string, messageId: string) {
  const m = schema.message;
  const [row] = await getDb()
    .select({ waMessageId: m.waMessageId })
    .from(m)
    .where(scoped(m.organizationId, organizationId, eq(m.id, messageId)))
    .limit(1);
  return row?.waMessageId ?? null;
}

export async function hasSuccessLog(organizationId: string, queueId: string): Promise<boolean> {
  const l = schema.automationExecutionLog;
  const [row] = await getDb()
    .select({ id: l.id })
    .from(l)
    .where(scoped(l.organizationId, organizationId, eq(l.queueId, queueId), eq(l.status, "success")))
    .limit(1);
  return !!row;
}

export type LogEntry = {
  organizationId: string;
  flowId: string;
  stepId: string;
  contactId: string;
  queueId: string;
  status: (typeof schema.automationExecutionLog.$inferInsert)["status"];
  metadata: Record<string, unknown>;
};

/**
 * Escribe una línea de auditoría. El índice único parcial (`queue_id` donde `status = 'success'`)
 * hace que un éxito repetido de la misma tarea se ignore: es la llave de idempotencia.
 */
export async function writeLog(entry: LogEntry): Promise<void> {
  await getDb()
    .insert(schema.automationExecutionLog)
    .values({ id: newId("automationExecutionLog"), ...entry })
    .onConflictDoNothing();
}

/**
 * Una tarea terminó bien: se marca `completed` y, si el flujo tiene un paso siguiente, se encola
 * para `nextAt` — las dos cosas en UNA transacción, para que un fallo no deje el flujo cortado
 * (completada sin siguiente) ni duplicado (siguiente sin completar).
 *
 * El «siguiente» es el que sigue en el orden del lienzo (`position_y`, `position_x`, id): la tabla
 * no tiene aristas, así que el orden visual es el orden de ejecución.
 */
export async function completeAndAdvance(row: QueueRow, nextAt: Date): Promise<string | null> {
  return getDb().transaction(async (tx) => {
    const s = schema.automationStep;
    const q = schema.automationQueue;
    const steps = await tx
      .select({ id: s.id })
      .from(s)
      .where(scoped(s.organizationId, row.organizationId, eq(s.flowId, row.flowId)))
      .orderBy(asc(s.positionY), asc(s.positionX), asc(s.id));
    const at = steps.findIndex((x) => x.id === row.stepId);
    const next = at >= 0 ? steps[at + 1] : undefined;

    await tx
      .update(q)
      .set({ status: "completed", lockedAt: null, error: null })
      .where(scoped(q.organizationId, row.organizationId, eq(q.id, row.id)));

    if (!next) return null;
    const id = newId("automationQueue");
    await tx.insert(q).values({
      id,
      organizationId: row.organizationId,
      flowId: row.flowId,
      contactId: row.contactId,
      stepId: next.id,
      scheduledFor: nextAt,
      maxAttempts: row.maxAttempts,
    });
    return id;
  });
}

async function setStatus(
  row: QueueRow,
  patch: Partial<typeof schema.automationQueue.$inferInsert>
): Promise<void> {
  const q = schema.automationQueue;
  await getDb()
    .update(q)
    .set(patch)
    .where(scoped(q.organizationId, row.organizationId, eq(q.id, row.id)));
}

export const markFailed = (row: QueueRow, error: string) =>
  setStatus(row, { status: "failed", lockedAt: null, error });

export const markCancelled = (row: QueueRow, reason: string) =>
  setStatus(row, { status: "cancelled", lockedAt: null, error: reason });

/** Vuelve a `pending` para `at`, con el motivo del último fallo. */
export const reschedule = (row: QueueRow, at: Date, error: string) =>
  setStatus(row, { status: "pending", lockedAt: null, scheduledFor: at, error });
