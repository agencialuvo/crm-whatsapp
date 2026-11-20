import { apiError, withAuth } from "@/lib/api";
import { getConversation } from "@/server/inbox/queries";
import { SEND_ERROR_STATUS } from "@/server/inbox/send-status";
import { SendError, sendMediaMessage } from "@/server/inbox/send";
import {
  BYTES_CABECERA_ADJUNTO,
  CuerpoDemasiadoGrande,
  leerFormularioAcotado,
  MAX_ADJUNTO_MANUAL_BYTES,
  MAX_CUERPO_ADJUNTO_BYTES,
  validarAdjuntoManual,
} from "@/server/inbox/adjunto-manual";
import { MediaValidationError } from "@/server/whatsapp/media";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MB = 1024 * 1024;
const TOPE_MENSAJE = `El archivo es demasiado grande: desde la bandeja el máximo es ${MAX_ADJUNTO_MANUAL_BYTES.image / MB} MB para imágenes y ${
  MAX_ADJUNTO_MANUAL_BYTES.document / MB
} MB para video, audio y documentos.`;

/**
 * 008 — Envía un adjunto de archivo por la conversación (multipart):
 * `file` (binario, requerido) + `caption` (opcional).
 *
 * Hallazgo A: el archivo se carga entero en memoria, así que se protege en tres tiempos, todos ANTES de tocar Graph o R2:
 * 1. `Content-Length` declarado > tope → 413 sin leer una sola parte del cuerpo; y aunque falte o mienta, la lectura
 *    se corta al pasar el tope (`leerFormularioAcotado`).
 * 2. Con el `File` ya parseado, tamaño por tipo + firma de los primeros bytes (`validarAdjuntoManual`): rechazo 413/415
 *    antes de materializar el archivo como `Buffer`.
 * 3. `sendMediaMessage` repite la comprobación con el tipo ya verificado, que es el que se guarda y se envía.
 */
export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const conv = await getConversation(session.organizationId, id);
  if (!conv) return apiError(404, "not_found", "Conversación no encontrada");

  const declarado = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declarado) && declarado > MAX_CUERPO_ADJUNTO_BYTES) {
    return apiError(413, "too_large", TOPE_MENSAJE);
  }

  let form: FormData;
  try {
    form = await leerFormularioAcotado(req, MAX_CUERPO_ADJUNTO_BYTES);
  } catch (err) {
    if (err instanceof CuerpoDemasiadoGrande) return apiError(413, "too_large", TOPE_MENSAJE);
    return apiError(400, "invalid", "Se esperaba multipart/form-data");
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return apiError(422, "invalid", "Falta el archivo (campo `file`)");
  }
  const captionRaw = form.get("caption");
  const caption =
    typeof captionRaw === "string" && captionRaw.trim()
      ? captionRaw.trim().slice(0, 1024)
      : undefined;

  try {
    // Solo la cabecera: si el tamaño o el tipo no cuadran, el archivo no se materializa en un Buffer.
    const head = new Uint8Array(await file.slice(0, BYTES_CABECERA_ADJUNTO).arrayBuffer());
    const verificado = validarAdjuntoManual({ mimeType: file.type, size: file.size, head });

    // `Buffer.from(ArrayBuffer)` comparte la memoria (no copia).
    const data = Buffer.from(await file.arrayBuffer());
    const result = await sendMediaMessage({
      conversationId: id,
      organizationId: session.organizationId,
      file: {
        data,
        mimeType: verificado.mimeType,
        fileName: file.name || undefined,
      },
      caption,
    });
    return Response.json({ messageId: result.messageId }, { status: 201 });
  } catch (err) {
    if (err instanceof MediaValidationError) {
      return apiError(
        err.code === "too_large" ? 413 : err.code === "empty" ? 422 : 415,
        err.code,
        err.message
      );
    }
    if (err instanceof SendError) {
      return apiError(SEND_ERROR_STATUS[err.code], err.code, err.message);
    }
    throw err;
  }
});
