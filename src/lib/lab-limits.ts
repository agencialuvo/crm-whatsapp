/**
 * Mejora 8 — Tope de costo del Laboratorio. Puro.
 *
 * Cada corrida son decenas de llamadas al modelo (un turno por línea de cada persona más el juez) y se pagan con
 * la llave de la plataforma sin descontar monedas (`ai_lab`: se mide, nunca se cobra). Sin tope, una cuenta en
 * Demo podía correrlo sin fin. Ahora:
 *  - corridas por organización en las últimas 24 horas: `LAB_RUNS_PER_DAY_TRIAL` en Demo, sin saldo o con la
 *    suscripción no activa; `LAB_RUNS_PER_DAY_ACTIVE` con la suscripción activa (o sin módulo de suscripciones);
 *  - casos por corrida (`LAB_MAX_CASES`) y turnos por caso (`LAB_MAX_TURNS_PER_CASE`).
 */

export const LAB_RUNS_PER_DAY_TRIAL = 5;
export const LAB_RUNS_PER_DAY_ACTIVE = 25;
export const LAB_MAX_CASES = 8;
export const LAB_MAX_TURNS_PER_CASE = 6;
export const LAB_WINDOW_MS = 24 * 60 * 60 * 1000;

export function labDailyLimit(input: {
  /** Estado efectivo de la suscripción; `null` = la organización no tiene suscripción (nada se restringe). */
  subscriptionStatus: string | null;
  /** Monedas encendidas, sin saldo y sin cuenta ilimitada. */
  sinSaldo: boolean;
}): number {
  if (input.sinSaldo) return LAB_RUNS_PER_DAY_TRIAL;
  if (input.subscriptionStatus === null || input.subscriptionStatus === "active") return LAB_RUNS_PER_DAY_ACTIVE;
  return LAB_RUNS_PER_DAY_TRIAL;
}

/** El mensaje para el dueño cuando ya usó su cupo. */
export function labLimitMessage(limit: number): string {
  return `Llegaste al máximo de ${limit} corridas del Laboratorio en 24 horas. Podrás correr otra cuando pase la más antigua.`;
}
