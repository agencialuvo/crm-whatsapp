/**
 * Las llaves ESTABLES del menú lateral. Una llave nunca cambia de significado: la guardan las configuraciones de menú
 * de las organizaciones, así que renombrar una pantalla o cambiar su ruta no las rompe.
 *
 * Sin dependencias: las leen `nav.ts` (el catálogo con iconos y rutas), `menu-config.ts` (el esquema de validación) y
 * el servidor. Una prueba afirma que el catálogo de `nav.ts` cubre EXACTAMENTE estas llaves.
 */

/** Los bloques del menú, en su orden por defecto. «sistema» es el de abajo (Notificaciones y Ajustes). */
export const NAV_GROUP_KEYS = ["trabajo", "gestion", "agente", "resultados", "sistema"] as const;
export type NavGroupKey = (typeof NAV_GROUP_KEYS)[number];

/** Las entradas del menú. */
export const NAV_ITEM_KEYS = [
  "panel",
  "bandeja",
  "pipeline",
  "caja",
  "citas",
  "clientes",
  "servicios",
  "equipo",
  "gastos",
  "contactos",
  "medios",
  "automatizaciones",
  "guia",
  "agente",
  "laboratorio",
  "resultados",
  "notificaciones",
  "ajustes",
] as const;
export type NavItemKey = (typeof NAV_ITEM_KEYS)[number];

/** En qué bloque nace cada entrada. */
export const NAV_ITEM_GROUP: Record<NavItemKey, NavGroupKey> = {
  panel: "trabajo",
  bandeja: "trabajo",
  pipeline: "trabajo",
  caja: "trabajo",
  citas: "trabajo",
  clientes: "trabajo",
  servicios: "gestion",
  equipo: "gestion",
  gastos: "gestion",
  contactos: "gestion",
  medios: "gestion",
  automatizaciones: "gestion",
  guia: "agente",
  agente: "agente",
  laboratorio: "agente",
  resultados: "resultados",
  notificaciones: "sistema",
  ajustes: "sistema",
};

/** El bloque que va al pie de la barra: solo lleva lo suyo y lo suyo no sale de él. */
export const NAV_BOTTOM_GROUP: NavGroupKey = "sistema";

/**
 * Entradas que NUNCA se pueden ocultar. «Ajustes» es la puerta de `/ajustes/menu`: si se pudiera esconder, un dueño
 * podría quedarse sin forma de volver a configurar el menú.
 */
export const PROTECTED_ITEM_KEYS: readonly NavItemKey[] = ["ajustes"];

export function isProtectedItem(key: NavItemKey): boolean {
  return PROTECTED_ITEM_KEYS.includes(key);
}
