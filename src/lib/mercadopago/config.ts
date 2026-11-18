import { DEFAULT_PAYMENT_GRACE_DAYS } from "@/lib/billing";

/**
 * 046 — La configuración del conector de Mercado Pago. Es el ÚNICO archivo (con el cliente) que lee el token y el
 * secreto del webhook: una prueba de vigilancia lo comprueba. Apagado por defecto (patrón ADR-001).
 */

const ON = new Set(["on", "1", "true", "si", "sí", "yes"]);

/** Bandera `MERCADOPAGO=on` **y** token presente. Cualquier otra cosa = apagado: webhook y `/api/billing/*` dan 404. */
export function billingEnabled(): boolean {
  return ON.has((process.env.MERCADOPAGO ?? "").trim().toLowerCase()) && !!process.env.MP_ACCESS_TOKEN?.trim();
}

export function mpAccessToken(): string {
  return process.env.MP_ACCESS_TOKEN?.trim() ?? "";
}

export function mpWebhookSecret(): string | undefined {
  const v = process.env.MP_WEBHOOK_SECRET?.trim();
  return v ? v : undefined;
}

export function mpApiBase(): string {
  return (process.env.MP_API_BASE?.trim() || "https://api.mercadopago.com").replace(/\/+$/, "");
}

/** Días de gracia tras un cobro rechazado antes de bloquear (`PAYMENT_GRACE_DAYS`, por defecto 5). */
export function paymentGraceDays(): number {
  const n = Number(process.env.PAYMENT_GRACE_DAYS);
  return Number.isFinite(n) && n >= 0 && n <= 60 ? Math.floor(n) : DEFAULT_PAYMENT_GRACE_DAYS;
}

/** Hosts extra a los que se puede redirigir (solo el mock de pruebas, y solo con los mocks encendidos). */
export function extraCheckoutHosts(): string[] {
  if (process.env.WA_MOCK_ENABLED !== "true" || process.env.NODE_ENV === "production") return [];
  try {
    return [new URL(mpApiBase()).host.toLowerCase()];
  } catch {
    return [];
  }
}
