/**
 * Paso 3 — Textos de la conexión con Google Calendar que comparten el servidor y la pantalla (sin
 * dependencias de servidor). El callback de OAuth vuelve a Ajustes con `?google=error&motivo=<código>`.
 */

export const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  denied: "Cancelaste el permiso en Google. No se conectó nada.",
  state: "El enlace de conexión caducó o no es de esta sesión. Vuelve a intentarlo.",
  exchange_failed: "Google no aceptó la autorización. Vuelve a intentarlo.",
  no_refresh_token:
    "Google no entregó el permiso permanente. Quita el acceso de esta app en tu cuenta de Google y vuelve a conectar.",
  missing_scope: "Falta el permiso para gestionar los eventos del calendario: márcalo en la pantalla de Google.",
  test_failed: "La cuenta se autorizó, pero no se pudo escribir en su calendario.",
  no_app: "Esta instancia no tiene configurada la app de Google: usa el modo Avanzado.",
};

export function oauthErrorMessage(code: string | null | undefined): string {
  return (code && OAUTH_ERROR_MESSAGES[code]) || "No se pudo conectar con Google. Vuelve a intentarlo.";
}

/** «primary» es el calendario principal de la cuenta; cualquier otro se muestra tal cual. */
export function calendarLabel(calendarId: string | null | undefined): string {
  return !calendarId || calendarId === "primary" ? "calendario principal" : `calendario «${calendarId}»`;
}

/* ---------- Mejora 2: varios calendarios ---------- */

/** El permiso que deja ver la lista de calendarios de la cuenta (pedido solo con `GOOGLE_CALENDAR_LIST`). */
export const CALENDAR_LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";

/** Cuántos calendarios se pueden leer como ocupado. */
export const MAX_BUSY_CALENDARS = 10;

export type CalendarAccessRole = "owner" | "writer" | "reader" | "freeBusyReader";

/** Un calendario de la cuenta, como lo ve la pantalla. `id` ya normalizado (`primary` para el principal). */
export type GoogleCalendarOption = {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: CalendarAccessRole;
  /** Se pueden publicar citas en él (propietario o editor). */
  canPublish: boolean;
  /** Se pueden leer sus eventos (al menos lector: «solo libre/ocupado» no basta para leer eventos). */
  canRead: boolean;
};

export type CalendarRef = { id: string; summary: string };

/** ¿La conexión concedió la lista de calendarios? */
export function hasCalendarListScope(scopes: string | null | undefined): boolean {
  return (scopes ?? "").split(/\s+/).includes(CALENDAR_LIST_SCOPE);
}

/** De una entrada de `calendarList.list` a una opción de la pantalla (el principal se guarda como `primary`). */
export function toCalendarOption(item: {
  id?: string;
  summary?: string;
  summaryOverride?: string;
  primary?: boolean;
  accessRole?: string;
}): GoogleCalendarOption | null {
  if (!item.id) return null;
  const role = (["owner", "writer", "reader", "freeBusyReader"] as const).find((r) => r === item.accessRole);
  if (!role) return null;
  const primary = item.primary === true;
  return {
    id: primary ? "primary" : item.id,
    summary: (item.summaryOverride || item.summary || item.id).trim(),
    primary,
    accessRole: role,
    canPublish: role === "owner" || role === "writer",
    canRead: role !== "freeBusyReader",
  };
}

export type CalendarSelection = { publish: CalendarRef; busy: CalendarRef[] };

/**
 * Valida lo elegido CONTRA la lista fresca de la cuenta: publicar exige poder escribir; leer, poder ver los
 * eventos; ids que no están (o repetidos) se rechazan; entre 1 y 10 para leer. Devuelve lo guardable (con
 * los nombres de Google, no los que mande el cliente) o el motivo en palabras del negocio.
 */
export function validateCalendarSelection(
  options: GoogleCalendarOption[],
  input: { publishCalendarId: string; busyCalendarIds: string[] }
): { ok: true; selection: CalendarSelection } | { ok: false; message: string } {
  const byId = new Map(options.map((o) => [o.id, o]));
  const publish = byId.get(input.publishCalendarId);
  if (!publish) return { ok: false, message: "Ese calendario para publicar ya no está en tu cuenta de Google." };
  if (!publish.canPublish) {
    return { ok: false, message: `No puedes publicar en «${publish.summary}»: tu cuenta solo puede verlo.` };
  }
  const ids = [...new Set(input.busyCalendarIds)];
  if (ids.length === 0) return { ok: false, message: "Elige al menos un calendario para leer lo ocupado." };
  if (ids.length > MAX_BUSY_CALENDARS) {
    return { ok: false, message: `Puedes leer hasta ${MAX_BUSY_CALENDARS} calendarios.` };
  }
  const busy: CalendarRef[] = [];
  for (const id of ids) {
    const cal = byId.get(id);
    if (!cal) return { ok: false, message: "Uno de los calendarios elegidos ya no está en tu cuenta de Google." };
    if (!cal.canRead) {
      return {
        ok: false,
        message: `«${cal.summary}» solo comparte libre/ocupado contigo: no se pueden leer sus eventos.`,
      };
    }
    busy.push({ id: cal.id, summary: cal.summary });
  }
  return { ok: true, selection: { publish: { id: publish.id, summary: publish.summary }, busy } };
}

/** Lo que se lee cuando no se eligió nada: el mismo calendario donde se publica (lo de siempre). */
export function effectiveBusyCalendars(
  publish: CalendarRef,
  busy: CalendarRef[] | null | undefined
): CalendarRef[] {
  return busy && busy.length > 0 ? busy : [publish];
}
