import { estadoIaDe } from "@/lib/ai/provider";
import type { ChatJsonResult, ChatUsageOpts } from "@/lib/ai";
import { idemKey, RATE_KEYS } from "@/lib/credits";
import { checkCredit, creditsEnabled, priceFor, spendCredits } from "@/server/credits";
import { ensureCreditAccount } from "@/server/saas/credits-sync";

/**
 * Monedas — el turno del agente. Une tres cosas que `pipeline.ts` no debe saber hacer por su cuenta:
 *
 *  1. ANTES del modelo: ¿se puede gastar? Solo cuenta cuando la llave es la del entorno (la del cliente, BYOK, no
 *     consume monedas) y no es el Laboratorio. Con el corte activo y sin saldo, el turno se CALLA: sin traspaso,
 *     sin acuse, sin mensaje (el cliente final no debe enterarse de un tema de facturación), y sin bucle porque el
 *     turno cuenta como leído.
 *  2. DURANTE: la medición de cada llamada (`credit_usage`), que hace `chatJson` con lo que se le pasa aquí.
 *  3. DESPUÉS de una respuesta válida: el cobro, idempotente por `ai:<conversación>:<último entrante>`.
 *
 * Con `CREDITS` apagada todo esto es un no-op que no toca la base. Nunca lanza: un fallo de monedas no puede
 * tumbar el turno.
 */

export type AiTurnMeter = {
  /** El corte está activo y no alcanza el saldo: no llamar al modelo. */
  blocked: boolean;
  /** Para `chatJson({ usage })`. Ausente con `CREDITS` apagada. */
  usage?: ChatUsageOpts;
  /** Cobra el turno si la respuesta fue válida y la llave era la del entorno. */
  settle: (result: ChatJsonResult<unknown>) => Promise<void>;
};

const NOOP: AiTurnMeter = { blocked: false, settle: async () => {} };

export async function beginAiTurnMeter(input: {
  organizationId: string;
  conversationId: string;
  lastInboundId: string;
  /** Conversación del Laboratorio: se mide, no se cobra ni se corta. */
  isTest: boolean;
}): Promise<AiTurnMeter> {
  if (!creditsEnabled()) return NOOP;
  const { organizationId, conversationId, lastInboundId } = input;
  const base = { conversationId, refType: "message", refId: lastInboundId } as const;

  if (input.isTest) {
    return { blocked: false, usage: { service: "ai_lab", ...base }, settle: async () => {} };
  }

  try {
    const estado = await estadoIaDe(organizationId).catch(() => null);
    const source = estado && estado.activa ? estado.origen : null;
    // Llave del cliente (o no resuelta): se mide pero no se cobra ni se corta.
    if (source !== "env") return { blocked: false, usage: { service: "ai", ...base }, settle: async () => {} };

    await ensureCreditAccount(organizationId);
    const price = await priceFor(RATE_KEYS.aiTurn);
    const gate = price > 0 ? await checkCredit(organizationId, { amount: price }) : null;
    if (gate && !gate.allow) {
      console.warn(`[monedas] ${organizationId} sin saldo: el agente no contesta en ${conversationId}`);
      return { blocked: true, settle: async () => {} };
    }
    const key = idemKey.aiTurn(conversationId, lastInboundId);
    return {
      blocked: false,
      usage: { service: "ai", ...base, key, chargeUnits: price, wouldCut: gate?.wouldCut ?? false },
      settle: async (result) => {
        if (!result.ok || result.meta?.source !== "env" || price <= 0) return;
        try {
          await spendCredits({
            organizationId,
            service: "ai",
            amount: price,
            idempotencyKey: key,
            refType: "message",
            refId: lastInboundId,
            meta: {
              model: result.meta.model,
              tokensIn: result.meta.tokensIn,
              tokensOut: result.meta.tokensOut,
              estimated: result.meta.estimated,
              attempts: result.meta.attempts,
            },
          });
        } catch (err) {
          console.error(`[monedas] no se pudo cobrar el turno ${key}:`, err instanceof Error ? err.message : err);
        }
      },
    };
  } catch (err) {
    console.error("[monedas] medición del turno:", err instanceof Error ? err.message : err);
    return NOOP;
  }
}
