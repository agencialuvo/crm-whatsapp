/**
 * Paso 3 — El evento de Google Calendar que refleja una cita. PURO (sin red, sin base, sin reloj): lo usan
 * el conector de Meet y la sincronización, y se prueba solo (`tests/unit/google-calendar-sync.test.ts`).
 *
 * Privacidad por defecto: el calendario del negocio suele estar compartido (recepción, el equipo, a veces
 * la familia). Por eso el evento lleva el nombre del cliente con la INICIAL del apellido y, salvo que el
 * negocio lo active, nunca su teléfono. Google nunca escribe al cliente: sin invitados y `sendUpdates=none`.
 */

/** Alfabeto base32hex en minúsculas: lo único que Google acepta en un id de evento propio (a-v, 0-9). */
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/** Prefijo de los eventos de Vocero (letras dentro de a-v): se reconocen a simple vista en un volcado. */
const EVENT_ID_PREFIX = "vcr";

/**
 * Id del evento de una cita, DETERMINISTA: el mismo `bookingId` da siempre el mismo id. Así crear es
 * idempotente: si la respuesta se perdió y se reintenta, Google contesta 409 y se actualiza el que ya
 * existe en vez de duplicar la cita en el calendario.
 */
export function calendarEventIdFor(bookingId: string): string {
  const bytes = new TextEncoder().encode(bookingId);
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32HEX[(buffer << (5 - bits)) & 31];
  return `${EVENT_ID_PREFIX}${out}`;
}

/** ¿Es un id válido para Google? (5 a 1024 caracteres de base32hex). */
export function isValidGoogleEventId(id: string): boolean {
  return /^[a-v0-9]{5,1024}$/.test(id);
}

/** El `requestId` de la conferencia de Meet: uno por cita (dos citas a la misma hora ya no lo comparten). */
export function conferenceRequestIdFor(bookingId: string): string {
  return `vocero-${bookingId}`;
}

/** «Ana María Pérez Soto» → «Ana P.»; «Ana» → «Ana»; vacío → «Cliente». */
export function shortClientName(fullName: string | null | undefined): string {
  const words = (fullName ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return "Cliente";
  const first = words[0]!;
  if (words.length === 1) return first;
  // Inicial de la segunda palabra: el apellido en el caso común «Nombre Apellido». En un nombre compuesto
  // («Ana María Pérez») sale «Ana M.», que revela todavía menos.
  const initial = [...words[1]!][0]!.toLocaleUpperCase("es");
  return `${first} ${initial}.`;
}

export type CalendarEventInput = {
  bookingId: string;
  organizationId: string;
  status: "agendada" | "realizada" | "no_show" | "cancelada";
  confirmed: boolean;
  startUtc: string;
  durationMinutes: number;
  timezone: string;
  clientName: string | null;
  /** Solo se usa si `includePhone`. */
  clientPhone: string | null;
  includePhone: boolean;
  /** Servicio u oferta de la cita. */
  itemName: string | null;
  staffName: string | null;
  notes: string | null;
  meetingLink: string | null;
  source: "manual" | "ai";
  /** Enlace a la cita en Vocero (absoluto). */
  crmLink: string | null;
};

export type GoogleEventBody = {
  summary: string;
  description: string;
  location?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  status: "confirmed";
  extendedProperties: { private: { voceroBookingId: string; voceroOrg: string } };
};

const PREFIX: Record<CalendarEventInput["status"], string> = {
  agendada: "",
  realizada: "[Realizada] ",
  no_show: "[No asistió] ",
  cancelada: "",
};

/** El cuerpo del evento (lo que se manda en `insert` y en `patch`). Sin invitados ni recordatorios propios. */
export function buildCalendarEvent(input: CalendarEventInput): GoogleEventBody {
  const who = shortClientName(input.clientName);
  const what = input.itemName?.trim() || "Cita";
  const mark = input.status === "agendada" && input.confirmed ? "✓ " : PREFIX[input.status];
  const endUtc = new Date(Date.parse(input.startUtc) + input.durationMinutes * 60_000).toISOString();

  const lines = [
    `Cliente: ${who}`,
    input.includePhone && input.clientPhone ? `Teléfono: ${input.clientPhone}` : null,
    `Servicio: ${what} (${input.durationMinutes} min)`,
    input.staffName ? `Profesional: ${input.staffName}` : null,
    input.confirmed ? "Asistencia confirmada" : null,
    input.notes?.trim() ? `Notas: ${input.notes.trim()}` : null,
    input.meetingLink ? `Enlace de la reunión: ${input.meetingLink}` : null,
    `Agendada por: ${input.source === "ai" ? "la IA" : "el equipo"}`,
    input.crmLink ? `Ver en Vocero: ${input.crmLink}` : null,
  ].filter((l): l is string => l !== null);

  return {
    summary: `${mark}${what} — ${who}`,
    description: lines.join("\n"),
    ...(input.meetingLink ? { location: input.meetingLink } : {}),
    start: { dateTime: input.startUtc, timeZone: input.timezone },
    end: { dateTime: endUtc, timeZone: input.timezone },
    // Siempre `confirmed`: reactiva un evento que se borró antes (cancelar y volver a agendar la misma cita).
    status: "confirmed",
    extendedProperties: {
      private: { voceroBookingId: input.bookingId, voceroOrg: input.organizationId },
    },
  };
}

export type SyncDecision =
  | { action: "skip"; reason: "disabled" | "not_session" | "test" | "not_connected" }
  | { action: "upsert" }
  | { action: "delete" };

/** Qué hacer con la cita en Google, según su estado y la configuración. */
export function decideCalendarSync(input: {
  enabled: boolean;
  connected: boolean;
  kind: "session" | "block";
  isTest: boolean;
  status: CalendarEventInput["status"];
}): SyncDecision {
  // Sandbox primero: una cita del Laboratorio jamás llega a Google, ni siquiera para borrarse.
  if (input.isTest) return { action: "skip", reason: "test" };
  if (input.kind !== "session") return { action: "skip", reason: "not_session" };
  if (!input.enabled) return { action: "skip", reason: "disabled" };
  if (!input.connected) return { action: "skip", reason: "not_connected" };
  return input.status === "cancelada" ? { action: "delete" } : { action: "upsert" };
}

/** Espera antes del intento N+1 (tras N fallos): 1 min, 5 min, 30 min, 2 h, 6 h; después, se rinde. */
export const SYNC_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000] as const;
export const SYNC_MAX_ATTEMPTS = SYNC_BACKOFF_MS.length + 1;

export function nextSyncDelayMs(failedAttempts: number): number | null {
  if (failedAttempts < 1 || failedAttempts >= SYNC_MAX_ATTEMPTS) return null;
  return SYNC_BACKOFF_MS[failedAttempts - 1] ?? null;
}
