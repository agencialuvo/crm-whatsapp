import { getEnv } from "@/lib/env";
import { agendaEnabled, parseAgendaFlag } from "@/server/agenda/flag";
import { salonEnabled } from "@/server/business/flag";
import { instanceOAuthApp } from "@/server/agenda/connectors/google-credentials";

/**
 * Mejora 3 — ¿Esta instancia ofrece que cada profesional conecte su Google Calendar?
 *
 * Conector opcional (constitución II): `GOOGLE_STAFF_CALENDARS` APAGADA por defecto. Además exige la agenda
 * (`AGENDA`), el equipo (`SALON`) y la app OAuth de la instancia (el profesional no pega credenciales). Si
 * algo falta, las rutas públicas del enlace dan 404 y la pantalla no lo ofrece.
 */
export function staffCalendarsEnabled(): boolean {
  return (
    parseAgendaFlag(getEnv().GOOGLE_STAFF_CALENDARS) && agendaEnabled() && salonEnabled() && instanceOAuthApp() !== null
  );
}

export function staffCalendarsDisabledResponse(): Response {
  return new Response(null, { status: 404 });
}
