import { parseWatchHeaders, verifyChannelToken } from "@/lib/google-watch";
import { findChannel, markNotified } from "@/server/agenda/calendar-watch/channels";
import { watchFlagOn, watchSecret } from "@/server/agenda/calendar-watch/flag";
import { triggerSourceRead } from "@/server/agenda/calendar-watch/notify";

export const dynamic = "force-dynamic";

const status = (code: number) => new Response(null, { status: code });

/**
 * Mejora 4 — Los avisos de Google Calendar (`events.watch`). Público (sin sesión, fuera de `SAAS_ENFORCE`, como
 * los demás webhooks): Google no manda cookies ni firma, solo encabezados `X-Goog-*`.
 *
 * Orden estricto, y SIN leer el cuerpo (el aviso no se usa como dato):
 *  1. Bandera apagada → 404.
 *  2. Encabezados que no parecen de Google → 400.
 *  3. Token: el HMAC del `channel_id` con el secreto de la instancia, comparado en tiempo constante ANTES de
 *     tocar la base (un aviso falso no cuesta ni una consulta) → 404.
 *  4. El canal existe, no está fallido y su `resource_id` coincide → si no, 404 (Google solo reintenta los 5xx:
 *     un canal viejo no genera reintentos).
 *  5. 200 enseguida. `sync` (el primer aviso, al crear el canal) no lee nada; `exists`/`not_exists` piden una
 *     lectura de ESA fuente (el negocio o el profesional del canal), agrupada por ráfagas, en segundo plano.
 */
export async function POST(req: Request): Promise<Response> {
  if (!watchFlagOn()) return status(404);
  const h = parseWatchHeaders(req.headers);
  if (!h) return status(400);
  if (!verifyChannelToken(watchSecret(), h.channelId, h.token)) return status(404);

  const row = await findChannel(h.channelId).catch(() => null);
  if (!row || row.status === "failed") return status(404);
  if (row.resourceId && row.resourceId !== h.resourceId) return status(404);

  await markNotified(row, h.messageNumber);
  if (h.state !== "sync") triggerSourceRead(row.organizationId, row.staffId);
  return status(200);
}
