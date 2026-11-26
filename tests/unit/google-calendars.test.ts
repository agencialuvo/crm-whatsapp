import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALENDAR_LIST_SCOPE,
  MAX_BUSY_CALENDARS,
  effectiveBusyCalendars,
  hasCalendarListScope,
  toCalendarOption,
  validateCalendarSelection,
  type GoogleCalendarOption,
} from "@/lib/google-calendar";

/**
 * Mejora 2 — Varios calendarios: las reglas puras (qué se puede elegir para publicar y para leer) y los
 * permisos que pide «Conectar con Google» según la bandera `GOOGLE_CALENDAR_LIST`.
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

const opt = (over: Partial<GoogleCalendarOption> & { id: string }): GoogleCalendarOption => ({
  summary: over.id,
  primary: false,
  accessRole: "owner",
  canPublish: true,
  canRead: true,
  ...over,
});

describe("toCalendarOption", () => {
  it("el principal se guarda como `primary` y usa el nombre que el dueño le puso", () => {
    expect(toCalendarOption({ id: "yo@x.com", summary: "yo@x.com", summaryOverride: "Mi agenda", primary: true, accessRole: "owner" })).toEqual({
      id: "primary",
      summary: "Mi agenda",
      primary: true,
      accessRole: "owner",
      canPublish: true,
      canRead: true,
    });
  });

  it("publicar exige escribir; leer, ver eventos («solo libre/ocupado» no basta)", () => {
    expect(toCalendarOption({ id: "a", accessRole: "writer" })).toMatchObject({ canPublish: true, canRead: true });
    expect(toCalendarOption({ id: "b", accessRole: "reader" })).toMatchObject({ canPublish: false, canRead: true });
    expect(toCalendarOption({ id: "c", accessRole: "freeBusyReader" })).toMatchObject({ canPublish: false, canRead: false });
  });

  it("descarta entradas sin id o con un rol desconocido", () => {
    expect(toCalendarOption({ accessRole: "owner" })).toBeNull();
    expect(toCalendarOption({ id: "x", accessRole: "none" })).toBeNull();
  });
});

describe("validateCalendarSelection", () => {
  const options = [
    opt({ id: "primary", summary: "Principal", primary: true }),
    opt({ id: "equipo", summary: "Equipo", accessRole: "writer" }),
    opt({ id: "personal", summary: "Personal", accessRole: "reader", canPublish: false }),
    opt({ id: "socio", summary: "Socio", accessRole: "freeBusyReader", canPublish: false, canRead: false }),
  ];

  it("guarda con los NOMBRES de Google (no los del cliente) y sin repetidos", () => {
    expect(validateCalendarSelection(options, { publishCalendarId: "equipo", busyCalendarIds: ["primary", "personal", "primary"] })).toEqual({
      ok: true,
      selection: {
        publish: { id: "equipo", summary: "Equipo" },
        busy: [
          { id: "primary", summary: "Principal" },
          { id: "personal", summary: "Personal" },
        ],
      },
    });
  });

  it("no se publica donde solo se puede ver", () => {
    expect(validateCalendarSelection(options, { publishCalendarId: "personal", busyCalendarIds: ["primary"] })).toMatchObject({
      ok: false,
      message: expect.stringContaining("Personal"),
    });
  });

  it("no se lee un calendario de solo libre/ocupado, ni uno que ya no está, ni ninguno, ni más de 10", () => {
    expect(validateCalendarSelection(options, { publishCalendarId: "primary", busyCalendarIds: ["socio"] })).toMatchObject({
      ok: false,
      message: expect.stringContaining("libre/ocupado"),
    });
    expect(validateCalendarSelection(options, { publishCalendarId: "primary", busyCalendarIds: ["borrado"] }).ok).toBe(false);
    expect(validateCalendarSelection(options, { publishCalendarId: "borrado", busyCalendarIds: ["primary"] }).ok).toBe(false);
    expect(validateCalendarSelection(options, { publishCalendarId: "primary", busyCalendarIds: [] }).ok).toBe(false);
    const many = Array.from({ length: MAX_BUSY_CALENDARS + 1 }, (_, i) => opt({ id: `c${i}` }));
    expect(
      validateCalendarSelection([...options, ...many], { publishCalendarId: "primary", busyCalendarIds: many.map((c) => c.id) })
    ).toMatchObject({ ok: false, message: expect.stringContaining(String(MAX_BUSY_CALENDARS)) });
  });
});

describe("permisos concedidos y lo que se lee por defecto", () => {
  it("hasCalendarListScope lee la lista de permisos separada por espacios", () => {
    expect(hasCalendarListScope(`openid email ${CALENDAR_LIST_SCOPE}`)).toBe(true);
    expect(hasCalendarListScope("openid email https://www.googleapis.com/auth/calendar.events")).toBe(false);
    expect(hasCalendarListScope(null)).toBe(false);
  });

  it("sin elegir nada, se lee el mismo calendario donde se publica (lo de siempre)", () => {
    const publish = { id: "primary", summary: "Principal" };
    expect(effectiveBusyCalendars(publish, null)).toEqual([publish]);
    expect(effectiveBusyCalendars(publish, [])).toEqual([publish]);
    expect(effectiveBusyCalendars(publish, [{ id: "x", summary: "X" }])).toEqual([{ id: "x", summary: "X" }]);
  });
});

describe("permisos que pide «Conectar con Google» según GOOGLE_CALENDAR_LIST", () => {
  beforeEach(() => {
    delete env.GOOGLE_CALENDAR_LIST;
  });

  it("apagada (por defecto): solo los mínimos, sin la lista de calendarios", async () => {
    const { buildAuthorizeUrl, calendarListEnabled, oauthScopes } = await import("@/server/agenda/google-oauth");
    expect(calendarListEnabled()).toBe(false);
    expect(oauthScopes()).not.toContain(CALENDAR_LIST_SCOPE);
    const url = new URL(buildAuthorizeUrl({ clientId: "cid", state: "s", challenge: "c" }));
    expect(url.searchParams.get("scope")).not.toContain("calendarlist");
  });

  it("encendida: pide también la lista de calendarios", async () => {
    env.GOOGLE_CALENDAR_LIST = "on";
    const { buildAuthorizeUrl, calendarListEnabled, oauthScopes } = await import("@/server/agenda/google-oauth");
    expect(calendarListEnabled()).toBe(true);
    expect(oauthScopes()).toContain(CALENDAR_LIST_SCOPE);
    const url = new URL(buildAuthorizeUrl({ clientId: "cid", state: "s", challenge: "c" }));
    expect(url.searchParams.get("scope")!.split(" ")).toContain(CALENDAR_LIST_SCOPE);
  });

  it("valores raros cuentan como apagada", async () => {
    const { calendarListEnabled } = await import("@/server/agenda/google-oauth");
    env.GOOGLE_CALENDAR_LIST = "quizás";
    expect(calendarListEnabled()).toBe(false);
    env.GOOGLE_CALENDAR_LIST = " TRUE ";
    expect(calendarListEnabled()).toBe(true);
  });
});
