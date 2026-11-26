import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateSlot, staffIsBusy, type CapacityMember } from "@/lib/agenda/capacity";
import { staffInviteMessage, staffInviteShareText, whatsappShareUrl } from "@/lib/staff-calendar";
import { buildBoardSlots } from "@/server/business/board";

/**
 * Mejora 3 — Calendario por profesional: las reglas PURAS (lo ocupado de un profesional lo saca solo a él en
 * el motor de cupos y en el tablero), el enlace de 24 h (estado, hash), el `state` firmado del flujo del
 * profesional (no se confunde con el del negocio), los permisos y la bandera.
 */

const env: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    APP_BASE_URL: "https://crm.ejemplo.test",
    GOOGLE_ACCOUNTS_BASE_URL: "https://accounts.google.test",
    GOOGLE_OAUTH_BASE_URL: "https://oauth.google.test",
    GOOGLE_CAL_BASE_URL: "https://cal.google.test/v3",
    ...env,
  }),
}));

const TZ = "America/Lima";
const at = (hhmm: string) => Date.parse(`2026-12-02T${hhmm}:00-05:00`);
const member = (id: string, createdAtMs = 0): CapacityMember => ({
  id,
  acceptsBookings: true,
  createdAtMs,
  shifts: new Map(),
});

describe("cupos: lo ocupado en el Google Calendar de un profesional lo saca SOLO a él", () => {
  const ctx = (staffBusy = [{ staffId: "carla", startMs: at("10:00"), endMs: at("11:00") }]) => ({
    members: [member("carla", 1), member("beto", 2)],
    sessions: [],
    timezone: TZ,
    staffBusy,
  });
  const q = { startMs: at("10:30"), endMs: at("11:00"), providers: null };

  it("«cualquiera disponible»: queda Beto, con un cupo", () => {
    expect(evaluateSlot(ctx(), q)).toEqual({ ok: true, free: 1, staffIds: ["beto"] });
  });

  it("pedir a Carla en ese tramo no se puede; a Beto, sí", () => {
    expect(evaluateSlot(ctx(), { ...q, staffId: "carla" }).ok).toBe(false);
    expect(evaluateSlot(ctx(), { ...q, staffId: "beto" })).toMatchObject({ ok: true, staffIds: ["beto"] });
  });

  it("si los dos están ocupados en su calendario, no hay cupo", () => {
    const both = ctx([
      { staffId: "carla", startMs: at("10:00"), endMs: at("11:00") },
      { staffId: "beto", startMs: at("09:00"), endMs: at("12:00") },
    ]);
    expect(evaluateSlot(both, q)).toEqual({ ok: false, free: 0, staffIds: [] });
  });

  it("fuera de su tramo ocupado vuelve a contar; tocarse no es pisarse", () => {
    expect(evaluateSlot(ctx(), { ...q, startMs: at("11:00"), endMs: at("11:30") }).staffIds.sort()).toEqual(["beto", "carla"]);
    expect(staffIsBusy(ctx().staffBusy, "carla", at("09:30"), at("10:00"))).toBe(false);
    expect(staffIsBusy(ctx().staffBusy, "carla", at("09:30"), at("10:01"))).toBe(true);
  });

  it("una cita SIN asignar sigue gastando un cupo como antes", () => {
    const withUnassigned = { ...ctx(), sessions: [{ id: "s1", staffId: null, startMs: at("10:30"), endMs: at("11:00") }] };
    expect(evaluateSlot(withUnassigned, q)).toEqual({ ok: false, free: 0, staffIds: [] });
  });
});

describe("tablero: la silla del profesional ocupado en Google", () => {
  it("solo su silla queda fuera del cupo; un bloqueo del negocio sigue apagando la franja", () => {
    const slot = (startUtc: string) => ({ startUtc, endUtc: new Date(Date.parse(startUtc) + 30 * 60_000).toISOString() });
    const base = {
      candidates: [slot("2026-12-02T15:00:00.000Z"), slot("2026-12-02T15:30:00.000Z")],
      members: [{ id: "carla" }, { id: "beto" }],
      shifts: new Map(),
      sessions: [],
      date: "2026-12-02",
      timezone: TZ,
      now: new Date("2026-12-01T00:00:00Z"),
    };
    const [busy, free] = buildBoardSlots({
      ...base,
      blocks: [{ startUtc: "2026-12-02T15:00:00.000Z", endUtc: "2026-12-02T15:30:00.000Z", staffId: "carla" }],
    });
    expect(busy).toMatchObject({ busyStaffIds: ["carla"], blocked: false, capacity: 1, free: 1 });
    expect(free).toMatchObject({ busyStaffIds: [], capacity: 2, free: 2 });

    const [global] = buildBoardSlots({
      ...base,
      blocks: [{ startUtc: "2026-12-02T15:00:00.000Z", endUtc: "2026-12-02T15:30:00.000Z", staffId: null }],
    });
    expect(global).toMatchObject({ blocked: true, free: 0, busyStaffIds: [] });
  });
});

