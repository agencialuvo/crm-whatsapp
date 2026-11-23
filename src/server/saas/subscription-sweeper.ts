import { reconcileBilling } from "@/server/billing/reconcile";
import { closeCancelledPeriods, expireTrials } from "@/server/saas/subscription";
import { reconcileIfDue, syncAllQuotas } from "@/server/saas/credits-sync";

/**
 * 045 — El temporizador del vencimiento de pruebas (ver `expireTrials`).
 *
 * Es del núcleo: corre siempre, dentro del proceso, como la barredera de envíos. Cada hora basta: lo que
 * se ve en el panel ya deriva `trial_expired` en cada lectura; el temporizador solo lo PERSISTE (estado
 * `past_due`, evento `expired`) para que los reportes y el cobro vean lo mismo. Un tick sin trabajo cuesta
 * una consulta sobre `subscription_status_idx`.
 */

const INTERVAL_MS = 60 * 60 * 1000;

type State = { timer: NodeJS.Timeout | null; running: boolean };

// En globalThis: en dev los módulos se evalúan más de una vez y dos temporizadores se pisarían.
const g = globalThis as unknown as { __voceroSubscriptionSweeper?: State };
const state = (): State => (g.__voceroSubscriptionSweeper ??= { timer: null, running: false });

/** Una barrida (tandas de 200 hasta vaciar). Nunca lanza. */
export async function tickSubscriptions(now = new Date()): Promise<number> {
  const s = state();
  if (s.running) return 0;
  s.running = true;
  try {
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const n = await expireTrials(now);
      total += n;
      if (n < 200) break;
    }
    if (total > 0) console.log(`[saas] ${total} prueba(s) vencida(s) pasaron a past_due`);
    // 046: las canceladas que ya cumplieron su periodo pagado, y la red de seguridad del cobro (solo con la bandera).
    const closed = await closeCancelledPeriods(now);
    if (closed > 0) console.log(`[saas] ${closed} suscripción(es) cancelada(s) cumplieron su periodo`);
    await reconcileBilling(now);
    // Monedas: la cuota del periodo sigue a la suscripción. Va DESPUÉS y aparte: nunca lanza, y si falla la
    // suscripción ya quedó resuelta. Con `CREDITS` apagada no hace nada.
    const cuotas = await syncAllQuotas(now);
    if (cuotas > 0) console.log(`[monedas] ${cuotas} cuota(s) de periodo al día`);
    // Y una vez al día, la conciliación del saldo contra el libro (nunca lanza).
    await reconcileIfDue(now);
    return total;
  } catch (err) {
    console.error("[saas] el vencimiento de pruebas falló:", err instanceof Error ? err.message : err);
    return 0;
  } finally {
    s.running = false;
  }
}

export function startSubscriptionSweeper(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => void tickSubscriptions(), INTERVAL_MS);
  s.timer.unref?.();
}
