import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  channelToken,
  isPermanentWatchError,
  newChannelId,
  parseWatchHeaders,
  planWatchChanges,
  summarizeWatch,
  verifyChannelToken,
  WATCH_RENEW_BEFORE_MS,
  watchRetryDelayMs,
  watchUrlOk,
  type WatchChannelRow,
  type WatchTarget,
} from "@/lib/google-watch";
import { watchStatusText } from "@/lib/google-watch-status";
import { checkGoogleWatch } from "@/server/doctor/checks";

/**
 * Mejora 4 — Avisos al instante de Google Calendar: las reglas PURAS (token del canal, encabezados del aviso,
 * dirección https pública, qué canales crear / renovar con solapamiento / detener, el estado que ve el dueño),
 * la bandera y la comprobación de `pnpm doctor`.
 */

const SECRET = "secreto-de-prueba-123456";
const NOW = new Date("2026-12-01T12:00:00Z");
const H = 3_600_000;

describe("token del canal", () => {
  it("es un HMAC estable del channel_id; otro canal u otro secreto no sirve", () => {
    const id = newChannelId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newChannelId()).not.toBe(id);
    const t = channelToken(SECRET, id);
    expect(t.length).toBeLessThanOrEqual(256);
    expect(channelToken(SECRET, id)).toBe(t);
    expect(verifyChannelToken(SECRET, id, t)).toBe(true);
    expect(verifyChannelToken(SECRET, "otro-canal", t)).toBe(false);
    expect(verifyChannelToken("otro-secreto-123456", id, t)).toBe(false);
    expect(verifyChannelToken(SECRET, id, `${t}x`)).toBe(false); // otro largo: sin lanzar
    expect(verifyChannelToken(SECRET, id, null)).toBe(false);
    expect(verifyChannelToken(SECRET, id, "")).toBe(false);
  });
});

describe("encabezados del aviso", () => {
  const base = {
    "x-goog-channel-id": "canal_1",
    "x-goog-channel-token": "tok",
    "x-goog-resource-id": "res-1",
    "x-goog-resource-state": "exists",
    "x-goog-message-number": "7",
  };

  it("lee un aviso de Google", () => {
    expect(parseWatchHeaders(new Headers(base))).toEqual({
      channelId: "canal_1",
      token: "tok",
      resourceId: "res-1",
      state: "exists",
      messageNumber: "7",
    });
    expect(parseWatchHeaders(new Headers({ ...base, "x-goog-resource-state": "sync" }))?.state).toBe("sync");
  });

  it("rechaza lo que no parece de Google", () => {
    const without = (k: string) => {
      const h: Record<string, string> = { ...base };
      delete h[k];
      return new Headers(h);
    };
    expect(parseWatchHeaders(without("x-goog-channel-id"))).toBeNull();
    expect(parseWatchHeaders(without("x-goog-resource-id"))).toBeNull();
    expect(parseWatchHeaders(new Headers({ ...base, "x-goog-resource-state": "update" }))).toBeNull();
    expect(parseWatchHeaders(new Headers({ ...base, "x-goog-channel-id": "con espacio" }))).toBeNull();
    expect(parseWatchHeaders(new Headers({ ...base, "x-goog-channel-id": "x".repeat(65) }))).toBeNull();
    expect(parseWatchHeaders(new Headers({ ...base, "x-goog-message-number": "abc" }))).toBeNull();
    expect(parseWatchHeaders(new Headers({ ...base, "x-goog-channel-token": "t".repeat(257) }))).toBeNull();
    // Sin token se lee (y luego no pasa la verificación).
    expect(parseWatchHeaders(without("x-goog-channel-token"))?.token).toBeNull();
  });
});

describe("¿Google puede avisar a esta instancia?", () => {
  it("solo https con un dominio público", () => {
    expect(watchUrlOk("https://crm.ejemplo.com")).toBe("https://crm.ejemplo.com/api/webhooks/google-calendar");
    expect(watchUrlOk("https://crm.ejemplo.com/")).toBe("https://crm.ejemplo.com/api/webhooks/google-calendar");
    expect(watchUrlOk("https://ejemplo.com/vocero")).toBe("https://ejemplo.com/vocero/api/webhooks/google-calendar");
    for (const bad of [
      "http://crm.ejemplo.com",
      "https://localhost:3000",
      "https://127.0.0.1",
      "https://192.168.1.20",
      "https://8.8.8.8",
      "https://servidor",
      "https://crm.local",
      "https://usuario:clave@crm.ejemplo.com",
      "no es url",
      undefined,
    ]) {
      expect(watchUrlOk(bad), String(bad)).toBeNull();
    }
  });

  it("con los mocks (nunca en producción) se admite el origen local", () => {
    expect(watchUrlOk("http://localhost:3000", { allowLocal: true })).toBe("http://localhost:3000/api/webhooks/google-calendar");
    expect(watchUrlOk("ftp://localhost", { allowLocal: true })).toBeNull();
  });
});

