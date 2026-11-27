import { describe, expect, it, vi } from "vitest";

/**
 * Bloque 3 — Ciclo de vida de la cita y disparador por anuncio, sin base de datos:
 *  - el ancla de hora (`bookingAnchorGuard`) y su uso en el motor antes de enviar;
 *  - los disparadores de cita: anclan la hora, la reprogramación cancela y rearma, el Laboratorio no dispara;
 *  - `ad_referral`: idempotente por anuncio, y un contacto del Laboratorio (sin conversación real) no arranca nada;
 *  - `registrarAnuncioDeOrigen` con `isTest` no toca la base ni dispara.
 * Contra Postgres: `automation-bookings-live.test.ts` y `ad-trigger-live.test.ts` (casos «Bloque 3»).
 */

// La base NUNCA debe abrirse en estas pruebas: si algo la pide, la prueba lo delata.
const getDb = vi.hoisted(() => vi.fn(() => {
  throw new Error("no debería tocar la base");
}));
vi.mock("@/lib/db", () => ({
  getDb,
  schema: new Proxy({}, { get: (_t, t) => new Proxy({}, { get: (_t2, c) => `${String(t)}.${String(c)}` }) }),
}));
const emitAdReferralSpy = vi.hoisted(() => vi.fn());

import { BOOKING_ANCHOR_KEY, bookingAnchorGuard, bookingGuard } from "@/lib/automation";
import { processRow, type Deps, type Row, type Step, type Target } from "@/server/automation/engine";
import { onBookingCreated, onBookingNoShow, onBookingRescheduled, type BookingEvent } from "@/server/automation/triggers";
import { emitAdReferral } from "@/server/automation/ad-referral";
import type { EnqueueInput, TriggerStore } from "@/server/automation/trigger-store";

const NOW = new Date("2026-11-27T12:00:00.000Z");
const CITA = new Date("2026-11-28T15:00:00.000Z");

/* ─── Regla pura ─── */

describe("bookingAnchorGuard", () => {
  const ctx = { [BOOKING_ANCHOR_KEY]: CITA.toISOString() };
  it("misma hora → sigue", () => {
    expect(bookingAnchorGuard("booking_created", ctx, { scheduledAt: CITA })).toBeNull();
    expect(bookingAnchorGuard("booking_confirmed", ctx, { scheduledAt: new Date(CITA) })).toBeNull();
  });
  it("la cita se movió → booking_rescheduled", () => {
    const movida = new Date(CITA.getTime() + 3_600_000);
    expect(bookingAnchorGuard("booking_created", ctx, { scheduledAt: movida })).toBe("booking_rescheduled");
    expect(bookingAnchorGuard("booking_confirmed", ctx, { scheduledAt: movida })).toBe("booking_rescheduled");
  });
  it("no-show y realizada no dependen de la hora: el ancla no decide", () => {
    const movida = new Date(CITA.getTime() + 3_600_000);
    expect(bookingAnchorGuard("booking_no_show", ctx, { scheduledAt: movida })).toBeNull();
    expect(bookingAnchorGuard("booking_completed", ctx, { scheduledAt: movida })).toBeNull();
  });
  it("sin ancla (ejecución anterior al cambio), ancla ilegible o sin cita: no decide (queda bookingGuard)", () => {
    expect(bookingAnchorGuard("booking_created", {}, { scheduledAt: CITA })).toBeNull();
    expect(bookingAnchorGuard("booking_created", null, { scheduledAt: CITA })).toBeNull();
    expect(bookingAnchorGuard("booking_created", { bookingAt: "no es fecha" }, { scheduledAt: CITA })).toBeNull();
    expect(bookingAnchorGuard("booking_created", { bookingAt: 123 }, { scheduledAt: CITA })).toBeNull();
    expect(bookingAnchorGuard("booking_created", ctx, null)).toBeNull();
  });
  it("bookingGuard sigue cubriendo el estado (cancelada / no-show reabierta)", () => {
    expect(bookingGuard("booking_created", { status: "cancelada" })).toBe("booking_not_active");
    expect(bookingGuard("booking_no_show", { status: "agendada" })).toBe("booking_no_longer_no_show");
  });
});

