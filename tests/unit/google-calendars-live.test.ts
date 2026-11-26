import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Mejora 2 — Varios calendarios, contra PostgreSQL REAL (`pnpm test:db`), con el mock de Google en proceso.
 *
 * Organización PROPIA (se borra al final). Cubre: una conexión sin el permiso de la lista sigue igual que
 * antes y pide reconectar (sin llamar a Google); con el permiso, la lista con sus roles; guardar valida contra
 * la lista fresca; reconectar con la MISMA cuenta conserva lo elegido y con OTRA lo reinicia; cambiar el
 * calendario de publicación MUEVE las citas que vienen (mismo evento, sin duplicar, también un Meet con la
 * publicación apagada) y las nuevas nacen ahí; leer varios calendarios suma lo ocupado; un calendario que
 * dejaron de compartir da error con su nombre y conserva los bloqueos; modo Avanzado con y sin el permiso.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const CAL_BASE = "https://google.mock.test/calendar/v3";
const OAUTH_BASE = "https://google.mock.test/oauth";
const TZ = "America/Lima";
const LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const EQUIPO = "equipo@group.calendar.mock";
const PERSONAL = "personal@group.calendar.mock";
const SOCIO = "socio@group.calendar.mock";

describe.skipIf(!live)("Google Calendar: varios calendarios, contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let agenda: typeof import("@/server/agenda/service");
  let calSync: typeof import("@/server/agenda/calendar-sync/sync");
  let busy: typeof import("@/server/agenda/calendar-busy/sync");
  let creds: typeof import("@/server/agenda/connectors/google-credentials");
  let choices: typeof import("@/server/agenda/google-calendars");
  let mockState: typeof import("@/server/dev/google-mock-state");
  let mockRoute: typeof import("@/app/api/dev/google-mock/[...path]/route");
  let slots: typeof import("@/lib/time/slots");
  let event: typeof import("@/server/agenda/calendar-sync/event");

  const tag = Date.now().toString(36);
  const org = `org_gcals_${tag}`;
  const contactId = `ct_gcals_${tag}`;
  let dayOffset = 2;
  const realFetch = globalThis.fetch;
  const googleCalls: { method: string; path: string }[] = [];

  beforeAll(async () => {
    process.env.GOOGLE_CAL_BASE_URL = CAL_BASE;
    process.env.GOOGLE_OAUTH_BASE_URL = OAUTH_BASE;
    process.env.WA_MOCK_ENABLED = "true";
    // La app OAuth de la instancia y la bandera ENCENDIDA (getEnv se lee una vez: antes de importar nada).
    process.env.GOOGLE_OAUTH_CLIENT_ID = "cid-instancia";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csec-instancia";
    process.env.GOOGLE_CALENDAR_LIST = "on";
    ({ eq, and } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    agenda = await import("@/server/agenda/service");
    calSync = await import("@/server/agenda/calendar-sync/sync");
    busy = await import("@/server/agenda/calendar-busy/sync");
    creds = await import("@/server/agenda/connectors/google-credentials");
    choices = await import("@/server/agenda/google-calendars");
    mockState = await import("@/server/dev/google-mock-state");
    mockRoute = await import("@/app/api/dev/google-mock/[...path]/route");
    slots = await import("@/lib/time/slots");
    event = await import("@/server/agenda/calendar-sync/event");

    const all = [{ start: "09:00", end: "18:00" }];
    await db.insert(schema.organization).values({ id: org, name: `GCals ${tag}`, slug: `gcals-${tag}` });
    await db.insert(schema.calendarSettings).values({
      id: `cal_gs_${tag}`,
      organizationId: org,
      weeklyHours: { mon: all, tue: all, wed: all, thu: all, fri: all, sat: all, sun: all },
      slotMinutes: 30,
      minNoticeHours: 0,
      maxDaysAhead: 30,
      timezone: TZ,
      connector: "enlace-fijo",
      meetingLink: "https://sala.fija/abc",
      googleSync: true,
      googleBusy: true,
    });
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Ana Pérez", waIdentity: `gcals-${tag}`, phone: "51999000222" });
  });

  beforeEach(async () => {
    mockState.resetGoogleMock();
    googleCalls.length = 0;
    creds.clearGoogleTokenCache();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const base = url.startsWith(CAL_BASE) ? CAL_BASE : url.startsWith(OAUTH_BASE) ? OAUTH_BASE : null;
      if (!base) return realFetch(input, init);
      const u = new URL(url);
      const path = u.pathname.slice(new URL(base).pathname.length).split("/").filter(Boolean).map(decodeURIComponent);
      const method = init?.method ?? "GET";
      googleCalls.push({ method, path: `/${path.join("/")}${u.search}` });
      const req = new Request(url, { method, headers: init?.headers, body: init?.body ?? undefined });
      const ctx = { params: Promise.resolve({ path }) };
      const handler = { GET: mockRoute.GET, POST: mockRoute.POST, PATCH: mockRoute.PATCH, DELETE: mockRoute.DELETE }[method];
      return handler ? handler(req, ctx) : new Response(null, { status: 405 });
    }) as typeof fetch;
    // Cada prueba empieza conectada CON el permiso de la lista, publicando y leyendo el principal.
    await connectOAuth({ list: true, email: mockState.MOCK_ACCOUNT_EMAIL });
    await db
      .update(schema.googleCredentials)
      .set({ calendarId: "primary", calendarSummary: null, busyCalendars: null })
      .where(eq(schema.googleCredentials.organizationId, org));
    await setSettings({ googleSync: true, googleBusy: true, connector: "enlace-fijo" });
    await busy.clearGoogleBusyBlocks(org);
    // Sin citas de pruebas anteriores (si no, contarían al mover).
    await db.delete(schema.booking).where(eq(schema.booking.organizationId, org));
  });

  afterEach(async () => {
    await calSync.waitForCalendarSyncIdle();
    await busy.waitForBusySyncIdle();
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, org));
  });

  /* ---------- ayudas ---------- */

  async function connectOAuth(opts: { list: boolean; email: string }) {
    await creds.saveGoogleOAuthConnection({
      organizationId: org,
      clientId: "cid-instancia",
      refreshToken: opts.list ? mockState.MOCK_REFRESH_TOKEN_LIST : mockState.MOCK_REFRESH_TOKEN,
      accountEmail: opts.email,
      grantedScopes: `openid email ${EVENTS_SCOPE}${opts.list ? ` ${LIST_SCOPE}` : ""}`,
    });
  }
  const setSettings = (set: Partial<typeof schema.calendarSettings.$inferInsert>) =>
    db.update(schema.calendarSettings).set(set).where(eq(schema.calendarSettings.organizationId, org));
  const credRow = async () =>
    (await db.select().from(schema.googleCredentials).where(eq(schema.googleCredentials.organizationId, org)))[0]!;
  const bookingRow = async (id: string) => (await db.select().from(schema.booking).where(eq(schema.booking.id, id)))[0]!;
  function nextSlot(hhmm = "10:00"): string {
    const day = slots.addDaysISO(slots.todayInTz(new Date(), TZ), dayOffset++);
    return slots.zonedWallClockToUtc(day, hhmm, TZ)!.toISOString();
  }
  const book = async (startUtc: string) => {
    const r = await agenda.createSessionBooking({ organizationId: org, contactId, startUtc, source: "manual", requireOffer: false });
    await calSync.waitForCalendarSyncIdle();
    return r;
  };
  const mockEventOf = (bookingId: string) => mockState.googleMockState().events.get(event.calendarEventIdFor(bookingId));
  const listCalls = () => googleCalls.filter((c) => c.path.startsWith("/users/me/calendarList"));
  const googleBlocks = () =>
    db.select().from(schema.booking).where(and(eq(schema.booking.organizationId, org), eq(schema.booking.busySource, "google")));

  /* ---------- permiso y reconexión ---------- */

  it("conexión SIN el permiso de la lista: sigue igual que antes (principal) y pide reconectar, sin llamar a Google", async () => {
    await connectOAuth({ list: false, email: mockState.MOCK_ACCOUNT_EMAIL });
    const c = await choices.getCalendarChoices(org);
    expect(c).toMatchObject({ available: false, reason: "needs_reconnect", calendars: [] });
    expect(c!.selection.publish).toEqual({ id: "primary", summary: "Calendario principal" });
    expect(listCalls()).toHaveLength(0);
    expect(await choices.saveCalendarChoices(org, { publishCalendarId: "primary", busyCalendarIds: ["primary"] })).toMatchObject({
      ok: false,
      status: 409,
      code: "needs_reconnect",
    });

    const r = await book(nextSlot());
    expect(mockEventOf(r.booking.id)?.calendarId).toBe(mockState.MOCK_PRIMARY_CALENDAR);
    expect((await bookingRow(r.booking.id)).calendarEventCalendarId).toBe("primary");
  });

  it("CON el permiso: la lista trae los roles (publicar exige escribir; libre/ocupado no se lee)", async () => {
    const c = (await choices.getCalendarChoices(org))!;
    expect(c.available).toBe(true);
    expect(c.calendars[0]).toMatchObject({ id: "primary", primary: true, summary: "Agenda del negocio" });
    const by = Object.fromEntries(c.calendars.map((x) => [x.id, x]));
    expect(by[EQUIPO]).toMatchObject({ canPublish: true, canRead: true });
    expect(by[PERSONAL]).toMatchObject({ canPublish: false, canRead: true });
    expect(by[SOCIO]).toMatchObject({ canPublish: false, canRead: false });
  });

  it("guardar valida contra la lista FRESCA de la cuenta", async () => {
    const no = (publishCalendarId: string, busyCalendarIds: string[]) =>
      choices.saveCalendarChoices(org, { publishCalendarId, busyCalendarIds });
    expect(await no(PERSONAL, ["primary"])).toMatchObject({ ok: false, status: 422, code: "invalid_selection" });
    expect(await no("primary", [SOCIO])).toMatchObject({ ok: false, status: 422 });
    // Un calendario que la cuenta ya no tiene.
    await mockRoute.POST(new Request("https://x/_calendars", { method: "POST", body: JSON.stringify({ remove: [EQUIPO] }) }), {
      params: Promise.resolve({ path: ["_calendars"] }),
    });
    expect(await no(EQUIPO, ["primary"])).toMatchObject({ ok: false, status: 422 });
    expect(await credRow()).toMatchObject({ calendarId: "primary", busyCalendars: null });
  });

  it("reconectar con la MISMA cuenta conserva lo elegido; con OTRA cuenta vuelve al principal", async () => {
    const saved = await choices.saveCalendarChoices(org, { publishCalendarId: EQUIPO, busyCalendarIds: ["primary", PERSONAL] });
    expect(saved).toMatchObject({ ok: true, publishChanged: true });
    expect(await credRow()).toMatchObject({
      calendarId: EQUIPO,
      calendarSummary: "Equipo",
      busyCalendars: [
        { id: "primary", summary: "Agenda del negocio" },
        { id: PERSONAL, summary: "Personal" },
      ],
    });

    await connectOAuth({ list: true, email: mockState.MOCK_ACCOUNT_EMAIL.toUpperCase() });
    expect(await credRow()).toMatchObject({ calendarId: EQUIPO, calendarSummary: "Equipo" });
    expect((await credRow()).busyCalendars).toHaveLength(2);

    await connectOAuth({ list: true, email: "otra@cuenta.mock" });
    expect(await credRow()).toMatchObject({ calendarId: "primary", calendarSummary: null, busyCalendars: null });
  });

  /* ---------- mover las citas al cambiar el calendario de publicación ---------- */

  it("cambiar el calendario de publicación MUEVE las citas que vienen (mismo evento, sin duplicar); las nuevas nacen ahí", async () => {
    const a = await book(nextSlot());
    const b = await book(nextSlot());
    expect(mockEventOf(a.booking.id)?.calendarId).toBe(mockState.MOCK_PRIMARY_CALENDAR);

    const saved = await choices.saveCalendarChoices(org, { publishCalendarId: EQUIPO, busyCalendarIds: [EQUIPO] });
    expect(saved).toMatchObject({ ok: true, publishChanged: true, moved: 2 });
    await calSync.waitForCalendarSyncIdle();

    for (const r of [a, b]) {
      const ev = mockEventOf(r.booking.id)!;
      expect(ev).toMatchObject({ calendarId: EQUIPO, moves: 1 });
      expect(await bookingRow(r.booking.id)).toMatchObject({ calendarEventCalendarId: EQUIPO, calendarSyncStatus: "synced" });
    }
    expect(mockState.googleMockState().events.size).toBe(2);

    const c = await book(nextSlot());
    expect(mockEventOf(c.booking.id)?.calendarId).toBe(EQUIPO);
    expect(mockEventOf(c.booking.id)?.moves ?? 0).toBe(0);

    // Cancelar una movida la borra de DONDE vive ahora.
    await agenda.cancelBooking({ organizationId: org, bookingId: a.booking.id });
    await calSync.waitForCalendarSyncIdle();
    expect(mockState.googleMockState().deleted).toContain(event.calendarEventIdFor(a.booking.id));
  });

  it("con la publicación APAGADA, el evento de Meet se mueve igual y conserva su enlace", async () => {
    await setSettings({ googleSync: false, connector: "google" });
    const r = await agenda.createSessionBooking({ organizationId: org, contactId, startUtc: nextSlot(), source: "manual", requireOffer: false });
    const before = await bookingRow(r.booking.id);
    expect(before).toMatchObject({ connector: "google", calendarEventCalendarId: "primary" });
    expect(before.meetingLink).toMatch(/meet\.google\.mock/);

    const saved = await choices.saveCalendarChoices(org, { publishCalendarId: EQUIPO, busyCalendarIds: ["primary"] });
    expect(saved).toMatchObject({ ok: true, moved: 1 });
    await calSync.waitForCalendarSyncIdle();
    const ev = mockState.googleMockState().events.get(before.externalRef!)!;
    expect(ev).toMatchObject({ calendarId: EQUIPO, moves: 1 });
    expect(await bookingRow(r.booking.id)).toMatchObject({
      calendarEventCalendarId: EQUIPO,
      calendarSyncStatus: null,
      meetingLink: before.meetingLink,
    });
  });

  /* ---------- leer varios calendarios ---------- */

  it("lee VARIOS calendarios y suma lo ocupado; lo de un calendario no elegido no cuenta", async () => {
    await choices.saveCalendarChoices(org, { publishCalendarId: "primary", busyCalendarIds: ["primary", PERSONAL] });
    await busy.waitForBusySyncIdle();
    const day = nextSlot("00:00").slice(0, 10);
    const at = (hhmm: string) => slots.zonedWallClockToUtc(day, hhmm, TZ)!.toISOString();
    const s = mockState.googleMockState();
    s.external.push(
      { id: "p1", start: { dateTime: at("10:00") }, end: { dateTime: at("11:00") } },
      { id: "x1", calendarId: PERSONAL, start: { dateTime: at("12:00") }, end: { dateTime: at("13:00") } },
      { id: "e1", calendarId: EQUIPO, start: { dateTime: at("15:00") }, end: { dateTime: at("16:00") } }
    );
    expect(await busy.syncGoogleBusy(org)).toMatchObject({ outcome: "synced", blocks: 2 });
    const starts = (await googleBlocks()).map((b) => b.scheduledAt.toISOString()).sort();
    expect(starts).toEqual([at("10:00"), at("12:00")]);
    const calendarsRead = googleCalls.filter((c) => /\/events\?/.test(c.path)).map((c) => c.path.split("/")[2]);
    expect(new Set(calendarsRead)).toEqual(new Set(["primary", PERSONAL]));
  });

  it("un calendario que dejaron de compartir: error con SU nombre y se conservan los bloqueos", async () => {
    await choices.saveCalendarChoices(org, { publishCalendarId: "primary", busyCalendarIds: ["primary", PERSONAL] });
    await busy.waitForBusySyncIdle();
    const day = nextSlot("00:00").slice(0, 10);
    const at = (hhmm: string) => slots.zonedWallClockToUtc(day, hhmm, TZ)!.toISOString();
    mockState.googleMockState().external.push({ id: "x2", calendarId: PERSONAL, start: { dateTime: at("12:00") }, end: { dateTime: at("13:00") } });
    await busy.syncGoogleBusy(org);
    expect(await googleBlocks()).toHaveLength(1);

    await mockRoute.POST(new Request("https://x/_calendars", { method: "POST", body: JSON.stringify({ remove: [PERSONAL] }) }), {
      params: Promise.resolve({ path: ["_calendars"] }),
    });
    const out = await busy.syncGoogleBusy(org);
    expect(out).toMatchObject({ outcome: "error" });
    const row = await credRow();
    expect(row.busyStatus).toBe("error");
    expect(row.busyError).toMatch(/«Personal».*ya no está compartido/);
    expect(await googleBlocks()).toHaveLength(1);
  });

  /* ---------- modo Avanzado ---------- */

  it("Avanzado: sin el permiso, `manual_no_scope`; con él, la lista (aunque la bandera sea de OAuth)", async () => {
    await creds.saveGoogleCredentials({ organizationId: org, clientId: "cid-propio", clientSecret: "csec", refreshToken: "rt-propio" });
    expect(await choices.getCalendarChoices(org)).toMatchObject({ available: false, reason: "manual_no_scope" });
    await creds.saveGoogleCredentials({ organizationId: org, clientId: "cid-propio", clientSecret: "csec", refreshToken: "rt-propio-list" });
    const c = await choices.getCalendarChoices(org);
    expect(c).toMatchObject({ available: true, reason: null });
    expect(c!.calendars.length).toBe(4);
  });
});
