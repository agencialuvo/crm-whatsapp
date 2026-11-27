import {
  OUT_OF_WINDOW_ERROR,
  OUT_OF_WINDOW_MEDIA_ERROR,
  addTagConfigSchema,
  applySendWindow,
  backoffMs,
  bookingAnchorGuard,
  bookingGuard,
  codeJsConfigSchema,
  conditionConfigSchema,
  conditionHandle,
  decideSend,
  decideWaitUntil,
  delayConfigSchema,
  delayToMs,
  evaluateCondition,
  evaluateSwitch,
  isReplyTimeoutKey,
  mergeVars,
  readVars,
  removeTagConfigSchema,
  endFlowConfigSchema,
  humanHandoffConfigSchema,
  readBirthdayContext,
  readLoyaltyContext,
  readSaleContext,
  renderVars,
  sendMediaConfigSchema,
  sendWhatsappConfigSchema,
  setStageConfigSchema,
  setVarConfigSchema,
  stepLabel,
  switchConfigSchema,
  waitReplyConfigSchema,
  waitUntilConfigSchema,
  type ConditionFacts,
  type EdgeHandle,
  type NodeResult,
  type SendDecision,
} from "@/lib/automation";
import { AUTOMATION_RATE_LIMIT, decideRateLimit, rateLimitHoldExpired } from "@/lib/automation-compliance";
import { dayLabelInTz, timeInTz } from "@/lib/time/slots";
import type { CodeRunResult } from "@/server/automation/sandbox";
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
  /** La cita de la que nació la tarea (disparadores de cita); null en el resto. */
  bookingId: string | null;
  /** La ejecución (`automation_run`) a la que pertenece; null/ausente en tareas anteriores a los `run`. */
  runId?: string | null;
  /** La llave de la tarea: la de «venció el tiempo» de un `wait_reply` empieza con `reply_timeout:`. */
  dedupeKey?: string | null;
  /** Cuándo nació la tarea: el límite de frecuencia descarta lo que lleva demasiado retenido. */
  createdAt?: Date;
};

/** Lo que el motor necesita de la cita de una tarea: si sigue vigente, a qué hora es y si ya se confirmó. */
export type BookingInfo = { status: string; scheduledAt: Date; confirmedAt?: Date | null };

/** Resultado de `add_tag`/`remove_tag` (ver `actions.ts`). */
export type TagActionResult = "added" | "removed" | "unchanged" | "tag_not_found";

/** Resultado de `set_stage` (ver `actions.ts`). */
export type StageActionResult =
  | { status: "moved" | "unchanged"; toStageId: string; fromStageId: string | null }
  | { status: "stage_not_found" | "contact_has_no_lead" };

/**
 * Cómo avanza el flujo al terminar una tarea: por qué asa sale (`default` si no se dice; sin arista, el flujo termina) y,
 * opcionalmente, las variables que el paso deja en `context.vars` (`null` borra una). Se persisten en la MISMA transacción
 * que el avance: o quedan el dato y el avance, o ninguno de los dos.
 */
export type AdvanceOptions = { handle?: EdgeHandle; vars?: Record<string, unknown> };

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
  status: "success" | "failed" | "skipped_opt_out" | "skipped_rate_limit";
  metadata: Record<string, unknown>;
};

