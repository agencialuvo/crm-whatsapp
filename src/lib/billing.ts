import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * 046 — Contratos y reglas puras del cobro con Mercado Pago: sin red ni base, para probarlas con tablas de casos.
 * Las comparten el cliente HTTP, el webhook, las rutas de `/api/billing/*` y la UI.
 */

/* ---------- Cuerpos de las rutas ---------- */

export const checkoutBodySchema = z.object({ planId: z.string().min(1).max(80) }).strict();
export const changePlanBodySchema = z.object({ planId: z.string().min(1).max(80) }).strict();
export const cancelBodySchema = z.object({ reason: z.string().trim().max(300).optional() }).strict();

/** El aviso del webhook: solo un timbre. Lo único que se lee de él es el tipo y el id del recurso. */
export const mpNotificationSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    type: z.string().optional(),
    topic: z.string().optional(),
    action: z.string().optional(),
    live_mode: z.boolean().optional(),
    data: z.object({ id: z.union([z.string(), z.number()]) }).partial().optional(),
  })
  .passthrough();

/* ---------- Montos ---------- */

/** Céntimos → el decimal que pide Mercado Pago (7900 → 79). Dos decimales exactos. */
export function centsToMpAmount(cents: number): number {
  if (!Number.isFinite(cents) || cents < 0) throw new RangeError("Monto inválido");
  return Math.round(cents) / 100;
}

/** El decimal de Mercado Pago → céntimos enteros (79.9 → 7990, "149.00" → 14900). */
export function mpAmountToCents(amount: number | string): number {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n) || n < 0) throw new RangeError("Monto inválido");
  return Math.round(n * 100);
}

/* ---------- Firma del webhook ---------- */

/** `ts=1700000000,v1=abc…` → sus partes. null si falta alguna. */
export function parseSignatureHeader(header: string | null | undefined): { ts: string; v1: string } | null {
  if (!header) return null;
  let ts = "";
  let v1 = "";
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "ts") ts = v;
    else if (k === "v1") v1 = v;
  }
  return ts && v1 ? { ts, v1 } : null;
}

/** El `data.id` del query va en minúsculas cuando es alfanumérico (así firma Mercado Pago). */
export function normalizeDataId(dataId: string): string {
  return /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
}

/** El texto que se firma: `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` */
export function buildSignatureManifest(p: { dataId: string; requestId: string; ts: string }): string {
  return `id:${normalizeDataId(p.dataId)};request-id:${p.requestId};ts:${p.ts};`;
}

export function signMp(p: { secret: string; dataId: string; requestId: string; ts: string }): string {
  return createHmac("sha256", p.secret).update(buildSignatureManifest(p)).digest("hex");
}

/** Verifica la firma con comparación de tiempo constante. Sin secreto, sin cabeceras o con otro largo: false (nunca lanza). */
export function verifyMpSignature(p: {
  secret: string | undefined;
  signatureHeader: string | null | undefined;
  requestId: string | null | undefined;
  dataId: string | null | undefined;
}): boolean {
  if (!p.secret || !p.requestId || !p.dataId) return false;
  const sig = parseSignatureHeader(p.signatureHeader);
  if (!sig) return false;
  const expected = Buffer.from(signMp({ secret: p.secret, dataId: p.dataId, requestId: p.requestId, ts: sig.ts }), "utf8");
  const given = Buffer.from(sig.v1.toLowerCase(), "utf8");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/* ---------- Estados de Mercado Pago → los nuestros ---------- */

export type MpPreapprovalStatus = "pending" | "authorized" | "paused" | "cancelled";
export type PaymentState = "pending" | "rejected" | "approved" | "refunded" | "charged_back" | "cancelled";

export function mapPreapprovalStatus(s: string | null | undefined): MpPreapprovalStatus {
  switch ((s ?? "").toLowerCase()) {
    case "authorized":
      return "authorized";
    case "paused":
      return "paused";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "pending";
  }
}

/** El estado de un cobro a partir del pago autorizado y del pago que lo respalda. */
export function classifyPayment(p: { authorizedStatus?: string | null; paymentStatus?: string | null }): PaymentState {
  const pay = (p.paymentStatus ?? "").toLowerCase();
  if (pay === "approved" || pay === "accredited") return "approved";
  if (pay === "refunded") return "refunded";
  if (pay === "charged_back") return "charged_back";
  if (pay === "rejected") return "rejected";
  if (pay === "cancelled") return "cancelled";
  if ((p.authorizedStatus ?? "").toLowerCase() === "cancelled") return "cancelled";
  return "pending";
}

const RANK: Record<PaymentState, number> = { pending: 0, cancelled: 0, rejected: 1, approved: 2, refunded: 3, charged_back: 3 };

/** El estado de un cobro solo avanza: un `rejected` tardío no pisa un `approved`. */
export function canAdvancePayment(from: PaymentState | null, to: PaymentState): boolean {
  if (!from) return true;
  if (from === to) return true;
  return RANK[to] > RANK[from];
}

/* ---------- Redirección y mensajes ---------- */

const MP_HOST_SUFFIXES = ["mercadopago.com", "mercadopago.com.pe", "mercadolibre.com", "mercadopago.com.ar", "mercadopago.com.mx"];

/** Solo se redirige a Mercado Pago (https y su dominio exacto o un subdominio). El mock de pruebas añade su host. */
export function isAllowedCheckoutUrl(raw: string, extraHosts: readonly string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (extraHosts.includes(u.host.toLowerCase())) return u.protocol === "http:" || u.protocol === "https:";
  if (u.protocol !== "https:") return false;
  return MP_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

const REJECTION: Record<string, string> = {
  cc_rejected_insufficient_amount: "fondos insuficientes",
  cc_rejected_bad_filled_security_code: "el código de seguridad es incorrecto",
  cc_rejected_bad_filled_date: "la fecha de vencimiento es incorrecta",
  cc_rejected_bad_filled_other: "hay un dato de la tarjeta incorrecto",
  cc_rejected_call_for_authorize: "el banco pide autorizar el pago",
  cc_rejected_card_disabled: "la tarjeta está deshabilitada",
  cc_rejected_blacklist: "la tarjeta no pudo ser procesada",
  cc_rejected_high_risk: "el pago fue rechazado por seguridad",
  cc_rejected_max_attempts: "se superó el máximo de intentos",
  cc_rejected_other_reason: "el banco no procesó el pago",
};

export function rejectionMessage(detail: string | null | undefined): string {
  const why = detail ? REJECTION[detail] : undefined;
  return why ? `La tarjeta fue rechazada: ${why}.` : "El pago fue rechazado. Prueba con otro medio de pago.";
}

export const CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PAYMENT_GRACE_DAYS = 5;
