import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  busyRetryDelayMs,
  busyWindow,
  classifyEvent,
  computeBusyBlocks,
  diffBusyBlocks,
  isOwnEvent,
  isScopeError,
  mergeIntervals,
  splitByLocalDay,
  type GoogleBusyEvent,
} from "@/server/agenda/calendar-busy/intervals";

/**
 * Paso 4 — Lo ocupado en Google Calendar → bloqueos. La parte PURA (qué cuenta como ocupado, la regla
 * anti-bucle, la ventana, unir/partir tramos, qué cambiar en la base) y el listado del mock de Google.
 */

const TZ = "America/Lima"; // UTC−5, sin horario de verano
const iso = (s: string) => Date.parse(s);
const ctx = (own: string[] = []) => ({ timezone: TZ, ownEventIds: new Set(own) });
const timed = (id: string, start: string, end: string, extra: Partial<GoogleBusyEvent> = {}): GoogleBusyEvent => ({
  id,
  status: "confirmed",
  start: { dateTime: start },
  end: { dateTime: end },
  ...extra,
});

describe("classifyEvent: qué cuenta como ocupado", () => {
  it("un evento con hora, confirmado y «Ocupado», bloquea su tramo exacto", () => {
    const v = classifyEvent(timed("e1", "2026-12-01T10:00:00-05:00", "2026-12-01T11:30:00-05:00"), ctx());
    expect(v).toEqual({ busy: true, interval: { startMs: iso("2026-12-01T15:00:00Z"), endMs: iso("2026-12-01T16:30:00Z") } });
  });

  it("anti-bucle: lo que publicó Vocero NUNCA bloquea (marca de cita, marca de negocio o id conocido)", () => {
    const base = timed("x", "2026-12-01T10:00:00-05:00", "2026-12-01T11:00:00-05:00");
    expect(classifyEvent({ ...base, extendedProperties: { private: { voceroBookingId: "bk_1" } } }, ctx())).toEqual({ busy: false, reason: "own" });
    expect(classifyEvent({ ...base, extendedProperties: { private: { voceroOrg: "org_otro" } } }, ctx())).toEqual({ busy: false, reason: "own" });
    // Un Meet de antes del Paso 3 (sin marca): se reconoce por el id que guardó la cita.
    expect(classifyEvent({ ...base, id: "meet_viejo" }, ctx(["meet_viejo"]))).toEqual({ busy: false, reason: "own" });
    // La marca gana aunque el evento esté cancelado o sea de día completo.
    expect(isOwnEvent({ status: "cancelled", extendedProperties: { private: { voceroBookingId: "bk" } } }, new Set())).toBe(true);
  });

  it("no bloquean: cancelado, «Disponible», invitación rechazada, ubicación de trabajo, fechas rotas", () => {
    const base = timed("e", "2026-12-01T10:00:00-05:00", "2026-12-01T11:00:00-05:00");
    expect(classifyEvent({ ...base, status: "cancelled" }, ctx())).toMatchObject({ reason: "cancelled" });
    expect(classifyEvent({ ...base, transparency: "transparent" }, ctx())).toMatchObject({ reason: "free" });
    expect(classifyEvent({ ...base, attendees: [{ self: true, responseStatus: "declined" }] }, ctx())).toMatchObject({ reason: "declined" });
    expect(classifyEvent({ ...base, eventType: "workingLocation" }, ctx())).toMatchObject({ reason: "working_location" });
    expect(classifyEvent({ ...base, end: { dateTime: "2026-12-01T09:00:00-05:00" } }, ctx())).toMatchObject({ reason: "invalid" });
    expect(classifyEvent({ id: "sin-fechas" }, ctx())).toMatchObject({ reason: "invalid" });
  });

  it("sí bloquean: tentativo, invitación aceptada o pendiente, «Fuera de la oficina», «opaque» explícito", () => {
    const base = timed("e", "2026-12-01T10:00:00-05:00", "2026-12-01T11:00:00-05:00");
    expect(classifyEvent({ ...base, status: "tentative" }, ctx()).busy).toBe(true);
    expect(classifyEvent({ ...base, attendees: [{ self: true, responseStatus: "accepted" }] }, ctx()).busy).toBe(true);
    expect(classifyEvent({ ...base, attendees: [{ self: true, responseStatus: "needsAction" }] }, ctx()).busy).toBe(true);
    // Otro asistente rechazó: el dueño sigue ocupado.
    expect(classifyEvent({ ...base, attendees: [{ self: false, responseStatus: "declined" }] }, ctx()).busy).toBe(true);
    expect(classifyEvent({ ...base, eventType: "outOfOffice" }, ctx()).busy).toBe(true);
    expect(classifyEvent({ ...base, transparency: "opaque" }, ctx()).busy).toBe(true);
  });

  it("día completo: de medianoche a medianoche en la zona del NEGOCIO (fin exclusivo)", () => {
    const v = classifyEvent({ id: "vac", start: { date: "2026-12-24" }, end: { date: "2026-12-26" } }, ctx());
    expect(v).toEqual({ busy: true, interval: { startMs: iso("2026-12-24T05:00:00Z"), endMs: iso("2026-12-26T05:00:00Z") } });
  });
});