/** El archivo de un `send_media` ya leído de la biblioteca, o por qué no se pudo. */
export type MediaFile =
  | { ok: true; mimeType: string; fileName: string; bytes: number }
  | { ok: false; reason: "not_found" | "file_missing" | "too_large" | "unsupported" | "processing" }
  /** La optimización del video falló (o quedó incompleta) y el original no se puede enviar; `detail` es el motivo. */
  | { ok: false; reason: "variant_failed"; detail?: string };

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
  sendMedia(input: {
    organizationId: string;
    conversationId: string;
    /** 048: el id del medio de la biblioteca; el envío resuelve su `media_id` de WhatsApp (caché por número). */
    mediaId: string;
    caption?: string;
  }): Promise<{ messageId: string }>;
  /** Los metadatos de un medio de la biblioteca (no sus bytes). */
  loadMedia(organizationId: string, mediaId: string): Promise<MediaFile>;
  /** Cumplimiento (037): ¿el contacto pidió no recibir mensajes automáticos? */
  isOptedOut(organizationId: string, contactId: string): Promise<boolean>;
  /** Cumplimiento (037): cuándo salieron los envíos automáticos exitosos del contacto desde `since` (todos los flujos). */
  recentAutomaticSends(organizationId: string, contactId: string, since: Date): Promise<Date[]>;
  /** Cumplimiento (037): devuelve la tarea a `pending` para `at` SIN gastar un intento (el límite no es un fallo). */
  defer(row: Row, at: Date, reason: string): Promise<void>;
  waMessageIdOf(organizationId: string, messageId: string): Promise<string | null>;
  hasSuccessLog(organizationId: string, queueId: string): Promise<boolean>;
  writeLog(entry: LogInput): Promise<void>;
  /** La cita de una tarea de cita (`null` si ya no existe). */
  loadBooking(organizationId: string, bookingId: string): Promise<BookingInfo | null>;
  /** El disparador del flujo: de él depende qué estado de la cita lo mantiene vigente. */
  flowTriggerType(organizationId: string, flowId: string): Promise<string | null>;
  /** Zona horaria del negocio (Ajustes → Marca): la de las ventanas horarias y las variables de la cita. */
  timezone(organizationId: string): Promise<string>;
  /**
   * El estado de la ejecución de la tarea (`null` si ya no existe). Opcional: una tarea en vuelo cuya ejecución se
   * canceló (cita movida, flujo apagado) se cancela sola antes de ejecutar su paso.
   */
  runStatus?(organizationId: string, runId: string): Promise<string | null>;
  /** `wait_reply` empieza: la ejecución espera la respuesta y la tarea del paso se cambia por una de timeout. */
  enterReplyWait?(row: Row, timeoutAt: Date): Promise<"waiting" | "cancelled">;
  /** Resuelve la espera por un asa (`timeout` cuando venció el tiempo). `false`: ya la había resuelto la otra vía. */
  resolveReplyWait?(row: Row, handle: EdgeHandle): Promise<boolean>;
  /** El contexto de la ejecución (anuncio, servicio…): de ahí sale `{{servicio}}`. */
  runContext?(organizationId: string, runId: string): Promise<Record<string, unknown>>;
  /**
   * Paso 5 — `human_handoff`: pasa la conversación a una persona (apaga la IA, deja el motivo y avisa en la bandeja).
   * Idempotente. Opcional: sin definir, el paso falla a la vista (`handoff_unavailable`).
   */
  handoff?(input: { organizationId: string; conversationId: string; note?: string }): Promise<{ status: "paused" | "already_paused" | "not_found" }>;
  /** Paso 3: ejecuta el código de un bloque `code_js` en el sandbox (sin definir, o con la bandera apagada: falla a la vista). */
  runCode?(input: { code: string; input: unknown }): Promise<CodeRunResult>;
  /**
   * Etiquetas y etapa de hoy del contacto: lo que lee una condición. Los datos de cita, visita, sellos y cumpleaños
   * son opcionales (quien no los trae, los da por «no»).
   */
  contactFacts(organizationId: string, contactId: string): Promise<Pick<ConditionFacts, "tagIds" | "stageId"> & Partial<ConditionFacts>>;
  /** `add_tag` / `remove_tag`: idempotente. */
  applyTag(organizationId: string, contactId: string, tagId: string, mode: "add" | "remove"): Promise<TagActionResult>;
  /** `set_stage`: por la puerta del embudo, sin disparar flujos de cambio de etapa (anti-bucle). */
  moveContactToStage(organizationId: string, contactId: string, stageId: string): Promise<StageActionResult>;
  /** Completa la tarea y encola el paso siguiente para `nextAt` (una sola transacción). */
  completeAndAdvance(row: Row, nextAt: Date, opts?: AdvanceOptions): Promise<unknown>;
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
  // `StepError`: un paso que falla por algo que no cambia solo (p. ej. se pasó el tope de variables).
  const typed = e?.name === "SendError" || e?.name === "TemplateError" || e?.name === "StepError";
  if (typed && typeof e?.code === "string") {
    return { recoverable: e.code === "meta_unavailable", code: e.code, message };
  }
  return { recoverable: true, code: "unexpected_error", message };
}

