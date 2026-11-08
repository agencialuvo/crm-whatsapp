import {
  OUT_OF_WINDOW_ERROR,
  backoffMs,
  decideSend,
  delayConfigSchema,
  delayToMs,
  renderVars,
  sendWhatsappConfigSchema,
  stepLabel,
  type SendDecision,
} from "@/lib/automation";
import { isWindowOpen } from "@/server/inbox/window";

/**
 * Automatizaciones — el motor: qué hace el worker con UNA tarea ya tomada de la cola.
 *
 * Sin base de datos ni red aquí: todo lo que toca el mundo entra por `Deps`, así cada regla
 * (ventana de 24 h, reintentos, idempotencia, auditoría) se prueba con dobles. El cableado real
 * vive en `worker.ts`.
 *
 * El camino infeliz degrada, nunca cuelga: una tarea termina siempre en uno de cuatro estados
 * (`completed`, `failed`, `cancelled`) o vuelve a `pending` con su próximo intento.
 */

export type Row = {
  id: string;
  organizationId: string;
  flowId: string;
  contactId: string;
  stepId: string;
  /** Intentos ya iniciados, incluido este (se suma al tomar la fila). */
  attempts: number;
  maxAttempts: number;
};

export type Step = { id: string; flowId: string; stepType: string; config: unknown };

export type Target = {
  conversationId: string;
  channel: string;
  isTest: boolean;
  lastInboundAt: Date | null;
  contactName: string | null;
};

export type LogInput = {
  organizationId: string;
  flowId: string;
  stepId: string;
  contactId: string;
  queueId: string;
  status: "success" | "failed";
  metadata: Record<string, unknown>;
};

export type Deps = {
  now(): Date;
  loadStep(organizationId: string, stepId: string): Promise<Step | null>;
  isFlowActive(organizationId: string, flowId: string): Promise<boolean>;
  loadTarget(organizationId: string, contactId: string): Promise<Target | null>;
  templateStatus(organizationId: string, templateId: string): Promise<string | null>;
  sendText(input: {
    organizationId: string;
    conversationId: string;
    text: string;
  }): Promise<{ messageId: string }>;
  sendTemplate(input: {
    organizationId: string;
    conversationId: string;
    templateId: string;
    variables?: string[];
  }): Promise<{ messageId: string }>;
  waMessageIdOf(organizationId: string, messageId: string): Promise<string | null>;
  hasSuccessLog(organizationId: string, queueId: string): Promise<boolean>;
  writeLog(entry: LogInput): Promise<void>;
  /** Completa la tarea y encola el paso siguiente para `nextAt` (una sola transacción). */
  completeAndAdvance(row: Row, nextAt: Date): Promise<unknown>;
  markFailed(row: Row, error: string): Promise<void>;
  markCancelled(row: Row, reason: string): Promise<void>;
  reschedule(row: Row, at: Date, error: string): Promise<void>;
};

export type Outcome = "completed" | "retry" | "failed" | "cancelled";

/** Un fallo y de qué tipo es: lo recuperable se reintenta, lo demás es definitivo. */
export type Classified = { recoverable: boolean; code: string; message: string };

/**
 * ¿Vale la pena reintentar? Solo lo transitorio: Meta caída o sin red (`meta_unavailable`) y lo que
 * no se reconoce (un corte de la base, un error de red sin tipo) — acotado por `max_attempts`.
 * Todo error tipado que dice «esto no va a cambiar solo» (ventana cerrada, número desconectado,
 * texto muy largo, rechazo de Meta, sandbox) es definitivo: reintentarlo solo gasta intentos.
 *
 * Se mira `name` y `code` en vez de `instanceof` para no arrastrar los módulos de envío (y su base
 * de datos) a la lógica pura; los errores los lanzan `SendError` y `TemplateError`.
 */
export function classifyError(err: unknown): Classified {
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : String(err);
  const typed = e?.name === "SendError" || e?.name === "TemplateError";
  if (typed && typeof e?.code === "string") {
    return { recoverable: e.code === "meta_unavailable", code: e.code, message };
  }
  return { recoverable: true, code: "unexpected_error", message };
}

const MAX_ERROR_CHARS = 500;
const clip = (s: string) => (s.length > MAX_ERROR_CHARS ? `${s.slice(0, MAX_ERROR_CHARS)}…` : s);

