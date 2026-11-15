import { eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { detectOptOutIntent, type OptOutIntent } from "@/lib/automation-compliance";
import { automationsEnabled } from "@/server/automation/flag";

/**
 * Automatizaciones — bajas de mensajes automáticos (spec 037, D1–D5).
 *
 * La baja vive en el contacto (`opted_out_at`). Darla de baja hace dos cosas en UNA transacción: marca al contacto
 * y cancela todas sus ejecuciones vivas (así los recordatorios ya programados no salen). El freno definitivo está en
 * el motor, justo antes de enviar; esto solo evita dejar tareas condenadas en la cola.
 */

export type OptOutSource = "keyword" | "manual";

/** ¿El contacto pidió no recibir mensajes automáticos? Un contacto que no existe no está de baja. */
export async function isOptedOut(organizationId: string, contactId: string): Promise<boolean> {
  const c = schema.contact;
  const [row] = await getDb()
    .select({ optedOutAt: c.optedOutAt })
    .from(c)
    .where(scoped(c.organizationId, organizationId, eq(c.id, contactId)))
    .limit(1);
  return !!row?.optedOutAt;
}

export type OptOutResult = {
  /** `false`: el contacto no existe en esta organización. */
  found: boolean;
  /** `true`: antes recibía y ahora no (una segunda baja no cambia la fecha). */
  changed: boolean;
  cancelledRuns: number;
};

/**
 * Da de baja al contacto y cancela sus ejecuciones vivas, con su rastro en el historial (`skipped_opt_out`).
 * Idempotente. Candados en el orden de siempre: `run` primero, luego la cola.
 */
export async function applyOptOut(input: {
  organizationId: string;
  contactId: string;
  source: OptOutSource;
  /** Lo que dijo el cliente (para el historial); nunca se usa para decidir nada. */
  detail?: string | null;
}): Promise<OptOutResult> {
  return getDb().transaction(async (tx) => {
    const c = schema.contact;
    const r = schema.automationRun;
    const q = schema.automationQueue;
    const now = new Date();

    const [exists] = await tx
      .select({ id: c.id })
      .from(c)
      .where(scoped(c.organizationId, input.organizationId, eq(c.id, input.contactId)))
      .limit(1);
    if (!exists) return { found: false, changed: false, cancelledRuns: 0 };

    const marked = await tx
      .update(c)
      .set({ optedOutAt: now, optOutSource: input.source, updatedAt: now })
      .where(scoped(c.organizationId, input.organizationId, eq(c.id, input.contactId), isNull(c.optedOutAt)))
      .returning({ id: c.id });

    const runs = await tx
      .select({ id: r.id, flowId: r.flowId, currentStepId: r.currentStepId })
      .from(r)
      .where(
        scoped(r.organizationId, input.organizationId, eq(r.contactId, input.contactId), inArray(r.status, ["running", "waiting"]))
      )
      .for("update");

    for (const run of runs) {
      await tx
        .update(r)
        .set({ status: "cancelled", waitingFor: null, waitingUntil: null, endedAt: now })
        .where(scoped(r.organizationId, input.organizationId, eq(r.id, run.id)));
      await tx
        .update(q)
        .set({ status: "cancelled", lockedAt: null, error: "skipped_opt_out" })
        .where(scoped(q.organizationId, input.organizationId, eq(q.runId, run.id), eq(q.status, "pending")));
      await tx.insert(schema.automationExecutionLog).values({
        id: newId("automationExecutionLog"),
        organizationId: input.organizationId,
        flowId: run.flowId,
        stepId: run.currentStepId,
        contactId: input.contactId,
        queueId: null,
        status: "skipped_opt_out",
        metadata: {
          reason: input.source,
          runId: run.id,
          cancelled: true,
          ...(input.detail ? { message: input.detail.slice(0, 200) } : {}),
        },
      });
    }
    return { found: true, changed: marked.length > 0, cancelledRuns: runs.length };
  });
}

/** Levanta la baja (el cliente volvió a pedir los mensajes, o el operador corrigió). `true` si estaba de baja. */
export async function clearOptOut(organizationId: string, contactId: string): Promise<boolean> {
  const c = schema.contact;
  const rows = await getDb()
    .update(c)
    .set({ optedOutAt: null, optOutSource: null, updatedAt: new Date() })
    .where(scoped(c.organizationId, organizationId, eq(c.id, contactId), isNotNull(c.optedOutAt)))
    .returning({ id: c.id });
  return rows.length > 0;
}

export type OptOutEvent = { organizationId: string; contactId: string; text: string | null };

/** Lo que `onInboundOptOut` toca del mundo: se sustituye por dobles en las pruebas. */
export type OptOutDeps = {
  enabled(): boolean;
  apply: typeof applyOptOut;
  clear: typeof clearOptOut;
};

export const dbOptOutDeps: OptOutDeps = { enabled: automationsEnabled, apply: applyOptOut, clear: clearOptOut };

/**
 * La ingesta de mensajes llama aquí ANTES de `onInboundReply`: una respuesta «STOP» a un `wait_reply` da de baja y
 * cancela la espera en vez de contarse como «otra cosa». Devuelve qué entendió (`null`: nada). Nunca lanza: el
 * mensaje del cliente ya entró y es lo que importa.
 */
export async function onInboundOptOut(event: OptOutEvent, deps: OptOutDeps = dbOptOutDeps): Promise<OptOutIntent | null> {
  if (!deps.enabled()) return null;
  try {
    const intent = detectOptOutIntent(event.text);
    if (!intent) return null;
    if (intent === "opt_out") {
      await deps.apply({
        organizationId: event.organizationId,
        contactId: event.contactId,
        source: "keyword",
        detail: event.text,
      });
    } else {
      await deps.clear(event.organizationId, event.contactId);
    }
    return intent;
  } catch (err) {
    console.error("[automatizaciones] no se pudo procesar la baja del cliente:", err);
    return null;
  }
}
