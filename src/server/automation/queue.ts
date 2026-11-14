import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { replyTimeoutKey, type EdgeHandle } from "@/lib/automation";
import { resolveNextStep } from "@/server/automation/graph";

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
    .returning({ id: q.id, organizationId: q.organizationId, runId: q.runId });
  // La ejecución de una tarea que se cayó sin remedio también termina fallida.
  for (const r of rows) await closeRun(getDb(), r.organizationId, r.runId, "failed");
  return rows.length;
}

/** El estado de una ejecución (`null` si no existe): una tarea en vuelo lo mira antes de ejecutar su paso. */
export async function runStatus(organizationId: string, runId: string): Promise<string | null> {
  const r = schema.automationRun;
  const [row] = await getDb()
    .select({ status: r.status })
    .from(r)
    .where(scoped(r.organizationId, organizationId, eq(r.id, runId)))
    .limit(1);
  return row?.status ?? null;
}

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

/** Termina la ejecución (`failed`/`cancelled`) si seguía viva. Sin `runId` (tarea anterior a los `run`) no hace nada. */
async function closeRun(tx: Tx, organizationId: string, runId: string | null, status: "failed" | "cancelled") {
  if (!runId) return;
  const r = schema.automationRun;
  await tx
    .update(r)
    .set({ status, waitingFor: null, endedAt: new Date() })
    .where(scoped(r.organizationId, organizationId, eq(r.id, runId), inArray(r.status, ["running", "waiting"])));
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

/** La cita de una tarea: su estado, su hora y si ya se confirmó. `null` si ya no existe. */
export async function loadBooking(
  organizationId: string,
  bookingId: string
): Promise<{ status: string; scheduledAt: Date; confirmedAt: Date | null } | null> {
  const b = schema.booking;
  const [row] = await getDb()
    .select({ status: b.status, scheduledAt: b.scheduledAt, confirmedAt: b.confirmedAt })
    .from(b)
    .where(scoped(b.organizationId, organizationId, eq(b.id, bookingId)))
    .limit(1);
  return row ?? null;
}

/** El disparador de un flujo (`booking_created`…), o `null` si el flujo ya no existe. */
export async function flowTriggerType(organizationId: string, flowId: string): Promise<string | null> {
  const f = schema.automationFlow;
  const [row] = await getDb()
    .select({ triggerType: f.triggerType })
    .from(f)
    .where(scoped(f.organizationId, organizationId, eq(f.id, flowId)))
    .limit(1);
  return row?.triggerType ?? null;
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
 * Una tarea terminó bien: se marca `completed` y se encola el paso al que lleva la arista `(paso, handle)` —
 * las dos cosas en UNA transacción, para que un fallo no deje el flujo cortado (completada sin siguiente) ni
 * duplicado (siguiente sin completar). Sin arista para ese asa, el flujo termina y su ejecución se completa.
 *
 * Concurrencia: primero se toma `FOR UPDATE` la fila del `run` (el mismo orden de candados con que lo cancelan:
 * `run` y luego la cola), así quien llega segundo ve el estado del primero. Un `run` cancelado a la vez NO encola
 * el siguiente paso, aunque su tarea en vuelo termine después.
 */
export async function completeAndAdvance(
  row: QueueRow,
  nextAt: Date,
  opts: { handle?: EdgeHandle } = {}
): Promise<string | null> {
  const handle = opts.handle ?? "default";
  return getDb().transaction(async (tx) => {
    const q = schema.automationQueue;
    const r = schema.automationRun;

    let alive = true;
    if (row.runId) {
      const [run] = await tx
        .select({ status: r.status })
        .from(r)
        .where(scoped(r.organizationId, row.organizationId, eq(r.id, row.runId)))
        .for("update");
      alive = !!run && (run.status === "running" || run.status === "waiting");
    }

    // Solo una tarea viva se completa: si otro avance (o una cancelación) ya la cerró, este no encola nada.
    const closed = await tx
      .update(q)
      .set({ status: "completed", lockedAt: null, error: null })
      .where(scoped(q.organizationId, row.organizationId, eq(q.id, row.id), inArray(q.status, ["pending", "processing"])))
      .returning({ id: q.id });
    if (closed.length === 0) return null;

    // Un run cancelado o terminado a la vez: no se sigue.
    if (!alive) return null;

    const nextStepId = await resolveNextStep(tx, row.organizationId, row.flowId, row.stepId, handle);
    if (!nextStepId) {
      if (row.runId) {
        await tx
          .update(r)
          .set({ status: "completed", waitingFor: null, endedAt: new Date() })
          .where(scoped(r.organizationId, row.organizationId, eq(r.id, row.runId)));
      }
      return null;
    }

    const id = newId("automationQueue");
    await tx.insert(q).values({
      id,
      organizationId: row.organizationId,
      flowId: row.flowId,
      contactId: row.contactId,
      stepId: nextStepId,
      scheduledFor: nextAt,
      maxAttempts: row.maxAttempts,
      // La cita y la ejecución viajan con el flujo: el paso siguiente sigue anclado a ellas.
      bookingId: row.bookingId,
      runId: row.runId,
    });
    if (row.runId) {
      const future = nextAt.getTime() > Date.now();
      await tx
        .update(r)
        .set({ currentStepId: nextStepId, status: future ? "waiting" : "running", waitingFor: future ? "time" : null })
        .where(scoped(r.organizationId, row.organizationId, eq(r.id, row.runId)));
    }
    return id;
  });
}

/**
 * `wait_reply` empieza: la ejecución pasa a «esperando respuesta» y la tarea del paso se cambia por una tarea de
 * TIMEOUT (mismo paso, a la hora límite, con una llave que el motor reconoce). Todo bajo el candado del `run`.
 * Idempotente: si la ejecución ya espera en este paso (un reintento tras una caída) no se encola otro timeout.
 * Devuelve `cancelled` si la ejecución ya no está viva.
 */
export async function enterReplyWait(row: QueueRow, timeoutAt: Date): Promise<"waiting" | "cancelled"> {
  if (!row.runId) return "cancelled";
  const runId = row.runId;
  return getDb().transaction(async (tx) => {
    const q = schema.automationQueue;
    const r = schema.automationRun;
    const [run] = await tx
      .select({ status: r.status, waitingFor: r.waitingFor, currentStepId: r.currentStepId })
      .from(r)
      .where(scoped(r.organizationId, row.organizationId, eq(r.id, runId)))
      .for("update");
    if (!run || (run.status !== "running" && run.status !== "waiting")) return "cancelled";

    const replay = run.waitingFor === "reply" && run.currentStepId === row.stepId;
    await tx
      .update(q)
      .set({ status: "completed", lockedAt: null, error: null })
      .where(scoped(q.organizationId, row.organizationId, eq(q.id, row.id), inArray(q.status, ["pending", "processing"])));
    if (replay) return "waiting";

    await tx
      .update(r)
      .set({ status: "waiting", waitingFor: "reply", waitingUntil: timeoutAt, currentStepId: row.stepId })
      .where(scoped(r.organizationId, row.organizationId, eq(r.id, runId)));
    await tx
      .insert(q)
      .values({
        id: newId("automationQueue"),
        organizationId: row.organizationId,
        flowId: row.flowId,
        contactId: row.contactId,
        stepId: row.stepId,
        scheduledFor: timeoutAt,
        maxAttempts: row.maxAttempts,
        dedupeKey: replyTimeoutKey(runId, row.stepId, timeoutAt),
        bookingId: row.bookingId,
        runId,
      })
      .onConflictDoNothing();
    return "waiting";
  });
}

export type ReplyResolution = {
  /** `false`: la espera ya no estaba viva (la ganó la otra vía, o se canceló): nada que hacer. */
  resolved: boolean;
  /** El paso `wait_reply` que se resolvió. */
  stepId?: string | null;
  /** La tarea del paso al que llevó la arista (null: no había arista y la ejecución terminó). */
  nextQueueId?: string | null;
  /** La cita de la ejecución (para confirmarla si la respuesta fue «confirmó»). */
  bookingId?: string | null;
};

/**
 * Resuelve una espera de respuesta por el asa dada: la ÚNICA función que lo hace, la llame la respuesta del
 * cliente (`confirmed`/`declined`/`reschedule`/`other`) o el temporizador (`timeout`).
 *
 * Toma `FOR UPDATE` la fila del `run` (el mismo orden de candados de la Fase 3: `run` y luego la cola). Si la
 * ejecución ya no está esperando, no hace nada. Si lo está: cierra la(s) tarea(s) pendiente(s) del paso, sigue
 * la arista `(paso, asa)` y encola el destino, o completa la ejecución si no hay arista. Por eso la carrera
 * «respuesta vs. vencimiento» la gana exactamente una: la otra ve el `run` ya resuelto.
 */
export async function resolveReplyWait(input: {
  organizationId: string;
  runId: string;
  handle: EdgeHandle;
  at?: Date;
}): Promise<ReplyResolution> {
  return getDb().transaction(async (tx) => {
    const q = schema.automationQueue;
    const r = schema.automationRun;
    const [run] = await tx
      .select({
        status: r.status,
        waitingFor: r.waitingFor,
        currentStepId: r.currentStepId,
        flowId: r.flowId,
        contactId: r.contactId,
        context: r.context,
      })
      .from(r)
      .where(scoped(r.organizationId, input.organizationId, eq(r.id, input.runId)))
      .for("update");
    if (!run || run.status !== "waiting" || run.waitingFor !== "reply" || !run.currentStepId) return { resolved: false };

    const stepId = run.currentStepId;
    // Las tareas del paso (la de timeout) se cierran: el candado del `run` ya decidió quién gana.
    const closed = await tx
      .update(q)
      .set({ status: "completed", lockedAt: null, error: null })
      .where(
        scoped(
          q.organizationId,
          input.organizationId,
          eq(q.runId, input.runId),
          eq(q.stepId, stepId),
          inArray(q.status, ["pending", "processing"])
        )
      )
      .returning({ bookingId: q.bookingId, maxAttempts: q.maxAttempts });
    const ctxBooking = (run.context as { bookingId?: unknown } | null)?.bookingId;
    const bookingId = closed[0]?.bookingId ?? (typeof ctxBooking === "string" ? ctxBooking : null);

    const nextStepId = await resolveNextStep(tx, input.organizationId, run.flowId, stepId, input.handle);
    if (!nextStepId) {
      await tx
        .update(r)
        .set({ status: "completed", waitingFor: null, waitingUntil: null, endedAt: new Date() })
        .where(scoped(r.organizationId, input.organizationId, eq(r.id, input.runId)));
      return { resolved: true, stepId, nextQueueId: null, bookingId };
    }

    const id = newId("automationQueue");
    await tx.insert(q).values({
      id,
      organizationId: input.organizationId,
      flowId: run.flowId,
      contactId: run.contactId,
      stepId: nextStepId,
      scheduledFor: input.at ?? new Date(),
      maxAttempts: closed[0]?.maxAttempts ?? 5,
      bookingId,
      runId: input.runId,
    });
    await tx
      .update(r)
      .set({ status: "running", waitingFor: null, waitingUntil: null, currentStepId: nextStepId })
      .where(scoped(r.organizationId, input.organizationId, eq(r.id, input.runId)));
    return { resolved: true, stepId, nextQueueId: id, bookingId };
  });
}

/** Cancela una ejecución que esperaba respuesta (flujo apagado, etc.) y sus tareas pendientes. `true` si la cancelaba. */
export async function cancelWaitingRun(organizationId: string, runId: string, reason: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const q = schema.automationQueue;
    const r = schema.automationRun;
    const [run] = await tx
      .select({ status: r.status })
      .from(r)
      .where(scoped(r.organizationId, organizationId, eq(r.id, runId)))
      .for("update");
    if (!run || (run.status !== "running" && run.status !== "waiting")) return false;
    await tx
      .update(r)
      .set({ status: "cancelled", waitingFor: null, waitingUntil: null, endedAt: new Date() })
      .where(scoped(r.organizationId, organizationId, eq(r.id, runId)));
    await tx
      .update(q)
      .set({ status: "cancelled", lockedAt: null, error: reason })
      .where(scoped(q.organizationId, organizationId, eq(q.runId, runId), eq(q.status, "pending")));
    return true;
  });
}

