import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { thresholdFor, formatCoins, type AlertThreshold } from "@/lib/credits";
import { claimAlert, creditsEnabled, getAlertState } from "@/server/credits";
import { getBranding } from "@/server/branding";
import { sendMail } from "@/server/email/mailer";
import { notify } from "@/server/notifications/service";

/**
 * Monedas — los avisos de saldo. Tres umbrales por periodo (`warn80`: queda ≤ 20 % de la cuota, `exhausted`: se acabó
 * la cuota del plan y solo quedan recargas, `zero`: sin nada), cada uno UNA vez por organización y periodo: el
 * «una vez» lo garantiza `claimAlert` (`credit_alert`, única por organización + periodo + umbral), así que dos
 * consumos simultáneos, un reintento o un reinicio no repiten el aviso.
 *
 * Sale por la campanita (`notify`) y por correo a los dueños y administradores. El correo es mejor esfuerzo: sin
 * SMTP (o con el servidor caído) se registra y se sigue. Nada de aquí lanza: un aviso jamás tumba el consumo que lo
 * originó. Con `CREDITS` apagada no hace nada ni toca la base.
 */

type Copy = { title: string; message: string };

export function alertCopy(threshold: AlertThreshold, state: { planBalance: number; topupBalance: number; quota: number; cutEnabled: boolean }): Copy {
  const quota = formatCoins(state.quota);
  const topup = formatCoins(Math.max(state.topupBalance, 0));
  const cut = state.cutEnabled;
  switch (threshold) {
    case "warn80":
      return {
        title: "Te quedan pocas monedas",
        message: `Ya usaste más del 80 % de las ${quota} monedas de tu plan este mes. Recarga a tiempo para que tu agente y tus plantillas no se detengan.`,
      };
    case "exhausted":
      return {
        title: "Se acabó la cuota de tu plan",
        message: `Usaste las ${quota} monedas incluidas en tu plan. ${state.topupBalance > 0 ? `Sigues con ${topup} monedas de recarga.` : ""} La cuota se renueva con tu próximo periodo.`.replace(/\s+/g, " ").trim(),
      };
    case "zero":
      return {
        title: "Te quedaste sin monedas",
        message: cut
          ? "Tu agente de IA dejó de contestar y las plantillas de WhatsApp no saldrán hasta que recargues o se renueve tu plan."
          : "Te quedaste sin monedas. Recarga o sube de plan para evitar que el agente y las plantillas se detengan.",
      };
  }
}

/** Dueños y administradores de la organización: a quienes les toca saber de la facturación. */
async function recipients(organizationId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, organizationId), inArray(schema.member.role, ["owner", "admin"])));
  return [...new Set(rows.map((r) => r.email.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Evalúa el saldo de la organización y, si cruzó un umbral que aún no se avisó en este periodo, avisa. Devuelve el
 * umbral avisado (o `null`). Nunca lanza.
 */
export async function notifyBalanceIfNeeded(organizationId: string): Promise<AlertThreshold | null> {
  if (!creditsEnabled()) return null;
  try {
    const state = await getAlertState(organizationId);
    if (!state) return null;
    const threshold = thresholdFor(state);
    if (!threshold) return null;
    if (!(await claimAlert({ organizationId, periodStart: state.periodStart, threshold }))) return null;

    const copy = alertCopy(threshold, state);
    await notify(organizationId, { title: copy.title, message: copy.message, category: "sistema", link: "/ajustes" });

    const to = await recipients(organizationId).catch(() => []);
    if (to.length > 0) {
      const branding = await getBranding(organizationId).catch(() => null);
      await Promise.all(
        to.map((address) =>
          sendMail({
            to: address,
            subject: copy.title,
            text: `${copy.message}\n\nEntra a tu cuenta para revisar tu saldo de monedas.`,
            fromName: branding?.name,
          }).catch((err) =>
            // Sin SMTP configurado no es un error de nadie: la campanita ya avisó.
            console.warn(`[monedas] aviso por correo no enviado (${threshold}):`, err instanceof Error ? err.message : "error")
          )
        )
      );
    }
    return threshold;
  } catch (err) {
    console.error(`[monedas] aviso de saldo de ${organizationId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
