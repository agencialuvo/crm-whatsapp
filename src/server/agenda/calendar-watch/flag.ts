import { getEnv, isMockEnabled } from "@/lib/env";
import { watchUrlOk } from "@/lib/google-watch";
import { agendaEnabled, parseAgendaFlag } from "@/server/agenda/flag";

/**
 * Mejora 4 — ¿Esta instancia recibe avisos al instante de Google Calendar?
 *
 * Conector opcional (constitución II): `GOOGLE_CALENDAR_WATCH` APAGADA por defecto, y exige la agenda
 * (`AGENDA`). Encendida, además hace falta que Google PUEDA avisar: `APP_BASE_URL` https con un dominio
 * público (`watchUrlOk`). Si no, no se crea ningún canal y la lectura sigue cada 5 min como siempre; la
 * pantalla lo dice. Con los mocks del entorno de pruebas (nunca en producción) se admite el origen local.
 */
export function watchFlagOn(): boolean {
  return parseAgendaFlag(getEnv().GOOGLE_CALENDAR_WATCH) && agendaEnabled();
}

export type WatchAvailability =
  | { ok: true; address: string }
  | { ok: false; reason: "off" | "no_https" };

export function watchAvailability(): WatchAvailability {
  if (!watchFlagOn()) return { ok: false, reason: "off" };
  const address = watchUrlOk(getEnv().APP_BASE_URL, { allowLocal: isMockEnabled() });
  return address ? { ok: true, address } : { ok: false, reason: "no_https" };
}

/** El secreto con el que se firma el token de cada canal. */
export function watchSecret(): string {
  return getEnv().BETTER_AUTH_SECRET;
}
