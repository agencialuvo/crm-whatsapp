import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelToken } from "@/lib/google-watch";

/**
 * Mejora 4 — El webhook `POST /api/webhooks/google-calendar` y el agrupado de ráfagas, sin base ni Google:
 *  - bandera apagada → 404; encabezados raros → 400; token falso → 404 SIN tocar la base; canal desconocido,
 *    fallido o con otro `resource_id` → 404 sin leer nada;
 *  - `sync` → 200 sin leer; `exists` → 200 y lee SOLO la fuente del canal (el negocio o ese profesional);
 *  - una ráfaga = una lectura ya + UNA al final; un aviso con una lectura en curso no se pierde.
 */

const SECRET = "secreto-de-prueba-123456";
const flag = vi.hoisted(() => ({ on: true }));
const db = vi.hoisted(() => ({
  findChannel: vi.fn(),
  markNotified: vi.fn(async (_row: unknown, _n: string | null) => {}),
}));
const reads = vi.hoisted(() => ({
  requestBusySync: vi.fn(async (_org: string, _opts?: { ensureWatch?: boolean }) => {}),
  syncGoogleBusy: vi.fn(async (_org: string) => ({ outcome: "synced" })),
  busySyncInflight: vi.fn((_org: string): Promise<unknown> | undefined => undefined),
  syncStaffBusy: vi.fn(async (_org: string, _staffId: string) => ({ outcome: "synced" })),
  staffBusySyncInflight: vi.fn((_org: string, _staffId: string): Promise<unknown> | undefined => undefined),
}));

vi.mock("@/server/agenda/calendar-watch/flag", () => ({
  watchFlagOn: () => flag.on,
  watchSecret: () => SECRET,
}));
vi.mock("@/server/agenda/calendar-watch/channels", () => db);
vi.mock("@/server/agenda/calendar-busy/sync", () => ({
  requestBusySync: reads.requestBusySync,
  syncGoogleBusy: reads.syncGoogleBusy,
  busySyncInflight: reads.busySyncInflight,
}));
vi.mock("@/server/agenda/staff-calendar/busy", () => ({
  syncStaffBusy: reads.syncStaffBusy,
  staffBusySyncInflight: reads.staffBusySyncInflight,
}));

import { POST } from "@/app/api/webhooks/google-calendar/route";
import {
  resetWatchReadsForTests,
  setWatchMinGapForTests,
  triggerSourceRead,
  waitForWatchReadsIdle,
} from "@/server/agenda/calendar-watch/notify";

const channel = (over: Record<string, unknown> = {}) => ({
  id: "gwc_1",
  organizationId: "org_a",
  staffId: null,
  calendarId: "primary",
  channelId: "canal_1",
  resourceId: "res-1",
  status: "active",
  lastMessageNumber: null,
  ...over,
});

const aviso = (over: Record<string, string | null> = {}) => {
  const h: Record<string, string> = {
    "X-Goog-Channel-ID": "canal_1",
    "X-Goog-Channel-Token": channelToken(SECRET, "canal_1"),
    "X-Goog-Resource-ID": "res-1",
    "X-Goog-Resource-State": "exists",
    "X-Goog-Message-Number": "2",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete h[k];
    else h[k] = v;
  }
  return new Request("https://crm.ejemplo.test/api/webhooks/google-calendar", { method: "POST", headers: h, body: "ignorado" });
};

beforeEach(() => {
  flag.on = true;
  resetWatchReadsForTests();
  setWatchMinGapForTests(60);
  db.findChannel.mockReset().mockResolvedValue(channel());
  db.markNotified.mockClear();
  for (const f of Object.values(reads)) f.mockClear();
  reads.busySyncInflight.mockReturnValue(undefined);
  reads.staffBusySyncInflight.mockReturnValue(undefined);
});

afterEach(async () => {
  await waitForWatchReadsIdle();
  setWatchMinGapForTests(undefined);
});

