import type { SendError } from "@/server/inbox/send";

/**
 * Código HTTP de cada fallo de envío. Lo comparten las rutas de texto,
 * adjuntos y plantillas: un mismo fallo (token vencido, ventana cerrada…)
 * debe responder igual salga por donde salga.
 */
export const SEND_ERROR_STATUS: Record<SendError["code"], number> = {
  sandbox_violation: 403,
  not_connected: 409,
  reconnect_required: 409,
  window_closed: 409,
  message_limit: 409,
  text_too_long: 422,
  meta_error: 422,
  meta_unavailable: 503,
  upload_failed: 502,
};