describe("reintentos", () => {
  it("1 min → 5 → 15 → 60 → 6 h; un rechazo permanente, 6 h directo", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => watchRetryDelayMs(n))).toEqual([60_000, 300_000, 900_000, H, 6 * H, 6 * H]);
    expect(watchRetryDelayMs(1, true)).toBe(6 * H);
    expect(isPermanentWatchError(400, "pushNotSupportedForRequestedResource")).toBe(true);
    expect(isPermanentWatchError(401, "push.webhookUrlUnauthorized")).toBe(true);
    expect(isPermanentWatchError(500, "pushNotSupportedForRequestedResource")).toBe(false);
    expect(isPermanentWatchError(400, "otra cosa")).toBe(false);
  });
});

describe("qué canales crear, renovar o detener", () => {
  const biz = (calendarId = "primary"): WatchTarget => ({ organizationId: "org_a", staffId: null, calendarId });
  let n = 0;
  const row = (over: Partial<WatchChannelRow> = {}): WatchChannelRow => ({
    id: `gwc_${++n}`,
    organizationId: "org_a",
    staffId: null,
    calendarId: "primary",
    channelId: `ch_${n}`,
    resourceId: "res",
    status: "active",
    expiresAt: new Date(NOW.getTime() + 6 * 24 * H),
    attempts: 0,
    nextAttemptAt: null,
    createdAt: new Date(NOW.getTime() - H),
    ...over,
  });

  beforeEach(() => {
    n = 0;
  });

  it("sin canal: se crea; con uno sano: no se toca", () => {
    expect(planWatchChanges([biz()], [], NOW)).toEqual({ create: [{ target: biz(), retry: null }], stop: [] });
    expect(planWatchChanges([biz()], [row()], NOW)).toEqual({ create: [], stop: [] });
  });

  it("renovar con solapamiento: a < 24 h se pide otro y el viejo sigue; cuando el nuevo está, el viejo sobra", () => {
    const old = row({ expiresAt: new Date(NOW.getTime() + WATCH_RENEW_BEFORE_MS - 60_000) });
    expect(planWatchChanges([biz()], [old], NOW)).toEqual({ create: [{ target: biz(), retry: null }], stop: [] });
    // Recién pedido: se espera a Google, sin pedir otro.
    const pending = row({ status: "pending", resourceId: null, expiresAt: null, createdAt: new Date(NOW.getTime() - 60_000) });
    expect(planWatchChanges([biz()], [old, pending], NOW)).toEqual({ create: [], stop: [] });
    const fresh = row();
    expect(planWatchChanges([biz()], [old, fresh], NOW)).toEqual({ create: [], stop: [old] });
  });

  it("vencido o pedido que nunca se confirmó: se detiene y se pide otro", () => {
    const dead = row({ expiresAt: new Date(NOW.getTime() - 1) });
    const stale = row({ status: "pending", resourceId: null, expiresAt: null, createdAt: new Date(NOW.getTime() - 10 * 60_000) });
    const plan = planWatchChanges([biz()], [dead, stale], NOW);
    expect(plan.stop).toEqual([dead, stale]);
    expect(plan.create).toHaveLength(1);
  });

  it("un fallo espera su turno y luego se reintenta reusando su fila", () => {
    const failed = row({ status: "failed", resourceId: null, expiresAt: null, attempts: 2, nextAttemptAt: new Date(NOW.getTime() + 60_000) });
    expect(planWatchChanges([biz()], [failed], NOW)).toEqual({ create: [], stop: [] });
    const due = { ...failed, nextAttemptAt: new Date(NOW.getTime() - 1) };
    expect(planWatchChanges([biz()], [due], NOW)).toEqual({ create: [{ target: biz(), retry: due }], stop: [] });
    // Con un canal sano, la fila fallida sobra.
    const ok = row();
    expect(planWatchChanges([biz()], [due, ok], NOW).stop).toEqual([due]);
  });

  it("lo que ya no se lee (otro calendario, lectura apagada, profesional desconectado) se detiene", () => {
    const keep = row({ calendarId: "equipo@x" });
    const gone = row({ calendarId: "personal@x" });
    const staff = row({ staffId: "stf_carla" });
    const plan = planWatchChanges([biz("equipo@x")], [keep, gone, staff], NOW);
    expect(plan.create).toEqual([]);
    expect(plan.stop).toEqual([gone, staff]);
    expect(planWatchChanges([], [keep], NOW).stop).toEqual([keep]);
  });

  it("negocio y profesional son fuentes distintas aunque los dos lean `primary`", () => {
    const carla: WatchTarget = { organizationId: "org_a", staffId: "stf_carla", calendarId: "primary" };
    const plan = planWatchChanges([biz(), carla], [row()], NOW);
    expect(plan.create).toEqual([{ target: carla, retry: null }]);
  });
});

