import { sendText } from "@/server/inbox/send";
import { sendTemplate } from "@/server/whatsapp/templates";
import { processRow, type Deps, type Row } from "@/server/automation/engine";
import * as queue from "@/server/automation/queue";
import { runBirthdayTrigger } from "@/server/automation/triggers";

/**
 * Automatizaciones — el worker: cada cierto tiempo toma las tareas vencidas de `automation_queue` y
 * las ejecuta con el motor.
 *
 * Dentro del proceso, como el resto del trabajo de fondo (sin colas externas: constitución II). Lo
 * que lo hace fiable no es el proceso sino la cola: si el contenedor se cae a mitad, la toma
 * (`locked_at`) vence y la tarea se reclama; si hay varias instancias, `claimDue` reparte las filas
 * sin repetirlas. Apagado por la bandera `AUTOMATIONS` (ver `flag.ts`): no arranca.
 */

const INTERVAL_MS = 10_000;
const BATCH = 10;

/** Cableado real del motor: base de datos y los envíos con su guarda de sandbox. */
export function defaultDeps(): Deps {
  return {
    now: () => new Date(),
    loadStep: queue.loadStep,
    isFlowActive: queue.isFlowActive,
    loadTarget: queue.loadTarget,
    templateStatus: queue.templateStatus,
    // Nunca de IA (`aiGenerated`): lo escribió el dueño del negocio, no el agente.
    sendText: (input) => sendText(input),
    sendTemplate: (input) => sendTemplate(input),
    waMessageIdOf: queue.waMessageIdOf,
    hasSuccessLog: queue.hasSuccessLog,
    writeLog: queue.writeLog,
    completeAndAdvance: (row, nextAt) => queue.completeAndAdvance(row as queue.QueueRow, nextAt),
    markFailed: (row, error) => queue.markFailed(row as queue.QueueRow, error),
    markCancelled: (row, reason) => queue.markCancelled(row as queue.QueueRow, reason),
    reschedule: (row, at, error) => queue.reschedule(row as queue.QueueRow, at, error),
  };
}

type State = { timer: NodeJS.Timeout | null; running: boolean };

// En globalThis porque en dev los módulos se evalúan más de una vez: dos temporizadores sobre la
// misma cola se pisarían (el candado evita duplicar envíos, pero no el trabajo doble).
const g = globalThis as unknown as { __voceroAutomationWorker?: State };
const state = (): State => (g.__voceroAutomationWorker ??= { timer: null, running: false });

/** Una pasada. Devuelve cuántas tareas tomó. */
export async function tickAutomations(
  now: Date = new Date(),
  deps: Deps = defaultDeps(),
  batch: number = BATCH
): Promise<number> {
  const s = state();
  if (s.running) return 0;
  s.running = true;
  try {
    await queue.failExhausted(now);
    const rows = await queue.claimDue(batch, now);
    for (const row of rows) {
      try {
        await processRow(row as Row, deps);
      } catch (err) {
        // `processRow` ya captura lo suyo; esto es la red última: una tarea rara no frena a las demás.
        console.error(`[automatizaciones] la tarea ${row.id} falló fuera del motor:`, err);
      }
    }
    return rows.length;
  } catch (err) {
    console.error("[automatizaciones] la pasada falló:", err);
    return 0;
  } finally {
    s.running = false;
  }
}

export function startAutomationWorker(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => void tickAutomations(), INTERVAL_MS);
  // `unref` para que el temporizador no impida que el proceso termine.
  s.timer.unref?.();
}

export function stopAutomationWorker(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}


/**
 * El barrido de cumpleaños corre al arrancar y cada rato, no «una vez al día»: es idempotente (una vez
 * por contacto, flujo y año), así que repetirlo es gratis, y a cambio no depende de que la app estuviera
 * encendida a una hora exacta ni de la zona horaria de cada negocio.
 */
const TRIGGER_INTERVAL_MS = 30 * 60_000;

type TriggerState = { timer: NodeJS.Timeout | null; running: boolean };
const gt = globalThis as unknown as { __voceroAutomationTriggers?: TriggerState };
const triggerState = (): TriggerState =>
  (gt.__voceroAutomationTriggers ??= { timer: null, running: false });

/** Una pasada del barrido. Nunca lanza. */
export async function tickTriggers(now: Date = new Date()): Promise<void> {
  const s = triggerState();
  if (s.running) return;
  s.running = true;
  try {
    const run = await runBirthdayTrigger(now);
    if (run.enqueued > 0) {
      console.log(`[automatizaciones] cumpleaños: ${run.enqueued} saludo(s) en cola`);
    }
  } catch (err) {
    console.error("[automatizaciones] el barrido de disparadores falló:", err);
  } finally {
    s.running = false;
  }
}

export function startTriggerScheduler(): void {
  const s = triggerState();
  if (s.timer) return;
  s.timer = setInterval(() => void tickTriggers(), TRIGGER_INTERVAL_MS);
  s.timer.unref?.();
}

export function stopTriggerScheduler(): void {
  const s = triggerState();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}
