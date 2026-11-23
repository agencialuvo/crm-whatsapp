import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { idemKey, splitSpend, UNLIMITED, type Bucket, type LedgerService } from "@/lib/credits";
import { creditsEnabled } from "./flag";
import { assertInt, balanceOf, insertLedgerRow, lockAccount, saveAccount, type Balance } from "./internal";

/**
 * Monedas — la PUERTA ÚNICA del libro y de los saldos. Es el único archivo (con el resto de `server/credits/`) que
 * escribe las tablas `credit_*`: una prueba de vigilancia escanea `src/` y falla si otro lo hace. Enruta tu cambio
 * por aquí.
 *
 * Todas las operaciones son idempotentes por su clave (ver `idemKey`), atómicas (una transacción, con la cuenta
 * bloqueada) y, con `CREDITS` apagada, no hacen NADA: devuelven `disabled` sin tocar la base.
 */

export type OpStatus =
  /** Se aplicó. */
  | "applied"
  /** Esa clave ya se había aplicado: no se hizo nada más. */
  | "duplicate"
  /** `CREDITS` está apagada. */
  | "disabled"
  /** Plan sin tope: se mide pero no se descuenta. */
  | "unlimited"
  /** No había nada que hacer (cuota 0, nada que vencer, monto 0). */
  | "nothing"
  /** El periodo es anterior al ya cargado: se ignora para no pisar uno más nuevo. */
  | "stale"
  /** La operación no es válida (ver `reason`). */
  | "rejected";

export type OpResult = { status: OpStatus; balance?: Balance; reason?: string };
export type SpendResult = OpResult & { fromPlan?: number; fromTopup?: number };

const DISABLED: OpResult = { status: "disabled" };

/* ───────────────────────── Cuota del periodo ───────────────────────── */

/**
 * Carga la cuota de un periodo de suscripción (`units` = unidades, `UNLIMITED` = sin tope, 0 = el plan no incluye).
 *
 * Es la ÚNICA forma de que entre cuota al saldo del plan. Si la cuenta traía lo que sobró del periodo anterior, se
 * VENCE aquí mismo (la cuota no se acumula) y luego se concede la nueva, en la misma transacción. Repetir la llamada
 * con el mismo periodo no hace nada; con un periodo anterior al ya cargado, tampoco.
 */
export async function grantPeriodQuota(input: {
  organizationId: string;
  subscriptionId: string;
  periodStart: Date;
  periodEnd: Date;
  units: number;
  actorUserId?: string | null;
  note?: string | null;
}): Promise<OpResult> {
  if (!creditsEnabled()) return DISABLED;
  if (input.units !== UNLIMITED) {
    assertInt(input.units, "units");
    if (input.units < 0) throw new Error("units no puede ser negativo (usa UNLIMITED para «sin tope»)");
  }

  return getDb().transaction(async (tx): Promise<OpResult> => {
    const org = input.organizationId;
    const acc = await lockAccount(tx, org);
    const prev = acc.planPeriodStart;
    if (prev && input.periodStart.getTime() < prev.getTime()) return { status: "stale", balance: balanceOf(acc) };

    const samePeriod = prev?.getTime() === input.periodStart.getTime();
    const key = idemKey.grant(input.subscriptionId, input.periodStart);
    let plan = acc.planBalance;

    // La cuota no se acumula: lo que sobró del periodo anterior vence antes de cargar la nueva.
    if (!samePeriod && plan > 0) {
      const expireKey = prev ? idemKey.expire(prev) : `expire:pre:${key}`;
      const expired = await insertLedgerRow(tx, {
        organizationId: org,
        kind: "expire",
        bucket: "plan",
        amount: -plan,
        key: expireKey,
        refType: "subscription",
        refId: input.subscriptionId,
        periodStart: prev ?? null,
        actorUserId: input.actorUserId,
        note: "La cuota del periodo anterior venció",
      });
      if (expired) plan = 0;
    }

    const base = { planPeriodStart: input.periodStart, planPeriodEnd: input.periodEnd };

    if (input.units === UNLIMITED) {
      await saveAccount(tx, org, { ...base, planBalance: plan, unlimited: true });
      return { status: "unlimited", balance: balanceOf({ planBalance: plan, topupBalance: acc.topupBalance }) };
    }
    if (input.units === 0) {
      await saveAccount(tx, org, { ...base, planBalance: plan, unlimited: false });
      return { status: "nothing", reason: "zero_quota", balance: balanceOf({ planBalance: plan, topupBalance: acc.topupBalance }) };
    }

    const granted = await insertLedgerRow(tx, {
      organizationId: org,
      kind: "grant",
      bucket: "plan",
      amount: input.units,
      key,
      refType: "subscription",
      refId: input.subscriptionId,
      periodStart: input.periodStart,
      actorUserId: input.actorUserId,
      note: input.note ?? null,
    });
    if (!granted) {
      // Ya estaba concedida. Si arriba se venció algo, la caché tiene que reflejarlo igual.
      await saveAccount(tx, org, { planBalance: plan });
      return { status: "duplicate", balance: balanceOf({ planBalance: plan, topupBalance: acc.topupBalance }) };
    }
    plan += input.units;
    await saveAccount(tx, org, { ...base, planBalance: plan, unlimited: false });
    return { status: "applied", balance: balanceOf({ planBalance: plan, topupBalance: acc.topupBalance }) };
  });
}

