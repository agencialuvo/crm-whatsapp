/** Error tipado del envío; `code` mapea a HTTP en la capa de API. */
export class SendError extends Error {
  code:
    | "sandbox_violation"
    | "not_connected"
    | "reconnect_required"
    | "window_closed"
    /** 022: el canal no admite más mensajes hasta que el cliente escriba. */
    | "message_limit"
    /** 022: el texto no cabe en el canal de esa conversación. */
    | "text_too_long"
    /** Monedas: sin saldo y con el corte activo, no sale la plantilla (que Meta cobra). */
    | "no_credit"
    | "meta_error"
    | "meta_unavailable"
    | "upload_failed";
  /** 008/041: la fila del mensaje (`failed`) cuando el fallo ocurrió TRAS el intento de envío. */
  messageId?: string;
  /** 048: el código y el detalle que Meta devolvió (solo en `meta_error`), para decidir si un media_id venció. */
  metaError?: { code: number | null; details: unknown };

  constructor(code: SendError["code"], message: string) {
    super(message);
    this.name = "SendError";
    this.code = code;
  }
}
