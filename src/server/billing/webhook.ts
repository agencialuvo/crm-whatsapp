import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { mp, MpApiError } from "@/lib/mercadopago/client";
import { processAuthorizedPayment, syncPreapproval, type CoreOutcome } from "./core";

/**
 * 046 — Lo que se hace con un aviso de Mercado Pago YA autenticado (la firma se verificó en la ruta). El aviso es
 * un timbre: lo único que se lee de él es el tipo y el id; el estado de verdad se consulta a la API.
 *
 * Idempotencia: la bandeja `billing_webhook_event` (UNIQUE por `x-request-id`) corta los reenvíos idénticos; lo
 * demás lo garantiza `core` (cobro único por `mp_authorized_payment_id`, `applied_at` bajo el candado).
 */

export type Notification = { requestId: string; topic: string; resourceId: string; action: string | null; liveMode: boolean | null };

export type WebhookResult = { status: 200 | 500; body: { ok: boolean; result: string } };

const MAX_ATTEMPTS = 8;

/** Resuelve el aviso contra la API de Mercado Pago y lo aplica. Lanza ante un error transitorio. */
export async function dispatch(topic: string, resourceId: string): Promise<CoreOutcome> {
  switch (topic) {
    case "subscription_preapproval":
    case "preapproval":
      return syncPreapproval(resourceId);
    case "subscription_authorized_payment":
    case "authorized_payment": {
      const ap = await mp.getAuthorizedPayment(resourceId);
      return processAuthorizedPayment(ap);
    }
    case "payment": {
      const pay = await mp.getPayment(resourceId);
      const pid = pay.preapproval_id ?? (typeof pay.metadata?.preapproval_id === "string" ? pay.metadata.preapproval_id : null);
      if (!pid) return { kind: "ignored", detail: "payment_not_ours" };
      return syncPreapproval(pid);
    }
    default:
      return { kind: "ignored", detail: "unknown_topic" };
  }
}

export async function handleNotification(n: Notification): Promise<WebhookResult> {
  const db = getDb();
  const inserted = await db
    .insert(schema.billingWebhookEvent)
    .values({
      id: newId("billingWebhookEvent"),
      requestId: n.requestId,
      topic: n.topic,
      resourceId: n.resourceId,
      action: n.action,
      liveMode: n.liveMode,
      status: "received",
    })
    .onConflictDoNothing({ target: schema.billingWebhookEvent.requestId })
    .returning({ id: schema.billingWebhookEvent.id });

  let eventId = inserted[0]?.id;
  if (!eventId) {
    const [prev] = await db.select().from(schema.billingWebhookEvent).where(eq(schema.billingWebhookEvent.requestId, n.requestId)).limit(1);
    if (prev && (prev.status === "processed" || prev.status === "ignored")) {
      return { status: 200, body: { ok: true, result: "duplicate" } };
    }
    eventId = prev?.id;
  }
  if (!eventId) return { status: 500, body: { ok: false, result: "inbox_unavailable" } };

  await db
    .update(schema.billingWebhookEvent)
    .set({ attempts: sql`${schema.billingWebhookEvent.attempts} + 1` })
    .where(eq(schema.billingWebhookEvent.id, eventId));
  return runEvent(eventId, n.topic, n.resourceId);
}

async function runEvent(eventId: string, topic: string, resourceId: string): Promise<WebhookResult> {
  const db = getDb();
  try {
    const out = await dispatch(topic, resourceId);
    const status = out.kind === "orphan" ? "orphan" : out.kind === "ignored" ? "ignored" : "processed";
    await db
      .update(schema.billingWebhookEvent)
      .set({ status, organizationId: out.organizationId ?? null, error: out.detail ?? null, processedAt: new Date() })
      .where(eq(schema.billingWebhookEvent.id, eventId));
    return { status: 200, body: { ok: true, result: out.kind } };
  } catch (err) {
    // Un recurso que Mercado Pago ya no conoce (p. ej. la simulación del panel con un id inventado) no se reintenta.
    if (err instanceof MpApiError && err.kind === "not_found") {
      await db
        .update(schema.billingWebhookEvent)
        .set({ status: "ignored", error: "resource_not_found", processedAt: new Date() })
        .where(eq(schema.billingWebhookEvent.id, eventId));
      return { status: 200, body: { ok: true, result: "not_found" } };
    }
    const message = err instanceof Error ? err.message.slice(0, 300) : "error";
    await db.update(schema.billingWebhookEvent).set({ status: "failed", error: message }).where(eq(schema.billingWebhookEvent.id, eventId));
    console.error("[billing] el aviso de Mercado Pago falló:", message);
    // 5xx: Mercado Pago reintenta. El temporizador de reconciliación también lo repasa.
    return { status: 500, body: { ok: false, result: "failed" } };
  }
}

/** Reintenta los avisos que no terminaron (`failed`, `orphan`, `received`) de las últimas 24 h. */
export async function reprocessPending(now = new Date(), limit = 25): Promise<number> {
  const db = getDb();
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const before = new Date(now.getTime() - 2 * 60 * 1000);
  const rows = await db
    .select()
    .from(schema.billingWebhookEvent)
    .where(
      and(
        inArray(schema.billingWebhookEvent.status, ["failed", "orphan", "received"]),
        gt(schema.billingWebhookEvent.receivedAt, since),
        lt(schema.billingWebhookEvent.receivedAt, before),
        lt(schema.billingWebhookEvent.attempts, MAX_ATTEMPTS)
      )
    )
    .limit(limit);
  let done = 0;
  for (const r of rows) {
    await db
      .update(schema.billingWebhookEvent)
      .set({ attempts: sql`${schema.billingWebhookEvent.attempts} + 1` })
      .where(eq(schema.billingWebhookEvent.id, r.id));
    const res = await runEvent(r.id, r.topic, r.resourceId);
    if (res.status === 200) done++;
  }
  return done;
}
