import { listCalendars } from "@/server/agenda/connectors/google";
import {
  getGoogleCredentials,
  saveGoogleCalendarSelection,
  type GoogleCreds,
} from "@/server/agenda/connectors/google-credentials";
import { ConnectorError } from "@/server/agenda/connectors/types";
import { calendarListEnabled } from "@/server/agenda/google-oauth";
import { relocateUpcomingEvents } from "@/server/agenda/calendar-sync/sync";
import { requestBusySync } from "@/server/agenda/calendar-busy/sync";
import { isScopeError } from "@/server/agenda/calendar-busy/intervals";
import {
  effectiveBusyCalendars,
  hasCalendarListScope,
  toCalendarOption,
  validateCalendarSelection,
  type CalendarRef,
  type GoogleCalendarOption,
} from "@/lib/google-calendar";

/**
 * Mejora 2 — Elegir en qué calendario se publican las citas y cuáles se leen como ocupado.
 *
 * Cuándo se puede elegir (`reason` cuando no):
 *  - OAuth: con `GOOGLE_CALENDAR_LIST` encendida (si no, `flag_off`: todo sigue en el principal, como antes)
 *    y con el permiso `calendar.calendarlist.readonly` concedido (si no, `needs_reconnect`: la pantalla
 *    ofrece «Reconectar con Google»). Sin el permiso NO se llama a Google.
 *  - Avanzado (credenciales propias): no se sabe qué permisos tiene el token; se prueba la lista y un 403 da
 *    `manual_no_scope` (generar el token con ese permiso, o escribir el ID del calendario en el formulario).
 *
 * La lista viene de Google en el momento (Ajustes, nunca el camino caliente de la agenda) y al guardar se
 * vuelve a pedir: lo elegido se valida contra lo que la cuenta tiene HOY.
 */

export type CalendarChoicesReason = "flag_off" | "needs_reconnect" | "manual_no_scope" | "error";

export type CalendarChoices = {
  available: boolean;
  reason: CalendarChoicesReason | null;
  /** Detalle de un error de Google (sin secretos). */
  error?: string;
  calendars: GoogleCalendarOption[];
  selection: { publish: CalendarRef; busy: CalendarRef[] };
};

function currentSelection(creds: GoogleCreds): CalendarChoices["selection"] {
  const publish = {
    id: creds.calendarId,
    summary: creds.calendarSummary ?? (creds.calendarId === "primary" ? "Calendario principal" : creds.calendarId),
  };
  return { publish, busy: creds.busyCalendars ?? effectiveBusyCalendars(publish, null) };
}

type Loaded =
  | { ok: true; creds: GoogleCreds; calendars: GoogleCalendarOption[] }
  | { ok: false; creds: GoogleCreds; reason: CalendarChoicesReason; error?: string };

async function load(organizationId: string): Promise<Loaded | null> {
  const creds = await getGoogleCredentials(organizationId);
  if (!creds) return null;
  if (creds.source !== "manual") {
    if (!calendarListEnabled()) return { ok: false, creds, reason: "flag_off" };
    if (!hasCalendarListScope(creds.grantedScopes)) return { ok: false, creds, reason: "needs_reconnect" };
  }
  try {
    const items = await listCalendars(creds);
    const calendars = items.map(toCalendarOption).filter((c): c is GoogleCalendarOption => c !== null);
    // El principal primero; luego los que se pueden usar para publicar; luego por nombre.
    calendars.sort(
      (a, b) =>
        Number(b.primary) - Number(a.primary) ||
        Number(b.canPublish) - Number(a.canPublish) ||
        a.summary.localeCompare(b.summary, "es")
    );
    return { ok: true, creds, calendars };
  } catch (err) {
    const status = err instanceof ConnectorError ? (err.status ?? undefined) : undefined;
    const text = err instanceof Error ? err.message : String(err);
    if (isScopeError(status, text)) {
      return { ok: false, creds, reason: creds.source === "manual" ? "manual_no_scope" : "needs_reconnect" };
    }
    return { ok: false, creds, reason: "error", error: text.slice(0, 300) };
  }
}

/** Lo que muestra Ajustes. `null` = Google no está conectado. */
export async function getCalendarChoices(organizationId: string): Promise<CalendarChoices | null> {
  const loaded = await load(organizationId);
  if (!loaded) return null;
  const selection = currentSelection(loaded.creds);
  if (!loaded.ok) {
    return { available: false, reason: loaded.reason, ...(loaded.error ? { error: loaded.error } : {}), calendars: [], selection };
  }
  return { available: true, reason: null, calendars: loaded.calendars, selection };
}

export type SaveChoicesResult =
  | { ok: true; choices: CalendarChoices; moved: number; publishChanged: boolean }
  | { ok: false; status: 409 | 422 | 502; code: string; message: string };

/**
 * Guarda lo elegido. Si cambió el calendario de publicación, las citas que vienen se mueven (en segundo
 * plano, con los reintentos de siempre); si cambió lo que se lee, se lee ya.
 */
export async function saveCalendarChoices(
  organizationId: string,
  input: { publishCalendarId: string; busyCalendarIds: string[] }
): Promise<SaveChoicesResult> {
  const loaded = await load(organizationId);
  if (!loaded) return { ok: false, status: 409, code: "not_connected", message: "Google Calendar no está conectado." };
  if (!loaded.ok) {
    if (loaded.reason === "error") {
      return { ok: false, status: 502, code: "google_error", message: `Google no respondió: ${loaded.error ?? ""}`.trim() };
    }
    return {
      ok: false,
      status: 409,
      code: loaded.reason,
      message:
        loaded.reason === "flag_off"
          ? "Elegir calendarios no está activado en este servidor."
          : "Falta el permiso para ver tus calendarios: reconecta Google.",
    };
  }
  const valid = validateCalendarSelection(loaded.calendars, input);
  if (!valid.ok) return { ok: false, status: 422, code: "invalid_selection", message: valid.message };

  const before = currentSelection(loaded.creds);
  const saved = await saveGoogleCalendarSelection(organizationId, valid.selection);
  if (!saved) return { ok: false, status: 409, code: "not_connected", message: "Google Calendar no está conectado." };

  const publishChanged = saved.previousCalendarId !== valid.selection.publish.id;
  const moved = publishChanged ? await relocateUpcomingEvents(organizationId, saved.previousCalendarId) : 0;
  const busyKey = (refs: CalendarRef[]) => refs.map((r) => r.id).sort().join("|");
  if (busyKey(before.busy) !== busyKey(valid.selection.busy)) await requestBusySync(organizationId);

  return {
    ok: true,
    moved,
    publishChanged,
    choices: { available: true, reason: null, calendars: loaded.calendars, selection: valid.selection },
  };
}
