/**
 * Monedas 5.5 — lo PURO de la pantalla de compra de recargas: qué decir en cada estado, cómo traducir los errores de la
 * API, y la configuración del checkout de Culqi en el navegador. Nada de aquí lee secretos: al navegador solo llega la
 * llave PÚBLICA (`pk_…`) y los datos de la orden que devolvió el servidor.
 */

/** El único script de Culqi que la pantalla carga (y el que la política de seguridad permite con `NEXT_PUBLIC_CULQI=on`). */
export const CULQI_CHECKOUT_SRC = "https://js.culqi.com/checkout-js";

/** Cada cuánto se consulta el estado de la compra, y cuánto se insiste antes de dejarla «pendiente» para el usuario. */
export const POLL_MS = 3000;
export const POLL_MAX_MS = 10 * 60 * 1000;

export type TopupStatus = "pending" | "paid" | "failed" | "abandoned" | "refunded";

export type TopupStatusDto = {
  id: string;
  status: TopupStatus;
  units: number;
  amountCents: number;
  currency: string;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
};

/** Solo una llave pública de Culqi. Una `sk_…` (secreta) o cualquier otra cosa NO se usa jamás en el navegador. */
export function isPublicKey(key: string | null | undefined): key is string {
  return typeof key === "string" && /^pk_(test|live)_[A-Za-z0-9]+$/.test(key);
}

export type TopupTone = "info" | "success" | "danger" | "neutral";
export type TopupView = { tone: TopupTone; title: string; text: string; /** Ya no cambiará: se deja de consultar. */ terminal: boolean };

/** Qué le decimos a la persona según el estado de su compra. `timedOut`: se agotó la espera y sigue pendiente. */
export function topupView(status: TopupStatus | null, opts: { timedOut?: boolean } = {}): TopupView {
  switch (status) {
    case "paid":
      return { tone: "success", title: "Recarga acreditada", text: "Tus monedas ya están en tu saldo. No vencen.", terminal: true };
    case "failed":
      return { tone: "danger", title: "No se pudo completar el pago", text: "No se te cobró nada. Puedes intentarlo de nuevo.", terminal: true };
    case "abandoned":
      return { tone: "neutral", title: "Pago cancelado o vencido", text: "La orden venció sin pagarse. Si ya pagaste, tus monedas aparecerán en cuanto Culqi lo confirme.", terminal: true };
    case "refunded":
      return { tone: "neutral", title: "Recarga reembolsada", text: "Se te devolvió el pago y se descontaron esas monedas de tu saldo.", terminal: true };
    case "pending":
      return opts.timedOut
        ? { tone: "info", title: "Seguimos esperando la confirmación", text: "Si ya pagaste, las monedas aparecerán solas en unos minutos. Puedes verificar de nuevo.", terminal: false }
        : { tone: "info", title: "Esperando la confirmación del pago", text: "Completa el pago en la ventana de Culqi. Esta pantalla se actualiza sola.", terminal: false };
    default:
      return { tone: "neutral", title: "", text: "", terminal: false };
  }
}

/** El mensaje claro de un fallo de `POST /api/credits/topups` (o `unavailable` si ni siquiera llegó a responder). */
export function purchaseErrorMessage(status: number, code?: string | null): string {
  if (code === "pack_not_found") return "Ese paquete ya no está disponible. Actualizamos la lista.";
  if (code === "too_many_pending") return "Ya tienes varias recargas sin completar. Termínalas o espera a que venzan.";
  if (status === 403) return "Solo el dueño de la cuenta puede comprar recargas.";
  if (status === 429) return "Demasiados intentos. Espera un momento e inténtalo de nuevo.";
  if (status === 404 || status === 503) return "Las recargas no están disponibles por ahora.";
  if (status === 422) return "No se pudo procesar la solicitud. Revisa los datos.";
  return "No se pudo iniciar el pago. Inténtalo de nuevo en un momento.";
}

export type CheckoutOrder = { orderId: string; publicKey: string | null; amountCents: number; currency: string };

/** La configuración del checkout de Culqi (v4) o `null` si no se puede abrir con seguridad (sin llave pública válida). */
export function checkoutConfig(order: CheckoutOrder, title = "Recarga de monedas") {
  if (!isPublicKey(order.publicKey) || !order.orderId) return null;
  return {
    publicKey: order.publicKey,
    config: {
      settings: { title, currency: order.currency, amount: order.amountCents, order: order.orderId },
      client: {},
      options: { lang: "es", installments: false, modal: true, paymentMethods: { tarjeta: true, yape: true, bancaMovil: true, agente: true, billetera: true, cuotealo: false } },
    },
  };
}
