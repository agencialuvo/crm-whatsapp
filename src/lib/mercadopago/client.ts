import { mpAccessToken, mpApiBase } from "./config";

/**
 * 046 — El ÚNICO cliente HTTP de Mercado Pago (como `src/lib/meta/` para Graph). Nadie más habla con su API.
 * Tiempo máximo de 8 s, un reintento en errores transitorios, `X-Idempotency-Key` al crear, y errores
 * clasificados. El token jamás aparece en un mensaje de error ni en un log.
 */

export type MpErrorKind = "auth" | "rate_limited" | "transient" | "invalid" | "not_found";

export class MpApiError extends Error {
  constructor(
    public readonly kind: MpErrorKind,
    public readonly status: number,
    message: string,
    /** Reintentable por el llamador (el webhook responde 5xx para que Mercado Pago reintente). */
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "MpApiError";
  }
}

export type MpPreapproval = {
  id: string;
  status: string;
  external_reference?: string | null;
  payer_id?: number | string | null;
  payer_email?: string | null;
  reason?: string | null;
  init_point?: string | null;
  next_payment_date?: string | null;
  auto_recurring?: { transaction_amount?: number; currency_id?: string; frequency?: number; frequency_type?: string } | null;
};

export type MpAuthorizedPayment = {
  id: string | number;
  preapproval_id: string;
  status: string;
  transaction_amount?: number;
  currency_id?: string;
  debit_date?: string | null;
  retry_attempt?: number;
  payment?: { id?: string | number; status?: string; status_detail?: string } | null;
};

export type MpPayment = {
  id: string | number;
  status: string;
  status_detail?: string;
  transaction_amount?: number;
  currency_id?: string;
  external_reference?: string | null;
  metadata?: Record<string, unknown> | null;
  preapproval_id?: string | null;
};

const TIMEOUT_MS = 8000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Quita de un texto cualquier rastro del token antes de que llegue a un mensaje o a un log. */
function scrub(text: string): string {
  const token = mpAccessToken();
  return token ? text.split(token).join("[token]") : text;
}

async function once<T>(method: string, path: string, body: unknown, idempotencyKey?: string): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${mpApiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${mpAccessToken()}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      cache: "no-store",
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new MpApiError("transient", 0, aborted ? "Mercado Pago no respondió a tiempo" : "No se pudo conectar con Mercado Pago", true);
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  const detail = scrub((await res.text().catch(() => "")).slice(0, 300));
  if (res.status === 401 || res.status === 403) throw new MpApiError("auth", res.status, "Mercado Pago rechazó las credenciales (revisa MP_ACCESS_TOKEN)", false);
  if (res.status === 404) throw new MpApiError("not_found", 404, "Recurso no encontrado en Mercado Pago", false);
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    throw new MpApiError("rate_limited", 429, "Mercado Pago limitó las consultas", true, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500);
  }
  if (res.status >= 500) throw new MpApiError("transient", res.status, "Mercado Pago tuvo un error", true);
  throw new MpApiError("invalid", res.status, `Mercado Pago rechazó la solicitud (${res.status}): ${detail}`, false);
}

/** Un reintento acotado en errores transitorios o de límite; el resto se propaga tal cual. */
async function call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  try {
    return await once<T>(method, path, body, idempotencyKey);
  } catch (err) {
    if (err instanceof MpApiError && err.retryable) {
      await sleep(Math.min(err.retryAfterMs ?? 400, 3000));
      return once<T>(method, path, body, idempotencyKey);
    }
    throw err;
  }
}

export const mp = {
  createPreapproval: (
    body: {
      reason: string;
      external_reference: string;
      payer_email: string;
      back_url: string;
      status: "pending";
      auto_recurring: { frequency: 1; frequency_type: "months"; transaction_amount: number; currency_id: string; start_date?: string };
    },
    idempotencyKey: string
  ) => call<MpPreapproval>("POST", "/preapproval", body, idempotencyKey),
  getPreapproval: (id: string) => call<MpPreapproval>("GET", `/preapproval/${encodeURIComponent(id)}`),
  updatePreapproval: (
    id: string,
    body: { status?: "authorized" | "paused" | "cancelled"; reason?: string; auto_recurring?: { transaction_amount: number; currency_id: string } }
  ) => call<MpPreapproval>("PUT", `/preapproval/${encodeURIComponent(id)}`, body),
  getAuthorizedPayment: (id: string) => call<MpAuthorizedPayment>("GET", `/authorized_payments/${encodeURIComponent(id)}`),
  searchAuthorizedPayments: async (preapprovalId: string): Promise<MpAuthorizedPayment[]> => {
    const r = await call<{ results?: MpAuthorizedPayment[] }>("GET", `/authorized_payments/search?preapproval_id=${encodeURIComponent(preapprovalId)}`);
    return r.results ?? [];
  },
  getPayment: (id: string) => call<MpPayment>("GET", `/v1/payments/${encodeURIComponent(id)}`),
  /** Solo lectura: comprueba que el token sirve (lo usa `pnpm doctor`). */
  whoAmI: () => call<{ id: number | string; email?: string; site_id?: string }>("GET", "/users/me"),
};
