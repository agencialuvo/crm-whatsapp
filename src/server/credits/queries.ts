import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { decideGate, type AlertThreshold, type Gate } from "@/lib/credits";
import { creditsEnabled } from "./flag";
import { balanceOf, type Balance } from "./internal";

/**
 * Monedas — las consultas del flujo: el saldo y la decisión de corte. Solo lectura, salvo `claimAlert`, que es la
 * única escritura de aquí (reclamar un aviso, para que no se mande dos veces).
 */

export type CreditBalance = Balance & {
  unlimited: boolean;
  cutEnabled: boolean;
  overdraftLimit: number;
  planPeriodStart: Date | null;
  planPeriodEnd: Date | null;
};

/** El saldo de una organización, o `null` si no está medida (sin cuenta) o `CREDITS` está apagada. */
export async function getCreditBalance(organizationId: string): Promise<CreditBalance | null> {
  if (!creditsEnabled()) return null;
  const [acc] = await getDb()
    .select()
    .from(schema.creditAccount)
    .where(scoped(schema.creditAccount.organizationId, organizationId))
    .limit(1);
  if (!acc) return null;
  return {
    ...balanceOf(acc),
    unlimited: acc.unlimited,
    cutEnabled: acc.cutEnabled,
    overdraftLimit: acc.overdraftLimit,
    planPeriodStart: acc.planPeriodStart,
    planPeriodEnd: acc.planPeriodEnd,
  };
}

/** Lo que hace falta para decidir un aviso de saldo: los saldos y la cuota que se concedió en el periodo vigente. */
export type AlertState = {
  planBalance: number;
  topupBalance: number;
  /** Cuota concedida en el periodo vigente (concesión inicial + ajustes de plan), en unidades. */
  quota: number;
  periodStart: Date;
  /** El corte está activo (no es modo sombra): cambia lo que se le dice al dueño. */
  cutEnabled: boolean;
};

/**
 * El estado para los avisos, o `null` si no corresponde avisar: `CREDITS` apagada, sin cuenta, plan sin tope o aún
 * sin periodo cargado. Solo lectura.
 */
export async function getAlertState(organizationId: string): Promise<AlertState | null> {
  if (!creditsEnabled()) return null;
  const [acc] = await getDb()
    .select()
    .from(schema.creditAccount)
    .where(scoped(schema.creditAccount.organizationId, organizationId))
    .limit(1);
  if (!acc || acc.unlimited || !acc.planPeriodStart) return null;
  const [row] = await getDb()
    .select({ quota: sql<number>`coalesce(sum(${schema.creditLedger.amount}), 0)::int` })
    .from(schema.creditLedger)
    .where(
      scoped(
        schema.creditLedger.organizationId,
        organizationId,
        and(
          eq(schema.creditLedger.kind, "grant"),
          eq(schema.creditLedger.bucket, "plan"),
          eq(schema.creditLedger.periodStart, acc.planPeriodStart)
        )
      )
    );
  return { planBalance: acc.planBalance, topupBalance: acc.topupBalance, quota: row?.quota ?? 0, periodStart: acc.planPeriodStart, cutEnabled: acc.cutEnabled };
}

export type PeriodSpend = { ai: { count: number; units: number }; whatsapp: { count: number; units: number } };

/**
 * Lo que se ha descontado desde `from` (normalmente el inicio del periodo), por servicio: cuántos turnos o envíos y
 * cuántas unidades. Sale del LIBRO —lo que de verdad se cobró—, no de la medición; un gasto repartido entre cuota y
 * recargas cuenta una sola vez. Solo lectura. `null` con `CREDITS` apagada.
 */
export async function getPeriodSpend(organizationId: string, from: Date): Promise<PeriodSpend | null> {
  if (!creditsEnabled()) return null;
  const l = schema.creditLedger;
  const rows = await getDb()
    .select({
      service: l.service,
      count: sql<number>`count(*) filter (where ${l.idempotencyKey} not like '%~topup')::int`,
      units: sql<number>`coalesce(sum(-${l.amount}), 0)::int`,
    })
    .from(l)
    .where(scoped(l.organizationId, organizationId, eq(l.kind, "spend"), gte(l.createdAt, from)))
    .groupBy(l.service);
  const out: PeriodSpend = { ai: { count: 0, units: 0 }, whatsapp: { count: 0, units: 0 } };
  for (const r of rows) {
    if (r.service === "ai") out.ai = { count: r.count, units: r.units };
    if (r.service === "whatsapp") out.whatsapp = { count: r.count, units: r.units };
  }
  return out;
}

/**
 * ¿Se puede gastar? La pregunta que hace el flujo ANTES de llamar a la IA o de mandar una plantilla.
 *
 * Nunca lanza y, ante un fallo, DEJA PASAR (`reason: "error"`): cortar a un cliente por un problema propio es peor
 * que un consumo sin medir. Con `CREDITS` apagada, o sin cuenta (organización no medida, p. ej. sin suscripción),
 * deja pasar siempre. En modo sombra (`cut_enabled = false`) también deja pasar, pero `wouldCut` dice qué habría
 * pasado: es el dato para calibrar.
 */
export async function checkCredit(organizationId: string, opts: { amount?: number } = {}): Promise<Gate> {
  if (!creditsEnabled()) return { allow: true, wouldCut: false, reason: "off" };
  try {
    const bal = await getCreditBalance(organizationId);
    if (!bal) return { allow: true, wouldCut: false, reason: "no_account" };
    return decideGate({
      total: bal.total,
      overdraftLimit: bal.overdraftLimit,
      cutEnabled: bal.cutEnabled,
      unlimited: bal.unlimited,
      amount: opts.amount,
    });
  } catch (err) {
    console.error(`[monedas] no se pudo consultar el saldo de ${organizationId}; se deja pasar:`, err);
    return { allow: true, wouldCut: false, reason: "error" };
  }
}

/**
 * Reclama un aviso de saldo: `true` si ESTE llamador lo reclamó (y por tanto debe mandarlo), `false` si otro ya lo
 * hizo para esa organización, periodo y umbral. Con `CREDITS` apagada devuelve `false`: no se avisa de nada.
 */
export async function claimAlert(input: {
  organizationId: string;
  periodStart: Date;
  threshold: AlertThreshold;
}): Promise<boolean> {
  if (!creditsEnabled()) return false;
  const inserted = await getDb()
    .insert(schema.creditAlert)
    .values({
      id: newId("creditAlert"),
      organizationId: input.organizationId,
      periodStart: input.periodStart,
      threshold: input.threshold,
    })
    .onConflictDoNothing({
      target: [schema.creditAlert.organizationId, schema.creditAlert.periodStart, schema.creditAlert.threshold],
    })
    .returning({ id: schema.creditAlert.id });
  return inserted.length > 0;
}
