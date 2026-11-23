import { estadoIaDe } from "@/lib/ai/provider";
import { RATE_KEYS, templateRateKey, TEMPLATE_CATEGORIES } from "@/lib/credits";
import type { PublicPackDto } from "@/lib/super-admin-credits";
import { checkCredit, creditsEnabled, getAlertState, getCreditBalance, getPeriodSpend, listPacks, priceFor, type PeriodSpend } from "@/server/credits";
import { ensureCreditAccount } from "@/server/saas/credits-sync";

/**
 * Monedas — lo que ve el CLIENTE: su saldo, su cuota, su consumo y el costo de lo que va a enviar. Es el único
 * camino de las pantallas del cliente hacia la puerta de monedas (solo lectura). Con `CREDITS` apagada todo es
 * `{ enabled: false }` y ninguna pantalla muestra nada: no se toca la base.
 */

export { creditsEnabled };

export type CreditSummary =
  | { enabled: false }
  | {
      enabled: true;
      /** La organización tiene cuenta (suscripción con cuota). Sin ella se mide nada y no hay saldo que mostrar. */
      metered: boolean;
      unlimited: boolean;
      planBalance: number;
      topupBalance: number;
      total: number;
      /** Cuota concedida en el periodo (unidades). */
      quota: number;
      periodStart: string | null;
      periodEnd: string | null;
      /** El corte está activo: sin saldo, el agente se calla y las plantillas no salen. En sombra es `false`. */
      cutEnabled: boolean;
      /** Con el corte activo, el saldo no alcanza para un turno del agente. */
      blockedAi: boolean;
      /** Con el corte activo, el saldo no alcanza ni para la plantilla más barata. */
      blockedTemplates: boolean;
      /** Cuánto cuesta un turno del agente (unidades). */
      turnCost: number;
      /** Cuánto cuesta una plantilla por categoría de Meta (unidades). */
      templateCosts: Record<string, number>;
      /** Lo descontado en el periodo, por servicio. */
      spend: PeriodSpend;
    };

const startOfMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

async function costs(): Promise<{ turnCost: number; templateCosts: Record<string, number> }> {
  const entries = await Promise.all([...TEMPLATE_CATEGORIES, "other"].map(async (c) => [c, await priceFor(templateRateKey(c))] as const));
  return { turnCost: await priceFor(RATE_KEYS.aiTurn), templateCosts: Object.fromEntries(entries) };
}

/** El resumen de monedas de una organización. Nunca lanza: ante un fallo devuelve `{ enabled: false }` (no se muestra nada). */
export async function creditSummary(organizationId: string, now: Date = new Date()): Promise<CreditSummary> {
  if (!creditsEnabled()) return { enabled: false };
  try {
    await ensureCreditAccount(organizationId);
    const [bal, c] = await Promise.all([getCreditBalance(organizationId), costs()]);
    if (!bal) {
      return {
        enabled: true, metered: false, unlimited: false, planBalance: 0, topupBalance: 0, total: 0, quota: 0,
        periodStart: null, periodEnd: null, cutEnabled: false, blockedAi: false, blockedTemplates: false,
        turnCost: c.turnCost, templateCosts: c.templateCosts, spend: { ai: { count: 0, units: 0 }, whatsapp: { count: 0, units: 0 } },
      };
    }
    const from = bal.planPeriodStart ?? startOfMonth(now);
    const spend = (await getPeriodSpend(organizationId, from)) ?? { ai: { count: 0, units: 0 }, whatsapp: { count: 0, units: 0 } };
    // La cuota concedida en el periodo (concesión + ajustes de plan), tal como la lleva el libro.
    const quota = (await getAlertState(organizationId))?.quota ?? 0;
    const cheapest = Math.min(...Object.values(c.templateCosts).filter((v) => v > 0), Number.POSITIVE_INFINITY);
    const cut = bal.cutEnabled && !bal.unlimited;
    const blockedAi = cut && c.turnCost > 0 && !(await checkCredit(organizationId, { amount: c.turnCost })).allow;
    const blockedTemplates = cut && Number.isFinite(cheapest) && !(await checkCredit(organizationId, { amount: cheapest })).allow;
    return {
      enabled: true,
      metered: true,
      unlimited: bal.unlimited,
      planBalance: bal.plan,
      topupBalance: bal.topup,
      total: bal.total,
      quota,
      periodStart: bal.planPeriodStart?.toISOString() ?? null,
      periodEnd: bal.planPeriodEnd?.toISOString() ?? null,
      cutEnabled: bal.cutEnabled,
      blockedAi,
      blockedTemplates,
      turnCost: c.turnCost,
      templateCosts: c.templateCosts,
      spend,
    };
  } catch (err) {
    console.error(`[monedas] resumen de ${organizationId}:`, err instanceof Error ? err.message : err);
    return { enabled: false };
  }
}

/**
 * Los paquetes de recarga a la venta: solo los ACTIVOS y solo lo que un cliente necesita (id, nombre, monedas,
 * precio). Con `CREDITS` apagada, `{ enabled: false, packs: [] }` sin tocar la base. Nunca lanza.
 */
export async function activePacks(): Promise<{ enabled: boolean; packs: PublicPackDto[] }> {
  if (!creditsEnabled()) return { enabled: false, packs: [] };
  try {
    const rows = await listPacks({ activeOnly: true });
    return { enabled: true, packs: rows.map((p) => ({ id: p.id, name: p.name, units: p.units, priceCents: p.priceCents, currency: p.currency })) };
  } catch (err) {
    console.error("[monedas] paquetes activos:", err instanceof Error ? err.message : err);
    return { enabled: false, packs: [] };
  }
}

export type AvisoMonedas = { mensaje: string; kind: "agent" | "templates" } | null;

/**
 * La franja de «sin monedas»: solo con el corte ACTIVO y sin saldo suficiente (en modo sombra no pasa nada, así
 * que no se avisa). Si el agente usa la llave de la plataforma, dice que está pausado y que los mensajes siguen
 * llegando para atención manual; si usa la llave propia del cliente, el agente no depende de las monedas y solo
 * se avisa de las plantillas. Nunca lanza.
 */
export async function avisoMonedasDe(organizationId: string): Promise<AvisoMonedas> {
  if (!creditsEnabled()) return null;
  try {
    const s = await creditSummary(organizationId);
    if (!s.enabled || !s.metered || !s.cutEnabled) return null;
    const estado = await estadoIaDe(organizationId).catch(() => null);
    const agenteConMonedas = !!estado && estado.activa && estado.origen === "env";
    if (s.blockedAi && agenteConMonedas) {
      return {
        kind: "agent",
        mensaje:
          "Tu agente está en pausa porque te quedaste sin monedas. Los mensajes de tus clientes siguen llegando a la bandeja para que los atiendas tú.",
      };
    }
    if (s.blockedTemplates) {
      return {
        kind: "templates",
        mensaje: "Te quedaste sin monedas: las plantillas de WhatsApp no saldrán hasta que recargues o se renueve tu plan. Los mensajes dentro de las 24 h siguen funcionando.",
      };
    }
    return null;
  } catch {
    return null;
  }
}
