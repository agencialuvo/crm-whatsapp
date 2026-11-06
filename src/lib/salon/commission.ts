/**
 * Módulo SALON — aritmética de comisiones.
 *
 * Pura y sin dependencias: la usan el servidor (al registrar la venta, donde se
 * GUARDA el reparto) y el cliente (para enseñar de antemano cuánto le toca al
 * profesional). Todo en CENTAVOS ENTEROS: el reparto nunca pasa por coma
 * flotante, así que `comisión + neto = monto` se cumple siempre (la base lo
 * exige con un CHECK).
 */

export type CommissionSource =
  | "custom"
  | "staff_service"
  | "staff"
  | "service"
  /** Nadie configuró un porcentaje: no hay comisión (0 %). */
  | "none";

export type CommissionSources = {
  /** Un porcentaje puntual para ESTA venta (descuento, acuerdo del día). */
  custom?: number | null;
  /** Lo pactado con este profesional para este servicio. */
  staffService?: number | null;
  /** El porcentaje global del profesional. */
  staff?: number | null;
  /** El porcentaje por defecto del servicio. */
  service?: number | null;
};

function valid(pct: number | null | undefined): pct is number {
  return typeof pct === "number" && Number.isFinite(pct) && pct >= 0 && pct <= 100;
}

/**
 * Qué porcentaje manda. De lo más específico a lo más general:
 * la venta → profesional × servicio → profesional → servicio. NO hay porcentaje por defecto:
 * si nadie lo configuró, no hay comisión (0 %) y todo el monto es del negocio.
 * Un valor fuera de 0-100 se ignora (cae al siguiente) en vez de repartir mal.
 */
export function resolveCommissionPercentage(src: CommissionSources): {
  percentage: number;
  source: CommissionSource;
} {
  if (valid(src.custom)) return { percentage: src.custom, source: "custom" };
  if (valid(src.staffService)) {
    return { percentage: src.staffService, source: "staff_service" };
  }
  if (valid(src.staff)) return { percentage: src.staff, source: "staff" };
  if (valid(src.service)) return { percentage: src.service, source: "service" };
  return { percentage: 0, source: "none" };
}

/**
 * Reparte un monto en centavos. La comisión se redondea al centavo y el neto
 * es el RESTO, no otro redondeo: así nunca se pierde ni se inventa un centavo.
 */
export function splitAmount(
  amountCents: number,
  percentage: number
): { staffCommissionCents: number; businessNetCents: number } {
  const staffCommissionCents = Math.round((amountCents * percentage) / 100);
  return {
    staffCommissionCents,
    businessNetCents: amountCents - staffCommissionCents,
  };
}

/**
 * Reparte el TOTAL cobrado entre los ítems de una venta, en proporción a su
 * precio de lista, sin perder ni inventar un centavo (método del mayor resto).
 * Si el total coincide con la suma de los precios, cada ítem se queda con el
 * suyo; si se editó el monto (descuento, propina, acuerdo), la diferencia se
 * reparte proporcional. Con precios en cero, se reparte por partes iguales.
 */
export function allocateAmounts(bases: number[], total: number): number[] {
  const n = bases.length;
  if (n === 0) return [];
  if (n === 1) return [total];
  const sum = bases.reduce((a, b) => a + b, 0);
  if (sum === total) return [...bases];

  const weights = sum > 0 ? bases : bases.map(() => 1);
  const weightSum = sum > 0 ? sum : n;
  const exact = weights.map((w) => (w * total) / weightSum);
  const floors = exact.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]! += 1;
    left -= 1;
  }
  return floors;
}
