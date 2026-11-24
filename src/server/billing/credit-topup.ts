import { and, asc, eq, gt, isNotNull, lt } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { culqi, CulqiApiError } from "@/lib/culqi/client";
import { culqiEnabled, culqiPublicKey } from "@/lib/culqi/config";
import { applyTopup, closePendingTopup, createTopupIntent, creditsEnabled, getTopup, noteTopupIssue, refundTopup, setTopupGateway, type TopupRow } from "@/server/credits";

/**
 * Monedas 5.4 — la compra de recargas con Culqi. Une tres piezas que NO se conocen entre sí: el catálogo de paquetes
 * (`createTopupIntent`), Culqi (`@/lib/culqi/client`) y el libro de monedas (`applyTopup`/`refundTopup`). Es el único
 * lugar que las junta, y no toca nada de la suscripción (Mercado Pago).
 *
 * Reglas que no se negocian:
 * - Las monedas se abonan SOLO tras consultar la orden a Culqi con la llave secreta y comprobar que está pagada, que
 *   su `order_number` es el id de nuestra compra y que monto y moneda coinciden con lo que copiamos del paquete.
 *   Lo que diga un aviso del webhook nunca basta.
 * - Abonar y reembolsar son idempotentes (la clave es el id de la compra, en el libro): un aviso repetido, dos
 *   consultas a la vez o el barrido que se cruza con el webhook no duplican saldo.
 * - Un pago que llega tarde (la compra ya estaba abandonada) igual se abona: el dinero ya se cobró.
 * - Con `CREDITS` apagada o `CULQI` apagada, no se crea ni se cobra nada.
 */

const MAX_PENDING = 5;
const RECONCILE_MIN_AGE_MS = 2 * 60 * 1000;
const RECONCILE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export type PurchaseFail = { ok: false; status: 404 | 409 | 422 | 429 | 502 | 503; code: string; message: string };

export type StartPurchase =
  | {
      ok: true;
      topupId: string;
      orderId: string;
      publicKey: string | null;
      paymentCode: string | null;
      units: number;
      amountCents: number;
      currency: string;
      expiresAt: string;
    }
  | PurchaseFail;

const fail = (status: PurchaseFail["status"], code: string, message: string): PurchaseFail => ({ ok: false, status, code, message });

/** Un texto de error seguro para guardar y mostrar (sin llaves, acotado). */
const safeReason = (err: unknown): string => (err instanceof Error ? err.message : "error").slice(0, 200);

/** Crea la compra de un paquete ACTIVO y su orden en Culqi. Devuelve lo que el checkout necesita para cobrar. */
export async function startTopupPurchase(input: { organizationId: string; userId: string; packId: string; phone?: string | null; now?: Date }): Promise<StartPurchase> {
  if (!creditsEnabled()) return fail(404, "not_found", "No disponible");
  if (!culqiEnabled()) return fail(503, "not_configured", "El pago de recargas no está configurado");
  const now = input.now ?? new Date();
  const db = getDb();

  // Tope de compras abiertas por organización: no se puede inundar a Culqi ni a la tabla.
  const open = await db
    .select({ id: schema.creditTopup.id })
    .from(schema.creditTopup)
    .where(and(eq(schema.creditTopup.organizationId, input.organizationId), eq(schema.creditTopup.status, "pending"), gt(schema.creditTopup.expiresAt, now)))
    .limit(MAX_PENDING);
  if (open.length >= MAX_PENDING) return fail(429, "too_many_pending", "Ya tienes varias recargas sin completar; termínalas o espera a que venzan");

  const [person] = await db.select({ name: schema.user.name, email: schema.user.email }).from(schema.user).where(eq(schema.user.id, input.userId)).limit(1);
  if (!person) return fail(404, "not_found", "Usuario no encontrado");

  const intent = await createTopupIntent({ organizationId: input.organizationId, packId: input.packId, userId: input.userId, now });
  if (intent.status === "disabled") return fail(404, "not_found", "No disponible");
  if (intent.status === "pack_not_found") return fail(404, "pack_not_found", "Ese paquete no existe o no está disponible");
  const topup = intent.topup;

  const [first, ...rest] = person.name.trim().split(/\s+/);
  let order;
  try {
    order = await culqi.createOrder({
      amount: topup.amountCents,
      currency_code: topup.currency,
      description: "Recarga de monedas",
      order_number: topup.id,
      expiration_date: Math.floor(topup.expiresAt.getTime() / 1000),
      client_details: {
        first_name: first || "Cliente",
        last_name: rest.join(" ") || "-",
        email: person.email,
        // Culqi pide solo dígitos (sin el «+»).
        ...(input.phone ? { phone_number: input.phone.replace(/\D/g, "") } : {}),
      },
      confirm: false,
    });
  } catch (err) {
    await closePendingTopup(topup.organizationId, topup.id, "failed", safeReason(err));
    console.error("[culqi] no se pudo crear la orden:", safeReason(err));
    return fail(502, "gateway_error", "No se pudo iniciar el pago. Inténtalo de nuevo en un momento");
  }
  await setTopupGateway(topup.organizationId, topup.id, { gateway: "culqi", orderId: order.id });
  return {
    ok: true,
    topupId: topup.id,
    orderId: order.id,
    publicKey: culqiPublicKey(),
    paymentCode: order.paymentCode,
    units: topup.units,
    amountCents: topup.amountCents,
    currency: topup.currency,
    expiresAt: topup.expiresAt.toISOString(),
  };
}

