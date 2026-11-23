import { culqiApiBase, culqiSecretKey } from "./config";

/**
 * Monedas 5.4 — El ÚNICO cliente HTTP de Culqi (como `src/lib/mercadopago/client.ts`). Tiempo máximo de 8 s, un
 * reintento en errores transitorios y errores clasificados. La llave secreta jamás aparece en un mensaje ni en un log.
 *
 * Las respuestas se leen de forma TOLERANTE (`toOrder`/`toCharge`): lo que no reconocemos queda en `null` y el
 * llamador decide (nunca se acredita nada con un campo que no se pudo leer). Los nombres de campo siguen la API v2 de
 * Culqi y deben validarse contra el sandbox antes de encender `CULQI=on` en producción.
 */

export type CulqiErrorKind = "auth" | "rate_limited" | "transient" | "invalid" | "not_found";

export class CulqiApiError extends Error {
  constructor(
    public readonly kind: CulqiErrorKind,
    public readonly status: number,
    message: string,
    /** Reintentable por el llamador (el webhook responde 5xx para que Culqi reintente). */
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "CulqiApiError";
  }
}

export type CulqiOrderState = "pending" | "paid" | "expired" | "deleted" | "creating" | "unknown";

export type CulqiOrder = {
  id: string;
  state: CulqiOrderState;
  /** Lo que pusimos al crearla: el id de nuestra compra. */
  orderNumber: string | null;
  amount: number | null;
  currency: string | null;
  /** El cargo con que se pagó, si la respuesta lo trae. */
  chargeId: string | null;
  /** Código de pago (CIP / efectivo) para mostrarlo en el checkout. */
  paymentCode: string | null;
};

export type CulqiCharge = { id: string; amount: number | null; currency: string | null; refundedAmount: number | null; orderId: string | null };

const TIMEOUT_MS = 8000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Lee una orden de Culqi sin asumir nada: lo ilegible queda en `null`. */
export function toOrder(raw: unknown): CulqiOrder | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const s = str(r.state);
  const state: CulqiOrderState = s === "pending" || s === "paid" || s === "expired" || s === "deleted" || s === "creating" ? s : "unknown";
  const charges = Array.isArray(r.charges) ? (r.charges as unknown[]) : [];
  const firstCharge = charges.find((c) => c && typeof c === "object") as Record<string, unknown> | undefined;
  return {
    id,
    state,
    orderNumber: str(r.order_number),
    amount: num(r.amount),
    currency: str(r.currency_code),
    chargeId: str(r.charge_id) ?? str(firstCharge?.id) ?? null,
    paymentCode: str(r.payment_code),
  };
}

export function toCharge(raw: unknown): CulqiCharge | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  return { id, amount: num(r.amount), currency: str(r.currency_code), refundedAmount: num(r.amount_refunded), orderId: str(r.order_id) };
}

/** Quita de un texto cualquier rastro de la llave antes de que llegue a un mensaje o a un log. */
function scrub(text: string): string {
  const key = culqiSecretKey();
  return key ? text.split(key).join("[llave]") : text;
}

async function once(method: string, path: string, body: unknown): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${culqiApiBase()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${culqiSecretKey()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      cache: "no-store",
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new CulqiApiError("transient", 0, aborted ? "Culqi no respondió a tiempo" : "No se pudo conectar con Culqi", true);
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return res.status === 204 ? null : await res.json().catch(() => null);
  const detail = scrub((await res.text().catch(() => "")).slice(0, 300));
  if (res.status === 401 || res.status === 403) throw new CulqiApiError("auth", res.status, "Culqi rechazó las credenciales (revisa CULQI_SECRET_KEY)", false);
  if (res.status === 404) throw new CulqiApiError("not_found", 404, "Recurso no encontrado en Culqi", false);
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    throw new CulqiApiError("rate_limited", 429, "Culqi limitó las consultas", true, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500);
  }
  if (res.status >= 500) throw new CulqiApiError("transient", res.status, "Culqi tuvo un error", true);
  throw new CulqiApiError("invalid", res.status, `Culqi rechazó la solicitud (${res.status}): ${detail}`, false);
}

/** Un reintento acotado SOLO en lecturas: crear dos órdenes o dos reembolsos por reintentar sería peor que fallar. */
async function call(method: string, path: string, body?: unknown, retry = false): Promise<unknown> {
  try {
    return await once(method, path, body);
  } catch (err) {
    if (retry && err instanceof CulqiApiError && err.retryable) {
      await sleep(Math.min(err.retryAfterMs ?? 400, 3000));
      return once(method, path, body);
    }
    throw err;
  }
}

const must = <T>(v: T | null, what: string): T => {
  if (v === null) throw new CulqiApiError("invalid", 200, `Culqi devolvió ${what} ilegible`, false);
  return v;
};

export const culqi = {
  createOrder: async (body: {
    amount: number;
    currency_code: string;
    description: string;
    order_number: string;
    /** Segundos Unix. */
    expiration_date: number;
    client_details: { first_name: string; last_name: string; email: string; phone_number?: string };
    confirm: false;
  }): Promise<CulqiOrder> => must(toOrder(await call("POST", "/orders", body)), "una orden"),
  getOrder: async (id: string): Promise<CulqiOrder> => must(toOrder(await call("GET", `/orders/${encodeURIComponent(id)}`, undefined, true)), "una orden"),
  getCharge: async (id: string): Promise<CulqiCharge> => must(toCharge(await call("GET", `/charges/${encodeURIComponent(id)}`, undefined, true)), "un cargo"),
  createRefund: async (body: { amount: number; charge_id: string; reason: string }): Promise<{ id: string | null }> => {
    const r = (await call("POST", "/refunds", body)) as Record<string, unknown> | null;
    return { id: str(r?.id) };
  },
};
