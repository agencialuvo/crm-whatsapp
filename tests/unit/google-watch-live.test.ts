import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Mejora 4 — Avisos al instante de Google Calendar, contra PostgreSQL REAL (`pnpm test:db`), con el mock de Google
 * en proceso: el mock abre canales, los cierra y MANDA los avisos al webhook real (con los encabezados de Google),
 * que dispara la lectura de siempre.
 *
 * Organización PROPIA con la lectura de lo ocupado encendida y Carla (Mejora 3). Cubre: alta de canales por cada
 * calendario leído; cambiar los calendarios abre y cierra los que tocan; un cambio en Google llega como bloqueo
 * SIN «Leer ahora»; el aviso de lo publicado por Vocero no escribe nada (anti-bucle); renovación con solapamiento;
 * Google rechaza el canal (se reintenta con espera y la lectura sigue); calendario sin avisos (permanente); apagar
 * la lectura y desconectar detienen los canales ANTES de revocar; el canal de Carla lee SOLO lo suyo; desactivar o
 * borrar a Carla detiene sus canales; permiso perdido detiene los canales; un aviso falso no lee nada.
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
const H = 3_600_000;

describe.skipIf(!live)("avisos al instante de Google Calendar, contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let isNull: (typeof import("drizzle-orm"))["isNull"];
  let orgBusy: typeof import("@/server/agenda/calendar-busy/sync");
  let conn: typeof import("@/server/agenda/staff-calendar/connection");
  let staffBusy: typeof import("@/server/agenda/staff-calendar/busy");
  let staffSvc: typeof import("@/server/business/staff");
  let creds: typeof import("@/server/agenda/connectors/google-credentials");
  let reconcile: typeof import("@/server/agenda/calendar-watch/reconcile");
  let notify: typeof import("@/server/agenda/calendar-watch/notify");
  let watchLib: typeof import("@/lib/google-watch");
  let mockState: typeof import("@/server/dev/google-mock-state");
  let mockRoute: typeof import("@/app/api/dev/google-mock/[...path]/route");
  let webhook: typeof import("@/app/api/webhooks/google-calendar/route");

  const tag = Date.now().toString(36);
  const org = `org_gw_${tag}`;
  const carla = `stf_gwcarla_${tag}`;
  const realFetch = globalThis.fetch;
  const googleCalls: { method: string; path: string; auth: string }[] = [];
  const webhookHits: number[] = [];
  /** Orden de lo que pasó en Google: detener canales y revocar permisos. */
  const timeline: string[] = [];

  beforeAll(async () => {
    process.env.GOOGLE_CAL_BASE_URL = CAL_BASE;
    process.env.GOOGLE_OAUTH_BASE_URL = OAUTH_BASE;
    process.env.GOOGLE_ACCOUNTS_BASE_URL = ACCOUNTS_BASE;
    process.env.WA_MOCK_ENABLED = "true";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "cid-instancia";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csec-instancia";
    process.env.GOOGLE_STAFF_CALENDARS = "on";
    process.env.GOOGLE_CALENDAR_WATCH = "on";
    process.env.AGENDA = "on";
    process.env.SALON = "on";
    ({ eq, and, isNull } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    orgBusy = await import("@/server/agenda/calendar-busy/sync");
    conn = await import("@/server/agenda/staff-calendar/connection");
    staffBusy = await import("@/server/agenda/staff-calendar/busy");
    staffSvc = await import("@/server/business/staff");
    creds = await import("@/server/agenda/connectors/google-credentials");
    reconcile = await import("@/server/agenda/calendar-watch/reconcile");
    notify = await import("@/server/agenda/calendar-watch/notify");
    watchLib = await import("@/lib/google-watch");
    mockState = await import("@/server/dev/google-mock-state");
    mockRoute = await import("@/app/api/dev/google-mock/[...path]/route");
    webhook = await import("@/app/api/webhooks/google-calendar/route");

    const all = [{ start: "09:00", end: "18:00" }];
    await db.insert(schema.organization).values({ id: org, name: `Barbería ${tag}`, slug: `gw-${tag}` });
    await db.insert(schema.calendarSettings).values({
      id: `cal_gw_${tag}`,
      organizationId: org,
      weeklyHours: { mon: all, tue: all, wed: all, thu: all, fri: all, sat: all, sun: all },
      slotMinutes: 30,
      minNoticeHours: 0,
      maxDaysAhead: 30,
      timezone: TZ,
      connector: "enlace-fijo",
      googleBusy: true,
    });
  });

  beforeEach(async () => {
    mockState.resetGoogleMock();
    notify.resetWatchReadsForTests();
    notify.setWatchMinGapForTests(0);
    googleCalls.length = 0;
    webhookHits.length = 0;
    timeline.length = 0;
    creds.clearGoogleTokenCache();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      // El aviso de Google llega al webhook REAL.
      if (url.endsWith(watchLib.WATCH_WEBHOOK_PATH)) {
        const res = await webhook.POST(new Request(url, { method: "POST", headers: init?.headers }));
        webhookHits.push(res.status);
        return res;
      }
      const base = [CAL_BASE, OAUTH_BASE, ACCOUNTS_BASE].find((b) => url.startsWith(b));
      if (!base) return realFetch(input, init);
      const u = new URL(url);
      const path = u.pathname.slice(new URL(base).pathname.length).split("/").filter(Boolean).map(decodeURIComponent);
      const method = init?.method ?? "GET";
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      googleCalls.push({ method, path: `/${path.join("/")}${u.search}`, auth });
      if (path.join("/") === "channels/stop") timeline.push(`stop:${auth.includes(".staff|") ? "staff" : "negocio"}`);
      if (path.join("/") === "revoke") timeline.push("revoke");
      const req = new Request(url, { method, headers: init?.headers, body: init?.body ?? undefined });
      const ctx = { params: Promise.resolve({ path }) };
      const handler = { GET: mockRoute.GET, POST: mockRoute.POST, PATCH: mockRoute.PATCH, DELETE: mockRoute.DELETE }[method];
      return handler ? handler(req, ctx) : new Response(null, { status: 405 });
    }) as typeof fetch;

    await db.delete(schema.googleWatchChannel).where(eq(schema.googleWatchChannel.organizationId, org));
    await db.delete(schema.booking).where(eq(schema.booking.organizationId, org));
    await db.delete(schema.staff).where(eq(schema.staff.organizationId, org));
    await db.update(schema.calendarSettings).set({ googleBusy: true }).where(eq(schema.calendarSettings.organizationId, org));
    await creds.saveGoogleCredentials({ organizationId: org, clientId: "cid", clientSecret: "csec", refreshToken: "rt-bueno" });
    await db
      .update(schema.googleCredentials)
      .set({ busyCalendars: null, busyStatus: null, status: "connected" })
      .where(eq(schema.googleCredentials.organizationId, org));
    await db.insert(schema.staff).values({ id: carla, organizationId: org, name: "Carla", phone: "51911111111" });
  });

  afterEach(async () => {
    await settle();
    globalThis.fetch = realFetch;
    notify.setWatchMinGapForTests(undefined);
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, org));
  });

  /** Espera a que no quede nada en vuelo: altas de canal, avisos y lecturas. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await reconcile.waitForWatchReconcileIdle();
      await notify.waitForWatchReadsIdle();
      await orgBusy.waitForBusySyncIdle();
      await staffBusy.waitForStaffBusyIdle();
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  const channels = () =>
    db.select().from(schema.googleWatchChannel).where(eq(schema.googleWatchChannel.organizationId, org));
  const mockChannels = () => mockState.googleMockState().channels;
  const watchCalls = () => googleCalls.filter((c) => c.path.endsWith("/events/watch"));
  const googleBlocks = (staffId: string | null) =>
    db
      .select()
      .from(schema.booking)
      .where(
        and(
          eq(schema.booking.organizationId, org),
          eq(schema.booking.busySource, "google"),
          staffId === null ? isNull(schema.booking.staffId) : eq(schema.booking.staffId, staffId)
        )
      );
  const tomorrowAt = (hh: number) => {
    const d = new Date(Date.now() + 2 * 24 * H);
    d.setUTCHours(hh + 5, 0, 0, 0); // hh en Lima
    return d.toISOString();
  };
  const external = async (events: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
    const res = await mockRoute.POST(
      new Request(`${CAL_BASE}/_external`, { method: "POST", body: JSON.stringify({ events, replace: true, ...extra }) }),
      { params: Promise.resolve({ path: ["_external"] }) }
    );
    return (await res.json()) as { notified: number };
  };
  const connectCarla = async () => {
    await conn.saveStaffConnection({
      organizationId: org,
      staffId: carla,
      refreshToken: mockState.mockStaffRefreshToken(CARLA_MAIL),
      accountEmail: CARLA_MAIL,
      grantedScopes: "https://www.googleapis.com/auth/calendar.events.readonly",
    });
  };

  it("se abre un canal por cada calendario leído, con el token del canal y vencimiento a 7 días", async () => {
    await reconcile.reconcileWatches(org);
    await settle();
    const rows = await channels();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ status: "active", staffId: null, calendarId: "primary", attempts: 0 });
    expect(row!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * H);
    const [mc] = mockChannels();
    expect(mc).toMatchObject({ id: row!.channelId, resourceId: row!.resourceId, stopped: false });
    expect(mc!.token).toBe(watchLib.channelToken(process.env.BETTER_AUTH_SECRET!, row!.channelId));
    expect(mc!.address.endsWith("/api/webhooks/google-calendar")).toBe(true);
    // El primer aviso (`sync`) llegó y se aceptó, sin lecturas.
    expect(webhookHits).toContain(200);
    // Ya sano: otra pasada no pide nada.
    googleCalls.length = 0;
    await reconcile.reconcileWatches(org);
    expect(watchCalls()).toHaveLength(0);
  });

  it("un cambio en Google llega como bloqueo SIN «Leer ahora»; lo publicado por Vocero no escribe nada", async () => {
    await reconcile.reconcileWatches(org);
    await settle();
    const before = googleCalls.filter((c) => c.method === "GET" && c.path.startsWith("/calendars/primary/events?")).length;
    const out = await external([{ id: "dentista", start: { dateTime: tomorrowAt(10) }, end: { dateTime: tomorrowAt(11) } }]);
    expect(out.notified).toBe(1);
    await settle();
    expect(googleCalls.filter((c) => c.method === "GET" && c.path.startsWith("/calendars/primary/events?")).length).toBe(before + 1);
    expect(await googleBlocks(null)).toHaveLength(1);

    // Anti-bucle: un evento de Vocero (con su marca) avisa, se lee y NO se escribe nada.
    const ids = (await googleBlocks(null)).map((b) => b.id);
    await external([
      { id: "dentista", start: { dateTime: tomorrowAt(10) }, end: { dateTime: tomorrowAt(11) } },
      {
        id: "evento-vocero",
        start: { dateTime: tomorrowAt(14) },
        end: { dateTime: tomorrowAt(15) },
        extendedProperties: { private: { voceroBookingId: "bk_x", voceroOrg: org } },
      },
    ]);
    await settle();
    expect((await googleBlocks(null)).map((b) => b.id)).toEqual(ids);
  });

  it("cambiar los calendarios leídos abre los nuevos y cierra los que sobran", async () => {
    await db
      .update(schema.googleCredentials)
      .set({ busyCalendars: [{ id: "primary", summary: "Principal" }, { id: "equipo@group.calendar.mock", summary: "Equipo" }] })
      .where(eq(schema.googleCredentials.organizationId, org));
    await reconcile.reconcileWatches(org);
    await settle();
    expect((await channels()).map((r) => r.calendarId).sort()).toEqual(["equipo@group.calendar.mock", "primary"]);

    await db
      .update(schema.googleCredentials)
      .set({ busyCalendars: [{ id: "equipo@group.calendar.mock", summary: "Equipo" }] })
      .where(eq(schema.googleCredentials.organizationId, org));
    await reconcile.reconcileWatches(org);
    await settle();
    expect((await channels()).map((r) => r.calendarId)).toEqual(["equipo@group.calendar.mock"]);
    expect(mockChannels().filter((c) => !c.stopped).map((c) => c.calendarId)).toEqual(["equipo@group.calendar.mock"]);
  });

  it("renovación con solapamiento: a < 24 h se abre otro y el viejo se cierra cuando el nuevo responde", async () => {
    await reconcile.reconcileWatches(org);
    await settle();
    const [old] = await channels();
    await db
      .update(schema.googleWatchChannel)
      .set({ expiresAt: new Date(Date.now() + 2 * H) })
      .where(eq(schema.googleWatchChannel.id, old!.id));
    await reconcile.reconcileWatches(org);
    await settle();
    // Los dos a la vez: el viejo sigue vivo mientras el nuevo arranca.
    const both = await channels();
    expect(both).toHaveLength(2);
    expect(mockChannels().filter((c) => !c.stopped)).toHaveLength(2);
    await reconcile.reconcileWatches(org);
    await settle();
    const after = await channels();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(old!.id);
    expect(mockChannels().find((c) => c.id === old!.channelId)?.stopped).toBe(true);
  });

  it("Google rechaza el canal: espera y reintenta; la lectura de cada 5 min sigue", async () => {
    mockState.googleMockState().failWatch = { status: 500, count: 1 };
    await reconcile.reconcileWatches(org);
    await settle();
    const [failed] = await channels();
    expect(failed).toMatchObject({ status: "failed", attempts: 1 });
    expect(failed!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    googleCalls.length = 0;
    await reconcile.reconcileWatches(org);
    expect(watchCalls()).toHaveLength(0); // aún en espera
    expect((await orgBusy.syncGoogleBusy(org)).outcome).toBe("synced");
    // Llega su turno: se reintenta reusando la fila.
    await db.update(schema.googleWatchChannel).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(schema.googleWatchChannel.id, failed!.id));
    await reconcile.reconcileWatches(org);
    await settle();
    const [ok] = await channels();
    expect(ok).toMatchObject({ id: failed!.id, status: "active", attempts: 0, lastError: null });
    expect((await reconcile.getWatchStatuses(org)).business).toEqual({ status: "active" });
  });

  it("un calendario que no admite avisos queda «fallido» 6 h sin insistir", async () => {
    mockState.googleMockState().watchUnsupported = [mockState.MOCK_PRIMARY_CALENDAR];
    await reconcile.reconcileWatches(org);
    await settle();
    const [row] = await channels();
    expect(row!.status).toBe("failed");
    expect(row!.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(5.9 * H);
    expect((await reconcile.getWatchStatuses(org)).business.status).toBe("failed");
  });

  it("apagar la lectura detiene los canales; desconectar Google los detiene ANTES de revocar", async () => {
    await reconcile.reconcileWatches(org);
    await settle();
    await orgBusy.clearGoogleBusyBlocks(org);
    expect(await channels()).toHaveLength(0);
    expect(mockChannels().every((c) => c.stopped)).toBe(true);

    // Reencender y desconectar como lo hace la ruta (DELETE /api/settings/google).
    await reconcile.reconcileWatches(org);
    await settle();
    expect(await channels()).toHaveLength(1);
    timeline.length = 0;
    // La ruta exige sesión: se reproduce su orden con las mismas piezas (limpiar → revocar → borrar).
    const c = await creds.getGoogleCredentials(org);
    await orgBusy.clearGoogleBusyBlocks(org);
    const google = await import("@/server/agenda/google-oauth");
    await google.revokeToken(c!.refreshToken);
    expect(timeline).toEqual(["stop:negocio", "revoke"]);
  });

  it("permiso perdido (needs_reconnect): la siguiente pasada detiene sus canales", async () => {
    await reconcile.reconcileWatches(org);
    await settle();
    await db.update(schema.googleCredentials).set({ busyStatus: "needs_reconnect" }).where(eq(schema.googleCredentials.organizationId, org));
    await reconcile.reconcileWatches(org);
    await settle();
    expect(await channels()).toHaveLength(0);
    expect(mockChannels().every((c) => c.stopped)).toBe(true);
  });

  it("el canal de Carla: su aviso lee SOLO su calendario y la bloquea solo a ella", async () => {
    await connectCarla();
    await reconcile.reconcileWatches(org);
    await settle();
    const rows = await channels();
    expect(rows.map((r) => r.staffId ?? "negocio").sort()).toEqual([carla, "negocio"].sort());
    expect(mockChannels().find((c) => c.calendarId === CARLA_MAIL)).toBeTruthy();

    // Un evento en SU calendario: avisa solo a su canal.
    googleCalls.length = 0;
    const out = await external([{ id: "dentista-carla", calendarId: CARLA_MAIL, start: { dateTime: tomorrowAt(10) }, end: { dateTime: tomorrowAt(11) } }]);
    expect(out.notified).toBe(1);
    await settle();
    expect(await googleBlocks(carla)).toHaveLength(1);
    expect(await googleBlocks(null)).toHaveLength(0);
    // Solo se leyó con el token de Carla.
    const reads = googleCalls.filter((c) => c.method === "GET" && c.path.includes("/events?"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.auth.includes(`.staff|${CARLA_MAIL}`))).toBe(true);
    expect((await reconcile.getWatchStatuses(org)).staff.get(carla)).toEqual({ status: "active" });
  });

  it("desconectar a Carla detiene SU canal antes de revocar; el del negocio sigue", async () => {
    await connectCarla();
    await reconcile.reconcileWatches(org);
    await settle();
    timeline.length = 0;
    await conn.disconnectStaffCalendar(org, carla, { revoke: true });
    expect(timeline).toEqual(["stop:staff", "revoke"]);
    expect((await channels()).map((r) => r.staffId)).toEqual([null]);
    expect(mockChannels().find((c) => c.calendarId === CARLA_MAIL)?.stopped).toBe(true);
    expect(mockChannels().find((c) => c.calendarId === mockState.MOCK_PRIMARY_CALENDAR)?.stopped).toBe(false);
  });

  it("borrar a Carla detiene su canal en Google (sus filas se van con ella) y luego revoca", async () => {
    await connectCarla();
    await reconcile.reconcileWatches(org);
    await settle();
    timeline.length = 0;
    await staffSvc.deleteStaff(org, carla);
    expect(timeline).toEqual(["stop:staff", "revoke"]);
    expect((await channels()).every((r) => r.staffId === null)).toBe(true);
    expect(mockChannels().find((c) => c.calendarId === CARLA_MAIL)?.stopped).toBe(true);
  });

  it("desactivar a Carla también detiene su canal", async () => {
    await connectCarla();
    await reconcile.reconcileWatches(org);
    await settle();
    await staffSvc.updateStaff(org, carla, { active: false });
    await settle();
    expect((await channels()).some((r) => r.staffId === carla)).toBe(false);
    expect(mockChannels().find((c) => c.calendarId === CARLA_MAIL)?.stopped).toBe(true);
  });

  it("un aviso falso (token de otro canal) no lee nada; un canal ya detenido no se atiende", async () => {
    await reconcile.reconcileWatches(org);
    await settle();
    const [row] = await channels();
    const forged = await webhook.POST(
      new Request("https://x/api/webhooks/google-calendar", {
        method: "POST",
        headers: {
          "X-Goog-Channel-ID": row!.channelId,
          "X-Goog-Channel-Token": watchLib.channelToken(process.env.BETTER_AUTH_SECRET!, "otro-canal"),
          "X-Goog-Resource-ID": row!.resourceId!,
          "X-Goog-Resource-State": "exists",
        },
      })
    );
    expect(forged.status).toBe(404);
    await orgBusy.clearGoogleBusyBlocks(org);
    const stale = await webhook.POST(
      new Request("https://x/api/webhooks/google-calendar", {
        method: "POST",
        headers: {
          "X-Goog-Channel-ID": row!.channelId,
          "X-Goog-Channel-Token": watchLib.channelToken(process.env.BETTER_AUTH_SECRET!, row!.channelId),
          "X-Goog-Resource-ID": row!.resourceId!,
          "X-Goog-Resource-State": "exists",
        },
      })
    );
    expect(stale.status).toBe(404);
    await settle();
    expect(googleCalls.filter((c) => c.method === "GET" && c.path.includes("/events?"))).toHaveLength(0);
  });

  it("el barrido pone al día todos los negocios y respeta el tope de llamadas", async () => {
    await connectCarla();
    const out = await reconcile.sweepWatchChannels();
    await settle();
    expect(out.calls).toBeGreaterThanOrEqual(2);
    expect(out.calls).toBeLessThanOrEqual(20);
    expect((await channels()).filter((r) => r.status === "active")).toHaveLength(2);
  });
});