const MAX_ERROR_CHARS = 500;
/** Monedas: cada cuánto se reintenta una tarea retenida por falta de saldo, y cuánto se la retiene antes de descartarla. */
const NO_CREDIT_RETRY_MS = 60 * 60_000;
const NO_CREDIT_HOLD_MS = 48 * 60 * 60_000;
/** Un video que aún se está optimizando: se reintenta cada minuto, sin gastar intento, hasta esta espera (desde que se encoló el paso). */
export const MEDIA_PROCESSING_RETRY_MS = 60_000;
export const MEDIA_PROCESSING_HOLD_MS = 60 * 60_000;
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

    // La ejecución se canceló mientras la tarea estaba en vuelo (D8): no se ejecuta el paso.
    if (row.runId && deps.runStatus) {
      const status = await deps.runStatus(row.organizationId, row.runId);
      if (status !== "running" && status !== "waiting") {
        await deps.markCancelled(row, "run_cancelled");
        return "cancelled";
      }
    }

    // Una tarea de cita solo sigue si la cita sigue vigente: una cancelada, realizada o movida no recibe el
    // recordatorio. Es la red de seguridad de la cancelación inmediata (también cubre el cobro en Caja).
    let booking: BookingInfo | null = null;
    if (row.bookingId) {
      const trigger = await deps.flowTriggerType(row.organizationId, row.flowId);
      booking = await deps.loadBooking(row.organizationId, row.bookingId);
      const stale = bookingGuard(trigger ?? "", booking);
      if (stale) {
        await deps.markCancelled(row, stale);
        return "cancelled";
      }
      // Bloque 3 — Sigue «agendada», pero ¿a la misma hora? Si se movió, esta ejecución quedó anclada a la hora
      // vieja (la reprogramación ya arrancó otra con la nueva): se cancela en vez de enviar a destiempo.
      if (row.runId && deps.runContext) {
        const movida = bookingAnchorGuard(trigger ?? "", await deps.runContext(row.organizationId, row.runId), booking);
        if (movida) {
          await deps.markCancelled(row, movida);
          return "cancelled";
        }
      }
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
    // Los nodos que ramifican (condición, espera con «tarde») no se cortocircuitan: el asa por la que salieron no
    // se guardó como dato, y repetir su evaluación es inocuo (el historial ya tiene su éxito).
    // Tampoco los que dejan datos en `context.vars` (set_var, code_js): el dato se escribe junto con el avance, así que si el
    // avance no ocurrió el dato tampoco, y repetir el paso (puro y determinista) lo deja igual. Un `switch` ramifica.
    const branching =
      step.stepType === "condition" ||
      step.stepType === "wait_until" ||
      step.stepType === "wait_reply" ||
      step.stepType === "switch" ||
      step.stepType === "set_var" ||
      step.stepType === "code_js";
    if (!branching && (await deps.hasSuccessLog(row.organizationId, row.id))) {
      await deps.completeAndAdvance(row, now);
      return "completed";
    }

    if (step.stepType === "delay") {
      const cfg = delayConfigSchema.safeParse(step.config);
      if (!cfg.success) return await fail("invalid_step_config", { detail: cfg.error.issues[0]?.message });
      let nextAt = new Date(now.getTime() + delayToMs(cfg.data));
      // Ventana horaria: tras esperar, no salir de madrugada o forzar una hora fija (en la zona del negocio).
      if (cfg.data.window) {
        nextAt = applySendWindow(nextAt, cfg.data.window, await deps.timezone(row.organizationId));
      }
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

    if (step.stepType === "wait_until") {
      const cfg = waitUntilConfigSchema.safeParse(step.config);
      if (!cfg.success) return await fail("invalid_step_config", { detail: cfg.error.issues[0]?.message });
      // Sin cita no hay a qué anclar la espera (el flujo no es de citas).
      if (!booking) return await fail("wait_until_requires_booking");
      const decision = decideWaitUntil({
        now,
        scheduledAt: booking.scheduledAt,
        config: cfg.data,
        timezone: await deps.timezone(row.organizationId),
      });
      if (decision.kind === "wait") {
        await deps.writeLog({
          organizationId: row.organizationId,
          flowId: row.flowId,
          stepId: step.id,
          contactId: row.contactId,
          queueId: row.id,
          status: "success",
          metadata: { ...snapshot, bookingId: row.bookingId, bookingAt: booking.scheduledAt.toISOString(), nextAt: decision.at.toISOString() },
        });
        await deps.completeAndAdvance(row, decision.at);
        return "completed";
      }
      // Ya es tarde (la cita se creó con menos anticipación, o la ventana pasaría de la hora de la cita).
      await deps.writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "success",
        metadata: {
          ...snapshot,
          bookingId: row.bookingId,
          bookingAt: booking.scheduledAt.toISOString(),
          late: true,
          lateAction: decision.action,
          handle: "late",
        },
      });
      // Tarde: sale por el asa `late` (la arista compilada de su `lateAction`; sin arista, el flujo termina).
      await deps.completeAndAdvance(row, now, { handle: "late" });
      return "completed";
    }

    if (step.stepType === "wait_reply") {
      const cfg = waitReplyConfigSchema.safeParse(step.config);
      if (!cfg.success) return await fail("invalid_step_config", { detail: cfg.error.issues[0]?.message });
      // Una espera vive en la ejecución: sin `run` (tarea anterior a los `run`) no hay dónde esperar.
      if (!row.runId || !deps.enterReplyWait || !deps.resolveReplyWait) return await fail("wait_reply_requires_run");

      // La tarea de «venció el tiempo»: resuelve la espera por `timeout`, salvo que la respuesta se le adelantara.
      if (isReplyTimeoutKey(row.dedupeKey)) {
        const resolved = await deps.resolveReplyWait(row, "timeout");
        if (resolved) {
          await deps.writeLog({
            organizationId: row.organizationId,
            flowId: row.flowId,
            stepId: step.id,
            contactId: row.contactId,
            queueId: row.id,
            status: "success",
            metadata: { ...snapshot, waitedFor: "reply", handle: "timeout" },
          });
        }
        return "completed";
      }

      const timeoutAt = new Date(now.getTime() + cfg.data.timeoutMinutes * 60_000);
      await deps.writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "success",
        metadata: { ...snapshot, waitingFor: "reply", timeoutAt: timeoutAt.toISOString() },
      });
      if ((await deps.enterReplyWait(row, timeoutAt)) === "cancelled") {
        await deps.markCancelled(row, "run_cancelled");
        return "cancelled";
      }
      return "completed";
    }

    // Acciones sobre el CRM. No envían nada: no necesitan chat, ventana de 24 h ni plantilla.
    if (step.stepType === "add_tag" || step.stepType === "remove_tag") {
      const cfg = (step.stepType === "add_tag" ? addTagConfigSchema : removeTagConfigSchema).safeParse(step.config);
      if (!cfg.success) return await fail("invalid_step_config", { detail: cfg.error.issues[0]?.message });
      const result = await deps.applyTag(
        row.organizationId,
        row.contactId,
        cfg.data.tagId,
        step.stepType === "add_tag" ? "add" : "remove"
      );
      // Una etiqueta borrada: falla a la vista en vez de darse por hecho.
      if (result === "tag_not_found") return await fail("tag_not_found", { tagId: cfg.data.tagId });
      await deps.writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "success",
        metadata: { ...snapshot, tagId: cfg.data.tagId, result },
      });
      await deps.completeAndAdvance(row, now);
      return "completed";
    }

    // Terminar flujo: cierra la rama a propósito. No envía nada ni consulta nada: deja una línea clara en el historial y la ejecución
    // se completa porque este nodo no tiene salidas (`completeAndAdvance` sin arista termina el `run`).
    if (step.stepType === "end_flow") {
      const cfg = endFlowConfigSchema.safeParse(step.config);
      if (!cfg.success) return await fail("invalid_step_config", { detail: cfg.error.issues[0]?.message });
      await deps.writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "success",
        metadata: { ...snapshot, result: "ended", reason: "end_flow" },
      });
      await deps.completeAndAdvance(row, now);
      return "completed";
    }

    // Paso 5 — escalar a una persona. No envía nada al cliente: no necesita ventana de 24 h ni plantilla, y no se frena por una baja.
    if (step.stepType === "human_handoff") {
      const cfg = humanHandoffConfigSchema.safeParse(step.config);
      if (!cfg.success) return await fail("invalid_step_config", { detail: cfg.error.issues[0]?.message });
      if (!deps.handoff) return await fail("handoff_unavailable");
      const target = await deps.loadTarget(row.organizationId, row.contactId);
      let result: "paused" | "already_paused" | "no_conversation" | "sandbox" | "not_found";
      if (!target) result = "no_conversation"; // sin chat no hay a quién escalar: el flujo sigue
      else if (target.isTest) result = "sandbox"; // el Laboratorio nunca se toca
      else {
        const ctx = row.runId && deps.runContext ? await deps.runContext(row.organizationId, row.runId) : {};
        const note = cfg.data.note ? renderVars(cfg.data.note, { name: target.contactName, vars: readVars(ctx), loyalty: readLoyaltyContext(ctx), sale: readSaleContext(ctx), birthday: readBirthdayContext(ctx) }) : "";
        result = (await deps.handoff({ organizationId: row.organizationId, conversationId: target.conversationId, ...(note ? { note } : {}) })).status;
      }
      await deps.writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "success",
        metadata: { ...snapshot, result },
      });
      await deps.completeAndAdvance(row, now);
      return "completed";
    }

    if (step.stepType === "set_stage") {
      const cfg = setStageConfigSchema.safeParse(step.config);
      if (!cfg.success) return await fail("invalid_step_config", { detail: cfg.error.issues[0]?.message });
      const moved = await deps.moveContactToStage(row.organizationId, row.contactId, cfg.data.stageId);
      if (moved.status !== "moved" && moved.status !== "unchanged") {
        return await fail(moved.status, { stageId: cfg.data.stageId });
      }
      await deps.writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "success",
        metadata: {
          ...snapshot,
          stageId: moved.toStageId,
          fromStageId: moved.fromStageId,
          result: moved.status,
          // Anti-bucle: un movimiento de automatización no dispara flujos `stage_changed`.
          triggeredByAutomation: true,
        },
      });
      await deps.completeAndAdvance(row, now);
      return "completed";
    }

    if (step.stepType === "condition") {
      const cfg = conditionConfigSchema.safeParse(step.config);
      if (!cfg.success) return await fail("invalid_step_config", { detail: cfg.error.issues[0]?.message });
      // Datos de ahora, no de cuando se disparó el flujo: la confirmación o una etiqueta pudo llegar mientras esperaba.
      const facts = await deps.contactFacts(row.organizationId, row.contactId);
      // Las variables y el premio del disparo solo se leen si la regla los usa (una consulta menos en el caso común).
      const usesCtx = cfg.data.rule.type === "var_equals" || cfg.data.rule.type === "loyalty_milestone_is";
      const ctx = usesCtx && row.runId && deps.runContext ? await deps.runContext(row.organizationId, row.runId) : {};
      const outcome = evaluateCondition(cfg.data.rule, {
        ...facts,
        booking,
        vars: readVars(ctx),
        loyaltyMilestoneStamps: readLoyaltyContext(ctx)?.milestoneStamps ?? null,
      });
      const result: NodeResult = { handle: conditionHandle(outcome) };
      await deps.writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "success",
        metadata: { ...snapshot, rule: cfg.data.rule, result: outcome.result, branch: result.handle, handle: result.handle },
      });
      await deps.completeAndAdvance(row, result.nextAt ?? now, { handle: result.handle });
      return "completed";
    }

    // Paso 3 — Switch: evalúa los casos EN ORDEN y sale por el del primero que se cumple (o por «Otro» = `default`).
    if (step.stepType === "switch") {
      const cfg = switchConfigSchema.safeParse(step.config);
      if (!cfg.success) return await fail("invalid_step_config", { detail: cfg.error.issues[0]?.message });
      const facts = await deps.contactFacts(row.organizationId, row.contactId);
      const usesCtx = cfg.data.cases.some((k) => k.rule.type === "var_equals" || k.rule.type === "loyalty_milestone_is");
      const ctx = usesCtx && row.runId && deps.runContext ? await deps.runContext(row.organizationId, row.runId) : {};
      const picked = evaluateSwitch(cfg.data.cases, {
        ...facts,
        booking,
        vars: readVars(ctx),
        loyaltyMilestoneStamps: readLoyaltyContext(ctx)?.milestoneStamps ?? null,
      });
      const label = cfg.data.cases.find((k) => k.id === picked.caseId)?.label ?? null;
      await deps.writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "success",
        metadata: { ...snapshot, caseId: picked.caseId, caseLabel: label, branch: label ?? "default", handle: picked.handle },
      });
      await deps.completeAndAdvance(row, now, { handle: picked.handle });
      return "completed";
    }

    // Paso 3 — Establecer variable: `context.vars[key] = value` (con `{{…}}` ya resuelto), junto con el avance.
    if (step.stepType === "set_var") {
      const cfg = setVarConfigSchema.safeParse(step.config);
      if (!cfg.success) return await fail("invalid_step_config", { detail: cfg.error.issues[0]?.message });
      if (!row.runId || !deps.runContext) return await fail("set_var_requires_run");
      const ctx = await deps.runContext(row.organizationId, row.runId);
      const current = readVars(ctx);
      const target = await deps.loadTarget(row.organizationId, row.contactId);
      const tz = booking ? await deps.timezone(row.organizationId) : null;
      const bookingAt = booking?.scheduledAt.toISOString();
      const value = renderVars(cfg.data.value, {
        name: target?.contactName ?? null,
        servicio: typeof ctx.serviceName === "string" ? ctx.serviceName : typeof ctx.comboName === "string" ? ctx.comboName : null,
        fecha: bookingAt && tz ? dayLabelInTz(bookingAt, tz, now) : null,
        hora: bookingAt && tz ? timeInTz(bookingAt, tz) : null,
        vars: current,
        loyalty: readLoyaltyContext(ctx),
        sale: readSaleContext(ctx),
        birthday: readBirthdayContext(ctx),
      });
      const merged = mergeVars(current, { [cfg.data.key]: value });
      if (!merged.ok) return await fail(merged.code, { detail: merged.message, key: cfg.data.key });
      await deps.writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "success",
        // Solo la clave y el largo: el valor puede traer datos del contacto y el historial no los necesita.
        metadata: { ...snapshot, key: cfg.data.key, valueChars: String(merged.vars[cfg.data.key] ?? "").length },
      });
      await deps.completeAndAdvance(row, now, { vars: { [cfg.data.key]: value } });
      return "completed";
    }

    // Paso 3 — Código JS: corre en el sandbox (sin red, sin datos, sin secretos) y deja `{ vars }`. Cualquier fallo del
    // código es DEFINITIVO (no se reintenta): el código y sus entradas no cambian solos.
    if (step.stepType === "code_js") {
      const cfg = codeJsConfigSchema.safeParse(step.config);
      if (!cfg.success) return await fail("invalid_step_config", { detail: cfg.error.issues[0]?.message });
      if (!deps.runCode) return await fail("code_js_disabled");
      if (!row.runId || !deps.runContext) return await fail("code_js_requires_run");
      const ctx = await deps.runContext(row.organizationId, row.runId);
      const current = readVars(ctx);
      const facts = await deps.contactFacts(row.organizationId, row.contactId);
      const target = await deps.loadTarget(row.organizationId, row.contactId);
      // Solo lo necesario y acotado: nada de teléfono, correo ni identificadores internos. El contexto sin `vars` (que va aparte).
      const trigger = Object.fromEntries(Object.entries(ctx).filter(([k]) => k !== "vars" && k !== "bookingId"));
      const res = await deps.runCode({
        code: cfg.data.code,
        input: {
          now: (row.createdAt ?? now).toISOString(),
          contact: { name: target?.contactName ?? null, tagIds: [...facts.tagIds].slice(0, 50), stageId: facts.stageId },
          context: trigger,
          vars: current,
        },
      });
      if (!res.ok) return await fail(res.code, { detail: res.message });
      const merged = mergeVars(current, res.vars);
      if (!merged.ok) return await fail(merged.code, { detail: merged.message });
      await deps.writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "success",
        // Trazabilidad sin volcar datos: las claves que escribió, cuánto tardó y cuánto devolvió (nunca los valores).
        metadata: { ...snapshot, keys: Object.keys(res.vars), durationMs: res.durationMs, outputChars: res.outputChars },
      });
      await deps.completeAndAdvance(row, now, { vars: res.vars });
      return "completed";
    }

    const isMedia = step.stepType === "send_media";
    if (step.stepType !== "send_whatsapp" && !isMedia) {
      // Un tipo sin ejecutor se falla a la vista en vez de dar el paso por hecho en silencio.
      return await fail("step_type_not_supported", { stepType: step.stepType });
    }

    const cfgResult = isMedia ? sendMediaConfigSchema.safeParse(step.config) : sendWhatsappConfigSchema.safeParse(step.config);
    if (!cfgResult.success) return await fail("invalid_step_config", { detail: cfgResult.error.issues[0]?.message });

    // Cumplimiento (037, D5): un contacto dado de baja NO recibe mensajes automáticos. Se mira antes que todo lo demás
    // (ventana, plantilla, límite): es la regla que manda. La ejecución termina aquí, no salta al paso siguiente.
    if (await deps.isOptedOut(row.organizationId, row.contactId)) {
      await deps.writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "skipped_opt_out",
        metadata: { ...snapshot, reason: "opted_out" },
      });
      await deps.markCancelled(row, "skipped_opt_out");
      return "cancelled";
    }

    const target = await deps.loadTarget(row.organizationId, row.contactId);
    if (!target) return await fail("no_conversation");
    // Aserción del sandbox: una conversación del Laboratorio jamás toca la API real.
    if (target.isTest) return await fail("sandbox_conversation");
    if (target.channel !== "whatsapp") return await fail("not_whatsapp_channel");

    // Regla de la ventana de 24 h de Meta.
    const windowOpen = isWindowOpen(target.lastInboundAt, now);
    let decision: SendDecision = { kind: "text" };
    let mediaFile: Extract<MediaFile, { ok: true }> | null = null;
    if (isMedia) {
      // Un adjunto no tiene plantilla: fuera de la ventana no hay forma de enviarlo.
      if (!windowOpen) {
        return await fail(OUT_OF_WINDOW_MEDIA_ERROR, { windowOpen, lastInboundAt: target.lastInboundAt?.toISOString() ?? null });
      }
      const mediaId = (cfgResult.data as { mediaId: string }).mediaId;
      const loaded = await deps.loadMedia(row.organizationId, mediaId);
      if (!loaded.ok && loaded.reason === "processing") {
        // Se está preparando para WhatsApp: no es un fallo del paso. Se espera sin gastar intento (como `no_credit`) y solo se
        // abandona pasado el tope; los diferimientos no se anotan en el historial (uno por minuto lo llenaría).
        const heldTooLong = !!row.createdAt && now.getTime() - row.createdAt.getTime() > MEDIA_PROCESSING_HOLD_MS;
        if (heldTooLong) return await fail("media_variant_pending", { mediaId });
        await deps.defer(row, new Date(now.getTime() + MEDIA_PROCESSING_RETRY_MS), "media_variant_pending");
        return "retry";
      }
      if (!loaded.ok) {
        if (loaded.reason === "variant_failed") {
          return await fail(loaded.detail ? `media_variant_failed: ${loaded.detail}` : "media_variant_failed", { mediaId });
        }
        const error =
          loaded.reason === "not_found"
            ? "media_not_found"
            : loaded.reason === "too_large"
              ? "media_too_large"
              : loaded.reason === "unsupported"
                ? "media_unsupported_format"
                : "media_file_missing";
        return await fail(error, { mediaId });
      }
      mediaFile = loaded;
    } else {
      const wa = cfgResult.data as { content?: string; templateId?: string };
      const templateStatus = wa.templateId ? await deps.templateStatus(row.organizationId, wa.templateId) : null;
      decision = decideSend({ windowOpen, config: wa, templateStatus });
      if (decision.kind === "fail") {
        return await fail(decision.error, {
          windowOpen,
          lastInboundAt: target.lastInboundAt?.toISOString() ?? null,
          templateId: wa.templateId ?? null,
          templateStatus,
        });
      }
    }

    // Cumplimiento (037, D6): tope de mensajes automáticos por contacto en una ventana móvil, sumando los flujos. Se mira
    // DESPUÉS de lo que haría fallar al paso: no se retiene lo que de todos modos no iba a salir.
    const windowMs = AUTOMATION_RATE_LIMIT.windowHours * 3_600_000;
    const sentAt = await deps.recentAutomaticSends(row.organizationId, row.contactId, new Date(now.getTime() - windowMs));
    const limit = decideRateLimit({ sentAt, now });
    if (!limit.allowed) {
      const discard = !!row.createdAt && rateLimitHoldExpired(row.createdAt, now);
      await deps.writeLog({
        organizationId: row.organizationId,
        flowId: row.flowId,
        stepId: step.id,
        contactId: row.contactId,
        queueId: row.id,
        status: "skipped_rate_limit",
        metadata: {
          ...snapshot,
          used: limit.used,
          max: AUTOMATION_RATE_LIMIT.maxMessages,
          windowHours: AUTOMATION_RATE_LIMIT.windowHours,
          action: discard ? "discarded" : "deferred",
          ...(discard ? {} : { retryAt: limit.retryAt.toISOString() }),
        },
      });
      if (discard) {
        await deps.markCancelled(row, "skipped_rate_limit");
        return "cancelled";
      }
      await deps.defer(row, limit.retryAt, "skipped_rate_limit");
      return "retry";
    }

    // En un flujo de cita, el mensaje puede decir cuándo es: {{fecha}} y {{hora}} en la zona del negocio.
    const tz = booking ? await deps.timezone(row.organizationId) : null;
    const bookingIso = booking?.scheduledAt.toISOString();
    // Una ejecución que nació de un anuncio sabe qué servicio u oferta lo trajo: `{{servicio}}`.
    const ctx = row.runId && deps.runContext ? await deps.runContext(row.organizationId, row.runId) : {};
    const servicio =
      typeof ctx.serviceName === "string" ? ctx.serviceName : typeof ctx.comboName === "string" ? ctx.comboName : null;
    const vars = {
      servicio,
      // Paso 3: `{{vars.clave}}`, lo que dejaron `set_var` y `code_js` antes de este paso.
      vars: readVars(ctx),
      // Premio de fidelidad: `{{premio}}`, `{{descuento}}` y `{{sellos}}` (vacías si la ejecución no nació de un premio).
      loyalty: readLoyaltyContext(ctx),
      // Venta cobrada: `{{monto}}` (y `{{servicio}}`, que viaja en `context.serviceName`).
      sale: readSaleContext(ctx),
      // Rescate de cumpleaños: `{{beneficio}}`, `{{cierre_mes}}`, `{{plazo}}`, `{{cumple}}`, `{{dias_restantes}}`.
      birthday: readBirthdayContext(ctx),
      name: target.contactName,
      fecha: bookingIso && tz ? dayLabelInTz(bookingIso, tz, now) : null,
      hora: bookingIso && tz ? timeInTz(bookingIso, tz) : null,
    };
    let payload: Record<string, unknown>;
    let sent: { messageId: string };
    if (isMedia && mediaFile) {
      const mc = cfgResult.data as { mediaId: string; caption?: string };
      const caption = mc.caption ? renderVars(mc.caption, vars) : undefined;
      payload = {
        mode: "media",
        conversationId: target.conversationId,
        mediaId: mc.mediaId,
        mimeType: mediaFile.mimeType,
        bytes: mediaFile.bytes,
        caption: caption ?? null,
      };
      sent = await deps.sendMedia({
        organizationId: row.organizationId,
        conversationId: target.conversationId,
        mediaId: mc.mediaId,
        ...(caption ? { caption } : {}),
      });
    } else if (decision.kind === "text") {
      const config = cfgResult.data as { content?: string };
      const text = renderVars(config.content!, vars);
      payload = { mode: "text", conversationId: target.conversationId, text };
      sent = await deps.sendText({
        organizationId: row.organizationId,
        conversationId: target.conversationId,
        text,
      });
    } else {
      const config = cfgResult.data as { templateId?: string; variables?: string[] };
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

  // Monedas: sin saldo (y con el corte activo) la plantilla no sale. No es un fallo del paso ni gasta intentos: se
  // retiene y se reintenta cada hora por si se recarga; pasado un par de días se descarta.
  if (c.code === "no_credit") {
    const heldTooLong = !!row.createdAt && now.getTime() - row.createdAt.getTime() > NO_CREDIT_HOLD_MS;
    if (heldTooLong) {
      await deps.markCancelled(row, "skipped_no_credit");
      return "cancelled";
    }
    await deps.defer(row, new Date(now.getTime() + NO_CREDIT_RETRY_MS), "skipped_no_credit");
    return "retry";
  }

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
