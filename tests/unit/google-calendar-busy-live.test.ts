import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Paso 4 — Lo ocupado en Google Calendar → bloqueos de la agenda, contra PostgreSQL REAL (`pnpm test:db`).
 *
 * «Google» es el mock del self-test (`/api/dev/google-mock`), llamado en proceso como en la prueba del
 * Paso 3. Organización PROPIA (se borra al final, todo cae en cascada). Cubre: crear bloqueos y que la
 * disponibilidad deje de ofrecer esos horarios; anti-bucle (lo publicado por Vocero, con marca o con id
 * conocido, nunca bloquea); actualizar y limpiar (mover = mover el bloqueo; borrar = quitarlo; sin cambios =
 * cero escrituras); nunca pisar citas ni bloqueos propios (ni chocar con el índice único); días completos;
 * Google caído y lectura a medias (se conserva lo último leído); token revocado y permiso insuficiente
 * (pausa, un aviso, el barrido no insiste, reconectar retoma); los bloqueos de Google no se tocan desde
 * Vocero; apagar o desconectar quita solo lo de Google; apagar a mitad de una lectura no escribe.
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

describe.skipIf(!live)("Google Calendar: lo ocupado como bloqueos, contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let asc: (typeof import("drizzle-orm"))["asc"];
  let agenda: typeof import("@/server/agenda/service");
  let availability: typeof import("@/server/agenda/availability");
  let busy: typeof import("@/server/agenda/calendar-busy/sync");
  let calSync: typeof import("@/server/agenda/calendar-sync/sync");
  let creds: typeof import("@/server/agenda/connectors/google-credentials");
  let mockState: typeof import("@/server/dev/google-mock-state");
  let mockRoute: typeof import("@/app/api/dev/google-mock/[...path]/route");
  let slots: typeof import("@/lib/time/slots");
  let http: typeof import("@/server/agenda/http");

  const tag = Date.now().toString(36);
  const org = `org_gbusy_${tag}`;
  const contactId = `ct_gbusy_${tag}`;
  let dayOffset = 2;
  const realFetch = globalThis.fetch;
  const googleCalls: { method: string; path: string }[] = [];
  /** El N-ésimo listado de eventos (desde que se fija) responde 503: una lectura que se corta a la mitad. */
  let failListAt: number | null = null;
  let listCount = 0;
  /** Se ejecuta (una vez) en medio del siguiente listado. */
  let duringList: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    process.env.GOOGLE_CAL_BASE_URL = CAL_BASE;
    process.env.GOOGLE_OAUTH_BASE_URL = OAUTH_BASE;
    process.env.WA_MOCK_ENABLED = "true";
    ({ eq, and, asc } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    agenda = await import("@/server/agenda/service");
    availability = await import("@/server/agenda/availability");
    busy = await import("@/server/agenda/calendar-busy/sync");
    calSync = await import("@/server/agenda/calendar-sync/sync");
    creds = await import("@/server/agenda/connectors/google-credentials");
    mockState = await import("@/server/dev/google-mock-state");
    mockRoute = await import("@/app/api/dev/google-mock/[...path]/route");
    slots = await import("@/lib/time/slots");
    http = await import("@/server/agenda/http");

    const all = [{ start: "09:00", end: "18:00" }];
    await db.insert(schema.organization).values({ id: org, name: `GBusy ${tag}`, slug: `gbusy-${tag}` });
    await db.insert(schema.calendarSettings).values({
      id: `cal_gb_${tag}`,
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
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Ana Pérez", waIdentity: `gbusy-${tag}`, phone: "51999000111" });
    await creds.saveGoogleCredentials({ organizationId: org, clientId: "cid", clientSecret: "csec", refreshToken: "rt-bueno" });
  });

  beforeEach(async () => {
    mockState.resetGoogleMock();
    googleCalls.length = 0;
    failListAt = null;
    listCount = 0;
    duringList = null;
    creds.clearGoogleTokenCache();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const base = url.startsWith(CAL_BASE) ? CAL_BASE : url.startsWith(OAUTH_BASE) ? OAUTH_BASE : null;
      if (!base) return realFetch(input, init);
      const u = new URL(url);
      const path = u.pathname.slice(new URL(base).pathname.length).split("/").filter(Boolean).map(decodeURIComponent);
      const method = init?.method ?? "GET";
      googleCalls.push({ method, path: `/${path.join("/")}${u.search}` });
      if (method === "GET" && path.length === 3 && path[2] === "events") {
        listCount += 1;
        if (failListAt !== null && listCount === failListAt) return new Response("{}", { status: 503 });
        if (duringList) {
          const hook = duringList;
          duringList = null;
          await hook();
        }
      }
      const req = new Request(url, { method, headers: init?.headers, body: init?.body ?? undefined });
      const ctx = { params: Promise.resolve({ path }) };
      const handler = { GET: mockRoute.GET, POST: mockRoute.POST, PATCH: mockRoute.PATCH, DELETE: mockRoute.DELETE }[method];
      return handler ? handler(req, ctx) : new Response(null, { status: 405 });
    }) as typeof fetch;
    // Cada prueba empieza sin bloqueos de Google, con la lectura encendida y la conexión sana.
    await setSettings({ googleBusy: true });
    await busy.clearGoogleBusyBlocks(org);
  });

  afterEach(async () => {
    await busy.waitForBusySyncIdle();
    await calSync.waitForCalendarSyncIdle();
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, org));
  });

  /* ---------- ayudas ---------- */

  /** Un día nuevo (más adelante cada vez) y sus instantes en la zona del negocio. */
  function nextDay(): { date: string; at: (hhmm: string) => string } {
    const date = slots.addDaysISO(slots.todayInTz(new Date(), TZ), dayOffset++);
    return { date, at: (hhmm) => slots.zonedWallClockToUtc(date, hhmm, TZ)!.toISOString() };
  }
  const setSettings = (set: Partial<typeof schema.calendarSettings.$inferInsert>) =>
    db.update(schema.calendarSettings).set(set).where(eq(schema.calendarSettings.organizationId, org));
  const external = (events: import("@/server/dev/google-mock-state").MockExternalEvent[]) => {
    const s = mockState.googleMockState();
    s.external.length = 0;
    s.external.push(...events);
  };
  const ev = (id: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
    id,
    start: { dateTime: start },
    end: { dateTime: end },
    ...extra,
  });
  const googleBlocks = () =>
    db
      .select()
      .from(schema.booking)
      .where(and(eq(schema.booking.organizationId, org), eq(schema.booking.busySource, "google")))
      .orderBy(asc(schema.booking.scheduledAt));
  const credRow = async () =>
    (await db.select().from(schema.googleCredentials).where(eq(schema.googleCredentials.organizationId, org)))[0]!;
  const bookingRow = async (id: string) => (await db.select().from(schema.booking).where(eq(schema.booking.id, id)))[0]!;
  const book = (startUtc: string) =>
    agenda.createSessionBooking({ organizationId: org, contactId, startUtc, source: "manual", requireOffer: false });
  const offered = async (date: string) =>
    (await availability.computeAvailability(org, { fromISO: date, toISO: date })).map((s) => s.startUtc);
  const avisos = async (title: string) =>
    db.select().from(schema.notifications).where(and(eq(schema.notifications.organizationId, org), eq(schema.notifications.title, title)));
  const listCalls = () => googleCalls.filter((c) => c.method === "GET" && /^\/calendars\/[^/]+\/events\?/.test(c.path));

  /* ---------- crear ---------- */

  it("crea bloqueos de lo ocupado y la disponibilidad deja de ofrecer esos horarios; lo de Vocero se ignora", async () => {
    const d = nextDay();
    // Una cita publicada por la sincronización del Paso 3 (lleva la marca de Vocero).
    const cita = await book(d.at("10:00"));
    await calSync.waitForCalendarSyncIdle();
    expect((await bookingRow(cita.booking.id)).calendarSyncStatus).toBe("synced");
    // Un Meet de antes del Paso 3: sin marca, pero la cita guardó su id.
    const legacyId = `bk_legacy_${tag}`;
    await db.insert(schema.booking).values({
      id: legacyId,
      organizationId: org,
      kind: "session",
      contactId,
      scheduledAt: new Date(d.at("15:00")),
      durationMinutes: 60,
      connector: "google",
      externalRef: "meet_legacy_evt",
    });
    external([
      ev("meet_legacy_evt", d.at("15:00"), d.at("16:00")),
      ev("otro_vocero", d.at("16:00"), d.at("17:00"), { extendedProperties: { private: { voceroOrg: "org_de_otra_instancia" } } }),
      ev("dentista", d.at("11:00"), d.at("12:00")),
      ev("libre", d.at("13:00"), d.at("14:00"), { transparency: "transparent" }),
    ]);

    const out = await busy.syncGoogleBusy(org);
    expect(out).toMatchObject({ outcome: "synced", blocks: 1, inserted: 1, deleted: 0 });

    const blocks = await googleBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "block",
      status: "agendada",
      busySource: "google",
      durationMinutes: 60,
      notes: busy.GOOGLE_BUSY_NOTE,
      contactId: null,
      calendarSyncStatus: null,
    });
    expect(blocks[0]!.scheduledAt.toISOString()).toBe(d.at("11:00"));

    // La disponibilidad (que solo lee la base) ya no ofrece 11:00 ni 11:30; sí 12:00 y lo «Disponible».
    const offers = await offered(d.date);
    expect(offers).not.toContain(d.at("11:00"));
    expect(offers).not.toContain(d.at("11:30"));
    expect(offers).toContain(d.at("12:00"));
    expect(offers).toContain(d.at("13:00"));
    // Y reservar encima se rechaza al confirmar.
    await expect(book(d.at("11:00"))).rejects.toMatchObject({ code: "slot_taken" });

    // El estado para Ajustes.
    expect(await busy.getBusyState(org)).toMatchObject({ status: "ok", error: null, blocks: 1 });
    // Un bloqueo de Google no se publica de vuelta en Google (no hay bucle hacia fuera tampoco).
    expect(mockState.googleMockState().events.size).toBe(1);
  });

  /* ---------- actualizar y limpiar ---------- */

  it("sin cambios no escribe; mover el evento mueve el bloqueo; borrarlo lo quita", async () => {
    const d = nextDay();
    external([ev("reunion", d.at("10:00"), d.at("11:00"))]);
    await busy.syncGoogleBusy(org);
    const [first] = await googleBlocks();

    expect(await busy.syncGoogleBusy(org)).toMatchObject({ outcome: "synced", inserted: 0, deleted: 0 });
    expect((await googleBlocks()).map((b) => b.id)).toEqual([first!.id]);

    external([ev("reunion", d.at("14:00"), d.at("15:30"))]);
    expect(await busy.syncGoogleBusy(org)).toMatchObject({ inserted: 1, deleted: 1 });
    const moved = await googleBlocks();
    expect(moved).toHaveLength(1);
    expect(moved[0]!.scheduledAt.toISOString()).toBe(d.at("14:00"));
    expect(moved[0]!.durationMinutes).toBe(90);
    expect(await offered(d.date)).toContain(d.at("10:00"));

    external([]);
    expect(await busy.syncGoogleBusy(org)).toMatchObject({ blocks: 0, deleted: 1 });
    expect(await googleBlocks()).toHaveLength(0);
    expect(await offered(d.date)).toContain(d.at("14:00"));
  });

  it("nunca pisa lo del negocio: cita y bloqueo propio a la misma hora conviven, y limpiar no los toca", async () => {
    const d = nextDay();
    const manual = await agenda.createBlock({ organizationId: org, startUtc: d.at("10:00"), durationMinutes: 60, notes: "Almuerzo" });
    const cita = await book(d.at("12:00"));
    // Lo ocupado en Google EMPIEZA a la misma hora que ambos (el índice único los dejaría chocar).
    external([ev("g1", d.at("10:00"), d.at("11:00")), ev("g2", d.at("12:00"), d.at("13:00"))]);
    expect(await busy.syncGoogleBusy(org)).toMatchObject({ outcome: "synced", blocks: 2 });

    external([]);
    await busy.syncGoogleBusy(org);
    expect(await googleBlocks()).toHaveLength(0);
    expect(await bookingRow(manual.id)).toMatchObject({ status: "agendada", busySource: null });
    expect(await bookingRow(cita.booking.id)).toMatchObject({ status: "agendada", busySource: null });
  });

  it("un evento de varios días completos deja un bloqueo por día, de medianoche a medianoche", async () => {
    const d1 = nextDay();
    nextDay();
    const d3 = nextDay();
    external([{ id: "vacaciones", start: { date: d1.date }, end: { date: d3.date } }]);
    expect(await busy.syncGoogleBusy(org)).toMatchObject({ blocks: 2 });
    const blocks = await googleBlocks();
    expect(blocks.map((b) => [b.scheduledAt.toISOString(), b.durationMinutes])).toEqual([
      [d1.at("00:00"), 1440],
      [slots.zonedWallClockToUtc(slots.addDaysISO(d1.date, 1), "00:00", TZ)!.toISOString(), 1440],
    ]);
    expect(await offered(d1.date)).toEqual([]);
    expect(await offered(d3.date)).not.toEqual([]);
  });

  /* ---------- degradación ---------- */

  it("Google caído: la agenda conserva lo último leído, queda «error» y se reintenta sola", async () => {
    const d = nextDay();
    external([ev("g", d.at("10:00"), d.at("11:00"))]);
    await busy.syncGoogleBusy(org);
    const before = await googleBlocks();

    external([]);
    mockState.googleMockState().failNext = { status: 503, count: 1 };
    const t0 = Date.now();
    expect(await busy.syncGoogleBusy(org)).toMatchObject({ outcome: "error" });
    expect((await googleBlocks()).map((b) => b.id)).toEqual(before.map((b) => b.id));
    const row = await credRow();
    expect(row).toMatchObject({ busyStatus: "error", busyAttempts: 1, status: "connected" });
    expect(row.busyError).toMatch(/503/);
    expect(row.busyNextAt!.getTime()).toBeGreaterThanOrEqual(t0 + 55_000);
    expect(row.busyNextAt!.getTime()).toBeLessThanOrEqual(Date.now() + 65_000);

    // El barrido lo retoma cuando toca y se recupera.
    await busy.sweepGoogleBusy(new Date(Date.now() + 2 * 60_000));
    expect(await credRow()).toMatchObject({ busyStatus: "ok", busyAttempts: 0, busyError: null });
    expect(await googleBlocks()).toHaveLength(0);
  });

  it("una lectura que se corta a la mitad (una página falla) no aplica nada", async () => {
    const d = nextDay();
    external([ev("a", d.at("09:00"), d.at("10:00")), ev("b", d.at("11:00"), d.at("12:00")), ev("c", d.at("14:00"), d.at("15:00"))]);
    mockState.googleMockState().pageSize = 1;
    expect(await busy.syncGoogleBusy(org)).toMatchObject({ outcome: "synced", blocks: 3 });
    expect(listCalls().length).toBe(3);

    external([ev("a", d.at("09:00"), d.at("10:00")), ev("b", d.at("11:00"), d.at("12:00"))]);
    listCount = 0;
    failListAt = 2;
    expect(await busy.syncGoogleBusy(org)).toMatchObject({ outcome: "error" });
    // Con la página 1 sola, «c» habría desaparecido: no se tocó.
    expect(await googleBlocks()).toHaveLength(3);
  });

  it("token revocado: se pausa, avisa UNA vez, conserva los bloqueos y el barrido no insiste; reconectar retoma", async () => {
    const d = nextDay();
    external([ev("g", d.at("10:00"), d.at("11:00"))]);
    await busy.syncGoogleBusy(org);
    expect(await googleBlocks()).toHaveLength(1);
    const title = "Google Calendar se desconectó";
    const prevAvisos = (await avisos(title)).length;

    await creds.saveGoogleCredentials({ organizationId: org, clientId: "cid", clientSecret: "csec", refreshToken: "rt-invalid" });
    try {
      expect(await busy.syncGoogleBusy(org)).toMatchObject({ outcome: "auth_error" });
      expect(await credRow()).toMatchObject({ status: "error", busyStatus: "error", busyNextAt: null });
      expect(await googleBlocks()).toHaveLength(1);
      expect(await offered(d.date)).not.toContain(d.at("10:00"));

      googleCalls.length = 0;
      expect(await busy.syncGoogleBusy(org)).toMatchObject({ outcome: "auth_error" });
      await busy.sweepGoogleBusy(new Date(Date.now() + 3_600_000));
      expect(googleCalls).toHaveLength(0);
      expect((await avisos(title)).length).toBe(prevAvisos + 1);
    } finally {
      await creds.saveGoogleCredentials({ organizationId: org, clientId: "cid", clientSecret: "csec", refreshToken: "rt-bueno" });
    }
    // Reconectar deja la lectura vencida: el barrido la hace ya.
    await busy.sweepGoogleBusy(new Date(Date.now() + 1000));
    expect(await credRow()).toMatchObject({ status: "connected", busyStatus: "ok" });
  });

  it("permiso insuficiente (403): pide reconectar, avisa una vez, el barrido lo salta y reconectar lo retoma", async () => {
    const d = nextDay();
    external([ev("g", d.at("10:00"), d.at("11:00"))]);
    await busy.syncGoogleBusy(org);
    const title = "Falta un permiso de Google Calendar";

    mockState.googleMockState().failNext = { status: 403, count: 10 };
    expect(await busy.syncGoogleBusy(org)).toMatchObject({ outcome: "needs_reconnect" });
    const row = await credRow();
    expect(row).toMatchObject({ busyStatus: "needs_reconnect", busyNextAt: null, status: "connected" });
    expect(row.busyError).toMatch(/permiso para leer/);
    expect(await googleBlocks()).toHaveLength(1);

    googleCalls.length = 0;
    await busy.sweepGoogleBusy(new Date(Date.now() + 3_600_000));
    expect(listCalls()).toHaveLength(0);
    // «Leer ahora» sí vuelve a intentar (por si ya se arregló); sigue sin permiso y no avisa de nuevo.
    expect(await busy.syncGoogleBusy(org)).toMatchObject({ outcome: "needs_reconnect" });
    expect(await avisos(title)).toHaveLength(1);

    mockState.googleMockState().failNext = null;
    await creds.saveGoogleCredentials({ organizationId: org, clientId: "cid", clientSecret: "csec", refreshToken: "rt-bueno" });
    expect((await credRow()).busyStatus).toBeNull();
    await busy.sweepGoogleBusy(new Date(Date.now() + 1000));
    expect(await credRow()).toMatchObject({ busyStatus: "ok" });
  });

  /* ---------- los bloqueos de Google son de Google ---------- */

  it("un bloqueo de Google no se mueve, ni se quita, ni se cierra desde Vocero (409 external_block)", async () => {
    const d = nextDay();
    external([ev("g", d.at("10:00"), d.at("11:00"))]);
    await busy.syncGoogleBusy(org);
    const [b] = await googleBlocks();
    const id = b!.id;
    await expect(agenda.cancelBooking({ organizationId: org, bookingId: id })).rejects.toMatchObject({ code: "external_block" });
    await expect(agenda.rescheduleBooking({ organizationId: org, bookingId: id, startUtc: d.at("15:00") })).rejects.toMatchObject({ code: "external_block" });
    await expect(agenda.markBookingStatus({ organizationId: org, bookingId: id, status: "realizada" })).rejects.toMatchObject({ code: "external_block" });
    expect(http.bookingErrorStatus("external_block")).toBe(409);
    expect(await bookingRow(id)).toMatchObject({ status: "agendada", scheduledAt: new Date(d.at("10:00")) });
  });

  it("apagar la opción quita SOLO lo traído de Google, y apagada no se llama a Google", async () => {
    const d = nextDay();
    const manual = await agenda.createBlock({ organizationId: org, startUtc: d.at("15:00"), durationMinutes: 30 });
    external([ev("g", d.at("10:00"), d.at("11:00"))]);
    await busy.syncGoogleBusy(org);
    expect(await googleBlocks()).toHaveLength(1);

    await setSettings({ googleBusy: false });
    expect(await busy.clearGoogleBusyBlocks(org)).toBe(1);
    expect(await googleBlocks()).toHaveLength(0);
    expect(await bookingRow(manual.id)).toMatchObject({ status: "agendada" });
    expect(await credRow()).toMatchObject({ busyStatus: null, busyBlocks: 0 });

    googleCalls.length = 0;
    expect(await busy.syncGoogleBusy(org)).toEqual({ outcome: "disabled" });
    await busy.requestBusySync(org);
    await busy.sweepGoogleBusy(new Date(Date.now() + 3_600_000));
    await busy.waitForBusySyncIdle();
    expect(googleCalls).toHaveLength(0);
  });

  it("apagar la opción a MITAD de una lectura: esa lectura no escribe nada", async () => {
    const d = nextDay();
    external([ev("g", d.at("10:00"), d.at("11:00"))]);
    duringList = async () => {
      await setSettings({ googleBusy: false });
      await busy.clearGoogleBusyBlocks(org);
    };
    expect(await busy.syncGoogleBusy(org)).toEqual({ outcome: "disabled" });
    expect(await googleBlocks()).toHaveLength(0);
  });

  it("dos «Leer ahora» seguidos comparten la misma lectura (una sola llamada al listado)", async () => {
    const d = nextDay();
    external([ev("g", d.at("10:00"), d.at("11:00"))]);
    const [a, b] = await Promise.all([busy.syncGoogleBusy(org), busy.syncGoogleBusy(org)]);
    expect(a).toEqual(b);
    expect(listCalls()).toHaveLength(1);
    expect(await googleBlocks()).toHaveLength(1);
  });
});
