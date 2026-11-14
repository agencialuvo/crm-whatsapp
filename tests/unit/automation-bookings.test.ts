import { describe, expect, it, vi } from "vitest";
import {
  applySendWindow,
  bookingConfirmedDedupeKey,
  bookingCreatedDedupeKey,
  bookingGuard,
  bookingNoShowDedupeKey,
  decideWaitUntil,
  delayConfigSchema,
  renderVars,
  sendWindowSchema,
  waitUntilConfigSchema,
  type SendWindow,
} from "@/lib/automation";
import {
  FLOW_TRIGGER_TYPES,
  STEP_TYPES,
  flowCreateSchema,
  parseStepConfig,
  parseTriggerConfigFor,
  stepCreateSchema,
} from "@/lib/automation-schemas";
import {
  CREATABLE_TRIGGERS,
  TRIGGER_HINTS,
  describeBookingOffset,
  describeStep,
  describeTrigger,
  describeWindow,
  offsetMinutesOf,
  offsetParts,
} from "@/lib/automation-dto";
import {
  onBookingClosed,
  onBookingConfirmed,
  onBookingCreated,
  onBookingNoShow,
  onBookingRescheduled,
  type BookingEvent,
} from "@/server/automation/triggers";
import type { EnqueueInput, TriggerStore } from "@/server/automation/trigger-store";

/**
 * Automatizaciones de citas (Fase 1) — las reglas puras: ventana horaria, espera anclada a la cita,
 * vigencia de la cita, esquemas, textos de pantalla y los disparadores con dobles. Lo que toca la base se
 * prueba en `automation-bookings-live.test.ts`.
 *
 * Lima (UTC−5, sin horario de verano) para que las cuentas se lean a mano; Nueva York para el cambio de hora.
 */

const LIMA = "America/Lima";
const iso = (s: string) => new Date(s);

describe("applySendWindow — a una hora fija", () => {
  const at10: SendWindow = { mode: "at", hour: 10, minute: 0 };

  it("si todavía no son las 10:00 de ese día, sale a las 10:00 de ese día", () => {
    // 05:00 en Lima (10:00Z) → 10:00 en Lima = 15:00Z.
    expect(applySendWindow(iso("2026-11-20T10:00:00Z"), at10, LIMA)).toEqual(iso("2026-11-20T15:00:00Z"));
  });

  it("si ya pasaron las 10:00, sale a las 10:00 del día siguiente (nunca antes)", () => {
    // 11:00 en Lima (16:00Z) → mañana 10:00 = 15:00Z del 21.
    expect(applySendWindow(iso("2026-11-20T16:00:00Z"), at10, LIMA)).toEqual(iso("2026-11-21T15:00:00Z"));
  });

  it("si cae justo a las 10:00 no se mueve", () => {
    expect(applySendWindow(iso("2026-11-20T15:00:00Z"), at10, LIMA)).toEqual(iso("2026-11-20T15:00:00Z"));
  });

  it("de madrugada (la noche anterior en hora local) manda a las 10:00 locales, no a las 10:00 UTC", () => {
    // 22:00 del 19 en Lima (03:00Z del 20) → 10:00 del 20 en Lima = 15:00Z.
    expect(applySendWindow(iso("2026-11-20T03:00:00Z"), at10, LIMA)).toEqual(iso("2026-11-20T15:00:00Z"));
  });

  it("admite minutos", () => {
    expect(applySendWindow(iso("2026-11-20T10:00:00Z"), { mode: "at", hour: 9, minute: 30 }, LIMA)).toEqual(
      iso("2026-11-20T14:30:00Z")
    );
  });

  it("jamás devuelve un instante anterior al dado, ni lanza, aunque la hora local no exista (salto de horario)", () => {
    // 8 de marzo de 2026 en Nueva York: las 02:30 no existen.
    const at = iso("2026-03-08T05:00:00Z");
    const out = applySendWindow(at, { mode: "at", hour: 2, minute: 30 }, "America/New_York");
    expect(out.getTime()).toBeGreaterThanOrEqual(at.getTime());
  });

  it("respeta el horario de verano: 10:00 locales son 14:00Z en verano y 15:00Z en invierno (Nueva York)", () => {
    expect(applySendWindow(iso("2026-07-15T08:00:00Z"), at10, "America/New_York")).toEqual(iso("2026-07-15T14:00:00Z"));
    expect(applySendWindow(iso("2026-01-15T08:00:00Z"), at10, "America/New_York")).toEqual(iso("2026-01-15T15:00:00Z"));
  });
});

