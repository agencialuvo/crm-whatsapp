import { sweepCalendarSync } from "@/server/agenda/calendar-sync/sync";
import { sweepGoogleBusy } from "@/server/agenda/calendar-busy/sync";

/**
 * Paso 3 — El temporizador de la sincronización con Google Calendar: cada minuto publica lo pendiente y los
 * reintentos que ya tocan (`sweepCalendarSync`) y —Paso 4— lee lo ocupado de los negocios a los que les toca
 * (`sweepGoogleBusy`: cada 5 min con todo bien, con espera creciente si Google falla). Solo arranca con la agenda encendida; sin ninguna cita
 * pendiente cuesta una consulta sobre un índice parcial casi vacío.
 */

const INTERVAL_MS = 60_000;

type State = { timer: NodeJS.Timeout | null; running: boolean };

// En globalThis: en dev los módulos se evalúan más de una vez y dos temporizadores se pisarían.
const g = globalThis as unknown as { __voceroCalendarSweeper?: State };
const state = (): State => (g.__voceroCalendarSweeper ??= { timer: null, running: false });

/** Una barrida. Nunca lanza ni se solapa consigo misma. */
export async function tickCalendarSync(): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = true;
  try {
    await sweepCalendarSync();
    await sweepGoogleBusy();
  } finally {
    s.running = false;
  }
}

export function startCalendarSyncSweeper(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => void tickCalendarSync(), INTERVAL_MS);
  s.timer.unref?.();
}