export async function processRow(row: Row, deps: Deps): Promise<Outcome> {
  const now = deps.now();

  try {
    const step = await deps.loadStep(row.organizationId, row.stepId);
    if (!step) {
      await deps.markFailed(row, "step_not_found");
      return "failed";
    }
    // Un flujo pausado o borrado no ejecuta lo que ya estaba en cola.
    if (!(await deps.isFlowActive(row.organizationId, row.flowId))) {
      await deps.markCancelled(row, "flow_inactive");
      return "cancelled";
    }

    // La foto del paso: el historial se entiende aunque el nodo se edite o se borre después.
    const snapshot = {
      queueId: row.id,
      attempt: row.attempts,
      step: {
        stepType: step.stepType,
        stepName: stepLabel(step.stepType, step.config),
        config: step.config,
      },
    };
    const fail = async (error: string, extra: Record<string, unknown> = {}): Promise<Outcome> => {
      await deps.writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "failed",
        metadata: { ...snapshot, error, ...extra },
      });
      await deps.markFailed(row, clip(error));
      return "failed";
    };

    // Idempotencia: si un intento anterior ya envió y registró el éxito pero se cayó antes de cerrar
    // la tarea, no se vuelve a enviar: solo se cierra y se avanza.
    if (await deps.hasSuccessLog(row.organizationId, row.id)) {
      await deps.completeAndAdvance(row, now);
      return "completed";
    }

    if (step.stepType === "delay") {
      const cfg = delayConfigSchema.safeParse(step.config);
      if (!cfg.success) return await fail("invalid_step_config", { detail: cfg.error.issues[0]?.message });
      const nextAt = new Date(now.getTime() + delayToMs(cfg.data));
      await deps.writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "success",
        metadata: { ...snapshot, nextAt: nextAt.toISOString() },
      });
      await deps.completeAndAdvance(row, nextAt);
      return "completed";
    }

    if (step.stepType !== "send_whatsapp") {
      // `condition` y `add_tag` todavía no tienen ejecutor: se falla a la vista en vez de dar el
      // paso por hecho en silencio.
      return await fail("step_type_not_supported", { stepType: step.stepType });
    }

    const cfg = sendWhatsappConfigSchema.safeParse(step.config);
    if (!cfg.success) return await fail("invalid_step_config", { detail: cfg.error.issues[0]?.message });
    const config = cfg.data;

    const target = await deps.loadTarget(row.organizationId, row.contactId);
    if (!target) return await fail("no_conversation");
    // Aserción del sandbox: una conversación del Laboratorio jamás toca la API real.
    if (target.isTest) return await fail("sandbox_conversation");
    if (target.channel !== "whatsapp") return await fail("not_whatsapp_channel");

    // Regla de la ventana de 24 h de Meta.
    const windowOpen = isWindowOpen(target.lastInboundAt, now);
    const templateStatus = config.templateId
      ? await deps.templateStatus(row.organizationId, config.templateId)
      : null;
    const decision: SendDecision = decideSend({ windowOpen, config, templateStatus });
    if (decision.kind === "fail") {
      return await fail(decision.error, {
        windowOpen,
        lastInboundAt: target.lastInboundAt?.toISOString() ?? null,
        templateId: config.templateId ?? null,
        templateStatus,
      });
    }

    const vars = { name: target.contactName };
    let payload: Record<string, unknown>;
    let sent: { messageId: string };
    if (decision.kind === "text") {
      const text = renderVars(config.content!, vars);
      payload = { mode: "text", conversationId: target.conversationId, text };
      sent = await deps.sendText({
        organizationId: row.organizationId,
        conversationId: target.conversationId,
        text,
      });
    } else {
      const variables = (config.variables ?? []).map((v) => renderVars(v, vars));
      payload = {
        mode: "template",
        conversationId: target.conversationId,
        templateId: config.templateId,
        variables,
      };
      sent = await deps.sendTemplate({
        organizationId: row.organizationId,
        conversationId: target.conversationId,
        templateId: config.templateId!,
        variables,
      });
    }

    const waMessageId = await deps.waMessageIdOf(row.organizationId, sent.messageId).catch(() => null);
    await deps.writeLog({
      organizationId: row.organizationId,
      flowId: row.flowId,
      stepId: step.id,
      contactId: row.contactId,
      queueId: row.id,
      status: "success",
      metadata: { ...snapshot, windowOpen, waMessageId, messageId: sent.messageId, payload },
    });
    await deps.completeAndAdvance(row, now);
    return "completed";
  } catch (err) {
    return handleFailure(row, err, deps, now);
  }
}

/** Reintento con backoff si el fallo es recuperable y quedan intentos; si no, falla definitivo. */
async function handleFailure(row: Row, err: unknown, deps: Deps, now: Date): Promise<Outcome> {
  const c = classifyError(err);
  const reason = clip(`${c.code}: ${c.message}`);

  if (c.recoverable && row.attempts < row.maxAttempts) {
    await deps.reschedule(row, new Date(now.getTime() + backoffMs(row.attempts)), reason);
    return "retry";
  }

  const error = c.recoverable ? clip(`max_attempts_exceeded: ${c.code}: ${c.message}`) : reason;
  // Auditoría del fallo definitivo. Si el paso ya no existe no hay foto que guardar: se omite.
  const step = await deps.loadStep(row.organizationId, row.stepId).catch(() => null);
  if (step) {
    await deps
      .writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "failed",
        metadata: {
          queueId: row.id,
          attempt: row.attempts,
          step: { stepType: step.stepType, stepName: stepLabel(step.stepType, step.config), config: step.config },
          error,
        },
      })
      .catch((e) => console.error("[automatizaciones] no se pudo escribir el log del fallo:", e));
  }
  await deps.markFailed(row, error);
  return "failed";
}

export { OUT_OF_WINDOW_ERROR };
