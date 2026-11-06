/**
 * Módulos que un plan de suscripción puede incluir (`plan.features.modules`).
 * Sin imports de servidor: lo leen también el menú y los componentes de cliente.
 */
export const PLAN_MODULES = ["agenda", "salon", "atribucion", "loyalty", "finances"] as const;
export type PlanModule = (typeof PLAN_MODULES)[number];

/** Cómo se llama cada módulo para quien lee el aviso «mejora tu plan». */
export const PLAN_MODULE_LABEL: Record<PlanModule, string> = {
  agenda: "Agenda y citas",
  salon: "Salón: servicios, equipo y clientes",
  atribucion: "Atribución de anuncios",
  loyalty: "Fidelización y cumpleaños",
  finances: "Finanzas: panel, caja y gastos",
};

export function isPlanModule(value: unknown): value is PlanModule {
  return typeof value === "string" && (PLAN_MODULES as readonly string[]).includes(value);
}
