import { signMp } from "@/lib/billing";
import { mockGuard } from "@/lib/dev-guard";

export const dynamic = "force-dynamic";

/**
 * 046 — Mercado Pago de mentira para el self-test (tras `mockGuard()`: 404 en producción). Imita lo que el
 * conector usa: crear/consultar/cambiar la suscripción (`preapproval`), los cobros (`authorized_payments`), un
 * pago, `users/me`, una página de pago alojada (el `init_point`) y firma cada webhook con el secreto como lo
 * haría Mercado Pago. Además un endpoint de control (`_control`) para que el arnés dispare eventos del lado de
 * Mercado Pago (cobro mensual, rechazo, cancelación, duplicado, caída) y lea lo que recibió (`_state`).
 *
 * ⚠ Está construido sobre lo que SE SABE de la API (spec 046); un mock verde no prueba la API real.
 */

type Pre = {
  id: string;
  status: "pending" | "authorized" | "paused" | "cancelled";
  external_reference: string;
  payer_email: string;
  payer_id: number;
  reason: string;
  back_url: string;
  transaction_amount: number;
  currency_id: string;
  start_date?: string;
  created: number;
};
type Ap = { id: string; preapproval_id: string; status: string; transaction_amount: number; currency_id: string; debit_date: string; retry_attempt: number; payment: { id: string; status: string; status_detail: string } };
type Sent = { requestId: string; url: string; topic: string; dataId: string; body: string; signature: string };

type State = { seq: number; pres: Map<string, Pre>; aps: Map<string, Ap>; sent: Sent[]; failNext: number; failCreate: boolean; calls: string[] };
const g = globalThis as unknown as { __mpMock?: State };
const st = (): State => (g.__mpMock ??= { seq: 1000, pres: new Map(), aps: new Map(), sent: [], failNext: 0, failCreate: false, calls: [] });

const TOKEN = () => process.env.MP_ACCESS_TOKEN ?? "";
const base = () => (process.env.MP_API_BASE ?? "").replace(/\/+$/, "");
const appBase = () => (process.env.APP_BASE_URL ?? "http://localhost:3002").replace(/\/+$/, "");
const json = (data: unknown, status = 200) => Response.json(data, { status });

async function send(topic: string, dataId: string, opts: { requestId?: string; secret?: string; breakSignature?: boolean } = {}): Promise<{ status: number; sent: Sent }> {
  const s = st();
  const requestId = opts.requestId ?? `req-${++s.seq}`;
  const ts = String(Date.now());
  const secret = opts.secret ?? process.env.MP_WEBHOOK_SECRET ?? "";
  let v1 = signMp({ secret, dataId, requestId, ts });
  if (opts.breakSignature) v1 = v1.replace(/.$/, v1.endsWith("0") ? "1" : "0");
  const url = `${appBase()}/api/webhooks/mercadopago?data.id=${encodeURIComponent(dataId)}&type=${encodeURIComponent(topic)}`;
  const body = JSON.stringify({ id: s.seq, type: topic, action: "updated", live_mode: false, data: { id: dataId } });
  const signature = `ts=${ts},v1=${v1}`;
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-signature": signature, "x-request-id": requestId }, body });
  const rec: Sent = { requestId, url, topic, dataId, body, signature };
  s.sent.push(rec);
  return { status: res.status, sent: rec };
}

function newAp(pre: Pre, approved: boolean, detail = "cc_rejected_insufficient_amount", retry = 0): Ap {
  const s = st();
  const id = `ap${++s.seq}`;
  const ap: Ap = {
    id,
    preapproval_id: pre.id,
    status: approved ? "processed" : "recycling",
    transaction_amount: pre.transaction_amount,
    currency_id: pre.currency_id,
    debit_date: new Date().toISOString(),
    retry_attempt: retry,
    payment: { id: `pay${s.seq}`, status: approved ? "approved" : "rejected", status_detail: approved ? "accredited" : detail },
  };
  s.aps.set(id, ap);
  return ap;
}

const preView = (p: Pre) => ({
  id: p.id,
  status: p.status,
  external_reference: p.external_reference,
  payer_email: p.payer_email,
  payer_id: p.payer_id,
  reason: p.reason,
  init_point: `${base()}/checkout/${p.id}`,
  next_payment_date: new Date(Date.now() + 30 * 86400000).toISOString(),
  auto_recurring: { transaction_amount: p.transaction_amount, currency_id: p.currency_id, frequency: 1, frequency_type: "months" },
});

type Ctx = { params: Promise<{ path: string[] }> };