/* ─── Motor: revalidación antes de enviar ─── */

function motor(o: { trigger?: string; booking?: { status: string; scheduledAt: Date } | null; context?: Record<string, unknown>; runId?: string | null }) {
  const step: Step = { id: "stp_1", flowId: "aut_1", stepType: "send_whatsapp", config: { content: "Te esperamos {{hora}}" } };
  const target: Target = { conversationId: "cv_1", channel: "whatsapp", isTest: false, lastInboundAt: new Date(NOW.getTime() - 3_600_000), contactName: "Ana" };
  const deps = {
    now: () => NOW,
    loadStep: vi.fn(async () => step),
    isFlowActive: vi.fn(async () => true),
    loadBooking: vi.fn(async () => (o.booking === undefined ? { status: "agendada", scheduledAt: CITA } : o.booking)),
    flowTriggerType: vi.fn(async () => o.trigger ?? "booking_created"),
    timezone: vi.fn(async () => "UTC"),
    contactFacts: vi.fn(async () => ({ tagIds: [] as string[], stageId: null as string | null })),
    runStatus: vi.fn(async () => "running"),
    runContext: vi.fn(async () => o.context ?? { [BOOKING_ANCHOR_KEY]: CITA.toISOString() }),
    applyTag: vi.fn(async () => "added" as const),
    moveContactToStage: vi.fn(async () => ({ status: "moved" as const, toStageId: "stg", fromStageId: null as string | null })),
    loadTarget: vi.fn(async () => target),
    templateStatus: vi.fn(async () => null),
    sendText: vi.fn(async () => ({ messageId: "msg_1" })),
    sendTemplate: vi.fn(async () => ({ messageId: "msg_2" })),
    sendMedia: vi.fn(async () => ({ messageId: "msg_3" })),
    loadMedia: vi.fn(async () => ({ ok: true as const, bytes: 1, mimeType: "image/png", fileName: "x.png" })),
    isOptedOut: vi.fn(async () => false),
    recentAutomaticSends: vi.fn(async () => []),
    defer: vi.fn(async () => undefined),
    waMessageIdOf: vi.fn(async () => null),
    hasSuccessLog: vi.fn(async () => false),
    writeLog: vi.fn(async () => undefined),
    completeAndAdvance: vi.fn(async () => null),
    markFailed: vi.fn(async () => undefined),
    markCancelled: vi.fn(async () => undefined),
    reschedule: vi.fn(async () => undefined),
  } satisfies Deps;
  const row: Row = {
    id: "que_1",
    organizationId: "org_1",
    flowId: "aut_1",
    contactId: "ct_1",
    stepId: "stp_1",
    attempts: 1,
    maxAttempts: 5,
    bookingId: "bk_1",
    createdAt: NOW,
    ...(o.runId === null ? {} : { runId: o.runId ?? "run_1" }),
  };
  return { deps, row, run: () => processRow(row, deps) };
}

describe("motor — revalidación de la cita antes de enviar", () => {
  it("cita vigente a la misma hora: envía", async () => {
    const m = motor({});
    expect(await m.run()).toBe("completed");
    expect(m.deps.sendText).toHaveBeenCalledTimes(1);
  });

  it("la cita se MOVIÓ (la ejecución quedó anclada a la hora vieja): cancela como booking_rescheduled y no envía", async () => {
    const m = motor({ booking: { status: "agendada", scheduledAt: new Date(CITA.getTime() + 2 * 3_600_000) } });
    expect(await m.run()).toBe("cancelled");
    expect(m.deps.sendText).not.toHaveBeenCalled();
    expect(m.deps.markCancelled).toHaveBeenCalledWith(m.row, "booking_rescheduled");
  });

  it("la cita se CANCELÓ: cancela como booking_not_active (sin mirar la hora)", async () => {
    const m = motor({ booking: { status: "cancelada", scheduledAt: CITA } });
    expect(await m.run()).toBe("cancelled");
    expect(m.deps.markCancelled).toHaveBeenCalledWith(m.row, "booking_not_active");
    expect(m.deps.runContext).not.toHaveBeenCalled();
  });

  it("la cita ya no existe: booking_not_found", async () => {
    const m = motor({ booking: null });
    expect(await m.run()).toBe("cancelled");
    expect(m.deps.markCancelled).toHaveBeenCalledWith(m.row, "booking_not_found");
  });

  it("flujo de no-show: la cita sigue no_show → envía aunque la hora difiera del ancla", async () => {
    const m = motor({ trigger: "booking_no_show", booking: { status: "no_show", scheduledAt: new Date(CITA.getTime() + 3_600_000) } });
    expect(await m.run()).toBe("completed");
    expect(m.deps.sendText).toHaveBeenCalledTimes(1);
  });

  it("ejecución vieja sin ancla (anterior a este cambio): se comporta como siempre", async () => {
    const m = motor({ context: {}, booking: { status: "agendada", scheduledAt: new Date(CITA.getTime() + 3_600_000) } });
    expect(await m.run()).toBe("completed");
  });
});