describe("busyWindow: qué se lee", () => {
  it("de la medianoche de hoy al final del último día reservable, en la zona del negocio", () => {
    const w = busyWindow(new Date("2026-12-01T20:00:00Z"), { timezone: TZ, maxDaysAhead: 7 });
    expect(new Date(w.startMs).toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(new Date(w.endMs).toISOString()).toBe("2026-12-09T05:00:00.000Z");
  });

  it("es la misma a cualquier hora del día (los bloqueos no «bailan» entre lecturas)", () => {
    const a = busyWindow(new Date("2026-12-01T05:00:00Z"), { timezone: TZ, maxDaysAhead: 3 });
    const b = busyWindow(new Date("2026-12-02T04:59:00Z"), { timezone: TZ, maxDaysAhead: 3 });
    expect(a).toEqual(b);
  });
});

describe("unir y partir tramos", () => {
  it("une los que se pisan o se tocan, y deja separados los que no", () => {
    expect(
      mergeIntervals([
        { startMs: 30, endMs: 40 },
        { startMs: 0, endMs: 10 },
        { startMs: 10, endMs: 20 },
        { startMs: 5, endMs: 15 },
      ])
    ).toEqual([
      { startMs: 0, endMs: 20 },
      { startMs: 30, endMs: 40 },
    ]);
  });

  it("parte en la medianoche del negocio: tres días = tres bloqueos", () => {
    const parts = splitByLocalDay({ startMs: iso("2026-12-24T20:00:00Z"), endMs: iso("2026-12-26T18:00:00Z") }, TZ);
    expect(parts.map((p) => [new Date(p.startMs).toISOString(), new Date(p.endMs).toISOString()])).toEqual([
      ["2026-12-24T20:00:00.000Z", "2026-12-25T05:00:00.000Z"],
      ["2026-12-25T05:00:00.000Z", "2026-12-26T05:00:00.000Z"],
      ["2026-12-26T05:00:00.000Z", "2026-12-26T18:00:00.000Z"],
    ]);
  });

  it("el día de 25 h del cambio de horario se parte en dos (ninguna pieza pasa de 24 h)", () => {
    const ny = "America/New_York"; // 2026-11-01: se atrasa la hora
    const parts = splitByLocalDay({ startMs: iso("2026-11-01T04:00:00Z"), endMs: iso("2026-11-02T05:00:00Z") }, ny);
    expect(parts.length).toBe(2);
    for (const p of parts) expect(p.endMs - p.startMs).toBeLessThanOrEqual(24 * 3_600_000);
    expect(parts[0]!.startMs).toBe(iso("2026-11-01T04:00:00Z"));
    expect(parts[1]!.endMs).toBe(iso("2026-11-02T05:00:00Z"));
  });
});

describe("computeBusyBlocks", () => {
  const window = busyWindow(new Date("2026-12-01T15:00:00Z"), { timezone: TZ, maxDaysAhead: 7 });

  it("une, recorta a la ventana, redondea a minutos HACIA FUERA e ignora lo propio y lo libre", () => {
    const out = computeBusyBlocks(
      [
        timed("a", "2026-12-02T10:00:20-05:00", "2026-12-02T11:00:00-05:00"),
        timed("b", "2026-12-02T10:30:00-05:00", "2026-12-02T12:00:10-05:00"),
        timed("propio", "2026-12-03T10:00:00-05:00", "2026-12-03T11:00:00-05:00", { extendedProperties: { private: { voceroBookingId: "bk" } } }),
        timed("libre", "2026-12-03T12:00:00-05:00", "2026-12-03T13:00:00-05:00", { transparency: "transparent" }),
        // Empezó ayer: cuenta desde la medianoche de hoy.
        timed("ayer", "2026-11-30T22:00:00-05:00", "2026-12-01T02:00:00-05:00"),
        // Más allá de la ventana: fuera.
        timed("lejos", "2026-12-20T10:00:00-05:00", "2026-12-20T11:00:00-05:00"),
      ],
      { timezone: TZ, window, ownEventIds: new Set() }
    );
    expect(out.blocks.map((b) => [new Date(b.startMs).toISOString(), new Date(b.endMs).toISOString()])).toEqual([
      ["2026-12-01T05:00:00.000Z", "2026-12-01T07:00:00.000Z"],
      ["2026-12-02T15:00:00.000Z", "2026-12-02T17:01:00.000Z"],
    ]);
    expect(out.ignored).toMatchObject({ own: 1, free: 1 });
    expect(out.counted).toBe(3);
  });

  it("sin eventos ⇒ sin bloqueos", () => {
    expect(computeBusyBlocks([], { timezone: TZ, window, ownEventIds: new Set() }).blocks).toEqual([]);
  });
});

describe("diffBusyBlocks: qué cambiar en la base", () => {
  const h = (n: number) => iso("2026-12-02T15:00:00Z") + n * 3_600_000;

  it("igual que lo leído ⇒ no se escribe nada", () => {
    const d = diffBusyBlocks([{ id: "b1", startMs: h(0), durationMinutes: 60 }], [{ startMs: h(0), endMs: h(1) }]);
    expect(d).toEqual({ toDelete: [], toInsert: [] });
  });

  it("un evento movido = borrar el viejo y crear el nuevo; uno que desapareció se borra", () => {
    const d = diffBusyBlocks(
      [
        { id: "movido", startMs: h(0), durationMinutes: 60 },
        { id: "se-fue", startMs: h(5), durationMinutes: 30 },
        { id: "igual", startMs: h(8), durationMinutes: 60 },
      ],
      [
        { startMs: h(1), endMs: h(2) },
        { startMs: h(8), endMs: h(9) },
      ]
    );
    expect(d.toDelete.sort()).toEqual(["movido", "se-fue"]);
    expect(d.toInsert).toEqual([{ startMs: h(1), endMs: h(2) }]);
  });

  it("un cambio de DURACIÓN también cuenta como cambio; un duplicado sobra", () => {
    const d = diffBusyBlocks(
      [
        { id: "a", startMs: h(0), durationMinutes: 60 },
        { id: "dup", startMs: h(0), durationMinutes: 60 },
        { id: "corto", startMs: h(3), durationMinutes: 30 },
      ],
      [
        { startMs: h(0), endMs: h(1) },
        { startMs: h(3), endMs: h(4) },
      ]
    );
    expect(d.toDelete.sort()).toEqual(["corto", "dup"]);
    expect(d.toInsert).toEqual([{ startMs: h(3), endMs: h(4) }]);
  });
});

describe("errores y esperas", () => {
  it("permiso insuficiente = 403 con «insufficient»/«scope»; otro 403 no", () => {
    expect(isScopeError(403, "Google respondió 403: Request had insufficient authentication scopes.")).toBe(true);
    expect(isScopeError(403, "ACCESS_TOKEN_SCOPE_INSUFFICIENT")).toBe(true);
    expect(isScopeError(403, "rateLimitExceeded")).toBe(false);
    expect(isScopeError(401, "insufficient")).toBe(false);
    expect(isScopeError(undefined, "insufficient")).toBe(false);
  });

  it("reintentos 1, 5, 15, 30 y 60 min, y se queda en 60 (leer nunca se rinde)", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(busyRetryDelayMs)).toEqual([60_000, 300_000, 900_000, 1_800_000, 3_600_000, 3_600_000, 3_600_000]);
  });
});

