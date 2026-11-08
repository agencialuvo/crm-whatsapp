import { and, count, desc, eq, inArray, max, min, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type { LogsQuery, LogStatusFilter } from "@/lib/automation-schemas";
import { AutomationError } from "@/server/automation/http";

/**
 * Automatizaciones — estado del motor y historial de ejecuciones (solo lectura).
 *
 * Todo pasa por `scoped()`. Con `flowId` se mide un flujo (debe ser de la organización: uno ajeno
 * responde 404 igual que uno inexistente); sin él, toda la organización.
 */

async function assertFlowOwned(organizationId: string, flowId: string) {
  const f = schema.automationFlow;
  const [row] = await getDb()
    .select({ id: f.id })
    .from(f)
    .where(scoped(f.organizationId, organizationId, eq(f.id, flowId)))
    .limit(1);
  if (!row) throw new AutomationError("not_found", 404, "El flujo no existe");
}

type LogStatus = "success" | "failed" | "skipped_rate_limit" | "skipped_opt_out";

const STATUS_FILTER: Record<LogStatusFilter, readonly LogStatus[]> = {
  success: ["success"],
  failed: ["failed"],
  skipped: ["skipped_rate_limit", "skipped_opt_out"],
  skipped_rate_limit: ["skipped_rate_limit"],
  skipped_opt_out: ["skipped_opt_out"],
};

export type FlowStats = {
  flowId: string | null;
  /** Los cuatro números que se leen de un vistazo. */
  summary: {
    /** Tareas que aún no terminan: en espera (`pending`) o tomadas por un worker (`processing`). */
    pending: number;
    /** Mensajes enviados con éxito (una línea `success` por tarea: nunca se cuenta doble). */
    success: number;
    /** Tareas que se rindieron tras agotar sus reintentos (no cuenta los intentos que luego salieron bien). */
    failed: number;
    /** Envíos saltados: por frecuencia o porque el contacto se dio de baja. */
    skipped: number;
  };
  /** La cola tal cual, por estado. */
  queue: {
    pending: number;
    processing: number;
    completed: number;
    cancelled: number;
    failed: number;
    nextScheduledFor: Date | null;
  };
  /** El historial, por estado (cada intento registrado cuenta, así que `failed` incluye los reintentados). */
  executions: {
    success: number;
    failed: number;
    skippedRateLimit: number;
    skippedOptOut: number;
    total: number;
    lastExecutedAt: Date | null;
  };
};

export async function getStats(organizationId: string, flowId: string | null): Promise<FlowStats> {
  if (flowId) await assertFlowOwned(organizationId, flowId);
  const db = getDb();
  const q = schema.automationQueue;
  const l = schema.automationExecutionLog;

  const [queueRows, logRows, nextRows, lastRows] = await Promise.all([
    db
      .select({ status: q.status, n: count() })
      .from(q)
      .where(scoped(q.organizationId, organizationId, flowId ? eq(q.flowId, flowId) : undefined))
      .groupBy(q.status),
    db
      .select({ status: l.status, n: count() })
      .from(l)
      .where(scoped(l.organizationId, organizationId, flowId ? eq(l.flowId, flowId) : undefined))
      .groupBy(l.status),
    db
      .select({ at: min(q.scheduledFor) })
      .from(q)
      .where(scoped(q.organizationId, organizationId, eq(q.status, "pending"), flowId ? eq(q.flowId, flowId) : undefined)),
    db
      .select({ at: max(l.executedAt) })
      .from(l)
      .where(scoped(l.organizationId, organizationId, flowId ? eq(l.flowId, flowId) : undefined)),
  ]);

  const byQueue = (s: string) => queueRows.find((r) => r.status === s)?.n ?? 0;
  const byLog = (s: string) => logRows.find((r) => r.status === s)?.n ?? 0;
  const queue = {
    pending: byQueue("pending"),
    processing: byQueue("processing"),
    completed: byQueue("completed"),
    cancelled: byQueue("cancelled"),
    failed: byQueue("failed"),
    nextScheduledFor: nextRows[0]?.at ?? null,
  };
  const executions = {
    success: byLog("success"),
    failed: byLog("failed"),
    skippedRateLimit: byLog("skipped_rate_limit"),
    skippedOptOut: byLog("skipped_opt_out"),
    total: logRows.reduce((sum, r) => sum + r.n, 0),
    lastExecutedAt: lastRows[0]?.at ?? null,
  };
  return {
    flowId,
    summary: {
      pending: queue.pending + queue.processing,
      success: executions.success,
      failed: queue.failed,
      skipped: executions.skippedRateLimit + executions.skippedOptOut,
    },
    queue,
    executions,
  };
}

/** El error de una línea del historial: el motor lo guarda en `metadata.error`. */
export function logError(metadata: unknown): string | null {
  if (metadata && typeof metadata === "object" && "error" in metadata) {
    const e = (metadata as { error?: unknown }).error;
    if (typeof e === "string" && e) return e;
  }
  return null;
}

export async function listLogs(organizationId: string, flowId: string | null, query: LogsQuery) {
  if (flowId) await assertFlowOwned(organizationId, flowId);
  const db = getDb();
  const l = schema.automationExecutionLog;
  const c = schema.contact;
  const s = schema.automationStep;
  const f = schema.automationFlow;

  const where: SQL = scoped(
    l.organizationId,
    organizationId,
    flowId ? eq(l.flowId, flowId) : undefined,
    query.status ? inArray(l.status, [...STATUS_FILTER[query.status]]) : undefined
  );

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: l.id,
        flowId: l.flowId,
        flowName: f.name,
        stepId: l.stepId,
        stepType: s.stepType,
        queueId: l.queueId,
        status: l.status,
        metadata: l.metadata,
        executedAt: l.executedAt,
        contactId: l.contactId,
        contactName: c.name,
        contactPhone: c.phone,
      })
      .from(l)
      // Cada unión lleva también la organización: un id suelto jamás cruza de tenant.
      .innerJoin(f, and(eq(f.id, l.flowId), eq(f.organizationId, l.organizationId)))
      .innerJoin(c, and(eq(c.id, l.contactId), eq(c.organizationId, l.organizationId)))
      .leftJoin(s, and(eq(s.id, l.stepId), eq(s.organizationId, l.organizationId)))
      .where(where)
      .orderBy(desc(l.executedAt), desc(l.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(l).where(where),
  ]);

  return {
    logs: rows.map((r) => ({
      id: r.id,
      flowId: r.flowId,
      flowName: r.flowName,
      // null: el paso se borró y la línea se conserva.
      step: r.stepId ? { id: r.stepId, stepType: r.stepType } : null,
      queueId: r.queueId,
      status: r.status,
      contact: { id: r.contactId, name: r.contactName, phone: r.contactPhone },
      error: logError(r.metadata),
      metadata: (r.metadata ?? null) as Record<string, unknown> | null,
      executedAt: r.executedAt,
    })),
    total: totalRows[0]?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}