/* ─── Disparadores de cita ─── */

function fakeStore(o: { flows?: Record<string, string[]>; real?: string[] } = {}) {
  const keys = new Set<string>();
  const enqueued: EnqueueInput[] = [];
  const cancelled: { bookingId: string; reason: string; except?: string }[] = [];
  const store = {
    listOrganizationIds: vi.fn(async () => ["org_1"]),
    activeFlows: vi.fn(async (_org: string, type: string) =>
      (o.flows?.[type] ?? []).map((id) => ({ id, organizationId: "org_1", triggerConfig: null }))
    ),
    timezone: vi.fn(async () => "UTC"),
    birthdayContacts: vi.fn(async () => []),
    hasRealConversation: vi.fn(async (_org: string, contactId: string) => (o.real ?? ["ct_1"]).includes(contactId)),
    enqueueFirstStep: vi.fn(async (i: EnqueueInput) => {
      const k = [i.organizationId, i.flowId, i.contactId, i.dedupeKey].join("|");
      if (keys.has(k)) return false;
      keys.add(k);
      enqueued.push(i);
      return true;
    }),
    cancelPendingForBooking: vi.fn(async (_org: string, bookingId: string, reason: string, opts?: { exceptTrigger?: string }) => {
      cancelled.push({ bookingId, reason, ...(opts?.exceptTrigger ? { except: opts.exceptTrigger } : {}) });
      return 1;
    }),
  } satisfies TriggerStore;
  return { store, enqueued, cancelled };
}

const on = () => true;
const evento = (over: Partial<BookingEvent> = {}): BookingEvent => ({
  organizationId: "org_1",
  bookingId: "bk_1",
  contactId: "ct_1",
  scheduledAt: CITA,
  ...over,
});