describe("el enlace de 24 h", () => {
  it("estado: vigente, vencido, usado, anulado (usado y anulado mandan sobre el vencimiento)", async () => {
    const { inviteState } = await import("@/server/agenda/staff-calendar/invite");
    const now = new Date("2026-12-02T12:00:00Z");
    const later = new Date("2026-12-02T13:00:00Z");
    const before = new Date("2026-12-02T11:00:00Z");
    expect(inviteState({ expiresAt: later, usedAt: null, revokedAt: null }, now)).toBe("valid");
    expect(inviteState({ expiresAt: before, usedAt: null, revokedAt: null }, now)).toBe("expired");
    expect(inviteState({ expiresAt: now, usedAt: null, revokedAt: null }, now)).toBe("expired");
    expect(inviteState({ expiresAt: before, usedAt: before, revokedAt: null }, now)).toBe("used");
    expect(inviteState({ expiresAt: later, usedAt: null, revokedAt: before }, now)).toBe("revoked");
  });

  it("el enlace es largo y aleatorio; en la base va solo su SHA-256", async () => {
    const { hashInviteToken, INVITE_TTL_MS, inviteUrl, newInviteToken } = await import("@/server/agenda/staff-calendar/invite");
    const a = newInviteToken();
    const b = newInviteToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashInviteToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken(a)).toBe(hashInviteToken(a));
    expect(hashInviteToken(a)).not.toContain(a);
    expect(INVITE_TTL_MS).toBe(24 * 3_600_000);
    expect(inviteUrl(a)).toBe(`https://crm.ejemplo.test/conectar-calendario/${a}`);
  });

  it("textos: motivo conocido o genérico; compartir por WhatsApp con el teléfono en dígitos", () => {
    expect(staffInviteMessage("expired")).toMatch(/venció/);
    expect(staffInviteMessage("business_account")).toMatch(/cuenta de Google del negocio/);
    expect(staffInviteMessage("raro")).toMatch(/No se pudo conectar/);
    const text = staffInviteShareText({ staffName: "Carla", url: "https://x/y" });
    expect(text).toContain("Carla");
    expect(text).toContain("https://x/y");
    expect(whatsappShareUrl("+51 999-888-777", "hola")).toBe("https://wa.me/51999888777?text=hola");
  });
});

describe("OAuth del profesional", () => {
  const SECRET = "secreto-de-prueba-123456";

  it("el `state` del profesional se firma con OTRO contexto: el del negocio no sirve aquí", async () => {
    const o = await import("@/server/agenda/google-oauth");
    const e = Date.now() + 60_000;
    const staff = o.signStaffState({ i: "sci_1", n: "nonce", e }, SECRET);
    expect(o.verifyStaffState(staff, { secret: SECRET, cookieNonce: "nonce" })).toEqual({ ok: true, state: { i: "sci_1", n: "nonce", e } });
    expect(o.verifyStaffState(staff, { secret: SECRET, cookieNonce: "otro" })).toMatchObject({ ok: false, reason: "nonce_mismatch" });
    expect(o.verifyStaffState(staff, { secret: "otro-secreto-123456", cookieNonce: "nonce" })).toMatchObject({ reason: "bad_signature" });
    expect(o.verifyStaffState(staff, { secret: SECRET, cookieNonce: "nonce", now: e + 1 })).toMatchObject({ reason: "expired" });
    const business = o.signState({ o: "org", u: "usr", n: "nonce", e }, SECRET);
    expect(o.verifyStaffState(business, { secret: SECRET, cookieNonce: "nonce" })).toMatchObject({ reason: "bad_signature" });
    expect(o.verifyStaffState("basura", { secret: SECRET, cookieNonce: "nonce" })).toMatchObject({ reason: "malformed" });
  });

  it("pide SOLO leer el calendario y vuelve a la URI pública del profesional", async () => {
    const o = await import("@/server/agenda/google-oauth");
    const url = new URL(
      o.buildAuthorizeUrl({
        clientId: "cid",
        state: "s",
        challenge: "c",
        redirectUri: o.staffOAuthRedirectUri(),
        scopes: o.STAFF_OAUTH_SCOPES,
      })
    );
    expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual(["email", "https://www.googleapis.com/auth/calendar.events.readonly", "openid"]);
    expect(url.searchParams.get("redirect_uri")).toBe("https://crm.ejemplo.test/api/calendar-invite/oauth/callback");
  });

  it("vale leer (o un permiso mayor); sin permiso de calendario, no", async () => {
    const { hasStaffReadScope } = await import("@/server/agenda/google-oauth");
    expect(hasStaffReadScope("openid email https://www.googleapis.com/auth/calendar.events.readonly")).toBe(true);
    expect(hasStaffReadScope("https://www.googleapis.com/auth/calendar.events")).toBe(true);
    expect(hasStaffReadScope("openid email")).toBe(false);
    expect(hasStaffReadScope(null)).toBe(false);
  });
});

describe("bandera GOOGLE_STAFF_CALENDARS", () => {
  beforeEach(() => {
    for (const k of Object.keys(env)) delete env[k];
    process.env.AGENDA = "on";
    process.env.SALON = "on";
  });

  it("apagada por defecto; encendida exige además AGENDA, SALON y la app OAuth de la instancia", async () => {
    const { staffCalendarsEnabled } = await import("@/server/agenda/staff-calendar/flag");
    expect(staffCalendarsEnabled()).toBe(false);
    env.GOOGLE_STAFF_CALENDARS = "on";
    expect(staffCalendarsEnabled()).toBe(false); // sin app OAuth
    env.GOOGLE_OAUTH_CLIENT_ID = "cid";
    env.GOOGLE_OAUTH_CLIENT_SECRET = "csec";
    expect(staffCalendarsEnabled()).toBe(true);
    process.env.SALON = "";
    expect(staffCalendarsEnabled()).toBe(false);
    process.env.SALON = "on";
    process.env.AGENDA = "";
    expect(staffCalendarsEnabled()).toBe(false);
  });
});
