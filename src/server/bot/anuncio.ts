import type { AdFlowTarget } from "@/lib/ad-flow";
import { atribucionEnabled } from "@/server/attribution/flag";
import { getAttributionForConversation } from "@/server/attribution/store";
import { getAdFlowContext } from "@/server/ai/ad-flow-context";

/**
 * Bloque 2 — Lo que el cerebro externo necesita saber del anuncio de origen, para portarse igual que el agente
 * incluido: de qué anuncio llegó la conversación y, si ese anuncio tiene un flujo ACTIVO, qué servicio u oferta
 * persigue, con sus datos oficiales, si es exclusivo y las reglas del negocio para ese anuncio.
 *
 * Contrato aditivo de `GET /api/bot/context`:
 *  - con `ATRIBUCION` apagada el campo `ad` FALTA (como `booking` sin agenda): un cerebro que no lo recibe no
 *    supone nada;
 *  - `ad: null` = la conversación no llegó por un anuncio;
 *  - `ad.flow: null` = llegó por un anuncio sin flujo activo (comportamiento genérico).
 *
 * No incluye el `ctwa_clid` (es para la CAPI, no para conversar) ni la fila cruda del webhook. Un fallo de
 * lectura deja el campo fuera, nunca tumba el contexto.
 */

export type AdFlowForBot = {
  id: string;
  exclusive: boolean;
  promptRules: string | null;
  target: AdFlowTarget | null;
};

export type AdForBot = {
  sourceId: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
  headline: string | null;
  body: string | null;
  mediaType: string | null;
  attributedAt: string;
  flow: AdFlowForBot | null;
};

/** `undefined` = el campo no va (bandera apagada o fallo); `null` = no llegó por un anuncio. */
export async function adParaBot(
  organizationId: string,
  conversationId: string
): Promise<AdForBot | null | undefined> {
  if (!atribucionEnabled()) return undefined;
  try {
    const fila = await getAttributionForConversation(organizationId, conversationId);
    if (!fila) return null;
    const ctx = fila.sourceId ? await getAdFlowContext(organizationId, fila.sourceId) : null;
    return {
      sourceId: fila.sourceId,
      sourceType: fila.sourceType,
      sourceUrl: fila.sourceUrl,
      headline: fila.headline,
      body: fila.body,
      mediaType: fila.mediaType,
      attributedAt: fila.createdAt.toISOString(),
      flow: ctx
        ? { id: ctx.flowId, exclusive: ctx.exclusive, promptRules: ctx.promptRules, target: ctx.target }
        : null,
    };
  } catch (err) {
    console.error(`[bot] no se pudo leer el anuncio de origen de ${conversationId}:`, err);
    return undefined;
  }
}