describe("lo que ve el dueño", () => {
  const r = (calendarId: string, over: Partial<WatchChannelRow> = {}): WatchChannelRow => ({
    id: calendarId,
    organizationId: "org_a",
    staffId: null,
    calendarId,
    channelId: calendarId,
    resourceId: "r",
    status: "active",
    expiresAt: new Date(NOW.getTime() + 24 * H * 3),
    attempts: 0,
    nextAttemptAt: null,
    createdAt: NOW,
    ...over,
  });

  it("activo solo si TODOS sus calendarios tienen canal; un rechazo se muestra", () => {
    expect(summarizeWatch(["a", "b"], [r("a"), r("b")], NOW)).toEqual({ status: "active" });
    expect(summarizeWatch(["a", "b"], [r("a")], NOW)).toEqual({ status: "starting" });
    expect(summarizeWatch(["a"], [r("a", { status: "failed", lastError: "no" })], NOW)).toEqual({ status: "failed", error: "no" });
  });

  it("textos: nada con la bandera apagada; el motivo cuando no hay https", () => {
    expect(watchStatusText({ status: "off" })).toBeNull();
    expect(watchStatusText(null)).toBeNull();
    expect(watchStatusText({ status: "active" })?.tone).toBe("ok");
    expect(watchStatusText({ status: "unavailable", reason: "no_https" })?.text).toMatch(/cada 5 min.*https/);
    expect(watchStatusText({ status: "failed", error: null })?.text).toMatch(/cada 5 min/);
  });
});

describe("pnpm doctor", () => {
  it("apagado: nada que revisar; encendido sin https público: aviso (no falla); con https: dice adónde avisa", () => {
    expect(checkGoogleWatch({})[0]!.status).toBe("skip");
    expect(checkGoogleWatch({ GOOGLE_CALENDAR_WATCH: "on" })[0]!.status).toBe("warn");
    const http = checkGoogleWatch({ GOOGLE_CALENDAR_WATCH: "on", AGENDA: "on", APP_BASE_URL: "http://localhost:3000" });
    expect(http[0]).toMatchObject({ status: "warn", label: "GOOGLE_CALENDAR_WATCH" });
    const ok = checkGoogleWatch({ GOOGLE_CALENDAR_WATCH: "on", AGENDA: "on", APP_BASE_URL: "https://crm.ejemplo.com" });
    expect(ok[0]).toMatchObject({ status: "ok", detail: "Google avisará a https://crm.ejemplo.com/api/webhooks/google-calendar" });
  });
});

describe("bandera GOOGLE_CALENDAR_WATCH", () => {
  it("apagada por defecto; encendida exige AGENDA; sin https público queda «no disponible»", async () => {
    const env: Record<string, string | undefined> = { APP_BASE_URL: "https://crm.ejemplo.com" };
    vi.resetModules();
    vi.doMock("@/lib/env", () => ({ getEnv: () => env, isMockEnabled: () => false }));
    const { watchAvailability, watchFlagOn } = await import("@/server/agenda/calendar-watch/flag");
    process.env.AGENDA = "on";
    expect(watchFlagOn()).toBe(false);
    expect(watchAvailability()).toEqual({ ok: false, reason: "off" });
    env.GOOGLE_CALENDAR_WATCH = "on";
    expect(watchAvailability()).toEqual({ ok: true, address: "https://crm.ejemplo.com/api/webhooks/google-calendar" });
    env.APP_BASE_URL = "http://localhost:3000";
    expect(watchAvailability()).toEqual({ ok: false, reason: "no_https" });
    process.env.AGENDA = "";
    expect(watchAvailability()).toEqual({ ok: false, reason: "off" });
    vi.doUnmock("@/lib/env");
  });
});