/**
 * Vence lo que quede de la cuota de un periodo que se cerró sin renovarse (suscripción cancelada o vencida).
 * Solo actúa si ese es el periodo cargado: nunca vence una cuota más nueva.
 */
export async function expirePeriodQuota(input: {
  organizationId: string;
  periodStart: Date;
  note?: string | null;
}): Promise<OpResult> {
  if (!creditsEnabled()) return DISABLED;
  return getDb().transaction(async (tx): Promise<OpResult> => {
    const org = input.organizationId;
    const acc = await lockAccount(tx, org);
    if (!acc.planPeriodStart || acc.planPeriodStart.getTime() !== input.periodStart.getTime()) {
      return { status: "stale", balance: balanceOf(acc) };
    }
    if (acc.planBalance <= 0) return { status: "nothing", reason: "no_leftover", balance: balanceOf(acc) };

    const expired = await insertLedgerRow(tx, {
      organizationId: org,
      kind: "expire",
      bucket: "plan",
      amount: -acc.planBalance,
      key: idemKey.expire(input.periodStart),
      refType: "subscription",
      periodStart: input.periodStart,
      note: input.note ?? "La cuota del periodo venció",
    });
    if (!expired) return { status: "duplicate", balance: balanceOf(acc) };
    await saveAccount(tx, org, { planBalance: 0 });
    return { status: "applied", balance: balanceOf({ planBalance: 0, topupBalance: acc.topupBalance }) };
  });
}

/* ───────────────────────── Gasto ───────────────────────── */

/**
 * Descuenta un consumo YA HECHO (la IA ya contestó, Meta ya aceptó el mensaje): primero de la cuota del plan y, si
 * no alcanza, de las recargas. Un gasto hecho SIEMPRE se registra, aunque deje el saldo en negativo: el corte es
 * una decisión previa (`checkCredit`), no una que se pueda tomar después de gastar.
 *
 * Idempotente por `idempotencyKey` (`idemKey.aiTurn`, `idemKey.waMessage`): un reintento del mismo turno o del
 * mismo envío no cobra dos veces. Un plan sin tope no descuenta nada.
 */
export async function spendCredits(input: {
  organizationId: string;
  service: LedgerService;
  amount: number;
  idempotencyKey: string;
  refType?: string | null;
  refId?: string | null;
  meta?: Record<string, unknown> | null;
  actorUserId?: string | null;
  note?: string | null;
}): Promise<SpendResult> {
  if (!creditsEnabled()) return DISABLED;
  assertInt(input.amount, "amount");
  if (input.amount < 0) throw new Error("amount no puede ser negativo");
  if (input.amount === 0) return { status: "nothing", reason: "zero_amount" };

  return getDb().transaction(async (tx): Promise<SpendResult> => {
    const org = input.organizationId;
    const acc = await lockAccount(tx, org);
    if (acc.unlimited) return { status: "unlimited", balance: balanceOf(acc) };

    const { fromPlan, fromTopup } = splitSpend(acc, input.amount);
    const common = {
      organizationId: org,
      kind: "spend" as const,
      service: input.service,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      actorUserId: input.actorUserId,
      note: input.note ?? null,
      meta: input.meta ?? null,
    };

    // La PRIMERA fila lleva la clave de la operación: si no entra, ya se cobró.
    const first =
      fromPlan > 0
        ? { bucket: "plan" as const, amount: -fromPlan, key: input.idempotencyKey }
        : { bucket: "topup" as const, amount: -fromTopup, key: input.idempotencyKey };
    if (!(await insertLedgerRow(tx, { ...common, ...first }))) {
      return { status: "duplicate", balance: balanceOf(acc) };
    }
    // Gasto que toca los dos saldos: la segunda fila lleva la clave derivada.
    if (fromPlan > 0 && fromTopup > 0) {
      await insertLedgerRow(tx, {
        ...common,
        bucket: "topup",
        amount: -fromTopup,
        key: idemKey.secondRow(input.idempotencyKey),
      });
    }

    const next = { planBalance: acc.planBalance - fromPlan, topupBalance: acc.topupBalance - fromTopup };
    await saveAccount(tx, org, next);
    return { status: "applied", fromPlan, fromTopup, balance: balanceOf(next) };
  });
}

