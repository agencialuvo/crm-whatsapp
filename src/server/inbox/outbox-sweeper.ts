import { sweepOutbox } from "@/server/inbox/outbox";

/**
 * 041 — El temporizador de la barredera de envíos (ver `sweepOutbox`).
 *
 * Es del núcleo, no un módulo opcional: corre siempre. Dentro del proceso, como el resto del
 * trabajo de fondo. Un tick sin trabajo cuesta una consulta sobre un índice casi vacío.
 */

const INTERVAL_MS = 60_000;

type State = { timer: NodeJS.Timeout | null; running: boolean };

// En globalThis: en dev los módulos se evalúan más de una vez y dos temporizadores se pisarían.
const g = globalThis as unknown as { __voceroOutboxSweeper?: State };
const state = (): State => (g.__voceroOutboxSweeper ??= { timer: null, running: false });

/** Una barrida. Nunca lanza. */
export async function tickOutbox(): Promise<{ rescued: number; purged: number }> {
  const s = state();
  if (s.running) return { rescued: 0, purged: 0 };
  s.running = true;
  try {
    const res = await sweepOutbox();
    if (res.rescued > 0) {
      console.warn(`[envio] ${res.rescued} envío(s) sin confirmar pasaron a fallido`);
    }
    return res;
  } catch (err) {
    console.error("[envio] la barredera falló:", err instanceof Error ? err.message : err);
    return { rescued: 0, purged: 0 };
  } finally {
    s.running = false;
  }
}

export function startOutboxSweeper(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => void tickOutbox(), INTERVAL_MS);
  s.timer.unref?.();
}
