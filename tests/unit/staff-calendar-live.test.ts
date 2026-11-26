import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Mejora 3 — Calendario por profesional, contra PostgreSQL REAL (`pnpm test:db`), con el mock de Google en
 * proceso (dos cuentas: la del negocio y la personal de cada profesional).
 *
 * Organización PROPIA con Carla y Beto. Cubre: el enlace de 24 h de punta a punta (enlace → Google → vuelta →
 * conexión cifrada, uso único, revocar al generar otro, vencido, profesional inactivo, la cuenta del negocio
 * se rechaza); lo ocupado de Carla la saca SOLO a ella (disponibilidad, reserva con y sin profesional,
 * tablero); los choques solo con SUS citas; anti-bucle; lo del negocio no toca lo de Carla; desactivar o
 * borrar limpia su conexión y sus bloqueos (sin dejar bloqueos para todo el negocio); token revocado.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const MOCK = "https://google.mock.test";
const CAL_BASE = `${MOCK}/calendar/v3`;
const OAUTH_BASE = `${MOCK}/oauth`;
const ACCOUNTS_BASE = `${MOCK}/accounts`;
const TZ = "America/Lima";
const CARLA_MAIL = "carla@personal.mock";
const BETO_MAIL = "beto@personal.mock";

describe.skipIf(!live)("calendario por profesional, contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let isNull: (typeof import("drizzle-orm"))["isNull"];
  let agenda: typeof import("@/server/agenda/service");
  let availability: typeof import("@/server/agenda/availability");
  let board: typeof import("@/server/business/board");
  let staffSvc: typeof import("@/server/business/staff");
  let orgBusy: typeof import("@/server/agenda/calendar-busy/sync");
  let invite: typeof import("@/server/agenda/staff-calendar/invite");
  let conn: typeof import("@/server/agenda/staff-calendar/connection");
  let staffBusy: typeof import("@/server/agenda/staff-calendar/busy");
  let creds: typeof import("@/server/agenda/connectors/google-credentials");
  let mockState: typeof import("@/server/dev/google-mock-state");
  let mockRoute: typeof import("@/app/api/dev/google-mock/[...path]/route");
  let startRoute: typeof import("@/app/api/calendar-invite/[token]/start/route");
  let callbackRoute: typeof import("@/app/api/calendar-invite/oauth/callback/route");
  let slots: typeof import("@/lib/time/slots");

  const tag = Date.now().toString(36);
  const org = `org_scal_${tag}`;
  const contactId = `ct_scal_${tag}`;
  const carla = `stf_carla_${tag}`;
  const beto = `stf_beto_${tag}`;
  const svc = `srv_scal_${tag}`;
  let dayOffset = 2;
  const realFetch = globalThis.fetch;
  const googleCalls: { method: string; path: string }[] = [];

  beforeAll(async () => {
    process.env.GOOGLE_CAL_BASE_URL = CAL_BASE;
    process.env.GOOGLE_OAUTH_BASE_URL = OAUTH_BASE;
    process.env.GOOGLE_ACCOUNTS_BASE_URL = ACCOUNTS_BASE;
    process.env.WA_MOCK_ENABLED = "true";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "cid-instancia";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csec-instancia";
    process.env.GOOGLE_STAFF_CALENDARS = "on";
    process.env.AGENDA = "on";
    process.env.SALON = "on";
    ({ eq, and, isNull } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    agenda = await import("@/server/agenda/service");
    availability = await import("@/server/agenda/availability");
    board = await import("@/server/business/board");
    staffSvc = await import("@/server/business/staff");
    orgBusy = await import("@/server/agenda/calendar-busy/sync");
    invite = await import("@/server/agenda/staff-calendar/invite");
    conn = await import("@/server/agenda/staff-calendar/connection");
    staffBusy = await import("@/server/agenda/staff-calendar/busy");
    creds = await import("@/server/agenda/connectors/google-credentials");
    mockState = await import("@/server/dev/google-mock-state");
    mockRoute = await import("@/app/api/dev/google-mock/[...path]/route");
    startRoute = await import("@/app/api/calendar-invite/[token]/start/route");
    callbackRoute = await import("@/app/api/calendar-invite/oauth/callback/route");
    slots = await import("@/lib/time/slots");

    const all = [{ start: "09:00", end: "18:00" }];
    await db.insert(schema.organization).values({ id: org, name: `Barbería ${tag}`, slug: `scal-${tag}` });
    await db.insert(schema.calendarSettings).values({
      id: `cal_sc_${tag}`,
      organizationId: org,
      weeklyHours: { mon: all, tue: all, wed: all, thu: all, fri: all, sat: all, sun: all },
      slotMinutes: 30,
      minNoticeHours: 0,
      maxDaysAhead: 30,
      timezone: TZ,
      connector: "enlace-fijo",
    });
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Ana Pérez", waIdentity: `scal-${tag}`, phone: "51999000333" });
    await db.insert(schema.service).values({ id: svc, organizationId: org, name: "Corte", priceCents: 3000, durationMinutes: 30 });
  });

  beforeEach(async () => {
    mockState.resetGoogleMock();
    googleCalls.length = 0;
    creds.clearGoogleTokenCache();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const base = [CAL_BASE, OAUTH_BASE, ACCOUNTS_BASE].find((b) => url.startsWith(b));
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
    // Equipo limpio en cada prueba: Carla y Beto activos, sin conexión ni bloqueos ni citas.
    await db.delete(schema.booking).where(eq(schema.booking.organizationId, org));
    await db.delete(schema.staff).where(eq(schema.staff.organizationId, org));
    await db.insert(schema.staff).values([
      { id: carla, organizationId: org, name: "Carla", phone: "51911111111" },
      { id: beto, organizationId: org, name: "Beto", phone: "51922222222" },
    ]);
  });

  afterEach(async () => {
    await staffBusy.waitForStaffBusyIdle();
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, org));
  });

  /* ---------- ayudas ---------- */

  function nextDay() {
    const date = slots.addDaysISO(slots.todayInTz(new Date(), TZ), dayOffset++);
    return { date, at: (hhmm: string) => slots.zonedWallClockToUtc(date, hhmm, TZ)!.toISOString() };
  }
  const connect = (staffId: string, email: string) =>
    conn.saveStaffConnection({
      organizationId: org,
      staffId,
      refreshToken: mockState.mockStaffRefreshToken(email),
      accountEmail: email,
      grantedScopes: "openid email https://www.googleapis.com/auth/calendar.events.readonly",
    });
  const busyIn = (email: string, start: string, end: string, extra: Record<string, unknown> = {}) =>
    mockState.googleMockState().external.push({ id: `${email}-${start}`, calendarId: email, start: { dateTime: start }, end: { dateTime: end }, ...extra });
  const staffBlocks = (staffId: string) =>
    db.select().from(schema.booking).where(and(eq(schema.booking.organizationId, org), eq(schema.booking.busySource, "google"), eq(schema.booking.staffId, staffId)));
  const orphanBlocks = () =>
    db.select().from(schema.booking).where(and(eq(schema.booking.organizationId, org), eq(schema.booking.busySource, "google"), isNull(schema.booking.staffId)));
  const connRow = async (staffId: string) =>
    (await db.select().from(schema.staffGoogleConnection).where(and(eq(schema.staffGoogleConnection.organizationId, org), eq(schema.staffGoogleConnection.staffId, staffId))))[0];
  const offered = async (date: string, staffId?: string) =>
    (await availability.computeAvailability(org, { fromISO: date, toISO: date, ...(staffId ? { staffId } : {}) })).map((s) => s.startUtc);
  const book = (startUtc: string, staffId?: string) =>
    agenda.createSessionBooking({ organizationId: org, contactId, startUtc, source: "manual", requireOffer: false, ...(staffId ? { staffId } : {}) });
  const avisos = (title: string) =>
    db.select().from(schema.notifications).where(and(eq(schema.notifications.organizationId, org), eq(schema.notifications.title, title)));

  /** El enlace de punta a punta: página → Google (mock) → vuelta. Devuelve a dónde terminó. */
  async function connectWithLink(token: string): Promise<URL> {
    const start = await startRoute.GET(new Request("https://x"), { params: Promise.resolve({ token }) });
    const google = start.headers.get("location")!;
    if (!google.startsWith(ACCOUNTS_BASE)) return new URL(google);
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const consent = await fetch(google);
    const back = new URL(consent.headers.get("location")!);
    const res = await callbackRoute.GET(new Request(back.toString(), { headers: { cookie } }));
    await staffBusy.waitForStaffBusyIdle();
    return new URL(res.headers.get("location")!);
  }

  /* ---------- el enlace de 24 h ---------- */

  it("enlace → Google → vuelta: conecta SU cuenta (cifrada), el enlace queda usado y se avisa al dueño", async () => {
    const link = await invite.createInvite({ organizationId: org, staffId: carla, userId: null });
    expect(link.url).toContain(`/conectar-calendario/${link.token}`);
    const [stored] = await db.select().from(schema.staffCalendarInvite).where(eq(schema.staffCalendarInvite.staffId, carla));
    expect(stored!.tokenHash).toBe(invite.hashInviteToken(link.token));
    expect(JSON.stringify(stored)).not.toContain(link.token);

    const end = await connectWithLink(link.token);
    expect(end.pathname).toBe("/conectar-calendario/resultado");
    expect(Object.fromEntries(end.searchParams)).toMatchObject({ estado: "ok", nombre: "Carla" });
    const row = await connRow(carla);
    expect(row).toMatchObject({ status: "connected", accountEmail: CARLA_MAIL });
    expect(JSON.stringify(row)).not.toContain("mock-refresh-staff");
    expect(row!.busyStatus).toBe("ok"); // la lectura inmediata ya corrió
    expect(await avisos("Carla conectó su Google Calendar")).toHaveLength(1);
    // Google solo recibió pedidos de LECTURA con la cuenta de Carla.
    expect(googleCalls.filter((c) => c.path.includes("/events") && c.method !== "GET")).toHaveLength(0);

    // Uso único.
    expect(await invite.resolveInvite(link.token)).toEqual({ ok: false, reason: "used" });
    expect((await connectWithLink(link.token)).searchParams.get("motivo")).toBe("used");
  });

  it("generar otro anula el anterior; vencido a las 24 h; profesional inactivo; permiso desmarcado", async () => {
    const a = await invite.createInvite({ organizationId: org, staffId: beto, userId: null });
    const b = await invite.createInvite({ organizationId: org, staffId: beto, userId: null });
    expect(await invite.resolveInvite(a.token)).toEqual({ ok: false, reason: "revoked" });
    expect((await invite.resolveInvite(b.token)).ok).toBe(true);
    expect(await invite.resolveInvite(b.token, new Date(Date.now() + invite.INVITE_TTL_MS + 1000))).toEqual({ ok: false, reason: "expired" });
    expect(await invite.resolveInvite("no-existe")).toEqual({ ok: false, reason: "not_found" });

    await mockRoute.POST(new Request("https://x/_staff", { method: "POST", body: JSON.stringify({ grantRead: false, email: BETO_MAIL }) }), {
      params: Promise.resolve({ path: ["_staff"] }),
    });
    expect((await connectWithLink(b.token)).searchParams.get("motivo")).toBe("missing_scope");
    expect(await connRow(beto)).toBeUndefined();

    await db.update(schema.staff).set({ active: false }).where(eq(schema.staff.id, beto));
    await expect(invite.createInvite({ organizationId: org, staffId: beto, userId: null })).rejects.toMatchObject({ code: "staff_inactive" });
  });

  it("la cuenta de Google del NEGOCIO no se acepta como calendario de un profesional (anti-bucle)", async () => {
    await creds.saveGoogleOAuthConnection({
      organizationId: org,
      clientId: "cid-instancia",
      refreshToken: mockState.MOCK_REFRESH_TOKEN,
      accountEmail: "dueno@negocio.mock",
    });
    try {
      await mockRoute.POST(new Request("https://x/_staff", { method: "POST", body: JSON.stringify({ email: "Dueno@Negocio.mock" }) }), {
        params: Promise.resolve({ path: ["_staff"] }),
      });
      const link = await invite.createInvite({ organizationId: org, staffId: carla, userId: null });
      expect((await connectWithLink(link.token)).searchParams.get("motivo")).toBe("business_account");
      expect(await connRow(carla)).toBeUndefined();
      expect(mockState.googleMockState().revoked).toContain(mockState.mockStaffRefreshToken("Dueno@Negocio.mock"));
    } finally {
      await creds.deleteGoogleCredentials(org);
    }
  });

  /* ---------- cupos, reservas y tablero ---------- */

  it("lo ocupado de Carla la saca SOLO a ella: se ofrece con Beto, «cualquiera» va a Beto y pedir a Carla falla", async () => {
    const d = nextDay();
    await connect(carla, CARLA_MAIL);
    busyIn(CARLA_MAIL, d.at("10:00"), d.at("11:00"));
    // Un evento de Vocero en su calendario (marca) no cuenta.
    busyIn(CARLA_MAIL, d.at("14:00"), d.at("15:00"), { extendedProperties: { private: { voceroBookingId: "bk_x" } } });
    expect(await staffBusy.syncStaffBusy(org, carla)).toMatchObject({ outcome: "synced", blocks: 1 });
    const [block] = await staffBlocks(carla);
    expect(block).toMatchObject({ kind: "block", staffId: carla, notes: "Ocupado en Google Calendar · Carla" });

    expect(await offered(d.date)).toContain(d.at("10:00"));
    expect(await offered(d.date, carla)).not.toContain(d.at("10:00"));
    expect(await offered(d.date, carla)).toContain(d.at("14:00"));
    await expect(book(d.at("10:00"), carla)).rejects.toMatchObject({ code: "slot_taken" });
    const any = await book(d.at("10:00"));
    expect(any.booking.staffId).toBe(beto);

    // Con Beto también ocupado (por su cita), el horario desaparece.
    expect(await offered(d.date)).not.toContain(d.at("10:00"));
  });

  it("tablero: la celda de Carla se ve ocupada, la de Beto libre; agendar con Carla ahí da `staff_busy`", async () => {
    const d = nextDay();
    await connect(carla, CARLA_MAIL);
    busyIn(CARLA_MAIL, d.at("10:00"), d.at("10:30"));
    await staffBusy.syncStaffBusy(org, carla);
    const b = await board.getBoard(org, d.date);
    const slot = b.slots.find((s) => s.startUtc === d.at("10:00"))!;
    expect(slot).toMatchObject({ busyStaffIds: [carla], blocked: false, free: 1 });
    await expect(board.createBoardBooking(org, { contactId, startUtc: d.at("10:00"), staffId: carla, serviceId: svc })).rejects.toMatchObject({
      code: "staff_busy",
      message: expect.stringContaining("Google Calendar"),
    });
    // Con Beto sí.
    expect((await board.createBoardBooking(org, { contactId, startUtc: d.at("10:00"), staffId: beto, serviceId: svc })).bookingId).toBeTruthy();
  });

  it("choques: un evento nuevo de Carla choca con SUS citas, no con las de Beto; el aviso dice con quién", async () => {
    const d = nextDay();
    const suya = await book(d.at("15:00"), carla);
    const deBeto = await book(d.at("15:00"), beto);
    await connect(carla, CARLA_MAIL);
    busyIn(CARLA_MAIL, d.at("14:30"), d.at("15:30"));
    expect(await staffBusy.syncStaffBusy(org, carla)).toMatchObject({ newConflicts: 1 });
    const [a] = await db.select().from(schema.booking).where(eq(schema.booking.id, suya.booking.id));
    const [b] = await db.select().from(schema.booking).where(eq(schema.booking.id, deBeto.booking.id));
    expect(a!.googleConflictStart).not.toBeNull();
    expect(b!.googleConflictStart).toBeNull();
    const [aviso] = await avisos("Una cita choca con tu Google Calendar");
    expect(aviso!.message).toMatch(/Ana Pérez con Carla/);
  });

  it("lo del negocio (Paso 4) no toca lo de Carla", async () => {
    const d = nextDay();
    await connect(carla, CARLA_MAIL);
    busyIn(CARLA_MAIL, d.at("10:00"), d.at("11:00"));
    await staffBusy.syncStaffBusy(org, carla);
    await orgBusy.clearGoogleBusyBlocks(org);
    expect(await staffBlocks(carla)).toHaveLength(1);
  });

  /* ---------- limpieza ---------- */

  it("desactivar a Carla: revoca su permiso, borra su conexión y SUS bloqueos; lo de Beto sigue", async () => {
    const d = nextDay();
    await connect(carla, CARLA_MAIL);
    await connect(beto, BETO_MAIL);
    busyIn(CARLA_MAIL, d.at("10:00"), d.at("11:00"));
    busyIn(BETO_MAIL, d.at("12:00"), d.at("13:00"));
    await staffBusy.syncStaffBusy(org, carla);
    await staffBusy.syncStaffBusy(org, beto);

    await staffSvc.updateStaff(org, carla, { active: false });
    expect(await connRow(carla)).toBeUndefined();
    expect(await staffBlocks(carla)).toHaveLength(0);
    expect(mockState.googleMockState().revoked).toContain(mockState.mockStaffRefreshToken(CARLA_MAIL));
    expect(await staffBlocks(beto)).toHaveLength(1);
    expect(await orphanBlocks()).toHaveLength(0);
  });

  it("borrar a Beto NO deja sus bloqueos bloqueando a todo el negocio", async () => {
    const d = nextDay();
    await connect(beto, BETO_MAIL);
    busyIn(BETO_MAIL, d.at("10:00"), d.at("11:00"));
    await staffBusy.syncStaffBusy(org, beto);
    expect(await staffBlocks(beto)).toHaveLength(1);

    await staffSvc.deleteStaff(org, beto);
    expect(await orphanBlocks()).toHaveLength(0);
    expect(await offered(d.date)).toContain(d.at("10:00")); // Carla atiende
    expect(mockState.googleMockState().revoked).toContain(mockState.mockStaffRefreshToken(BETO_MAIL));
  });

  /* ---------- degradación ---------- */

  it("permiso revocado: su conexión queda «se perdió», se conservan sus bloqueos, un aviso y el barrido no insiste", async () => {
    const d = nextDay();
    await connect(carla, CARLA_MAIL);
    busyIn(CARLA_MAIL, d.at("10:00"), d.at("11:00"));
    await staffBusy.syncStaffBusy(org, carla);

    await connect(carla, `${CARLA_MAIL}-invalid`);
    expect(await staffBusy.syncStaffBusy(org, carla)).toMatchObject({ outcome: "auth_error" });
    expect(await connRow(carla)).toMatchObject({ status: "error", busyNextAt: null });
    expect(await staffBlocks(carla)).toHaveLength(1);
    expect(await offered(d.date, carla)).not.toContain(d.at("10:00"));

    googleCalls.length = 0;
    await staffBusy.sweepStaffBusy(new Date(Date.now() + 3_600_000));
    expect(googleCalls).toHaveLength(0);
    await staffBusy.syncStaffBusy(org, carla);
    expect(await avisos("Se perdió el Google Calendar de Carla")).toHaveLength(1);
  });

  it("Google caído: error con reintento y se conserva lo último leído", async () => {
    const d = nextDay();
    await connect(carla, CARLA_MAIL);
    busyIn(CARLA_MAIL, d.at("10:00"), d.at("11:00"));
    await staffBusy.syncStaffBusy(org, carla);
    mockState.googleMockState().external.length = 0;
    mockState.googleMockState().failNext = { status: 503, count: 1 };
    expect(await staffBusy.syncStaffBusy(org, carla)).toMatchObject({ outcome: "error" });
    expect(await staffBlocks(carla)).toHaveLength(1);
    expect(await connRow(carla)).toMatchObject({ busyStatus: "error", busyAttempts: 1, status: "connected" });
  });
});
