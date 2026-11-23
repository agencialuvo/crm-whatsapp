/**
 * Monedas (IA y WhatsApp) — la puerta única. Todo el que necesite medir, cobrar, abonar o consultar saldo entra por
 * aquí; nadie fuera de `src/server/credits/` escribe las tablas `credit_*` (lo vigila `credits-guard.test.ts`).
 *
 * Con `CREDITS` apagada (lo normal) nada de esto toca la base ni cambia el comportamiento del sistema.
 */

export { creditsEnabled, parseCreditsFlag } from "./flag";
export {
  adjustCredits,
  adjustPeriodQuota,
  applyTopup,
  configureCut,
  expirePeriodQuota,
  grantPeriodQuota,
  refundTopup,
  spendCredits,
  type OpResult,
  type OpStatus,
  type SpendResult,
} from "./ledger";
export { recordUsage, usageSummary, type UsageInput, type UsageResult, type UsageSummaryRow } from "./usage";
export { claimAlert, checkCredit, getAlertState, getCreditBalance, type AlertState, type CreditBalance } from "./queries";
export { priceFor, clearRateCache } from "./pricing";
export { createTopupIntent, ensureDefaultRates, getRate, getTopup, setRate, TOPUP_TTL_MS, type RateRow, type TopupRow } from "./catalog";
export { reconcileCredits, type Drift, type ReconcileResult } from "./reconcile";
export type { Balance } from "./internal";
