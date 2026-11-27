import { estadoIaDe } from "@/lib/ai/provider";
import type { ChatJsonResult, ChatUsageOpts } from "@/lib/ai";
import { idemKey, RATE_KEYS } from "@/lib/credits";
import { checkCredit, creditsEnabled, getCreditBalance, priceFor, spendCredits } from "@/server/credits";
import { ensureCreditAccount } from "@/server/saas/credits-sync";
import { notifyBalanceIfNeeded } from "@/server/notifications/credit-alerts";

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

/**
 * ¿Hay que cortar a esta organización ahora mismo? La pregunta de las puertas que NO pasan por `runAgentTurn`
 * (`/api/bot/messages`: un cerebro externo que escribe por nosotros). Solo es `true` con el corte activo y sin saldo
 * para un turno; en modo sombra, con `CREDITS` apagada, sin cuenta o ante cualquier fallo, deja pasar. No mira de
 * quién es la llave: ese cerebro no usa la nuestra, pero el agente de la organización sí se detiene por falta de saldo.
 */
export async function aiBlockedByCredit(organizationId: string): Promise<boolean> {
  if (!creditsEnabled()) return false;
  try {
    const price = await priceFor(RATE_KEYS.aiTurn);
    if (price <= 0) return false;
    await ensureCreditAccount(organizationId);
    return !(await checkCredit(organizationId, { amount: price })).allow;
  } catch (err) {
    console.error("[monedas] aiBlockedByCredit:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Mejora 8 — ¿La organización se quedó sin monedas? Para el cupo del Laboratorio (`server/lab/runner.ts`), que no
 * habla con la puerta de monedas directo. `false` con `CREDITS` apagada, sin cuenta o con cuenta ilimitada. Lanza
 * si la consulta falla: quien llama decide (el Laboratorio cae al cupo menor).
 */
export async function sinSaldoDeMonedas(organizationId: string): Promise<boolean> {
  if (!creditsEnabled()) return false;
  const saldo = await getCreditBalance(organizationId);
  return !!saldo && !saldo.unlimited && saldo.total <= 0;
}

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
      void notifyBalanceIfNeeded(organizationId); // por si el saldo llegó a cero por otro camino: una vez por periodo
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
          void notifyBalanceIfNeeded(organizationId); // sin esperar: avisar no retrasa la respuesta
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
