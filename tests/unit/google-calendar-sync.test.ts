import { describe, expect, it } from "vitest";
import {
  buildCalendarEvent,
  calendarEventIdFor,
  conferenceRequestIdFor,
  decideCalendarSync,
  isValidGoogleEventId,
  nextSyncDelayMs,
  shortClientName,
  SYNC_MAX_ATTEMPTS,
  type CalendarEventInput,
} from "@/server/agenda/calendar-sync/event";
import { calendarSyncLine } from "@/components/bookings/booking-look";
import { calendarLabel, oauthErrorMessage } from "@/lib/google-calendar";

/**
 * Paso 3 — El evento de Google Calendar de una cita, puro: id determinista (idempotencia), privacidad por
 * defecto, qué se hace con cada cita y la espera entre reintentos. La sincronización contra Postgres está en
 * `google-calendar-sync-live.test.ts`.
 */

describe("id del evento: determinista y válido para Google", () => {
  it("la misma cita da siempre el mismo id; citas distintas, ids distintos", () => {
    expect(calendarEventIdFor("bk_abc123")).toBe(calendarEventIdFor("bk_abc123"));
    expect(calendarEventIdFor("bk_abc123")).not.toBe(calendarEventIdFor("bk_abc124"));
  });

  it("solo usa base32hex (a-v, 0-9) y respeta el largo que Google acepta", () => {
    for (const id of ["bk_1", "bk_V1StGXR8_Z5jdHi6B-myT", "x", "ñandú_ü"]) {
      const out = calendarEventIdFor(id);
      expect(isValidGoogleEventId(out), `${id} → ${out}`).toBe(true);
      expect(out.startsWith("vcr")).toBe(true);
    }
    expect(isValidGoogleEventId("evt_1")).toBe(false);
    expect(isValidGoogleEventId("abcw1")).toBe(false);
  });

  it("el requestId de Meet es POR CITA: dos citas a la misma hora ya no lo comparten", () => {
    expect(conferenceRequestIdFor("bk_a")).toBe("vocero-bk_a");
    expect(conferenceRequestIdFor("bk_a")).not.toBe(conferenceRequestIdFor("bk_b"));
  });
});

describe("privacidad del nombre", () => {
  it("nombre con la inicial del apellido", () => {
    expect(shortClientName("Ana Pérez")).toBe("Ana P.");
    expect(shortClientName("  ana   pérez  soto ")).toBe("ana P.");
    expect(shortClientName("Ana")).toBe("Ana");
    expect(shortClientName("Ana Óscar")).toBe("Ana Ó.");
    expect(shortClientName("")).toBe("Cliente");
    expect(shortClientName(null)).toBe("Cliente");
  });
});

const base: CalendarEventInput = {
  bookingId: "bk_1",
  organizationId: "org_1",
  status: "agendada",
  confirmed: false,
  startUtc: "2026-12-01T14:00:00.000Z",
  durationMinutes: 60,
  timezone: "America/Lima",
  clientName: "Ana Pérez Soto",
  clientPhone: "+51 999 888 777",
  includePhone: false,
  itemName: "Corte y barba",
  staffName: "Beto",
  notes: "Trae su foto de referencia",
  meetingLink: null,
  source: "ai",
  crmLink: "https://crm.test/citas?cita=bk_1",
};

describe("el cuerpo del evento", () => {
  it("título y descripción con lo justo; sin teléfono por defecto", () => {
    const e = buildCalendarEvent(base);
    expect(e.summary).toBe("Corte y barba — Ana P.");
    expect(e.description).toContain("Cliente: Ana P.");
    expect(e.description).toContain("Servicio: Corte y barba (60 min)");
    expect(e.description).toContain("Profesional: Beto");
    expect(e.description).toContain("Notas: Trae su foto de referencia");
    expect(e.description).toContain("Agendada por: la IA");
    expect(e.description).toContain("Ver en Vocero: https://crm.test/citas?cita=bk_1");
    // Nada del nombre completo ni del teléfono.
    expect(JSON.stringify(e)).not.toContain("Pérez");
    expect(JSON.stringify(e)).not.toContain("999");
  });

  it("con la casilla del teléfono, lo incluye", () => {
    expect(buildCalendarEvent({ ...base, includePhone: true }).description).toContain("Teléfono: +51 999 888 777");
    // Sin teléfono en el contacto, no inventa la línea.
    expect(buildCalendarEvent({ ...base, includePhone: true, clientPhone: null }).description).not.toContain("Teléfono");
  });

  it("horas: inicio y fin reales en UTC, con la zona del negocio", () => {
    const e = buildCalendarEvent(base);
    expect(e.start).toEqual({ dateTime: "2026-12-01T14:00:00.000Z", timeZone: "America/Lima" });
    expect(e.end).toEqual({ dateTime: "2026-12-01T15:00:00.000Z", timeZone: "America/Lima" });
  });

  it("la marca de Vocero va en extendedProperties.private, y el evento siempre queda confirmado", () => {
    const e = buildCalendarEvent(base);
    expect(e.extendedProperties).toEqual({ private: { voceroBookingId: "bk_1", voceroOrg: "org_1" } });
    expect(e.status).toBe("confirmed");
    // Sin invitados: Google nunca le escribe al cliente.
    expect(e).not.toHaveProperty("attendees");
  });

  it("el enlace de la reunión va en el lugar y en la descripción; sin él, no hay lugar", () => {
    const withLink = buildCalendarEvent({ ...base, meetingLink: "https://zoom.us/j/1" });
    expect(withLink.location).toBe("https://zoom.us/j/1");
    expect(withLink.description).toContain("Enlace de la reunión: https://zoom.us/j/1");
    expect(buildCalendarEvent(base)).not.toHaveProperty("location");
  });

  it("el estado se lee en el título: ✓ confirmada, [Realizada], [No asistió]", () => {
    expect(buildCalendarEvent({ ...base, confirmed: true }).summary).toBe("✓ Corte y barba — Ana P.");
    expect(buildCalendarEvent({ ...base, confirmed: true }).description).toContain("Asistencia confirmada");
    expect(buildCalendarEvent({ ...base, status: "realizada", confirmed: true }).summary).toBe("[Realizada] Corte y barba — Ana P.");
    expect(buildCalendarEvent({ ...base, status: "no_show" }).summary).toBe("[No asistió] Corte y barba — Ana P.");
  });

  it("sin servicio ni profesional ni notas: «Cita» y sin líneas vacías", () => {
    const e = buildCalendarEvent({ ...base, itemName: null, staffName: null, notes: "  ", source: "manual", crmLink: null });
    expect(e.summary).toBe("Cita — Ana P.");
    expect(e.description).not.toMatch(/Profesional|Notas|Ver en Vocero/);
    expect(e.description).toContain("Agendada por: el equipo");
    expect(e.description.split("\n").every((l) => l.trim().length > 0)).toBe(true);
  });
});