export type ConfirmResult =
  | { status: "applied" | "duplicate" }
  | { status: "pending" }
  | { status: "closed" }
  | { status: "ignored"; reason: "unknown_order" | "unknown_state" }
  | { status: "mismatch" }
  | { status: "disabled" };

/** La compra a la que pertenece una orden: por su id en la pasarela o, si no quedó guardado, por su `order_number`. */
async function topupOfOrder(orderId: string, orderNumber: string | null): Promise<TopupRow | null> {
  const db = getDb();
  const [byOrder] = await db.select().from(schema.creditTopup).where(eq(schema.creditTopup.gatewayOrderId, orderId)).limit(1);
  if (byOrder) return byOrder;
  if (!orderNumber) return null;
  const [byNumber] = await db.select().from(schema.creditTopup).where(eq(schema.creditTopup.id, orderNumber)).limit(1);
  // Una compra que ya apunta a OTRA orden no se adopta: el `order_number` por sí solo no es prueba.
  return byNumber && (byNumber.gatewayOrderId === null || byNumber.gatewayOrderId === orderId) ? byNumber : null;
}

/**
 * Asienta una orden: consulta su estado real a Culqi y actúa. Puede lanzar `CulqiApiError` (el webhook responde 5xx y
 * Culqi reintenta). Idempotente: se puede llamar cuantas veces haga falta, desde el webhook, el barrido o la pantalla.
 */
export async function confirmOrder(orderId: string): Promise<ConfirmResult> {
  if (!creditsEnabled()) return { status: "disabled" };
  const order = await culqi.getOrder(orderId);
  const topup = await topupOfOrder(order.id, order.orderNumber);
  if (!topup) return { status: "ignored", reason: "unknown_order" };

  if (order.state === "paid") {
    const coincide = order.orderNumber === topup.id && order.amount === topup.amountCents && order.currency === topup.currency;
    if (!coincide) {
      console.error(`[culqi] la orden ${order.id} está pagada pero no coincide con la compra ${topup.id}: no se abona`);
      await noteTopupIssue(topup.organizationId, topup.id, "El pago no coincide con la compra (monto, moneda o referencia)");
      return { status: "mismatch" };
    }
    await setTopupGateway(topup.organizationId, topup.id, { gateway: "culqi", orderId: order.id, chargeId: order.chargeId ?? undefined });
    const r = await applyTopup({ organizationId: topup.organizationId, topupId: topup.id, mpPaymentId: order.id, note: "Recarga con Culqi" });
    if (r.status === "applied") return { status: "applied" };
    if (r.status === "duplicate") return { status: "duplicate" };
    if (r.status === "disabled") return { status: "disabled" };
    throw new Error(`No se pudo abonar la recarga ${topup.id}: ${"reason" in r ? r.reason : r.status}`);
  }
  if (order.state === "expired" || order.state === "deleted") {
    await closePendingTopup(topup.organizationId, topup.id, "abandoned", order.state === "expired" ? "La orden venció sin pagarse" : "La orden fue eliminada");
    return { status: "closed" };
  }
  if (order.state === "pending" || order.state === "creating") return { status: "pending" };
  return { status: "ignored", reason: "unknown_state" };
}

export type RefundOutcome = { ok: true; duplicate: boolean } | PurchaseFail;

/** Descuenta una recarga reembolsada. Idempotente por el id de la compra; puede dejar las recargas en negativo. */
async function settleRefund(topup: TopupRow, actorUserId: string | null, note: string): Promise<RefundOutcome> {
  const r = await refundTopup({ organizationId: topup.organizationId, topupId: topup.id, actorUserId, note });
  if (r.status === "applied") return { ok: true, duplicate: false };
  if (r.status === "duplicate") return { ok: true, duplicate: true };
  return fail(409, r.status === "disabled" ? "disabled" : "refund_rejected", "No se pudo descontar la recarga");
}

/**
 * Reembolso pedido por el Super Admin: primero se devuelve el dinero en Culqi y SOLO si Culqi lo acepta se descuentan
 * las monedas. Una compra ya reembolsada responde `duplicate` sin volver a llamar a Culqi.
 */