/** Las ejecuciones de un contacto que esperan su respuesta (normalmente una). */
export async function waitingRunsForContact(organizationId: string, contactId: string) {
  const r = schema.automationRun;
  return getDb()
    .select({ id: r.id, flowId: r.flowId, currentStepId: r.currentStepId })
    .from(r)
    .where(scoped(r.organizationId, organizationId, eq(r.contactId, contactId), eq(r.status, "waiting"), eq(r.waitingFor, "reply")))
    .orderBy(asc(r.startedAt));
}

/** El contexto estable de una ejecución (la cita, el anuncio y su servicio). `{}` si no existe. */
export async function runContext(organizationId: string, runId: string): Promise<Record<string, unknown>> {
  const r = schema.automationRun;
  const [row] = await getDb()
    .select({ context: r.context })
    .from(r)
    .where(scoped(r.organizationId, organizationId, eq(r.id, runId)))
    .limit(1);
  return (row?.context as Record<string, unknown> | null) ?? {};
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

/** Cierra la tarea y su ejecución en una transacción: `run` primero, luego la cola (el orden de candados de siempre). */
async function endRow(row: QueueRow, status: "failed" | "cancelled", error: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await closeRun(tx, row.organizationId, row.runId, status);
    const q = schema.automationQueue;
    await tx
      .update(q)
      .set({ status, lockedAt: null, error })
      .where(scoped(q.organizationId, row.organizationId, eq(q.id, row.id)));
  });
}

export const markFailed = (row: QueueRow, error: string) => endRow(row, "failed", error);

export const markCancelled = (row: QueueRow, reason: string) => endRow(row, "cancelled", reason);

/** Vuelve a `pending` para `at`, con el motivo del último fallo. */
export const reschedule = (row: QueueRow, at: Date, error: string) =>
  setStatus(row, { status: "pending", lockedAt: null, scheduledFor: at, error });