describe("applySendWindow — solo dentro de un horario", () => {
  const nine21: SendWindow = { mode: "between", fromHour: 9, toHour: 21 };

  it("antes de abrir, espera a la apertura de ese día", () => {
    // 03:00 en Lima (08:00Z) → 09:00 en Lima = 14:00Z.
    expect(applySendWindow(iso("2026-11-20T08:00:00Z"), nine21, LIMA)).toEqual(iso("2026-11-20T14:00:00Z"));
  });

  it("dentro del horario no se mueve", () => {
    expect(applySendWindow(iso("2026-11-20T20:00:00Z"), nine21, LIMA)).toEqual(iso("2026-11-20T20:00:00Z"));
  });

  it("después de cerrar, pasa a la apertura del día siguiente", () => {
    // 22:00 del 20 en Lima (03:00Z del 21) → 09:00 del 21 en Lima = 14:00Z.
    expect(applySendWindow(iso("2026-11-21T03:00:00Z"), nine21, LIMA)).toEqual(iso("2026-11-21T14:00:00Z"));
  });

  it("el cierre es exclusivo: a las 21:00 en punto ya es de noche", () => {
    expect(applySendWindow(iso("2026-11-21T02:00:00Z"), nine21, LIMA)).toEqual(iso("2026-11-21T14:00:00Z"));
  });

  it("hasta las 24 llega al final del día", () => {
    const w: SendWindow = { mode: "between", fromHour: 9, toHour: 24 };
    expect(applySendWindow(iso("2026-11-21T04:30:00Z"), w, LIMA)).toEqual(iso("2026-11-21T04:30:00Z")); // 23:30 locales
    expect(applySendWindow(iso("2026-11-21T05:30:00Z"), w, LIMA)).toEqual(iso("2026-11-21T14:00:00Z")); // 00:30 → 09:00
  });
});