describe("qué hacer con cada cita", () => {
  const ok = { enabled: true, connected: true, kind: "session" as const, isTest: false, status: "agendada" as const };
  it("publica, y borra las canceladas", () => {
    expect(decideCalendarSync(ok)).toEqual({ action: "upsert" });
    expect(decideCalendarSync({ ...ok, status: "realizada" })).toEqual({ action: "upsert" });
    expect(decideCalendarSync({ ...ok, status: "cancelada" })).toEqual({ action: "delete" });
  });
  it("el Laboratorio jamás llega a Google, ni con todo encendido", () => {
    expect(decideCalendarSync({ ...ok, isTest: true })).toEqual({ action: "skip", reason: "test" });
    expect(decideCalendarSync({ ...ok, isTest: true, status: "cancelada" })).toEqual({ action: "skip", reason: "test" });
  });
  it("ni los bloqueos, ni con la sincronización apagada, ni sin conexión", () => {
    expect(decideCalendarSync({ ...ok, kind: "block" })).toMatchObject({ action: "skip", reason: "not_session" });
    expect(decideCalendarSync({ ...ok, enabled: false })).toMatchObject({ action: "skip", reason: "disabled" });
    expect(decideCalendarSync({ ...ok, connected: false })).toMatchObject({ action: "skip", reason: "not_connected" });
  });
});

describe("espera entre reintentos", () => {
  it("1 min, 5 min, 30 min, 2 h, 6 h y se rinde", () => {
    expect([1, 2, 3, 4, 5].map(nextSyncDelayMs)).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]);
    expect(nextSyncDelayMs(SYNC_MAX_ATTEMPTS)).toBeNull();
    expect(nextSyncDelayMs(0)).toBeNull();
  });
});

describe("cómo se ve en la cita y en Ajustes", () => {
  const booking = (calendarSync: unknown, extra: Record<string, unknown> = {}) =>
    ({ kind: "session", status: "agendada", calendarSync, ...extra }) as never;

  it("una línea por estado; reintentar solo cuando ya no se reintenta sola", () => {
    expect(calendarSyncLine(booking(null))).toBeNull();
    expect(calendarSyncLine(booking({ status: "synced", error: null, willRetry: false, syncedAt: "x" }))).toMatchObject({ tone: "ok", canRetry: false });
    expect(calendarSyncLine(booking({ status: "synced" }, { status: "cancelada" }))!.text).toMatch(/Quitada/);
    expect(calendarSyncLine(booking({ status: "pending", error: null, willRetry: true, syncedAt: null }))).toMatchObject({ tone: "wait" });
    expect(calendarSyncLine(booking({ status: "error", error: "Google 503", willRetry: true, syncedAt: null }))).toMatchObject({ tone: "error", canRetry: false });
    expect(calendarSyncLine(booking({ status: "error", error: "x", willRetry: false, syncedAt: null }))).toMatchObject({ tone: "error", canRetry: true });
  });

  it("mensajes del flujo OAuth y el nombre del calendario", () => {
    expect(oauthErrorMessage("denied")).toMatch(/Cancelaste/);
    expect(oauthErrorMessage("loquesea")).toMatch(/No se pudo conectar/);
    expect(oauthErrorMessage(null)).toMatch(/No se pudo conectar/);
    expect(calendarLabel("primary")).toBe("calendario principal");
    expect(calendarLabel("citas@group.calendar.google.com")).toBe("calendario «citas@group.calendar.google.com»");
  });
});
