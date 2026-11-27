import type { z } from "zod";
import { chatJson, type ChatJsonResult, type ChatMessage, type ChatUsageOpts } from "@/lib/ai";
import type { AdFlowContext } from "@/lib/ad-flow";
import {
  correccionExclusiva,
  detectarFugaExclusiva,
  respuestaSeguraExclusiva,
  type FugaExclusiva,
} from "@/lib/ad-flow-guard";
import type { AgentActionType } from "@/server/ai/actions";
import { loadRivalOfferNames } from "@/server/ai/ad-flow-context";

/**
 * Bloque 2 — Refuerzo determinista del modo EXCLUSIVO de un anuncio, sobre la acción que devolvió el modelo.
 *
 *  1. Revisa cada texto que saldría al cliente (`reply`, `text`, `farewell`) con `detectarFugaExclusiva`.
 *  2. Si hay fuga, UN reintento con una corrección del sistema que nombra lo que sobró.
 *  3. Si el reintento falla o vuelve a fugarse, se reemplaza ese texto por una respuesta segura fija
 *     (`respuestaSeguraExclusiva`) y la acción se conserva (un handoff sigue siendo handoff).
 *
 * Nunca lanza: si algo de esto falla (leer el catálogo, el proveedor), sale la acción original. El reintento se
 * mide como parte del mismo turno (clave `…:exclusivo`) y no se cobra aparte.
 */

type Campo = "text" | "reply" | "farewell";

/** Los textos que saldrían al cliente con esta acción. */
export function textosDeAccion(action: AgentActionType): { campo: Campo; texto: string }[] {
  switch (action.action) {
    case "reply":
      return [{ campo: "text", texto: action.text }];
    case "handoff":
      return action.farewell ? [{ campo: "farewell", texto: action.farewell }] : [];
    case "none":
      return [];
    default:
      return "reply" in action && action.reply ? [{ campo: "reply", texto: action.reply }] : [];
  }
}

function reemplazar(action: AgentActionType, campo: Campo, texto: string): AgentActionType {
  return { ...action, [campo]: texto } as AgentActionType;
}

function primeraFuga(
  action: AgentActionType,
  ctx: { objetivo: string; rivales: string[]; ultimoDelCliente: string | null }
): (Extract<FugaExclusiva, { violacion: true }> & { campo: Campo }) | null {
  for (const { campo, texto } of textosDeAccion(action)) {
    const f = detectarFugaExclusiva({ texto, ...ctx });
    if (f.violacion) return { ...f, campo };
  }
  return null;
}

export async function reforzarExclusivo(input: {
  organizationId: string;
  conversationId: string;
  adFlow: AdFlowContext | null;
  /** El resultado válido del modelo. */
  result: Extract<ChatJsonResult<AgentActionType>, { ok: true }>;
  schema: z.ZodType<AgentActionType>;
  messages: ChatMessage[];
  ultimoDelCliente: string | null;
  usage?: ChatUsageOpts;
}): Promise<Extract<ChatJsonResult<AgentActionType>, { ok: true }>> {
  const { adFlow, result } = input;
  const target = adFlow?.target;
  if (!adFlow?.exclusive || !target) return result;

  try {
    const rivales = await loadRivalOfferNames(input.organizationId, target);
    if (rivales.length === 0) return result;
    const ctx = { objetivo: target.name, rivales, ultimoDelCliente: input.ultimoDelCliente };

    const fuga = primeraFuga(result.data, ctx);
    if (!fuga) return result;
    console.warn(
      `[agente] ${input.conversationId}: la respuesta rompió el anuncio exclusivo (${fuga.motivo}: ${fuga.nombres.join(", ")}); se pide corregir.`
    );

    const reintento = await chatJson(
      input.schema,
      [
        ...input.messages,
        { role: "assistant", content: result.raw },
        { role: "system", content: correccionExclusiva(target.name, fuga) },
      ],
      {
        organizationId: input.organizationId,
        ...(input.usage
          ? {
              usage: {
                ...input.usage,
                key: input.usage.key ? `${input.usage.key}:exclusivo` : null,
                // El turno se cobra una vez (settle); el reintento solo se mide.
                chargeUnits: 0,
              },
            }
          : {}),
      }
    );
    if (reintento.ok && !primeraFuga(reintento.data, ctx)) return reintento;

    // Segunda fuga (o el reintento falló): la acción original con TODOS sus textos fugados reemplazados.
    console.warn(`[agente] ${input.conversationId}: la corrección no bastó; sale la respuesta segura del anuncio.`);
    let action = result.data;
    for (const { campo, texto } of textosDeAccion(action)) {
      if (detectarFugaExclusiva({ texto, ...ctx }).violacion) {
        action = reemplazar(action, campo, respuestaSeguraExclusiva(target.name, target.priceLabel));
      }
    }
    return { ...result, data: action };
  } catch (err) {
    console.error(`[agente] la validación del anuncio exclusivo falló en ${input.conversationId}; sale la respuesta original:`, err);
    return result;
  }
}
