import { timingSafeEqual } from "node:crypto";

/**
 * Monedas 5.4 — lo PURO del webhook de Culqi: qué evento llegó y si quien llama conoce el secreto. El aviso es solo
 * un timbre: lo que dice jamás se toma como verdad. Quien lo atiende vuelve a consultar la orden o el cargo a la API
 * de Culqi con la llave secreta antes de mover un solo centavo de saldo.
 */

export type CulqiEvent = {
  /** Ej. `order.status.changed`, `refund.creation.succeeded`. */
  type: string;
  /** El id del recurso del evento (orden, cargo o reembolso). */
  resourceId: string | null;
  /** Para eventos de reembolso: el cargo reembolsado. */
  chargeId: string | null;
  /** Para eventos de cargo: la orden a la que pertenece. */
  orderId: string | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** `data` llega como texto JSON (Culqi lo serializa) o ya como objeto: se acepta cualquiera. */
function dataOf(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw) as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/** Lee el cuerpo del aviso. Devuelve `null` si no tiene la forma de un evento (sin tipo). */
export function parseCulqiEvent(body: unknown): CulqiEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const type = str(b.type);
  if (!type || type.length > 80) return null;
  const d = dataOf(b.data);
  return { type, resourceId: str(d.id), chargeId: str(d.charge_id), orderId: str(d.order_id) ?? (type.startsWith("order.") ? str(d.id) : null) };
}

/** Compara en tiempo constante (sin filtrar cuánto coincide). Sin secreto configurado, nada es válido. */
export function secretMatches(given: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** El secreto viaja en la URL del webhook (`?token=`) o en el encabezado `x-webhook-token`. */
export function webhookToken(req: Request): string | null {
  return req.headers.get("x-webhook-token") ?? new URL(req.url).searchParams.get("token");
}