function authorized(req: Request): boolean {
  return req.headers.get("authorization") === `Bearer ${TOKEN()}`;
}

function failInjected(): Response | null {
  const s = st();
  if (s.failNext > 0) {
    s.failNext--;
    return json({ message: "error simulado" }, 500);
  }
  return null;
}

const checkoutPage = (p: Pre) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Mercado Pago (simulado)</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;max-width:420px;margin:40px auto">
<h1>Mercado Pago (simulado)</h1><p data-testid="mp-reason">${p.reason}</p>
<p data-testid="mp-amount">${p.currency_id} ${p.transaction_amount.toFixed(2)} / mes</p>
<form method="post" action="${base()}/checkout/${p.id}"><button name="action" value="approve" data-testid="mp-approve">Pagar (aprobado)</button>
<button name="action" value="reject" data-testid="mp-reject">Tarjeta rechazada</button>
<button name="action" value="cancel" data-testid="mp-cancel">Cancelar</button></form></body></html>`;

export async function GET(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const { path } = await ctx.params;
  const route = path.join("/");
  const s = st();

  if (path[0] === "checkout" && path[1]) {
    const p = s.pres.get(path[1]);
    if (!p) return new Response("No existe", { status: 404 });
    return new Response(checkoutPage(p), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (route === "_state") {
    return json({ pres: [...s.pres.values()], aps: [...s.aps.values()], sent: s.sent, calls: s.calls, failCreate: s.failCreate });
  }
  if (!authorized(req)) return json({ message: "invalid token" }, 401);
  const inj = failInjected();
  if (inj) return inj;
  s.calls.push(`GET ${route}`);

  if (route === "users/me") return json({ id: 1, email: "mock@mp.test", site_id: "MPE" });
  if (path[0] === "preapproval" && path[1]) {
    const p = s.pres.get(path[1]);
    return p ? json(preView(p)) : json({ message: "not found" }, 404);
  }
  if (route === "authorized_payments/search") {
    const pid = new URL(req.url).searchParams.get("preapproval_id");
    return json({ results: [...s.aps.values()].filter((a) => a.preapproval_id === pid) });
  }
  if (path[0] === "authorized_payments" && path[1]) {
    const a = s.aps.get(path[1]);
    return a ? json(a) : json({ message: "not found" }, 404);
  }
  if (path[0] === "v1" && path[1] === "payments" && path[2]) {
    for (const a of s.aps.values()) {
      if (a.payment.id === path[2]) return json({ id: a.payment.id, status: a.payment.status, preapproval_id: a.preapproval_id, transaction_amount: a.transaction_amount });
    }
    return json({ message: "not found" }, 404);
  }
  return json({ message: "not found" }, 404);
}

export async function POST(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const { path } = await ctx.params;
  const route = path.join("/");
  const s = st();

  // La página de pago alojada: el cliente pulsa un botón (formulario) y vuelve a la app.
  if (path[0] === "checkout" && path[1]) {
    const p = s.pres.get(path[1]);
    if (!p) return new Response("No existe", { status: 404 });
    const form = await req.formData();
    const action = String(form.get("action"));
    if (action === "approve") {
      p.status = "authorized";
      const ap = newAp(p, true);
      await send("subscription_preapproval", p.id);
      await send("subscription_authorized_payment", ap.id);
    } else if (action === "reject") {
      // Con la tarjeta rechazada la suscripción no se autoriza; MP deja un intento rechazado.
      const ap = newAp(p, false);
      await send("subscription_authorized_payment", ap.id);
    } else if (action === "cancel") {
      p.status = "cancelled";
      await send("subscription_preapproval", p.id);
    }
    return Response.redirect(p.back_url, 303);
  }

  if (route === "_control") {
    const b = (await req.json().catch(() => ({}))) as {
      action?: string;
      preapproval_id?: string;
      detail?: string;
      request_id?: string;
      count?: number;
      secret?: string;
      topic?: string;
      data_id?: string;
      silent?: boolean;
    };
    const p = b.preapproval_id ? s.pres.get(b.preapproval_id) : undefined;
    switch (b.action) {
      case "reset":
        s.pres.clear();
        s.aps.clear();
        s.sent.length = 0;
        s.calls.length = 0;
        s.failNext = 0;
        s.failCreate = false;
        return json({ ok: true });
      case "fail_next":
        s.failNext = b.count ?? 1;
        return json({ ok: true });
      case "fail_create":
        s.failCreate = b.count !== 0;
        return json({ ok: true });
      case "charge_month": {
        if (!p) return json({ error: "sin suscripción" }, 404);
        const ap = newAp(p, true);
        const r = await send("subscription_authorized_payment", ap.id);
        return json({ ok: true, ap, webhook: r.status });
      }
      case "reject_month": {
        if (!p) return json({ error: "sin suscripción" }, 404);
        const ap = newAp(p, false, b.detail ?? "cc_rejected_insufficient_amount");
        const r = await send("subscription_authorized_payment", ap.id);
        return json({ ok: true, ap, webhook: r.status });
      }
      case "mp_cancel":
      case "mp_pause": {
        if (!p) return json({ error: "sin suscripción" }, 404);
        p.status = b.action === "mp_cancel" ? "cancelled" : "paused";
        const r = await send("subscription_preapproval", p.id);
        return json({ ok: true, webhook: r.status });
      }
      case "refund": {
        const ap = [...s.aps.values()].filter((a) => a.preapproval_id === b.preapproval_id).pop();
        if (!ap) return json({ error: "sin cobro" }, 404);
        ap.payment.status = b.detail === "charged_back" ? "charged_back" : "refunded";
        const r = await send("subscription_authorized_payment", ap.id);
        return json({ ok: true, webhook: r.status });
      }
      case "resend_last": {
        const last = s.sent[s.sent.length - 1];
        if (!last) return json({ error: "nada que reenviar" }, 404);
        const res = await fetch(last.url, { method: "POST", headers: { "content-type": "application/json", "x-signature": last.signature, "x-request-id": last.requestId }, body: last.body });
        return json({ ok: true, webhook: res.status, requestId: last.requestId });
      }
      case "send_raw": {
        const r = await send(b.topic ?? "subscription_preapproval", b.data_id ?? "x", { requestId: b.request_id, secret: b.secret });
        return json({ ok: true, webhook: r.status });
      }
      case "send_bad_signature": {
        const r = await send("subscription_preapproval", b.data_id ?? p?.id ?? "x", { breakSignature: true });
        return json({ ok: true, webhook: r.status });
      }
      default:
        return json({ error: "acción desconocida" }, 422);
    }
  }

  if (!authorized(req)) return json({ message: "invalid token" }, 401);
  const inj = failInjected();
  if (inj) return inj;
  s.calls.push(`POST ${route}`);

  if (route === "preapproval") {
    if (s.failCreate) return json({ message: "mock caído" }, 503);
    const b = (await req.json()) as {
      reason: string;
      external_reference: string;
      payer_email: string;
      back_url: string;
      auto_recurring: { transaction_amount: number; currency_id: string; start_date?: string };
    };
    // Idempotencia por cabecera: la misma clave devuelve la misma suscripción.
    const key = req.headers.get("x-idempotency-key");
    if (key) {
      const prev = [...s.pres.values()].find((x) => x.external_reference === b.external_reference);
      if (prev) return json(preView(prev), 201);
    }
    if (b.auto_recurring.currency_id !== "PEN") return json({ message: "invalid currency_id" }, 400);
    const id = `mpre${++s.seq}`;
    const p: Pre = {
      id,
      status: "pending",
      external_reference: b.external_reference,
      payer_email: b.payer_email,
      payer_id: 9000 + s.seq,
      reason: b.reason,
      back_url: b.back_url,
      transaction_amount: b.auto_recurring.transaction_amount,
      currency_id: b.auto_recurring.currency_id,
      start_date: b.auto_recurring.start_date,
      created: Date.now(),
    };
    s.pres.set(id, p);
    return json(preView(p), 201);
  }
  return json({ message: "not found" }, 404);
}

export async function PUT(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const { path } = await ctx.params;
  const s = st();
  if (!authorized(req)) return json({ message: "invalid token" }, 401);
  const inj = failInjected();
  if (inj) return inj;
  s.calls.push(`PUT ${path.join("/")}`);
  if (path[0] === "preapproval" && path[1]) {
    const p = s.pres.get(path[1]);
    if (!p) return json({ message: "not found" }, 404);
    const b = (await req.json()) as { status?: Pre["status"]; reason?: string; auto_recurring?: { transaction_amount?: number } };
    if (p.status === "cancelled" && b.status && b.status !== "cancelled") return json({ message: "cancelled preapproval cannot be reactivated" }, 400);
    if (b.status) p.status = b.status;
    if (b.reason) p.reason = b.reason;
    if (b.auto_recurring?.transaction_amount) p.transaction_amount = b.auto_recurring.transaction_amount;
    return json(preView(p));
  }
  return json({ message: "not found" }, 404);
}
