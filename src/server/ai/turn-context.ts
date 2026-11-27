import { contextoTemporal, type HorarioSemanal } from "@/lib/agent/temporal";
import { businessTimezone } from "@/server/analytics/period";
import { DEFAULT_TIMEZONE, getSettings } from "@/server/agenda/settings";

/**
 * Mejora 1 — El «ahora» del negocio para el turno: la zona horaria que el negocio eligió (Ajustes → Negocio →
 * Marca, y si no, la de la agenda) y, con la agenda encendida, el horario semanal con el que se agenda.
 *
 * Es contexto: si algo falla, el turno sigue con la zona por defecto y sin horario. Nunca lanza.
 */
export async function loadTemporalContext(
  organizationId: string,
  opts: { agenda: boolean; now?: Date }
): Promise<string> {
  const now = opts.now ?? new Date();
  try {
    if (opts.agenda) {
      // `getSettings` ya resuelve la zona con la misma precedencia que `businessTimezone`.
      const settings = await getSettings(organizationId);
      return contextoTemporal({
        now,
        timeZone: settings.timezone,
        horario: settings.weeklyHours as HorarioSemanal,
      });
    }
    return contextoTemporal({ now, timeZone: await businessTimezone(organizationId) });
  } catch (err) {
    console.error("[agente] no se pudo leer la zona horaria del negocio:", err);
    return contextoTemporal({ now, timeZone: DEFAULT_TIMEZONE });
  }
}