/* ───────────────────────── Recargas, reembolsos y ajustes ───────────────────────── */

/**
 * Abona una recarga al saldo de recargas (no vence). Si viene de una compra (`topupId`), la marca pagada en la misma
 * transacción; abonarla dos veces —un webhook duplicado— no hace nada: la clave es el id de la compra.
 */
export async function applyTopup(input: {
  organizationId: string;
  /** Unidades. Si se omite y hay `topupId`, son las de la compra. */
  units?: number;
  topupId?: string | null;
  mpPaymentId?: string | null;
  /** Obligatoria si no hay `topupId` (un abono sin compra: cortesía, migración). */
  idempotencyKey?: string;
  actorUserId?: string | null;
  note?: string | null;
}): Promise<OpResult> {
  if (!creditsEnabled()) return DISABLED;
  if (!input.topupId && !input.idempotencyKey) throw new Error("applyTopup necesita topupId o idempotencyKey");

  return getDb().transaction(async (tx): Promise<OpResult> => {
    const org = input.organizationId;
    const acc = await lockAccount(tx, org);

    let units = input.units;
    if (input.topupId) {
      const [purchase] = await tx
        .select()
        .from(schema.creditTopup)
        .where(scoped(schema.creditTopup.organizationId, org, eq(schema.creditTopup.id, input.topupId)))
        .limit(1)
        .for("update");
      if (!purchase) return { status: "rejected", reason: "topup_not_found", balance: balanceOf(acc) };
      if (purchase.status === "paid") return { status: "duplicate", balance: balanceOf(acc) };
      units ??= purchase.units;
    }
    if (units === undefined) throw new Error("applyTopup necesita units o topupId");
    assertInt(units, "units");
    if (units <= 0) throw new Error("units debe ser positivo");

    const key = input.idempotencyKey ?? idemKey.topup(input.topupId!);
    const applied = await insertLedgerRow(tx, {
      organizationId: org,
      kind: "topup",
      bucket: "topup",
      amount: units,
      key,
      refType: input.topupId ? "topup" : null,
      refId: input.topupId ?? null,
      actorUserId: input.actorUserId,
      note: input.note ?? null,
      meta: input.mpPaymentId ? { mpPaymentId: input.mpPaymentId } : null,
    });
    if (!applied) return { status: "duplicate", balance: balanceOf(acc) };

    if (input.topupId) {
      await tx
        .update(schema.creditTopup)
        .set({ status: "paid", mpPaymentId: input.mpPaymentId ?? null, completedAt: new Date() })
        .where(and(scoped(schema.creditTopup.organizationId, org, eq(schema.creditTopup.id, input.topupId)), ne(schema.creditTopup.status, "paid")));
    }
    const next = { planBalance: acc.planBalance, topupBalance: acc.topupBalance + units };
    await saveAccount(tx, org, { topupBalance: next.topupBalance });
    return { status: "applied", balance: balanceOf(next) };
  });
}

