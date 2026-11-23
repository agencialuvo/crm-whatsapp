import { coinsToUnits } from "@/lib/credits";
import type { CreditsActionInput } from "@/lib/super-admin-credits";
import {
  adjustCredits,
  calibrationReport,
  configureCut,
  creditsEnabled,
  orgCreditDetail,
  type CalibrationReport,
  type OrgCreditDetail,
} from "@/server/credits";
import { lastReconcile, runReconcile, type ReconcileState } from "@/server/saas/credits-sync";

/**
 * Monedas — lo que el panel de Super Admin ve y hace. Es el ÚNICO camino de la API de Super Admin hacia la puerta de
 * monedas: las rutas no la importan directo. Todo lo que cambia saldo o corte pasa por las operaciones de la puerta
 * (idempotentes y con su registro en el libro: quién, cuánto y por qué).
 */

const DAY = 24 * 60 * 60 * 1000;

export type CreditsOverview = { report: CalibrationReport; reconcile: ReconcileState | null };

/** El reporte de calibración de los últimos `days` días y el último resultado de la conciliación. */
export async function creditsOverview(days: number, now: Date = new Date()): Promise<CreditsOverview> {
  const report = await calibrationReport({ from: new Date(now.getTime() - days * DAY), to: new Date(now.getTime() + 1000) });
  return { report, reconcile: lastReconcile() };
}

export async function creditsOrgDetail(organizationId: string, days = 30, now: Date = new Date()): Promise<OrgCreditDetail | null> {
  return orgCreditDetail(organizationId, { from: new Date(now.getTime() - days * DAY), to: new Date(now.getTime() + 1000) });
}

export type ActionOutcome =
  | { ok: true; duplicate: boolean }
  | { ok: false; status: 404 | 409 | 422; code: string; message: string };

const OFF: ActionOutcome = { ok: false, status: 409, code: "credits_off", message: "Las monedas están apagadas en esta instancia (CREDITS)." };

/** Aplica un ajuste manual o cambia el corte de UNA organización. */
export async function applyCreditsAction(
  admin: { userId: string },
  organizationId: string,
  input: CreditsActionInput
): Promise<ActionOutcome> {
  if (!creditsEnabled()) return OFF;
  const exists = await orgCreditDetail(organizationId, { from: new Date(), to: new Date() });
  if (!exists) return { ok: false, status: 404, code: "not_found", message: "Organización no encontrada" };

  if (input.action === "adjust") {
    const res = await adjustCredits({
      organizationId,
      bucket: input.bucket,
      amount: coinsToUnits(input.coins),
      idempotencyKey: `op:${input.requestId}`,
      actorUserId: admin.userId,
      note: input.note,
    });
    if (res.status === "rejected") {
      return { ok: false, status: 422, code: res.reason ?? "rejected", message: "La cuota del plan no puede quedar en negativo." };
    }
    if (res.status === "disabled") return OFF;
    console.info(`[monedas] ajuste de ${admin.userId} en ${organizationId}: ${input.bucket} ${input.coins} (${res.status})`);
    return { ok: true, duplicate: res.status === "duplicate" };
  }

  const res = await configureCut({
    organizationId,
    cutEnabled: input.cutEnabled,
    ...(input.overdraftCoins !== undefined ? { overdraftLimit: coinsToUnits(input.overdraftCoins) } : {}),
  });
  if (res.status === "disabled") return OFF;
  console.info(`[monedas] corte de ${organizationId} ${input.cutEnabled ? "ACTIVADO" : "desactivado"} por ${admin.userId}`);
  return { ok: true, duplicate: false };
}

/** Concilia ahora, a pedido del operador. `null` con las monedas apagadas. */
export async function reconcileNow(repair: boolean): Promise<ReconcileState | null> {
  return runReconcile({ repair });
}