describe("disparadores de cita", () => {
  it("crear la cita ancla la hora en la ejecución, y un reintento no duplica", async () => {
    const s = fakeStore({ flows: { booking_created: ["aut_rec"] } });
    expect(await onBookingCreated(evento(), s.store, on, () => NOW)).toBe(1);
    expect(await onBookingCreated(evento(), s.store, on, () => NOW)).toBe(0);
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0]).toMatchObject({ bookingId: "bk_1", context: { [BOOKING_ANCHOR_KEY]: CITA.toISOString() } });
  });

  it("reprogramar: cancela lo pendiente y rearma con la hora NUEVA anclada", async () => {
    const s = fakeStore({ flows: { booking_created: ["aut_rec"] } });
    await onBookingCreated(evento(), s.store, on, () => NOW);
    const nueva = new Date(CITA.getTime() + 24 * 3_600_000);
    expect(await onBookingRescheduled(evento({ scheduledAt: nueva }), s.store, on, () => NOW)).toBe(1);
    expect(s.cancelled).toEqual([{ bookingId: "bk_1", reason: "booking_rescheduled" }]);
    expect(s.enqueued.at(-1)).toMatchObject({ context: { [BOOKING_ANCHOR_KEY]: nueva.toISOString() } });
  });

  it("si cancelar lo pendiente falla al reprogramar, el flujo nuevo se arma igual (y el viejo lo frena el ancla)", async () => {
    const s = fakeStore({ flows: { booking_created: ["aut_rec"] } });
    s.store.cancelPendingForBooking.mockRejectedValueOnce(new Error("base caída"));
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    const nueva = new Date(CITA.getTime() + 24 * 3_600_000);
    expect(await onBookingRescheduled(evento({ scheduledAt: nueva }), s.store, on, () => NOW)).toBe(1);
    consola.mockRestore();
  });

  it("no-show: cancela los recordatorios (excepto su propio flujo) y arranca el de no-show", async () => {
    const s = fakeStore({ flows: { booking_no_show: ["aut_ns"] } });
    expect(await onBookingNoShow(evento(), s.store, on, () => NOW)).toBe(1);
    expect(s.cancelled).toEqual([{ bookingId: "bk_1", reason: "booking_no_show", except: "booking_no_show" }]);
    expect(s.enqueued[0]).toMatchObject({ flowId: "aut_ns", bookingId: "bk_1" });
  });

  it("una cita del Laboratorio (isTest) o un bloqueo sin contacto no disparan nada", async () => {
    const s = fakeStore({ flows: { booking_created: ["aut_rec"], booking_no_show: ["aut_ns"] } });
    expect(await onBookingCreated(evento({ isTest: true }), s.store, on, () => NOW)).toBe(0);
    expect(await onBookingCreated(evento({ contactId: null }), s.store, on, () => NOW)).toBe(0);
    expect(s.enqueued).toHaveLength(0);
  });
});

/* ─── ad_referral ─── */

describe("ad_referral", () => {
  const ctx = async (_o: string, sourceId: string) => ({ adSourceId: sourceId, headline: "Promo" });
  const jerarquia = async (_o: string, adId: string) => ({ adId });

  it("idempotente: el mismo anuncio para el mismo contacto arranca el flujo UNA vez", async () => {
    const s = fakeStore({ flows: { ad_referral: ["aut_ad"] } });
    const input = { organizationId: "org_1", contactId: "ct_1", sourceId: "ad_1", headline: "Promo" };
    expect(await emitAdReferral(input, s.store, on, ctx, () => NOW, jerarquia)).toBe(1);
    expect(await emitAdReferral(input, s.store, on, ctx, () => NOW, jerarquia)).toBe(0);
    expect(s.enqueued).toHaveLength(1);
  });

  it("un contacto sin conversación REAL (solo del Laboratorio) no arranca nada", async () => {
    const s = fakeStore({ flows: { ad_referral: ["aut_ad"] }, real: [] });
    expect(await emitAdReferral({ organizationId: "org_1", contactId: "ct_lab", sourceId: "ad_1" }, s.store, on, ctx, () => NOW, jerarquia)).toBe(0);
    expect(s.enqueued).toHaveLength(0);
  });

  it("apagado, ni consulta", async () => {
    const s = fakeStore({ flows: { ad_referral: ["aut_ad"] } });
    expect(await emitAdReferral({ organizationId: "org_1", contactId: "ct_1", sourceId: "ad_1" }, s.store, () => false, ctx, () => NOW, jerarquia)).toBe(0);
    expect(s.store.activeFlows).not.toHaveBeenCalled();
  });
});

describe("registrarAnuncioDeOrigen — conversación del Laboratorio", () => {
  it("con isTest no abre la base ni dispara ad_referral", async () => {
    vi.doMock("@/server/automation/ad-referral", () => ({ emitAdReferral: emitAdReferralSpy }));
    const { registrarAnuncioDeOrigen } = await import("@/server/attribution/store");
    getDb.mockClear();
    await registrarAnuncioDeOrigen({
      organizationId: "org_1",
      contactId: "ct_lab",
      conversationId: "cv_lab",
      isTest: true,
      anuncio: { sourceId: "ad_1", sourceType: "ad", sourceUrl: null, headline: "Promo", body: null, mediaType: null, ctwaClid: null, imageUrl: null, raw: {} },
    });
    expect(getDb).not.toHaveBeenCalled();
    expect(emitAdReferralSpy).not.toHaveBeenCalled();
  });
});
