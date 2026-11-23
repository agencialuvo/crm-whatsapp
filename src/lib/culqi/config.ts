/**
 * Monedas 5.4 — la configuración del conector de Culqi (recargas de monedas). Es el ÚNICO archivo (con el cliente)
 * que lee las llaves y el secreto del webhook: una prueba de vigilancia lo comprueba. Apagado por defecto: con
 * `CULQI` distinto de `on`, o sin la llave secreta, las rutas de compra y el webhook responden 404 / «no configurado».
 * No tiene nada que ver con la suscripción (Mercado Pago).
 */

const ON = new Set(["on", "1", "true", "si", "sí", "yes"]);

/** `CULQI=on` **y** llave secreta presente. Cualquier otra cosa = apagado. */
export function culqiEnabled(): boolean {
  return ON.has((process.env.CULQI ?? "").trim().toLowerCase()) && !!process.env.CULQI_SECRET_KEY?.trim();
}

export function culqiSecretKey(): string {
  return process.env.CULQI_SECRET_KEY?.trim() ?? "";
}

/** La llave pública viaja al navegador (la usa el checkout de Culqi): no es secreta. */
export function culqiPublicKey(): string | null {
  return process.env.CULQI_PUBLIC_KEY?.trim() || null;
}

export function culqiWebhookSecret(): string | undefined {
  const v = process.env.CULQI_WEBHOOK_SECRET?.trim();
  return v ? v : undefined;
}

export function culqiApiBase(): string {
  return (process.env.CULQI_API_BASE?.trim() || "https://api.culqi.com/v2").replace(/\/+$/, "");
}
