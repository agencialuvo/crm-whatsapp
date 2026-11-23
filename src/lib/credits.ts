/**
 * Monedas (IA y WhatsApp) — la parte PURA: unidades, tipos, tarifas, claves de idempotencia y la decisión de corte.
 * Sin base de datos ni entorno: la usan el servidor (`server/credits/`) y, más adelante, la interfaz.
 *
 * Todo se cuenta en UNIDADES enteras: 1 moneda = 100 unidades. Así un turno de IA que cuesta fracciones de moneda
 * se cobra sin números decimales (y sin errores de redondeo que descuadren el libro).
 */

export const UNITS_PER_COIN = 100;

/** `monthlyCoins = -1` en el plan: sin tope. */
export const UNLIMITED = -1;

export const LEDGER_KINDS = ["grant", "expire", "spend", "topup", "refund", "adjustment", "reversal"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** `plan` vence al cerrar el periodo; `topup` (recargas) no vence. */
export const BUCKETS = ["plan", "topup"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** Lo que se cobra: IA y WhatsApp. */
export const LEDGER_SERVICES = ["ai", "whatsapp"] as const;
export type LedgerService = (typeof LEDGER_SERVICES)[number];

/** Lo que se mide: además, la IA del Laboratorio (se mide, no se cobra). */
export const USAGE_SERVICES = ["ai", "ai_lab", "whatsapp"] as const;
export type UsageService = (typeof USAGE_SERVICES)[number];

export const ALERT_THRESHOLDS = ["warn80", "exhausted", "zero"] as const;
export type AlertThreshold = (typeof ALERT_THRESHOLDS)[number];

export const coinsToUnits = (coins: number): number => Math.round(coins * UNITS_PER_COIN);
export const unitsToCoins = (units: number): number => units / UNITS_PER_COIN;

/** «12,5» — monedas con hasta 2 decimales, para mostrar. */
export function formatCoins(units: number): string {
  return unitsToCoins(units).toLocaleString("es-PE", { maximumFractionDigits: 2 });
}

/* ───────────────────────── Saldo ───────────────────────── */

export type Balances = { planBalance: number; topupBalance: number };

/** El saldo total: lo que queda de la cuota más las recargas (que pueden estar en negativo). */
export const totalOf = (b: Balances): number => b.planBalance + b.topupBalance;

/**
 * Cómo se reparte un gasto: primero la cuota del plan (hasta dejarla en 0) y después las recargas. Si no alcanza,
 * el faltante también se toma de las recargas, que quedan en negativo: un gasto YA HECHO (la IA ya contestó, Meta
 * ya aceptó el mensaje) siempre se registra; el corte es una decisión ANTES de gastar, no después.
 */
export function splitSpend(b: Balances, amount: number): { fromPlan: number; fromTopup: number } {
  const fromPlan = Math.min(amount, Math.max(b.planBalance, 0));
  return { fromPlan, fromTopup: amount - fromPlan };
}

/** `error`: no se pudo consultar el saldo. Se deja pasar: nunca se corta a un cliente por un fallo propio. */
export type GateReason = "off" | "no_account" | "unlimited" | "ok" | "exhausted" | "error";

export type Gate = {
  /** ¿Se puede gastar? */
  allow: boolean;
  /** El saldo no alcanza: con el corte activo se habría bloqueado. Es el dato del modo sombra. */
  wouldCut: boolean;
  reason: GateReason;
};

/**
 * La decisión de corte, pura. Agotado = el saldo, más lo que se tolera en negativo (`overdraftLimit`), ya no cubre
 * el gasto (`amount`, por defecto 1 unidad: «¿queda algo?»). Con el corte apagado (modo sombra) se permite siempre,
 * pero `wouldCut` dice lo que habría pasado.
 */
export function decideGate(input: {
  total: number;
  overdraftLimit: number;
  cutEnabled: boolean;
  unlimited: boolean;
  amount?: number;
}): Gate {
  if (input.unlimited) return { allow: true, wouldCut: false, reason: "unlimited" };
  const need = Math.max(input.amount ?? 1, 1);
  const exhausted = input.total + input.overdraftLimit < need;
  if (!exhausted) return { allow: true, wouldCut: false, reason: "ok" };
  return { allow: !input.cutEnabled, wouldCut: true, reason: "exhausted" };
}

/** ¿Qué umbral de aviso toca, según lo usado de la cuota? `null` = ninguno todavía. */
export function thresholdFor(input: { planBalance: number; topupBalance: number; quota: number }): AlertThreshold | null {
  if (input.quota <= 0) return null;
  const total = totalOf(input);
  if (total <= 0) return "zero";
  if (input.planBalance <= 0) return "exhausted";
  if (input.planBalance <= input.quota * 0.2) return "warn80";
  return null;
}

/* ───────────────────────── Tarifas ───────────────────────── */

export const RATE_UNIT_KINDS = ["per_turn", "per_1k_tokens", "per_message"] as const;
export type RateUnitKind = (typeof RATE_UNIT_KINDS)[number];

export const RATE_KEYS = {
  aiTurn: "ai.turn",
  waText: "wa.text",
} as const;

/** Las categorías de plantilla de Meta que se cobran. Cualquier otra cae en `wa.template.other`. */
export const TEMPLATE_CATEGORIES = ["marketing", "utility", "authentication"] as const;

export function templateRateKey(category: string | null | undefined): string {
  const c = (category ?? "").trim().toLowerCase();
  return (TEMPLATE_CATEGORIES as readonly string[]).includes(c) ? `wa.template.${c}` : "wa.template.other";
}

/**
 * Cuánto cuesta un consumo con una tarifa. Entero y nunca negativo. Una tarifa de 0 (mensajes libres) da 0: se mide,
 * no se cobra. Por tokens se redondea hacia arriba por cada 1.000, con un mínimo de 1 unidad si la tarifa no es 0.
 */
export function priceUsage(
  rate: { unitKind: RateUnitKind; amount: number },
  q: { tokens?: number; quantity?: number }
): number {
  if (rate.amount <= 0) return 0;
  switch (rate.unitKind) {
    case "per_turn":
      return rate.amount;
    case "per_message":
      return rate.amount * Math.max(Math.floor(q.quantity ?? 1), 0);
    case "per_1k_tokens": {
      const tokens = Math.max(Math.floor(q.tokens ?? 0), 0);
      return Math.max(Math.ceil((tokens / 1000) * rate.amount), 1);
    }
  }
}

/* ───────────────────────── Claves de idempotencia ───────────────────────── */

const iso = (d: Date): string => d.toISOString();

/**
 * Cada operación se identifica por LO QUE LA ORIGINÓ, no por cuándo se intentó: repetirla (un reintento, un webhook
 * duplicado, un barrido que corre dos veces) cae en la misma clave y no hace nada. Se centralizan aquí para que
 * el cobro de la IA, el de WhatsApp y el de las recargas usen siempre la misma forma.
 */
export const idemKey = {
  /** La cuota de un periodo de suscripción. */
  grant: (subscriptionId: string, periodStart: Date) => `period:${subscriptionId}:${iso(periodStart)}`,
  /** Lo que sobró de la cuota de un periodo y vence al cerrarlo. */
  expire: (periodStart: Date) => `expire:${iso(periodStart)}`,
  /** Un turno del agente: la conversación y el último mensaje entrante que lo provocó. */
  aiTurn: (conversationId: string, lastInboundId: string) => `ai:${conversationId}:${lastInboundId}`,
  /** Un envío de WhatsApp: el id de la fila del mensaje (que existe antes de llamar a Meta). */
  waMessage: (messageId: string) => `wa:${messageId}`,
  /** Una recarga: su propio id (el `external_reference` ante la pasarela). */
  topup: (topupId: string) => `topup:${topupId}`,
  /** Un reembolso de una recarga. */
  refund: (topupId: string) => `refund:${topupId}`,
  /** El ajuste de cuota por un cambio de plan a mitad de periodo (la clave lleva la cuota nueva: repetirlo no suma). */
  planChange: (subscriptionId: string, periodStart: Date, units: number) => `planchange:${subscriptionId}:${iso(periodStart)}:${units}`,
  /** La segunda fila de un gasto que toca los dos saldos. */
  secondRow: (key: string) => `${key}~topup`,
} as const;

/* ───────────────────────── Valores provisionales (modo sombra) ───────────────────────── */

/**
 * Tarifas base mientras se calibra en modo sombra. Se SIEMBRAN en `credit_rate` solo si la clave no tiene ninguna
 * fila (`ensureDefaultRates`): desde ahí mandan las filas de la base —cambiar un precio es agregar una versión—, y
 * estos valores no pisan nunca una decisión tomada. `amount` en unidades (1 moneda = 100).
 */
export const DEFAULT_RATES: readonly {
  key: string;
  service: LedgerService;
  category: string | null;
  unitKind: RateUnitKind;
  amount: number;
  note: string;
}[] = [
  { key: RATE_KEYS.aiTurn, service: "ai", category: null, unitKind: "per_turn", amount: 100, note: "Provisional: 1 moneda por turno del agente" },
  // El mensaje libre dentro de la ventana de 24 h se MIDE pero no se cobra.
  { key: RATE_KEYS.waText, service: "whatsapp", category: "text", unitKind: "per_message", amount: 0, note: "Mensaje libre: solo medido" },
  { key: "wa.template.marketing", service: "whatsapp", category: "marketing", unitKind: "per_message", amount: 300, note: "Provisional" },
  { key: "wa.template.utility", service: "whatsapp", category: "utility", unitKind: "per_message", amount: 100, note: "Provisional" },
  { key: "wa.template.authentication", service: "whatsapp", category: "authentication", unitKind: "per_message", amount: 100, note: "Provisional" },
  { key: "wa.template.other", service: "whatsapp", category: "other", unitKind: "per_message", amount: 100, note: "Provisional: categoría no reconocida" },
];

/**
 * Cuota mensual provisional por plan, en UNIDADES. La manda `plan.features.monthlyCoins` cuando existe; si no, esta
 * tabla por `slug`. `UNLIMITED` = sin tope. Un plan que no está aquí ni define `monthlyCoins` no mide (cuota 0).
 */
export const DEFAULT_PLAN_QUOTA_UNITS: Readonly<Record<string, number>> = {
  demo: 200 * UNITS_PER_COIN,
  emprendedor: 1000 * UNITS_PER_COIN,
  pro: 3500 * UNITS_PER_COIN,
  enterprise: UNLIMITED,
};

/** La cuota (unidades) de un plan: lo explícito del plan, o el valor provisional de su `slug`, o 0. */
export function quotaForPlan(plan: { slug: string; features?: { monthlyCoins?: number } | null }): number {
  const explicit = plan.features?.monthlyCoins;
  if (typeof explicit === "number" && Number.isInteger(explicit) && (explicit >= 0 || explicit === UNLIMITED)) return explicit;
  return DEFAULT_PLAN_QUOTA_UNITS[plan.slug] ?? 0;
}