describe("sendWindowSchema", () => {
  it("valida los dos modos y sus rangos", () => {
    expect(sendWindowSchema.parse({ mode: "at", hour: 10 })).toEqual({ mode: "at", hour: 10, minute: 0 });
    for (const bad of [
      { mode: "at", hour: 24 },
      { mode: "at", hour: -1 },
      { mode: "at", hour: 10, minute: 60 },
      { mode: "between", fromHour: 9, toHour: 9 },
      { mode: "between", fromHour: 21, toHour: 9 },
      { mode: "between", fromHour: 9, toHour: 25 },
      { mode: "otro", hour: 1 },
    ]) {
      expect(sendWindowSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("el «Esperar» de siempre sigue válido sin ventana, y con ventana también", () => {
    expect(delayConfigSchema.safeParse({ amount: 1, unit: "days" }).success).toBe(true);
    expect(delayConfigSchema.safeParse({ amount: 1, unit: "days", window: { mode: "at", hour: 10 } }).success).toBe(true);
    expect(delayConfigSchema.safeParse({ amount: 1, unit: "days", window: { mode: "at", hour: 99 } }).success).toBe(false);
  });
});

describe("decideWaitUntil — esperar hasta la cita", () => {
  const scheduledAt = iso("2026-11-20T20:00:00Z"); // 15:00 en Lima
  const base = { offsetMinutes: -1440, lateAction: "skip_next" as const };

  it("un día antes: espera hasta esa hora", () => {
    const d = decideWaitUntil({ now: iso("2026-11-18T12:00:00Z"), scheduledAt, config: base, timezone: LIMA });
    expect(d).toEqual({ kind: "wait", at: iso("2026-11-19T20:00:00Z") });
  });

  it("2 horas antes", () => {
    const d = decideWaitUntil({ now: iso("2026-11-18T12:00:00Z"), scheduledAt, config: { ...base, offsetMinutes: -120 }, timezone: LIMA });
    expect(d).toEqual({ kind: "wait", at: iso("2026-11-20T18:00:00Z") });
  });

  it("después de la cita (offset positivo)", () => {
    const d = decideWaitUntil({ now: iso("2026-11-18T12:00:00Z"), scheduledAt, config: { ...base, offsetMinutes: 60 }, timezone: LIMA });
    expect(d).toEqual({ kind: "wait", at: iso("2026-11-20T21:00:00Z") });
  });

  it("si la hora ya pasó, es tarde y trae la acción elegida", () => {
    const now = iso("2026-11-20T10:00:00Z"); // la cita es en 10 h: «1 día antes» ya pasó
    for (const lateAction of ["skip_next", "continue", "stop"] as const) {
      expect(decideWaitUntil({ now, scheduledAt, config: { ...base, lateAction }, timezone: LIMA })).toEqual({
        kind: "late",
        action: lateAction,
      });
    }
  });

  it("con una ventana, la hora se retrasa a la permitida", () => {
    // Cita 15:00 Lima del 20; «1 día antes» = 15:00 Lima del 19; a las 10:00 fijas → 10:00 del 20 (15:00Z).
    const d = decideWaitUntil({
      now: iso("2026-11-18T12:00:00Z"),
      scheduledAt,
      config: { ...base, window: { mode: "at", hour: 10, minute: 0 } },
      timezone: LIMA,
    });
    expect(d).toEqual({ kind: "wait", at: iso("2026-11-20T15:00:00Z") });
  });

  it("un recordatorio jamás sale después de la cita: si la ventana lo empujaría a la hora de la cita o más, es tarde", () => {
    const cita = iso("2026-11-20T15:30:00Z"); // 10:30 en Lima
    const cfg = { offsetMinutes: -60, lateAction: "skip_next" as const };
    // 1 h antes = 09:30; a las 10:00 fijas cabe (10:00 < 10:30)…
    expect(
      decideWaitUntil({ now: iso("2026-11-19T12:00:00Z"), scheduledAt: cita, config: { ...cfg, window: { mode: "at", hour: 10, minute: 0 } }, timezone: LIMA })
    ).toEqual({ kind: "wait", at: iso("2026-11-20T15:00:00Z") });
    // …pero a las 11:00 fijas ya sería después de la cita.
    expect(
      decideWaitUntil({ now: iso("2026-11-19T12:00:00Z"), scheduledAt: cita, config: { ...cfg, window: { mode: "at", hour: 11, minute: 0 } }, timezone: LIMA })
    ).toEqual({ kind: "late", action: "skip_next" });
  });
});

describe("waitUntilConfigSchema", () => {
  it("por defecto omite el mensaje que sigue cuando ya es tarde", () => {
    expect(waitUntilConfigSchema.parse({ anchor: "booking.scheduledAt", offsetMinutes: -1440 }).lateAction).toBe("skip_next");
  });

  it("solo ancla a la cita, con desplazamiento entero y acotado a 30 días", () => {
    for (const bad of [
      { anchor: "lead.createdAt", offsetMinutes: -60 },
      { anchor: "booking.scheduledAt", offsetMinutes: -60.5 },
      { anchor: "booking.scheduledAt", offsetMinutes: -43_201 },
      { anchor: "booking.scheduledAt", offsetMinutes: 43_201 },
      { anchor: "booking.scheduledAt", offsetMinutes: -60, lateAction: "explotar" },
    ]) {
      expect(waitUntilConfigSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(waitUntilConfigSchema.safeParse({ anchor: "booking.scheduledAt", offsetMinutes: 0 }).success).toBe(true);
  });
});

describe("bookingGuard — vigencia de la cita", () => {
  it("recordatorios (cita creada o confirmada): solo mientras la cita está agendada", () => {
    for (const trigger of ["booking_created", "booking_confirmed"]) {
      expect(bookingGuard(trigger, { status: "agendada" })).toBeNull();
      expect(bookingGuard(trigger, { status: "cancelada" })).toBe("booking_not_active");
      expect(bookingGuard(trigger, { status: "realizada" })).toBe("booking_not_active");
      expect(bookingGuard(trigger, { status: "no_show" })).toBe("booking_not_active");
    }
  });

  it("no-show: solo mientras siga marcada como no-show", () => {
    expect(bookingGuard("booking_no_show", { status: "no_show" })).toBeNull();
    expect(bookingGuard("booking_no_show", { status: "agendada" })).toBe("booking_no_longer_no_show");
  });

  it("una cita que ya no existe cancela la tarea", () => {
    expect(bookingGuard("booking_created", null)).toBe("booking_not_found");
  });
});

describe("variables de la cita y llaves de deduplicación", () => {
  it("{{fecha}} y {{hora}} se rellenan; sin cita quedan vacías (sin dejar espacios dobles)", () => {
    expect(renderVars("Hola {{name}}, te esperamos {{fecha}} a las {{hora}}.", { name: "Ana", fecha: "mañana lunes 9 de noviembre", hora: "15:00" })).toBe(
      "Hola Ana, te esperamos mañana lunes 9 de noviembre a las 15:00."
    );
    expect(renderVars("Cita: {{ fecha }} {{ HORA }}", { name: null })).toBe("Cita:");
  });

  it("la llave de creación lleva la hora (reprogramar rearma) y la de no-show es una por cita", () => {
    const a = iso("2026-11-20T20:00:00Z");
    const b = iso("2026-11-21T20:00:00Z");
    expect(bookingCreatedDedupeKey("bk_1", a)).not.toBe(bookingCreatedDedupeKey("bk_1", b));
    expect(bookingCreatedDedupeKey("bk_1", a)).toBe(bookingCreatedDedupeKey("bk_1", a));
    expect(bookingConfirmedDedupeKey("bk_1", a)).toContain("booking_confirmed:bk_1");
    expect(bookingNoShowDedupeKey("bk_1")).toBe("booking_no_show:bk_1");
  });
});

describe("la API acepta los disparadores y el paso nuevos", () => {
  it("los tres disparadores de cita y el paso wait_until existen", () => {
    for (const t of ["booking_created", "booking_confirmed", "booking_no_show"]) {
      expect(FLOW_TRIGGER_TYPES).toContain(t);
      expect(flowCreateSchema.safeParse({ name: "Recordatorio", triggerType: t }).success).toBe(true);
      // Sin ajustes: una clave suelta es un error de quien llama.
      expect(parseTriggerConfigFor(t as never, { toStageId: "x" }).ok).toBe(false);
      expect(parseTriggerConfigFor(t as never, null)).toEqual({ ok: true, value: null });
    }
    expect(STEP_TYPES).toContain("wait_until");
  });

  it("crear un paso wait_until valida su configuración", () => {
    const ok = stepCreateSchema.safeParse({
      stepType: "wait_until",
      config: { anchor: "booking.scheduledAt", offsetMinutes: -1440, window: { mode: "at", hour: 10 } },
    });
    expect(ok.success).toBe(true);
    expect(stepCreateSchema.safeParse({ stepType: "wait_until", config: { offsetMinutes: -1440 } }).success).toBe(false);
    expect(parseStepConfig("wait_until", { anchor: "booking.scheduledAt", offsetMinutes: -60 }).ok).toBe(true);
    expect(parseStepConfig("wait_until", { anchor: "nada", offsetMinutes: -60 }).ok).toBe(false);
  });

  it("la pantalla ofrece los disparadores de cita, cada uno con su pista", () => {
    for (const t of ["booking_created", "booking_confirmed", "booking_no_show"] as const) {
      expect(CREATABLE_TRIGGERS).toContain(t);
      expect(TRIGGER_HINTS[t].length).toBeGreaterThan(10);
      expect(describeTrigger(t, null)).not.toBe(t);
    }
  });
});

describe("textos de pantalla de lo nuevo", () => {
  it("el desplazamiento se lee como la persona lo escribiría y viaja ida y vuelta", () => {
    expect(offsetParts(-1440)).toEqual({ direction: "before", amount: 1, unit: "days" });
    expect(offsetParts(-120)).toEqual({ direction: "before", amount: 2, unit: "hours" });
    expect(offsetParts(-90)).toEqual({ direction: "before", amount: 90, unit: "minutes" });
    expect(offsetParts(60)).toEqual({ direction: "after", amount: 1, unit: "hours" });
    for (const m of [-2880, -1440, -180, -90, -1, 0, 45, 60, 1440]) {
      const p = offsetParts(m);
      expect(offsetMinutesOf(p.direction, p.amount, p.unit)).toBe(m === 0 ? 0 : m);
    }
  });

  it("describeBookingOffset", () => {
    expect(describeBookingOffset(-1440)).toBe("1 día antes de la cita");
    expect(describeBookingOffset(-2880)).toBe("2 días antes de la cita");
    expect(describeBookingOffset(-60)).toBe("1 hora antes de la cita");
    expect(describeBookingOffset(30)).toBe("30 minutos después de la cita");
    expect(describeBookingOffset(0)).toBe("A la hora de la cita");
  });

  it("describeWindow", () => {
    expect(describeWindow({ mode: "at", hour: 10, minute: 0 })).toBe("a las 10:00");
    expect(describeWindow({ mode: "at", hour: 9, minute: 30 })).toBe("a las 09:30");
    expect(describeWindow({ mode: "between", fromHour: 9, toHour: 21 })).toBe("solo entre las 09:00 y las 21:00");
    expect(describeWindow(null)).toBeNull();
    expect(describeWindow(undefined)).toBeNull();
  });

  it("la tarjeta de un paso wait_until dice cuándo y qué pasa si ya es tarde", () => {
    const d = describeStep({
      stepType: "wait_until",
      config: { anchor: "booking.scheduledAt", offsetMinutes: -1440, lateAction: "skip_next", window: { mode: "at", hour: 10, minute: 0 } },
    });
    expect(d.title).toBe("Esperar hasta 1 día antes de la cita");
    expect(d.detail).toContain("a las 10:00");
    expect(d.detail).toContain("omitir el mensaje que sigue");
  });

  it("la tarjeta de «Esperar» menciona su ventana", () => {
    expect(describeStep({ stepType: "delay", config: { amount: 1, unit: "days", window: { mode: "at", hour: 10, minute: 0 } } }).detail).toBe(
      "Envía a las 10:00"
    );
    expect(describeStep({ stepType: "delay", config: { amount: 1, unit: "days" } }).detail).toBeNull();
  });
});

/* ─── Disparadores con dobles ─── */

const NOW = iso("2026-11-08T12:00:00Z");
const BOOKING_AT = iso("2026-11-20T20:00:00Z");

function fakeStore(o: { flows?: Record<string, string[]>; conversations?: string[]; failActiveFlows?: boolean } = {}) {
  const keys = new Set<string>();
  const enqueued: EnqueueInput[] = [];
  const cancelled: { bookingId: string; reason: string; except?: string }[] = [];
  const store = {
    listOrganizationIds: vi.fn(async () => ["org_1"]),
    activeFlows: vi.fn(async (_org: string, type: string) => {
      if (o.failActiveFlows) throw new Error("la base se cayó");
      return (o.flows?.[type] ?? []).map((id) => ({ id, organizationId: "org_1", triggerConfig: null }));
    }),
    timezone: vi.fn(async () => "UTC"),
    birthdayContacts: vi.fn(async () => []),
    hasRealConversation: vi.fn(async (_org: string, contactId: string) => (o.conversations ?? ["ct_1"]).includes(contactId)),
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

const event = (over: Partial<BookingEvent> = {}): BookingEvent => ({
  organizationId: "org_1",
  bookingId: "bk_1",
  contactId: "ct_1",
  scheduledAt: BOOKING_AT,
  isTest: false,
  ...over,
});
const on = () => true;
const off = () => false;
const now = () => NOW;

describe("disparadores de cita", () => {
  it("cita creada: encola el primer paso de cada flujo, anclado a la cita y con la hora en la llave", async () => {
    const { store, enqueued } = fakeStore({ flows: { booking_created: ["aut_1", "aut_2"] } });
    expect(await onBookingCreated(event(), store, on, now)).toBe(2);
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]).toMatchObject({
      organizationId: "org_1",
      contactId: "ct_1",
      bookingId: "bk_1",
      scheduledFor: NOW,
      dedupeKey: bookingCreatedDedupeKey("bk_1", BOOKING_AT),
    });
  });

  it("es idempotente: el mismo disparo no encola dos veces", async () => {
    const { store } = fakeStore({ flows: { booking_created: ["aut_1"] } });
    expect(await onBookingCreated(event(), store, on, now)).toBe(1);
    expect(await onBookingCreated(event(), store, on, now)).toBe(0);
  });

  it("una cita de prueba, un bloqueo (sin contacto) o un contacto sin chat real no disparan nada", async () => {
    const t1 = fakeStore({ flows: { booking_created: ["aut_1"] } });
    expect(await onBookingCreated(event({ isTest: true }), t1.store, on, now)).toBe(0);
    expect(t1.store.activeFlows).not.toHaveBeenCalled();
    const t2 = fakeStore({ flows: { booking_created: ["aut_1"] } });
    expect(await onBookingCreated(event({ contactId: null }), t2.store, on, now)).toBe(0);
    const t3 = fakeStore({ flows: { booking_created: ["aut_1"] }, conversations: [] });
    expect(await onBookingCreated(event(), t3.store, on, now)).toBe(0);
    expect(t3.enqueued).toHaveLength(0);
  });

  it("apagado (AUTOMATIONS) no consulta la base", async () => {
    const { store } = fakeStore({ flows: { booking_created: ["aut_1"] } });
    expect(await onBookingCreated(event(), store, off, now)).toBe(0);
    expect(await onBookingConfirmed(event(), store, off, now)).toBe(0);
    expect(await onBookingNoShow(event(), store, off, now)).toBe(0);
    expect(await onBookingRescheduled(event(), store, off, now)).toBe(0);
    expect(await onBookingClosed({ organizationId: "org_1", bookingId: "bk_1" }, "booking_cancelled", store, off)).toBe(0);
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });

  it("un fallo de la base nunca lanza hacia la agenda", async () => {
    const { store } = fakeStore({ failActiveFlows: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(onBookingCreated(event(), store, on, now)).resolves.toBe(0);
    await expect(onBookingConfirmed(event(), store, on, now)).resolves.toBe(0);
    await expect(onBookingNoShow(event(), store, on, now)).resolves.toBe(0);
    spy.mockRestore();
  });

  it("cita confirmada: arranca solo los flujos de ese disparador", async () => {
    const { store, enqueued } = fakeStore({ flows: { booking_created: ["aut_c"], booking_confirmed: ["aut_k"] } });
    expect(await onBookingConfirmed(event(), store, on, now)).toBe(1);
    expect(enqueued[0]).toMatchObject({ flowId: "aut_k", bookingId: "bk_1" });
    expect(enqueued[0]!.dedupeKey).toContain("booking_confirmed:bk_1");
  });

  it("no-show: primero cancela los recordatorios pendientes y luego arranca los flujos de no-show", async () => {
    const { store, enqueued, cancelled } = fakeStore({ flows: { booking_no_show: ["aut_n"] } });
    expect(await onBookingNoShow(event(), store, on, now)).toBe(1);
    // Cancela los recordatorios, pero deja en paz los flujos de no-show (para que repetir la marca no cancele el suyo).
    expect(cancelled).toEqual([{ bookingId: "bk_1", reason: "booking_no_show", except: "booking_no_show" }]);
    expect(enqueued[0]).toMatchObject({ flowId: "aut_n", dedupeKey: bookingNoShowDedupeKey("bk_1") });
  });

  it("reprogramar: cancela lo pendiente y rearma con la hora nueva (otra llave, así no choca con la anterior)", async () => {
    const { store, enqueued, cancelled } = fakeStore({ flows: { booking_created: ["aut_1"] } });
    expect(await onBookingCreated(event(), store, on, now)).toBe(1);
    const moved = iso("2026-11-21T20:00:00Z");
    expect(await onBookingRescheduled(event({ scheduledAt: moved }), store, on, now)).toBe(1);
    expect(cancelled).toEqual([{ bookingId: "bk_1", reason: "booking_rescheduled" }]);
    expect(enqueued).toHaveLength(2);
    expect(enqueued[1]!.dedupeKey).toBe(bookingCreatedDedupeKey("bk_1", moved));
    expect(enqueued[1]!.dedupeKey).not.toBe(enqueued[0]!.dedupeKey);
  });

  it("cancelar o realizar: solo cancela lo pendiente, con su motivo", async () => {
    const { store, cancelled } = fakeStore();
    expect(await onBookingClosed({ organizationId: "org_1", bookingId: "bk_1" }, "booking_cancelled", store, on)).toBe(1);
    expect(await onBookingClosed({ organizationId: "org_1", bookingId: "bk_2" }, "booking_completed", store, on)).toBe(1);
    expect(cancelled).toEqual([
      { bookingId: "bk_1", reason: "booking_cancelled" },
      { bookingId: "bk_2", reason: "booking_completed" },
    ]);
  });
});