/** Devuelve (descuenta) una recarga que se reembolsó o se disputó. Puede dejar las recargas en negativo. */
export async function refundTopup(input: {
  organizationId: string;
  topupId: string;
  /** Unidades a descontar; por omisión, las de la compra. */
  units?: number;
  actorUserId?: string | null;
  note?: string | null;
}): Promise<OpResult> {
  if (!creditsEnabled()) return DISABLED;
  return getDb().transaction(async (tx): Promise<OpResult> => {
    const org = input.organizationId;
    const acc = await lockAccount(tx, org);
    const [purchase] = await tx
      .select()
      .from(schema.creditTopup)
      .where(scoped(schema.creditTopup.organizationId, org, eq(schema.creditTopup.id, input.topupId)))
      .limit(1)
      .for("update");
    if (!purchase) return { status: "rejected", reason: "topup_not_found", balance: balanceOf(acc) };
    const units = input.units ?? purchase.units;
    assertInt(units, "units");
    if (units <= 0) throw new Error("units debe ser positivo");

    const done = await insertLedgerRow(tx, {
      organizationId: org,
      kind: "refund",
      bucket: "topup",
      amount: -units,
      key: idemKey.refund(input.topupId),
      refType: "topup",
      refId: input.topupId,
      actorUserId: input.actorUserId,
      note: input.note ?? null,
    });
    if (!done) return { status: "duplicate", balance: balanceOf(acc) };
    await tx
      .update(schema.creditTopup)
      .set({ status: "refunded" })
      .where(scoped(schema.creditTopup.organizationId, org, eq(schema.creditTopup.id, input.topupId)));
    const next = { planBalance: acc.planBalance, topupBalance: acc.topupBalance - units };
    await saveAccount(tx, org, { topupBalance: next.topupBalance });
    return { status: "applied", balance: balanceOf(next) };
  });
}

/**
 * Ajuste manual (Super Admin, soporte): suma o resta al saldo indicado. Siempre con quien lo hizo y por qué. La
 * cuota del plan no puede quedar por debajo de 0; las recargas sí (deuda).
 */
export async function adjustCredits(input: {
  organizationId: string;
  bucket: Bucket;
  /** Con signo, en unidades. No puede ser 0. */
  amount: number;
  idempotencyKey: string;
  actorUserId: string;
  note: string;
}): Promise<OpResult> {
  if (!creditsEnabled()) return DISABLED;
  assertInt(input.amount, "amount");
  if (input.amount === 0) throw new Error("amount no puede ser 0");
  if (!input.note.trim()) throw new Error("Un ajuste necesita su motivo (note)");

  return getDb().transaction(async (tx): Promise<OpResult> => {
    const org = input.organizationId;
    const acc = await lockAccount(tx, org);
    if (input.bucket === "plan" && acc.planBalance + input.amount < 0) {
      return { status: "rejected", reason: "plan_would_be_negative", balance: balanceOf(acc) };
    }
    const done = await insertLedgerRow(tx, {
      organizationId: org,
      kind: "adjustment",
      bucket: input.bucket,
      amount: input.amount,
      key: input.idempotencyKey,
      refType: "adjustment",
      actorUserId: input.actorUserId,
      note: input.note.trim(),
    });
    if (!done) return { status: "duplicate", balance: balanceOf(acc) };
    const next =
      input.bucket === "plan"
        ? { planBalance: acc.planBalance + input.amount, topupBalance: acc.topupBalance }
        : { planBalance: acc.planBalance, topupBalance: acc.topupBalance + input.amount };
    await saveAccount(tx, org, next);
    return { status: "applied", balance: balanceOf(next) };
  });
}

/** Activa o desactiva el corte de UNA organización y fija cuánto negativo tolera. Es el paso del modo sombra al corte. */
export async function configureCut(input: {
  organizationId: string;
  cutEnabled?: boolean;
  overdraftLimit?: number;
}): Promise<OpResult> {
  if (!creditsEnabled()) return DISABLED;
  if (input.overdraftLimit !== undefined) {
    assertInt(input.overdraftLimit, "overdraftLimit");
    if (input.overdraftLimit < 0) throw new Error("overdraftLimit no puede ser negativo");
  }
  return getDb().transaction(async (tx): Promise<OpResult> => {
    const acc = await lockAccount(tx, input.organizationId);
    await saveAccount(tx, input.organizationId, {
      ...(input.cutEnabled !== undefined ? { cutEnabled: input.cutEnabled } : {}),
      ...(input.overdraftLimit !== undefined ? { overdraftLimit: input.overdraftLimit } : {}),
    });
    return { status: "applied", balance: balanceOf(acc) };
  });
}
