import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { waitReplyConfigSchema, type EdgeHandle, type ReplyIntent } from "@/lib/automation";
import { confirmBooking } from "@/server/agenda/service";
import { automationsEnabled } from "@/server/automation/flag";
import { classifyReplyIntent, type IntentResult } from "@/server/automation/intent";
import * as queue from "@/server/automation/queue";

/**
 * Automatizaciones — la respuesta del cliente reanuda un flujo que la esperaba (`wait_reply`).
 *
 * La ingesta de mensajes llama a `onInboundReply` tras guardar el mensaje. Si el contacto no tiene ninguna
 * ejecución esperando respuesta, no hace nada (una consulta indexada: ni LLM ni nada más). Si la tiene:
 * 1. Solo el TEXTO cuenta: un sticker, reacción, imagen o audio sin texto no reanuda la espera.
 * 2. Se clasifica la intención (reglas exactas → LLM → `other`).
 * 3. Se resuelve la espera por el asa de esa intención con `resolveReplyWait`, que toma el candado del `run`:
 *    si el temporizador se le adelantó (o la ejecución se canceló), no hace nada.
 * 4. Si la intención fue «confirmó» y la ejecución viene de una cita, se confirma con `confirmBooking`, la misma
 *    función del botón de la Agenda (best-effort: un fallo se registra, no deshace la resolución).
 *
 * Nunca lanza hacia arriba: el mensaje del cliente ya entró y es lo que importa. El agente de IA NO se silencia
 * (spec 035, D7): la respuesta sigue su camino normal y el flujo la usa como señal.
 */

export type ReplyEvent = {
  organizationId: string;
  contactId: string;
  /** El texto del mensaje, o `null` si no trae (sticker, reacción…). */
  text: string | null;
  messageId?: string | null;
};

type WaitingRun = { id: string; flowId: string; currentStepId: string | null };

/** Lo que `onInboundReply` toca del mundo: se sustituye por dobles en las pruebas. */
export type ReplyDeps = {
  enabled(): boolean;
  waitingRuns(organizationId: string, contactId: string): Promise<WaitingRun[]>;
  flowActive(organizationId: string, flowId: string): Promise<boolean>;
  cancelRun(organizationId: string, runId: string, reason: string): Promise<boolean>;
  stepConfig(organizationId: string, stepId: string): Promise<unknown>;
  classify(text: string, organizationId: string): Promise<IntentResult>;
  resolve(input: { organizationId: string; runId: string; handle: EdgeHandle }): Promise<queue.ReplyResolution>;
  confirm(organizationId: string, bookingId: string): Promise<unknown>;
  log(entry: {
    organizationId: string;
    flowId: string;
    stepId: string | null;
    contactId: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
};

export const dbReplyDeps: ReplyDeps = {
  enabled: automationsEnabled,
  waitingRuns: queue.waitingRunsForContact,
  flowActive: queue.isFlowActive,
  cancelRun: queue.cancelWaitingRun,
  async stepConfig(organizationId, stepId) {
    return (await queue.loadStep(organizationId, stepId))?.config ?? null;
  },
  classify: (text, organizationId) => classifyReplyIntent(text, { organizationId }),
  resolve: (input) => queue.resolveReplyWait(input),
  confirm: (organizationId, bookingId) => confirmBooking({ organizationId, bookingId }),
  async log(entry) {
    // Sin tarea propia (`queue_id` NULL): la resolución por respuesta no nace de la cola.
    await getDb()
      .insert(schema.automationExecutionLog)
      .values({ id: newId("automationExecutionLog"), ...entry, queueId: null, status: "success" });
  },
};

/** Devuelve cuántas ejecuciones reanudó. Nunca lanza. */
export async function onInboundReply(event: ReplyEvent, deps: ReplyDeps = dbReplyDeps): Promise<number> {
  if (!deps.enabled()) return 0;
  try {
    // Solo el texto cuenta (D4): un sticker o una reacción no es una respuesta.
    const text = event.text?.trim();
    if (!text) return 0;

    const runs = await deps.waitingRuns(event.organizationId, event.contactId);
    if (runs.length === 0) return 0; // D6: nadie espera → ni LLM ni nada

    const result = await deps.classify(text, event.organizationId);
    const handle: ReplyIntent = result.intent;
    let resumed = 0;

    for (const run of runs) {
      try {
        // Un flujo apagado mientras esperaba no se reanuda: la ejecución se cancela.
        if (!(await deps.flowActive(event.organizationId, run.flowId))) {
          await deps.cancelRun(event.organizationId, run.id, "flow_inactive");
          continue;
        }
        const cfg = waitReplyConfigSchema.safeParse(run.currentStepId ? await deps.stepConfig(event.organizationId, run.currentStepId) : {});
        const confirmBookingOn = cfg.success ? cfg.data.confirmBooking : true;

        const resolution = await deps.resolve({ organizationId: event.organizationId, runId: run.id, handle });
        if (!resolution.resolved) continue; // el temporizador (u otra respuesta) se adelantó
        resumed += 1;

        await deps
          .log({
            organizationId: event.organizationId,
            flowId: run.flowId,
            stepId: resolution.stepId ?? run.currentStepId,
            contactId: event.contactId,
            metadata: {
              waitedFor: "reply",
              runId: run.id,
              handle,
              intent: result.intent,
              source: result.source,
              ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
              ...(event.messageId ? { messageId: event.messageId } : {}),
            },
          })
          .catch((e) => console.error("[automatizaciones] no se pudo registrar la respuesta:", e));

        if (handle === "confirmed" && confirmBookingOn && resolution.bookingId) {
          await deps.confirm(event.organizationId, resolution.bookingId).catch((e) =>
            console.error("[automatizaciones] no se pudo confirmar la cita desde la respuesta:", e instanceof Error ? e.message : e)
          );
        }
      } catch (err) {
        console.error(`[automatizaciones] la respuesta no reanudó la ejecución ${run.id}:`, err);
      }
    }
    return resumed;
  } catch (err) {
    console.error("[automatizaciones] el manejo de la respuesta del cliente falló:", err);
    return 0;
  }
}