describe("webhook de Google Calendar", () => {
  it("con la bandera apagada no existe (404)", async () => {
    flag.on = false;
    expect((await POST(aviso())).status).toBe(404);
    expect(db.findChannel).not.toHaveBeenCalled();
  });

  it("encabezados que no son de Google → 400", async () => {
    expect((await POST(aviso({ "X-Goog-Channel-ID": null }))).status).toBe(400);
    expect((await POST(aviso({ "X-Goog-Resource-State": "otro" }))).status).toBe(400);
    expect(db.findChannel).not.toHaveBeenCalled();
  });

  it("token falso o ausente → 404 sin tocar la base", async () => {
    expect((await POST(aviso({ "X-Goog-Channel-Token": "falso" }))).status).toBe(404);
    expect((await POST(aviso({ "X-Goog-Channel-Token": null }))).status).toBe(404);
    // El token de OTRO canal tampoco sirve.
    expect((await POST(aviso({ "X-Goog-Channel-Token": channelToken(SECRET, "canal_2") }))).status).toBe(404);
    expect(db.findChannel).not.toHaveBeenCalled();
  });

  it("canal desconocido, fallido o con otro resource_id → 404 y no se lee nada", async () => {
    db.findChannel.mockResolvedValueOnce(null);
    expect((await POST(aviso())).status).toBe(404);
    db.findChannel.mockResolvedValueOnce(channel({ status: "failed" }));
    expect((await POST(aviso())).status).toBe(404);
    expect((await POST(aviso({ "X-Goog-Resource-ID": "res-otro" }))).status).toBe(404);
    expect(db.markNotified).not.toHaveBeenCalled();
    expect(reads.syncGoogleBusy).not.toHaveBeenCalled();
  });

  it("`sync` (el primer aviso) → 200 sin leer; vale aunque el canal siga «pedido»", async () => {
    db.findChannel.mockResolvedValueOnce(channel({ status: "pending", resourceId: null }));
    const res = await POST(aviso({ "X-Goog-Resource-State": "sync", "X-Goog-Message-Number": "1" }));
    expect(res.status).toBe(200);
    expect(db.markNotified).toHaveBeenCalledWith(expect.objectContaining({ id: "gwc_1" }), "1");
    await waitForWatchReadsIdle();
    expect(reads.syncGoogleBusy).not.toHaveBeenCalled();
  });

  it("`exists` del negocio → 200 y se lee lo del negocio (sin volver a pedir canales)", async () => {
    expect((await POST(aviso())).status).toBe(200);
    await waitForWatchReadsIdle();
    expect(reads.requestBusySync).toHaveBeenCalledWith("org_a", { ensureWatch: false });
    expect(reads.syncGoogleBusy).toHaveBeenCalledWith("org_a");
    expect(reads.syncStaffBusy).not.toHaveBeenCalled();
  });

  it("`exists` de un profesional → se lee SOLO su calendario", async () => {
    db.findChannel.mockResolvedValue(channel({ staffId: "stf_carla" }));
    expect((await POST(aviso({ "X-Goog-Resource-State": "not_exists" }))).status).toBe(200);
    await waitForWatchReadsIdle();
    expect(reads.syncStaffBusy).toHaveBeenCalledWith("org_a", "stf_carla");
    expect(reads.syncGoogleBusy).not.toHaveBeenCalled();
  });

  it("responde enseguida: no espera a que termine la lectura", async () => {
    let release!: () => void;
    reads.syncGoogleBusy.mockImplementationOnce(() => new Promise((r) => (release = () => r({ outcome: "synced" }))));
    const res = await POST(aviso());
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(reads.syncGoogleBusy).toHaveBeenCalled());
    release();
  });
});

describe("ráfagas de avisos", () => {
  it("cinco avisos seguidos = una lectura ya y UNA más al final", async () => {
    const out = Array.from({ length: 5 }, () => triggerSourceRead("org_a", null));
    expect(out).toEqual(["started", "queued", "queued", "queued", "queued"]);
    await waitForWatchReadsIdle();
    expect(reads.syncGoogleBusy).toHaveBeenCalledTimes(2);
  });

  it("como mucho una lectura por intervalo; fuentes distintas no se esperan entre sí", async () => {
    triggerSourceRead("org_a", null);
    await waitForWatchReadsIdle();
    // Dentro del intervalo: se programa para después, no se lee ya.
    expect(triggerSourceRead("org_a", null)).toBe("queued");
    expect(triggerSourceRead("org_a", "stf_carla")).toBe("started");
    expect(triggerSourceRead("org_b", null)).toBe("started");
    await waitForWatchReadsIdle();
    expect(reads.syncGoogleBusy.mock.calls.map((c) => c[0])).toEqual(["org_a", "org_b", "org_a"]);
    expect(reads.syncStaffBusy).toHaveBeenCalledTimes(1);
  });

  it("con una lectura en curso (del barrido) se espera y se lee OTRA vez: el cambio no se pierde", async () => {
    let finish!: () => void;
    const running = new Promise<void>((r) => (finish = r));
    reads.busySyncInflight.mockReturnValueOnce(running);
    triggerSourceRead("org_a", null);
    await new Promise((r) => setTimeout(r, 10));
    expect(reads.syncGoogleBusy).not.toHaveBeenCalled();
    finish();
    await waitForWatchReadsIdle();
    expect(reads.syncGoogleBusy).toHaveBeenCalledTimes(1);
  });

  it("una lectura que falla no rompe nada: el siguiente aviso vuelve a leer", async () => {
    reads.syncStaffBusy.mockRejectedValueOnce(new Error("Google caído"));
    triggerSourceRead("org_a", "stf_carla");
    await waitForWatchReadsIdle();
    await new Promise((r) => setTimeout(r, 70));
    expect(triggerSourceRead("org_a", "stf_carla")).toBe("started");
    await waitForWatchReadsIdle();
    expect(reads.syncStaffBusy).toHaveBeenCalledTimes(2);
  });
});
