import { z } from "zod";

/**
 * Panel — «Embudo financiero real»: de lo que entra (ingresos) a lo que de verdad queda
 * (ganancia neta). Todo en céntimos enteros.
 *
 *   ganancia neta = ingresos − comisiones − gastos
 *
 * Los GASTOS son del negocio (alquiler, luz, insumos): no pertenecen a un servicio ni a un
 * profesional. Con uno de esos filtros activos no se prorratean (sería inventar el dato):
 * `expensesCents` queda en `null` y la ganancia es «antes de gastos» (ingresos − comisiones).
 */

export type FunnelTotalsDto = {
  /** Ventas cobradas (con filtro de servicio: las ventas que lo incluyen). */
  count: number;
  revenueCents: number;
  commissionsCents: number;
  /** `null` = no aplica (hay un filtro de profesional o de servicio). */
  expensesCents: number | null;
  netCents: number;
};

export type FunnelPointDto = {
  /** `AAAA-MM-DD` (día o inicio de semana) o `AAAA-MM` (mes), en la zona del negocio. */
  bucket: string;
  revenueCents: number;
  commissionsCents: number;
  /** 0 cuando los gastos no aplican (ver `FunnelTotalsDto`). */
  expensesCents: number;
  netCents: number;
  count: number;
};

/** La suma del embudo: el único lugar donde se define la ganancia neta. */
export function computeFunnel(input: {
  count: number;
  revenueCents: number;
  commissionsCents: number;
  expensesCents: number | null;
}): FunnelTotalsDto {
  return {
    ...input,
    netCents: input.revenueCents - input.commissionsCents - (input.expensesCents ?? 0),
  };
}

/* ------------------------- filtro «servicio o categoría» ------------------------ */

/**
 * Lo que se puede filtrar: todos los servicios, todos los combos, un servicio o un combo.
 * (El catálogo no tiene categorías propias: «servicios» y «combos» son los dos tipos.)
 * Viaja como texto: `service`, `combo`, `service:<id>` o `combo:<id>`.
 */
export type ItemFilter = { kind: "service" | "combo"; id: string | null };

const ITEM_FILTER = /^(service|combo)(?::([A-Za-z0-9_-]{1,64}))?$/;

export const itemFilterSchema = z
  .string()
  .max(80)
  .regex(ITEM_FILTER, "Filtro de servicio no válido");

/** `null` si no hay filtro o no es válido (el llamador decide si eso es un error). */
export function parseItemFilter(raw: string | null | undefined): ItemFilter | null {
  if (!raw) return null;
  const m = ITEM_FILTER.exec(raw);
  if (!m) return null;
  return { kind: m[1] as ItemFilter["kind"], id: m[2] ?? null };
}

export function formatItemFilter(filter: ItemFilter | null): string {
  return filter ? (filter.id ? `${filter.kind}:${filter.id}` : filter.kind) : "";
}

/** Opciones del desplegable, agrupadas: por tipo, luego cada servicio y cada combo. */
export function itemFilterOptions(
  services: { id: string; name: string }[],
  combos: { id: string; name: string }[]
): { value: string; label: string; group: string }[] {
  return [
    { value: "service", label: "Todos los servicios", group: "Por tipo" },
    { value: "combo", label: "Todos los combos", group: "Por tipo" },
    ...services.map((s) => ({ value: `service:${s.id}`, label: s.name, group: "Servicios" })),
    ...combos.map((c) => ({ value: `combo:${c.id}`, label: c.name, group: "Combos" })),
  ];
}
