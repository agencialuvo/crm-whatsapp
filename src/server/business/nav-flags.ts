import { agendaEnabled } from "@/server/agenda/flag";
import { automationsEnabled } from "@/server/automation/flag";
import { salonEnabled } from "@/server/business/flag";

/**
 * Las banderas de despliegue que deciden QUÉ entradas existen en el menú lateral (`appNavGroups`). Se leen en el
 * servidor y bajan por prop: el menú es un componente de cliente y no puede leer variables de entorno.
 *
 * Solo describe el menú; no protege ninguna pantalla (cada una lleva su guardia: `requireSalonPage`,
 * `requirePlanModule`, el rol).
 */
export function navFlags(): { agenda: boolean; salon: boolean; automations: boolean } {
  return { agenda: agendaEnabled(), salon: salonEnabled(), automations: automationsEnabled() };
}
