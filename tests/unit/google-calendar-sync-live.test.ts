import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Paso 3 — Publicar las citas en Google Calendar, contra PostgreSQL REAL (`pnpm test:db`).
 *
 * «Google» es el mock del self-test (`/api/dev/google-mock`), llamado en proceso: `fetch` hacia sus bases se
 * enruta a sus handlers. Así se ejercitan juntos el conector, la sincronización y el mock, sin red.
 *
 * Organización PROPIA (se borra al final, todo cae en cascada). Cubre: crear/mover/cerrar/cancelar se
 * reflejan; sin teléfono por defecto; Meet solo con el conector `google` (y un único evento); dos citas a
 * la misma hora con su propio Meet; Google caído → la cita se crea igual y el barrido la publica sin
 * duplicar; respuesta perdida → 409 → actualizar; token revocado → pausa, aviso una vez y nada más a
 * Google; un cambio a mitad de un intento no se pierde; sincronización apagada y Laboratorio → cero llamadas.
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

describe.skipIf(!live)("Google Calendar: sincronización de citas contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let agenda: typeof import("@/server/agenda/service");
  let sync: typeof import("@/server/agenda/calendar-sync/sync");
  let creds: typeof import("@/server/agenda/connectors/google-credentials");
  let mockState: typeof import("@/server/dev/google-mock-state");
  let mockRoute: typeof import("@/app/api/dev/google-mock/[...path]/route");
  let slots: typeof import("@/lib/time/slots");
  let event: typeof import("@/server/agenda/calendar-sync/event");

  const tag = Date.now().toString(36);
  const org = `org_gcal_${tag}`;
  const contactId = `ct_gcal_${tag}`;
  const svc = `svc_gcal_${tag}`;
  let dayOffset = 2;
  const realFetch = globalThis.fetch;
  /** Cada llamada a «Google» (método + camino), para contar y para inspeccionar. */
  const googleCalls: { method: string; path: string; body: string }[] = [];
  /** Se ejecuta (una vez) en medio de la siguiente escritura de un evento. */
  let duringWrite: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    process.env.GOOGLE_CAL_BASE_URL = CAL_BASE;
    process.env.GOOGLE_OAUTH_BASE_URL = OAUTH_BASE;
    process.env.WA_MOCK_ENABLED = "true";
    ({ eq, and } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    agenda = await import("@/server/agenda/service");
    sync = await import("@/server/agenda/calendar-sync/sync");
    creds = await import("@/server/agenda/connectors/google-credentials");
    mockState = await import("@/server/dev/google-mock-state");
    mockRoute = await import("@/app/api/dev/google-mock/[...path]/route");
    slots = await import("@/lib/time/slots");
    event = await import("@/server/agenda/calendar-sync/event");

    const all = [{ start: "09:00", end: "18:00" }];
    await db.insert(schema.organization).values({ id: org, name: `GCal ${tag}`, slug: `gcal-${tag}` });
    await db.insert(schema.calendarSettings).values({
      id: `cal_g_${tag}`,
      organizationId: org,
      weeklyHours: { mon: all, tue: all, wed: all, thu: all, fri: all, sat: all, sun: all },
      slotMinutes: 30,
      minNoticeHours: 0,
      maxDaysAhead: 30,
      timezone: TZ,
      connector: "enlace-fijo",
      meetingLink: "https://sala.fija/abc",
      googleSync: true,
    });
    await db.insert(schema.service).values({ id: svc, organizationId: org, name: "Corte y barba", priceCents: 5000, durationMinutes: 60 });
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Ana Pérez Soto", waIdentity: `gcal-${tag}`, phone: "51999888777" });
    await creds.saveGoogleCredentials({ organizationId: org, clientId: "cid", clientSecret: "csec", refreshToken: "rt-bueno" });
  });

  beforeEach(() => {
    mockState.resetGoogleMock();
    googleCalls.length = 0;
    duringWrite = null;
    creds.clearGoogleTokenCache();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const base = url.startsWith(CAL_BASE) ? CAL_BASE : url.startsWith(OAUTH_BASE) ? OAUTH_BASE : null;
      if (!base) return realFetch(input, init);
      const u = new URL(url);
      const path = u.pathname.slice(new URL(base).pathname.length).split("/").filter(Boolean).map(decodeURIComponent);
      const method = init?.method ?? "GET";
      googleCalls.push({ method, path: `/${path.join("/")}${u.search}`, body: String(init?.body ?? "") });
      if (duringWrite && path[2] === "events" && (method === "POST" || method === "PATCH")) {
        const hook = duringWrite;
        duringWrite = null;
        await hook();
      }
      const req = new Request(url, { method, headers: init?.headers, body: init?.body ?? undefined });
      const ctx = { params: Promise.resolve({ path }) };
      const handler = { GET: mockRoute.GET, POST: mockRoute.POST, PATCH: mockRoute.PATCH, DELETE: mockRoute.DELETE }[method];
      return handler ? handler(req, ctx) : new Response(null, { status: 405 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    await sync.waitForCalendarSyncIdle();
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, org));
  });

  /** Un instante libre y distinto en cada llamada (un día más adelante cada vez). */
  function nextSlot(hhmm = "10:00"): string {
    const day = slots.addDaysISO(slots.todayInTz(new Date(), TZ), dayOffset++);
    return slots.zonedWallClockToUtc(day, hhmm, TZ)!.toISOString();
  }

  const book = (startUtc: string, over: Partial<Parameters<typeof agenda.createSessionBooking>[0]> = {}) =>
    agenda.createSessionBooking({ organizationId: org, contactId, startUtc, source: "manual", requireOffer: false, ...over });

  const row = async (id: string) => (await db.select().from(schema.booking).where(eq(schema.booking.id, id)))[0]!;
  const mockEvent = (id: string) => mockState.googleMockState().events.get(event.calendarEventIdFor(id));
  const eventWrites = () => googleCalls.filter((c) => c.path.includes("/events") && c.method !== "GET");
  const setSettings = (set: Partial<typeof schema.calendarSettings.$inferInsert>) =>
    db.update(schema.calendarSettings).set(set).where(eq(schema.calendarSettings.organizationId, org));

  it("crear publica el evento con el id de la cita, sin Meet, sin teléfono y con la marca de Vocero", async () => {
    const r = await book(nextSlot(), { serviceId: svc, durationMinutes: 60, notes: "Trae su foto" });
    await sync.waitForCalendarSyncIdle();

    const e = mockEvent(r.booking.id)!;
    expect(e).toBeDefined();
    expect(e.summary).toBe("Corte y barba — Ana P.");
    expect(e.description).toContain("Notas: Trae su foto");
    expect(e.description).toContain("Enlace de la reunión: https://sala.fija/abc");
    expect(e.description).not.toContain("51999888777");
    expect(e.description).not.toContain("Pérez");
    expect(e.location).toBe("https://sala.fija/abc");
    expect(e.privateProps).toEqual({ voceroBookingId: r.booking.id, voceroOrg: org });
    expect(e.wantsMeet).toBe(false);
    expect(Date.parse(e.end) - Date.parse(e.start)).toBe(60 * 60_000);
    expect(eventWrites().every((c) => c.path.includes("sendUpdates=none"))).toBe(true);

    const b = await row(r.booking.id);
    expect(b).toMatchObject({ calendarSyncStatus: "synced", calendarEventId: event.calendarEventIdFor(r.booking.id), calendarSyncNextAt: null });
  });

  it("mover, confirmar, cerrar y cancelar se reflejan en el MISMO evento", async () => {
    const r = await book(nextSlot());
    await sync.waitForCalendarSyncIdle();
    const to = nextSlot("15:00");
    await agenda.rescheduleBooking({ organizationId: org, bookingId: r.booking.id, startUtc: to });
    await sync.waitForCalendarSyncIdle();
    expect(mockEvent(r.booking.id)!.start).toBe(to);

    await agenda.confirmBooking({ organizationId: org, bookingId: r.booking.id });
    await sync.waitForCalendarSyncIdle();
    expect(mockEvent(r.booking.id)!.summary).toBe("✓ Cita — Ana P.");

    await agenda.markBookingStatus({ organizationId: org, bookingId: r.booking.id, status: "no_show" });
    await sync.waitForCalendarSyncIdle();
    expect(mockEvent(r.booking.id)!.summary).toBe("[No asistió] Cita — Ana P.");

    await agenda.cancelBooking({ organizationId: org, bookingId: r.booking.id });
    await sync.waitForCalendarSyncIdle();
    expect(mockEvent(r.booking.id)).toBeUndefined();
    expect(mockState.googleMockState().deleted).toContain(event.calendarEventIdFor(r.booking.id));
    expect((await row(r.booking.id)).calendarSyncStatus).toBe("synced");
    // Un único evento en todo el recorrido.
    expect(googleCalls.filter((c) => c.method === "POST" && c.path.endsWith("/events?sendUpdates=none"))).toHaveLength(1);
  });

  it("con la casilla del teléfono, el evento lo incluye", async () => {
    await setSettings({ googleSyncPhone: true });
    try {
      const r = await book(nextSlot());
      await sync.waitForCalendarSyncIdle();
      expect(mockEvent(r.booking.id)!.description).toContain("Teléfono: 51999888777");
    } finally {
      await setSettings({ googleSyncPhone: false });
    }
  });

  it("con el conector Google (Meet): UN solo evento, con su Meet y el título privado; dos citas a la misma hora, dos Meet", async () => {
    await setSettings({ connector: "google" });
    try {
      const at = nextSlot("11:00");
      // Multicupo sin equipo no existe: dos citas a la misma hora necesitan dos profesionales.
      await db.insert(schema.staff).values([
        { id: `stf_g1_${tag}`, organizationId: org, name: "Uno" },
        { id: `stf_g2_${tag}`, organizationId: org, name: "Dos" },
      ]);
      const a = await book(at);
      const b = await book(at);
      await sync.waitForCalendarSyncIdle();
      expect(a.booking.externalRef).toBe(event.calendarEventIdFor(a.booking.id));
      expect(a.meetingLink).toMatch(/^https:\/\/meet\.google\.mock\//);
      expect(b.meetingLink).toMatch(/^https:\/\/meet\.google\.mock\//);
      expect(a.meetingLink).not.toBe(b.meetingLink);

      const requestIds = googleCalls
        .filter((c) => c.method === "POST" && c.path.includes("/events"))
        .map((c) => (JSON.parse(c.body) as { conferenceData?: { createRequest?: { requestId?: string } } }).conferenceData?.createRequest?.requestId)
        .filter(Boolean);
      expect(requestIds).toEqual([`vocero-${a.booking.id}`, `vocero-${b.booking.id}`]);

      const e = mockEvent(a.booking.id)!;
      expect(e.wantsMeet).toBe(true);
      expect(e.summary).toBe("Cita — Ana P.");
      expect(e.description).toContain(`Profesional: `);
      expect(mockState.googleMockState().events.size).toBe(2);
    } finally {
      await setSettings({ connector: "enlace-fijo" });
      await db.delete(schema.booking).where(eq(schema.booking.organizationId, org));
      await db.delete(schema.staff).where(eq(schema.staff.organizationId, org));
    }
  });

  it("Google caído: la cita se crea igual; queda en error con reintento y el barrido la publica sin duplicar", async () => {
    mockState.googleMockState().failNext = { status: 503, count: 1 };
    const r = await book(nextSlot());
    await sync.waitForCalendarSyncIdle();
    expect(r.booking.id).toBeTruthy();
    let b = await row(r.booking.id);
    expect(b.calendarSyncStatus).toBe("error");
    expect(b.calendarSyncAttempts).toBe(1);
    expect(b.calendarSyncNextAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);

    // Antes de su hora, el barrido no la toca.
    await sync.sweepCalendarSync(new Date());
    expect(mockEvent(r.booking.id)).toBeUndefined();
    // Cuando le toca, sí.
    await sync.sweepCalendarSync(new Date(Date.now() + 2 * 60_000));
    b = await row(r.booking.id);
    expect(b).toMatchObject({ calendarSyncStatus: "synced", calendarSyncAttempts: 0, calendarSyncError: null });
    expect(mockState.googleMockState().events.size).toBe(1);
  });

  it("respuesta perdida: el evento ya existía → 409 → se actualiza ese mismo, sin duplicar", async () => {
    const r = await book(nextSlot(), { notes: "versión 1" });
    await sync.waitForCalendarSyncIdle();
    // Como si el primer insert hubiera llegado a Google pero su respuesta no: la cita no sabe su evento.
    await db.update(schema.booking).set({ calendarEventId: null, notes: "versión 2" }).where(eq(schema.booking.id, r.booking.id));
    await sync.requestCalendarSync(org, r.booking.id, { immediate: false });
    expect(await sync.syncBookingNow(org, r.booking.id)).toBe("synced");
    expect(mockState.googleMockState().events.size).toBe(1);
    expect(mockEvent(r.booking.id)!.description).toContain("Notas: versión 2");
    expect(googleCalls.some((c) => c.method === "POST" && c.path.includes("/events"))).toBe(true);
    expect(googleCalls.some((c) => c.method === "PATCH")).toBe(true);
  });

  it("un cambio a mitad de un intento no se pierde: el resultado viejo no se guarda y queda pendiente", async () => {
    const r = await book(nextSlot());
    await sync.waitForCalendarSyncIdle();
    await sync.requestCalendarSync(org, r.booking.id, { immediate: false });
    duringWrite = async () => {
      await db.update(schema.booking).set({ notes: "cambió a mitad" }).where(eq(schema.booking.id, r.booking.id));
      await sync.requestCalendarSync(org, r.booking.id, { immediate: false });
    };
    expect(await sync.syncBookingNow(org, r.booking.id)).toBe("stale");
    expect((await row(r.booking.id)).calendarSyncStatus).toBe("pending");
    expect(await sync.syncBookingNow(org, r.booking.id)).toBe("synced");
    expect(mockEvent(r.booking.id)!.description).toContain("Notas: cambió a mitad");
  });

  it("sincronización apagada o cita del Laboratorio: ni una llamada a Google", async () => {
    await setSettings({ googleSync: false });
    try {
      const r = await book(nextSlot());
      await sync.waitForCalendarSyncIdle();
      expect((await row(r.booking.id)).calendarSyncStatus).toBeNull();
    } finally {
      await setSettings({ googleSync: true });
    }
    const convId = `cv_lab_${tag}`;
    await db.insert(schema.conversation).values({ id: convId, organizationId: org, contactId, isTest: true });
    const lab = await book(nextSlot(), { conversationId: convId });
    await sync.requestCalendarSync(org, lab.booking.id);
    await sync.waitForCalendarSyncIdle();
    expect((await row(lab.booking.id)).calendarSyncStatus).toBeNull();
    expect(googleCalls).toHaveLength(0);
  });

  it("al encender la sincronización se publican las citas que vienen", async () => {
    await setSettings({ googleSync: false });
    const r = await book(nextSlot());
    await setSettings({ googleSync: true });
    expect(await sync.resyncUpcomingBookings(org)).toBeGreaterThan(0);
    await sync.sweepCalendarSync(new Date(Date.now() + 1000));
    expect(mockEvent(r.booking.id)).toBeDefined();
  });

  it("token revocado: la conexión pasa a error, se avisa UNA vez y se deja de llamar a Google", async () => {
    await creds.saveGoogleCredentials({ organizationId: org, clientId: "cid", clientSecret: "csec", refreshToken: "rt-invalid" });
    try {
      const a = await book(nextSlot());
      await sync.waitForCalendarSyncIdle();
      expect((await row(a.booking.id)).calendarSyncStatus).toBe("error");
      expect((await row(a.booking.id)).calendarSyncNextAt).toBeNull();
      const info = await creds.getGoogleConnectionInfo(org);
      expect(info).toMatchObject({ status: "error" });
      expect(info!.lastError).toMatch(/refresh token/);

      googleCalls.length = 0;
      const b = await book(nextSlot());
      await sync.waitForCalendarSyncIdle();
      expect((await row(b.booking.id)).calendarSyncError).toMatch(/no está conectado/);
      expect(googleCalls).toHaveLength(0);

      const avisos = await db
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.organizationId, org), eq(schema.notifications.title, "Google Calendar se desconectó")));
      expect(avisos).toHaveLength(1);

      // Reconectar retoma lo pendiente.
      await creds.saveGoogleCredentials({ organizationId: org, clientId: "cid", clientSecret: "csec", refreshToken: "rt-bueno" });
      expect(await sync.resyncUpcomingBookings(org)).toBeGreaterThan(0);
      await sync.sweepCalendarSync(new Date(Date.now() + 1000));
      expect((await row(b.booking.id)).calendarSyncStatus).toBe("synced");
    } finally {
      await creds.saveGoogleCredentials({ organizationId: org, clientId: "cid", clientSecret: "csec", refreshToken: "rt-bueno" });
    }
  });

  it("la conexión OAuth guarda solo el refresh token: el secreto sale de la instancia, y sin ella no hay credenciales", async () => {
    const other = `org_gcal2_${tag}`;
    await db.insert(schema.organization).values({ id: other, name: "Otra", slug: `gcal2-${tag}` });
    try {
      await creds.saveGoogleOAuthConnection({ organizationId: other, clientId: "inst-cid", refreshToken: "rt-oauth", accountEmail: "dueno@negocio.com" });
      const [stored] = await db.select().from(schema.googleCredentials).where(eq(schema.googleCredentials.organizationId, other));
      expect(stored).toMatchObject({ source: "oauth", clientSecretCipher: null, accountEmail: "dueno@negocio.com", status: "connected" });
      expect(stored!.refreshTokenCipher).not.toContain("rt-oauth");
      // Sin GOOGLE_OAUTH_CLIENT_ID/SECRET en el entorno: la conexión no se puede usar y Ajustes lo dice.
      expect(await creds.getGoogleCredentials(other)).toBeNull();
      expect(await creds.getGoogleConnectionInfo(other)).toMatchObject({ appMissing: true, source: "oauth" });
    } finally {
      await db.delete(schema.organization).where(eq(schema.organization.id, other));
    }
  });
});
