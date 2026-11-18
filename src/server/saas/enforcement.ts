import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { effectiveStatus, paymentGraceEndsAt, type EffectiveStatus } from "@/lib/saas";
import { paymentGraceDays } from "@/lib/mercadopago/config";

/**
 * 045 — Cumplimiento de la suscripción (`SAAS_ENFORCE`, APAGADO por defecto).
 *
 * Hasta hoy nada hacía cumplir el estado de la suscripción: una prueba vencida, una suspendida o una cancelada
 * seguían con acceso completo. Activarlo de golpe bloquearía a las instalaciones propias y a los clientes
 * existentes, así que va detrás de una bandera de despliegue (patrón ADR-001):
 *
 *  - Apagada: solo se MUESTRA el estado (aviso «tu prueba termina en N días» y el panel de Super Admin).
 *  - Encendida: una organización cuyo estado efectivo es `trial_expired`, `past_due`, `canceled` o `paused` ve
 *    `/suscripcion-inactiva` en vez de la app, y su API responde 403 `SUBSCRIPTION_INACTIVE`. Las rutas de la
 *    cuenta (`withAccountAuth`), la autenticación, `/api/health` y los webhooks de mensajería quedan fuera:
 *    **los mensajes entrantes siguen guardándose** (no se pierde nada del cliente por una prueba vencida).
 *  - Una organización SIN suscripción (anterior al módulo SaaS) jamás se bloquea. Tampoco una de un plan anterior
 *    mientras esté activa o en prueba: esos planes no vencen solos.
 *  - El agente de IA y las automatizaciones NO se pausan en este paso (decisión del dueño).
 */

export function enforcementEnabled(): boolean {
  const v = process.env.SAAS_ENFORCE?.toLowerCase();
  return v === "true" || v === "on" || v === "1";
}

export type SubscriptionAccess = {
  /** null = la organización no tiene suscripción: nada se restringe. */
  status: EffectiveStatus | null;
  blocked: boolean;
  daysLeft: number | null;
  planName: string | null;
  currentPeriodEnd: Date | null;
  statusReason: string | null;
  /** 046: fin de la gracia tras un cobro rechazado (mientras dure, no se bloquea). */
  graceEndsAt: Date | null;
};

const BLOCKING: readonly EffectiveStatus[] = ["trial_expired", "past_due", "canceled", "paused"];

const CACHE_TTL_MS = 15_000;
const g = globalThis as unknown as { __voceroSubAccess?: Map<string, { at: number; value: SubscriptionAccess }> };
const cache = (): Map<string, { at: number; value: SubscriptionAccess }> => (g.__voceroSubAccess ??= new Map());

/** Una acción del panel cambia el estado: la próxima petición de esa organización lo ve de inmediato. */
export function invalidateSubscriptionAccess(organizationId?: string): void {
  if (organizationId) cache().delete(organizationId);
  else cache().clear();
}

export async function getSubscriptionAccess(organizationId: string, now = new Date(), useCache = true): Promise<SubscriptionAccess> {
  const hit = useCache ? cache().get(organizationId) : undefined;
  if (hit && now.getTime() - hit.at < CACHE_TTL_MS) return hit.value;
  const [row] = await getDb()
    .select({ sub: schema.subscription, plan: schema.plan })
    .from(schema.subscription)
    .innerJoin(schema.plan, eq(schema.subscription.planId, schema.plan.id))
    .where(scoped(schema.subscription.organizationId, organizationId))
    .limit(1);
  let value: SubscriptionAccess;
  if (!row) {
    value = { status: null, blocked: false, daysLeft: null, planName: null, currentPeriodEnd: null, statusReason: null, graceEndsAt: null };
  } else {
    const eff = effectiveStatus(row.sub, row.plan, now);
    const graceEndsAt = paymentGraceEndsAt(row.sub, paymentGraceDays());
    const inGrace = graceEndsAt !== null && now.getTime() <= graceEndsAt.getTime();
    value = {
      status: eff.status,
      // 046: un cobro rechazado da unos días de gracia (aviso, sin corte) antes de bloquear.
      blocked: BLOCKING.includes(eff.status) && !inGrace,
      graceEndsAt: inGrace ? graceEndsAt : null,
      daysLeft: eff.daysLeft,
      planName: row.plan.name,
      currentPeriodEnd: row.sub.currentPeriodEnd,
      statusReason: row.sub.statusReason,
    };
  }
  cache().set(organizationId, { at: now.getTime(), value });
  return value;
}

/** ¿Debe cortarse el acceso de esta organización? Solo con la bandera encendida. */
export async function subscriptionInactive(organizationId: string): Promise<SubscriptionAccess | null> {
  if (!enforcementEnabled()) return null;
  const access = await getSubscriptionAccess(organizationId);
  return access.blocked ? access : null;
}