export async function refundPurchase(input: { topupId: string; actorUserId: string; reason?: string | null }): Promise<RefundOutcome> {
  if (!creditsEnabled()) return fail(404, "not_found", "No disponible");
  const [topup] = await getDb().select().from(schema.creditTopup).where(eq(schema.creditTopup.id, input.topupId)).limit(1);
  if (!topup) return fail(404, "not_found", "Compra no encontrada");
  if (topup.status === "refunded") return { ok: true, duplicate: true };
  if (topup.status !== "paid") return fail(409, "not_paid", "Solo se reembolsan compras pagadas");
  if (!culqiEnabled()) return fail(503, "not_configured", "El pago de recargas no está configurado");

  try {
    let chargeId = topup.gatewayChargeId;
    if (!chargeId && topup.gatewayOrderId) {
      chargeId = (await culqi.getOrder(topup.gatewayOrderId)).chargeId;
      if (chargeId) await setTopupGateway(topup.organizationId, topup.id, { gateway: "culqi", chargeId });
    }
    if (!chargeId) return fail(409, "charge_unknown", "No se conoce el cargo de esta compra: reembolsa desde el panel de Culqi");
    await culqi.createRefund({ amount: topup.amountCents, charge_id: chargeId, reason: "solicitud_comprador" });
  } catch (err) {
    console.error("[culqi] el reembolso no se pudo hacer:", safeReason(err));
    return fail(502, "gateway_error", "Culqi no aceptó el reembolso; no se descontó nada");
  }
  return settleRefund(topup, input.actorUserId, input.reason?.trim() || "Reembolso con Culqi");
}

export type RefundEventResult = { status: "applied" | "duplicate" | "ignored" | "disabled" };

/**
 * Un aviso de reembolso hecho fuera de aquí (desde el panel de Culqi). Se descuenta SOLO si es un reembolso total y
 * Culqi confirma, al consultar el cargo, que de verdad lo está.
 */
export async function confirmRefund(chargeId: string): Promise<RefundEventResult> {
  if (!creditsEnabled()) return { status: "disabled" };
  const [topup] = await getDb().select().from(schema.creditTopup).where(eq(schema.creditTopup.gatewayChargeId, chargeId)).limit(1);
  if (!topup) return { status: "ignored" };
  const charge = await culqi.getCharge(chargeId);
  if (charge.refundedAmount === null || charge.refundedAmount < topup.amountCents) {
    console.warn(`[culqi] reembolso parcial o no confirmado del cargo ${chargeId}: no se descuentan monedas`);
    return { status: "ignored" };
  }
  const r = await settleRefund(topup, null, "Reembolso hecho en Culqi");
  return r.ok ? { status: r.duplicate ? "duplicate" : "applied" } : { status: "ignored" };
}

/** Red de seguridad si un webhook se perdió: asienta las compras abiertas con orden. Nunca lanza. */
export async function reconcilePendingTopups(now: Date = new Date(), limit = 20): Promise<number> {
  if (!creditsEnabled() || !culqiEnabled()) return 0;
  let settled = 0;
  try {
    const rows = await getDb()
      .select({ orderId: schema.creditTopup.gatewayOrderId })
      .from(schema.creditTopup)
      .where(
        and(
          eq(schema.creditTopup.status, "pending"),
          isNotNull(schema.creditTopup.gatewayOrderId),
          lt(schema.creditTopup.createdAt, new Date(now.getTime() - RECONCILE_MIN_AGE_MS)),
          gt(schema.creditTopup.createdAt, new Date(now.getTime() - RECONCILE_MAX_AGE_MS))
        )
      )
      .orderBy(asc(schema.creditTopup.createdAt))
      .limit(limit);
    for (const r of rows) {
      try {
        const res = await confirmOrder(r.orderId!);
        if (res.status === "applied" || res.status === "closed") settled++;
      } catch (err) {
        console.error("[culqi] no se pudo asentar una compra abierta:", safeReason(err));
      }
    }
  } catch (err) {
    console.error("[culqi] la revisión de compras abiertas falló:", safeReason(err));
  }
  return settled;
}

export type TopupStatusDto = {
  id: string;
  status: TopupRow["status"];
  units: number;
  amountCents: number;
  currency: string;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
};

const toDto = (t: TopupRow): TopupStatusDto => ({
  id: t.id,
  status: t.status,
  units: t.units,
  amountCents: t.amountCents,
  currency: t.currency,
  createdAt: t.createdAt.toISOString(),
  expiresAt: t.expiresAt.toISOString(),
  completedAt: t.completedAt ? t.completedAt.toISOString() : null,
});

/**
 * El estado de una compra de ESTA organización. Si sigue pendiente, la asienta antes de responder (así quien vuelve del
 * checkout no depende de que el webhook haya llegado). Un fallo de Culqi no rompe la consulta: se responde lo que hay.
 */
export async function topupStatus(organizationId: string, topupId: string): Promise<TopupStatusDto | null> {
  let t = await getTopup(organizationId, topupId);
  if (!t) return null;
  if (t.status === "pending" && t.gatewayOrderId && culqiEnabled()) {
    try {
      await confirmOrder(t.gatewayOrderId);
      t = (await getTopup(organizationId, topupId)) ?? t;
    } catch (err) {
      console.error("[culqi] no se pudo consultar la compra:", safeReason(err));
    }
  }
  return toDto(t);
}

export { CulqiApiError };