describe("mock de Google: el listado del calendario", () => {
  let route: typeof import("@/app/api/dev/google-mock/[...path]/route");
  let state: typeof import("@/server/dev/google-mock-state");
  const prev = process.env.WA_MOCK_ENABLED;
  const call = (method: "GET" | "POST", path: string, body?: unknown, auth = true) => {
    const url = `https://mock.test/${path}`;
    const req = new Request(url, {
      method,
      headers: auth ? { authorization: "Bearer google-token-de-mentira" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    return route[method](req, { params: Promise.resolve({ path: segs }) });
  };

  beforeAll(async () => {
    process.env.WA_MOCK_ENABLED = "true";
    route = await import("@/app/api/dev/google-mock/[...path]/route");
    state = await import("@/server/dev/google-mock-state");
  });
  afterAll(() => {
    process.env.WA_MOCK_ENABLED = prev;
  });
  beforeEach(() => state.resetGoogleMock());

  const seed = () =>
    call("POST", "_external", {
      events: [
        { id: "x1", start: { dateTime: "2026-12-02T10:00:00Z" }, end: { dateTime: "2026-12-02T11:00:00Z" } },
        { id: "x2", start: { dateTime: "2026-12-03T10:00:00Z" }, end: { dateTime: "2026-12-03T11:00:00Z" } },
        { id: "x3", start: { date: "2026-12-04" }, end: { date: "2026-12-05" } },
        { id: "x4", status: "cancelled", start: { dateTime: "2026-12-02T12:00:00Z" }, end: { dateTime: "2026-12-02T13:00:00Z" } },
      ],
    });

  it("filtra por ventana y no devuelve cancelados", async () => {
    await seed();
    const res = await call("GET", "calendars/primary/events?timeMin=2026-12-02T10:30:00Z&timeMax=2026-12-04T00:00:00Z");
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((e) => e.id)).toEqual(["x1", "x2"]);
  });

  it("pagina con `nextPageToken`", async () => {
    await seed();
    await call("POST", "_external", { pageSize: 2 });
    const p1 = (await (await call("GET", "calendars/primary/events?maxResults=250")).json()) as { items: { id: string }[]; nextPageToken?: string };
    expect(p1.items.map((e) => e.id)).toEqual(["x1", "x2"]);
    expect(p1.nextPageToken).toBe("2");
    const p2 = (await (await call("GET", `calendars/primary/events?pageToken=${p1.nextPageToken}`)).json()) as { items: { id: string }[]; nextPageToken?: string };
    expect(p2.items.map((e) => e.id)).toEqual(["x3"]);
    expect(p2.nextPageToken).toBeUndefined();
  });

  it("un 403 provocado trae el cuerpo de «permiso insuficiente»; sin token, 401", async () => {
    await call("POST", "_fail", { status: 403, count: 1 });
    const res = await call("GET", "calendars/primary/events");
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/insufficient authentication scopes/);
    expect((await call("GET", "calendars/primary/events", undefined, false)).status).toBe(401);
  });
});
