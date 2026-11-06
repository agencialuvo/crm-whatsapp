/**
 * Qué plan inicial le toca a un negocio nuevo según su sector. Puro: sin base de datos, para
 * poder probarlo con tablas de casos.
 *
 * La regla sale de los DATOS, no de un `slug` fijo: cada categoría declara sus
 * `defaultModules` (los que su menú va a mostrar) y el plan inicial es el más barato que los
 * incluye TODOS. Así un negocio nuevo no cae en «mejora tu plan» sin haber tocado nada, y
 * añadir un sector o un plan no obliga a tocar el registro.
 */

export type PlanCandidate = {
  id: string;
  slug: string;
  active: boolean;
  priceMonthlyCents: number;
  features: { modules: readonly string[] };
};

/**
 * 1. Entre los planes activos que incluyen todos los módulos del sector: el más barato; a igual
 *    precio, el de menos módulos (el mínimo que cubre el sector); y, por último, el slug.
 * 2. Si ninguno los cubre todos (el catálogo no tiene un plan para ese sector): el que cubre
 *    más, con el mismo desempate. Es mejor un plan parcial que ninguna suscripción.
 * 3. Sin planes activos: `null`.
 */
export function pickInitialPlan<T extends PlanCandidate>(
  plans: readonly T[],
  needed: readonly string[]
): T | null {
  const active = plans.filter((p) => p.active);
  if (active.length === 0) return null;
  const covered = (p: T) => needed.filter((m) => p.features.modules.includes(m)).length;
  const order = (a: T, b: T) =>
    a.priceMonthlyCents - b.priceMonthlyCents ||
    a.features.modules.length - b.features.modules.length ||
    a.slug.localeCompare(b.slug);

  const full = active.filter((p) => covered(p) === needed.length).sort(order);
  if (full[0]) return full[0];
  return [...active].sort((a, b) => covered(b) - covered(a) || order(a, b))[0] ?? null;
}
