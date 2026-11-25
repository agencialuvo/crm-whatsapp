import { describe, expect, it, vi } from "vitest";
import {
  CONDITION_RULE_TYPES,
  bookingCompletedDedupeKey,
  bookingGuard,
  calendarDaysBetween,
  conditionRuleSchema,
  evaluateCondition,
  evaluateSwitch,
  formatSaleAmount,
  readSaleContext,
  renderVars,
  saleCompletedDedupeKey,
  switchConfigSchema,
  type ConditionFacts,
} from "@/lib/automation";
import { FLOW_TRIGGER_TYPES, flowCreateSchema, parseTriggerConfigFor } from "@/lib/automation-schemas";
import { CONDITION_RULE_LABELS, TRIGGER_HINTS, TRIGGER_LABELS, describeRule, describeTrigger } from "@/lib/automation-dto";
import { PALETTE } from "@/lib/automation-canvas";
import { casesFromConfig, ruleFromCase } from "@/components/automatizaciones/step-extras";
import { onBookingCompleted, onSaleCompleted, type BookingEvent, type SaleCompletedInput } from "@/server/automation/triggers";
import type { EnqueueInput, TriggerStore } from "@/server/automation/trigger-store";

/**
 * Condiciones de citas más completas y los disparadores «Cita realizada» y «Venta cobrada», lo que no necesita base de datos.
 * La consulta real (`contactFacts`), los dos caminos que cierran una cita y el cobro en Caja están en
 * `automation-citas-live.test.ts`.
 */

const facts = (over: Partial<ConditionFacts> = {}): ConditionFacts => ({ tagIds: [], stageId: null, booking: null, ...over });
const ok = (rule: unknown, f: Partial<ConditionFacts>) => evaluateCondition(conditionRuleSchema.parse(rule), facts(f)).result;

describe("reglas nuevas: esquema", () => {
  it("están en el catálogo y todas tienen etiqueta", () => {
    for (const t of ["has_confirmed_upcoming_booking", "upcoming_booking_days_lte", "inactive_for_days_gte", "visits_gte"]) {
      expect(CONDITION_RULE_TYPES).toContain(t);
    }
    for (const t of CONDITION_RULE_TYPES) expect(CONDITION_RULE_LABELS[t], t).toBeTruthy();
  });

  it("validan sus números: enteros, con piso y tope", () => {
    expect(conditionRuleSchema.safeParse({ type: "has_confirmed_upcoming_booking" }).success).toBe(true);
    // «Dentro de 0 días» = hoy, es válido.
    expect(conditionRuleSchema.safeParse({ type: "upcoming_booking_days_lte", days: 0 }).success).toBe(true);
    expect(conditionRuleSchema.safeParse({ type: "upcoming_booking_days_lte", days: -1 }).success).toBe(false);
    expect(conditionRuleSchema.safeParse({ type: "upcoming_booking_days_lte", days: 3651 }).success).toBe(false);
    expect(conditionRuleSchema.safeParse({ type: "upcoming_booking_days_lte" }).success).toBe(false);
    // «0 días sin venir» no significa nada: mínimo 1.
    expect(conditionRuleSchema.safeParse({ type: "inactive_for_days_gte", days: 0 }).success).toBe(false);
    expect(conditionRuleSchema.safeParse({ type: "inactive_for_days_gte", days: 30 }).success).toBe(true);
    expect(conditionRuleSchema.safeParse({ type: "inactive_for_days_gte", days: 1.5 }).success).toBe(false);
    expect(conditionRuleSchema.safeParse({ type: "visits_gte", visits: 0 }).success).toBe(false);
    expect(conditionRuleSchema.safeParse({ type: "visits_gte", visits: 5 }).success).toBe(true);
    expect(conditionRuleSchema.safeParse({ type: "visits_gte", visits: 10_001 }).success).toBe(false);
    expect(conditionRuleSchema.safeParse({ type: "visits_gte", visits: "5" }).success).toBe(false);
  });

  it("sirven en un Switch", () => {
    const cfg = switchConfigSchema.parse({
      cases: [
        { id: "a", label: "Confirmada", rule: { type: "has_confirmed_upcoming_booking" } },
        { id: "b", label: "Esta semana", rule: { type: "upcoming_booking_days_lte", days: 7 } },
        { id: "c", label: "Dormido", rule: { type: "inactive_for_days_gte", days: 60 } },
        { id: "d", label: "Fiel", rule: { type: "visits_gte", visits: 10 } },
      ],
    });
    expect(evaluateSwitch(cfg.cases, facts({ hasConfirmedUpcomingBooking: true, daysToNextBooking: 2 }))).toEqual({ handle: "case_a", caseId: "a" });
    expect(evaluateSwitch(cfg.cases, facts({ hasConfirmedUpcomingBooking: false, daysToNextBooking: 2 })).caseId).toBe("b");
    expect(evaluateSwitch(cfg.cases, facts({ daysSinceLastVisit: 90 })).caseId).toBe("c");
    expect(evaluateSwitch(cfg.cases, facts({ visitCount: 12 })).caseId).toBe("d");
    expect(evaluateSwitch(cfg.cases, facts())).toEqual({ handle: "default", caseId: null });
  });
});

describe("has_confirmed_upcoming_booking", () => {
  it("se cumple solo con una cita futura confirmada, sin importar el tipo de flujo (no usa la cita del disparo)", () => {
    expect(ok({ type: "has_confirmed_upcoming_booking" }, { hasConfirmedUpcomingBooking: true })).toBe(true);
    expect(ok({ type: "has_confirmed_upcoming_booking" }, { hasConfirmedUpcomingBooking: false })).toBe(false);
    // Agendada pero sin confirmar: «tiene cita próxima» sí, «confirmada» no.
    expect(ok({ type: "has_upcoming_booking" }, { hasUpcomingBooking: true, hasConfirmedUpcomingBooking: false })).toBe(true);
    expect(ok({ type: "has_confirmed_upcoming_booking" }, { hasUpcomingBooking: true, hasConfirmedUpcomingBooking: false })).toBe(false);
    // Un dato ausente (quien no lo trae) es «no».
    expect(ok({ type: "has_confirmed_upcoming_booking" }, {})).toBe(false);
    // La cita del disparo confirmada NO basta: esta regla mira las citas futuras del contacto.
    expect(ok({ type: "has_confirmed_upcoming_booking" }, { booking: { confirmedAt: new Date() } })).toBe(false);
  });
});

describe("upcoming_booking_days_lte", () => {
  const rule = { type: "upcoming_booking_days_lte", days: 3 };
  it("compara los días hasta la próxima cita (hoy = 0), con el límite incluido", () => {
    expect(ok(rule, { daysToNextBooking: 0 })).toBe(true);
    expect(ok(rule, { daysToNextBooking: 3 })).toBe(true);
    expect(ok(rule, { daysToNextBooking: 4 })).toBe(false);
    expect(ok({ type: "upcoming_booking_days_lte", days: 0 }, { daysToNextBooking: 0 })).toBe(true);
    expect(ok({ type: "upcoming_booking_days_lte", days: 0 }, { daysToNextBooking: 1 })).toBe(false);
  });
  it("sin próxima cita (null o ausente) no se cumple, ni con un tope enorme", () => {
    expect(ok(rule, { daysToNextBooking: null })).toBe(false);
    expect(ok(rule, {})).toBe(false);
    expect(ok({ type: "upcoming_booking_days_lte", days: 3650 }, { daysToNextBooking: null })).toBe(false);
  });
});

describe("inactive_for_days_gte", () => {
  const rule = { type: "inactive_for_days_gte", days: 30 };
  it("se cumple con N días o más desde la última visita, con el límite incluido", () => {
    expect(ok(rule, { daysSinceLastVisit: 30 })).toBe(true);
    expect(ok(rule, { daysSinceLastVisit: 200 })).toBe(true);
    expect(ok(rule, { daysSinceLastVisit: 29 })).toBe(false);
    expect(ok(rule, { daysSinceLastVisit: 0 })).toBe(false);
  });
  it("quien nunca vino (null o ausente) NO cumple, y es el inverso exacto de «vino en los últimos N días» solo para quien sí vino", () => {
    expect(ok(rule, { daysSinceLastVisit: null })).toBe(false);
    expect(ok(rule, {})).toBe(false);
    // Para quien nunca vino, «vino en los últimos 30 días» también es «No»: ahí se usa esa regla con la rama «No».
    expect(ok({ type: "visited_within_days", days: 30 }, { daysSinceLastVisit: null })).toBe(false);
    // Quien sí vino: o vino dentro de 29 días, o lleva 30 o más. Nunca ambas, nunca ninguna.
    for (const d of [0, 1, 29, 30, 31, 365]) {
      const dentro = ok({ type: "visited_within_days", days: 29 }, { daysSinceLastVisit: d });
      const fuera = ok({ type: "inactive_for_days_gte", days: 30 }, { daysSinceLastVisit: d });
      expect(dentro !== fuera, `d=${d}`).toBe(true);
    }
  });
});

describe("visits_gte", () => {
  it("se cumple con N visitas o más; sin dato, cuenta como cero", () => {
    expect(ok({ type: "visits_gte", visits: 3 }, { visitCount: 3 })).toBe(true);
    expect(ok({ type: "visits_gte", visits: 3 }, { visitCount: 9 })).toBe(true);
    expect(ok({ type: "visits_gte", visits: 3 }, { visitCount: 2 })).toBe(false);
    expect(ok({ type: "visits_gte", visits: 1 }, { visitCount: 0 })).toBe(false);
    expect(ok({ type: "visits_gte", visits: 1 }, {})).toBe(false);
  });
});

describe("calendarDaysBetween", () => {
  it("cuenta días de calendario, cruzando fin de mes, de año y bisiestos", () => {
    expect(calendarDaysBetween("2026-11-25", "2026-11-25")).toBe(0);
    expect(calendarDaysBetween("2026-11-25", "2026-11-26")).toBe(1);
    expect(calendarDaysBetween("2026-11-25", "2026-12-25")).toBe(30);
    expect(calendarDaysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(calendarDaysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(calendarDaysBetween("2027-02-28", "2027-03-01")).toBe(1);
    expect(calendarDaysBetween("2026-11-26", "2026-11-25")).toBe(-1);
  });
});

describe("guardia de la cita para «Cita realizada»", () => {
  it("solo sigue mientras la cita esté realizada; una cancelada o reabierta cancela la tarea", () => {
    expect(bookingGuard("booking_completed", { status: "realizada" })).toBeNull();
    expect(bookingGuard("booking_completed", { status: "agendada" })).toBe("booking_no_longer_completed");
    expect(bookingGuard("booking_completed", { status: "cancelada" })).toBe("booking_no_longer_completed");
    expect(bookingGuard("booking_completed", { status: "no_show" })).toBe("booking_no_longer_completed");
    expect(bookingGuard("booking_completed", null)).toBe("booking_not_found");
  });
  it("los demás disparadores de cita siguen exigiendo una cita agendada (no cambió)", () => {
    expect(bookingGuard("booking_created", { status: "agendada" })).toBeNull();
    expect(bookingGuard("booking_created", { status: "realizada" })).toBe("booking_not_active");
    expect(bookingGuard("booking_confirmed", { status: "realizada" })).toBe("booking_not_active");
    expect(bookingGuard("booking_no_show", { status: "no_show" })).toBeNull();
  });
});

describe("disparadores nuevos: contrato", () => {
  it("se pueden crear, sin ajustes, y rechazan claves de más", () => {
    for (const t of ["booking_completed", "sale_completed"] as const) {
      expect(FLOW_TRIGGER_TYPES).toContain(t);
      expect(flowCreateSchema.safeParse({ name: "Reseña", triggerType: t }).success).toBe(true);
      expect(parseTriggerConfigFor(t, {})).toEqual({ ok: true, value: null });
      expect(parseTriggerConfigFor(t, { stamps: 3 }).ok).toBe(false);
    }
  });

  it("tienen nombre, ayuda, frase y bloque en la paleta (una cita realizada es un flujo de cita; una venta no)", () => {
    expect(TRIGGER_LABELS.booking_completed).toBe("Cita realizada");
    expect(TRIGGER_LABELS.sale_completed).toBe("Venta cobrada");
    expect(TRIGGER_HINTS.booking_completed).toMatch(/realizada/);
    expect(TRIGGER_HINTS.sale_completed).toMatch(/\{\{monto\}\}/);
    expect(describeTrigger("booking_completed", null)).toMatch(/realizada/);
    expect(describeTrigger("sale_completed", null)).toMatch(/venta/);
    const bc = PALETTE.find((p) => p.id === "trigger:booking_completed");
    const sc = PALETTE.find((p) => p.id === "trigger:sale_completed");
    expect(bc).toMatchObject({ label: "Cita realizada", category: "triggers", group: "Citas", icon: "CalendarCheck2" });
    expect(sc).toMatchObject({ label: "Venta cobrada", category: "triggers", group: "Ventas", icon: "Receipt" });
    expect("booking_completed".startsWith("booking_")).toBe(true);
    expect("sale_completed".startsWith("booking_")).toBe(false);
  });

  it("las llaves de idempotencia: una por cita y una por venta", () => {
    expect(bookingCompletedDedupeKey("bk_1")).toBe("booking_completed:bk_1");
    expect(saleCompletedDedupeKey("ssl_9")).toBe("sale_completed:ssl_9");
  });
});

describe("textos y formulario de las reglas", () => {
  it("la tarjeta lo dice en una frase", () => {
    expect(describeRule({ type: "has_confirmed_upcoming_booking" })).toBe("El contacto tiene una cita próxima confirmada");
    expect(describeRule({ type: "upcoming_booking_days_lte", days: 3 })).toBe("Su próxima cita es dentro de 3 días o menos");
    expect(describeRule({ type: "upcoming_booking_days_lte", days: 1 })).toBe("Su próxima cita es dentro de 1 día o menos");
    expect(describeRule({ type: "upcoming_booking_days_lte", days: 0 })).toBe("Su próxima cita es hoy");
    expect(describeRule({ type: "inactive_for_days_gte", days: 30 })).toBe("Lleva 30 días o más sin venir");
    expect(describeRule({ type: "visits_gte", visits: 1 })).toBe("Tiene al menos 1 visita");
    expect(describeRule({ type: "visits_gte", visits: 8 })).toBe("Tiene al menos 8 visitas");
    expect(describeRule({ type: "visits_gte" })).toMatch(/sin configurar/);
    expect(describeRule({ type: "inactive_for_days_gte" })).toMatch(/sin configurar/);
  });

  it("el formulario del Switch las guarda y las lee ida y vuelta, con un resultado que el esquema acepta", () => {
    const reglas = [
      { type: "has_confirmed_upcoming_booking" },
      { type: "upcoming_booking_days_lte", days: 2 },
      { type: "inactive_for_days_gte", days: 45 },
      { type: "visits_gte", visits: 6 },
    ];
    const casos = casesFromConfig(reglas.map((rule, i) => ({ id: `c${i}`, label: `Caso ${i}`, rule })));
    expect(casos.map((c) => c.type)).toEqual(reglas.map((r) => r.type));
    expect(casos.map(ruleFromCase)).toEqual(reglas);
    for (const r of casos.map(ruleFromCase)) expect(conditionRuleSchema.safeParse(r).success).toBe(true);
  });
});

describe("variables de la venta", () => {
  it("{{monto}} sale sin símbolo ni ceros de más, y vacío fuera de un flujo de venta", () => {
    const sale = { saleId: "s1", amountCents: 125_000, paymentMethod: "efectivo", itemName: "Corte", bookingId: null };
    expect(renderVars("Pagaste ${{monto}}", { name: "Ana", sale })).toBe("Pagaste $1250");
    expect(renderVars("{{monto}}", { name: "Ana", sale: { ...sale, amountCents: 125_050 } })).toBe("1250.50");
    expect(renderVars("{{monto}}", { name: "Ana", sale: { ...sale, amountCents: 5 } })).toBe("0.05");
    expect(renderVars("Total: {{monto}}", { name: "Ana" })).toBe("Total:");
    expect(renderVars("Total: {{monto}}", { name: "Ana", sale: null })).toBe("Total:");
  });
  it("un dato con llaves no se vuelve a interpretar", () => {
    expect(renderVars("{{servicio}}", { name: "Ana", servicio: "{{monto}}", sale: { saleId: "s", amountCents: 100, paymentMethod: null, itemName: null, bookingId: null } })).toBe("{{monto}}");
  });
  it("readSaleContext lee con tolerancia y formatSaleAmount redondea limpio", () => {
    expect(readSaleContext({ sale: { saleId: "s1", amountCents: 5000, paymentMethod: "tarjeta", itemName: "Corte", bookingId: "bk_1" } })).toEqual({
      saleId: "s1",
      amountCents: 5000,
      paymentMethod: "tarjeta",
      itemName: "Corte",
      bookingId: "bk_1",
    });
    expect(readSaleContext({ sale: { saleId: "s1", amountCents: 5000 } })).toMatchObject({ paymentMethod: null, itemName: null, bookingId: null });
    for (const raw of [null, undefined, {}, { sale: null }, { sale: [] }, { sale: "x" }, { sale: { amountCents: 1 } }, { sale: { saleId: "s", amountCents: "1" } }, { sale: { saleId: "s", amountCents: Infinity } }]) {
      expect(readSaleContext(raw as never)).toBeNull();
    }
    expect(formatSaleAmount(0)).toBe("0");
    expect(formatSaleAmount(100)).toBe("1");
    expect(formatSaleAmount(199)).toBe("1.99");
  });
});

/* ─── Disparadores con dobles ─── */

const NOW = new Date("2026-11-25T12:00:00Z");
const BOOKING_AT = new Date("2026-11-25T10:00:00Z");

function fakeStore(o: { flows?: Record<string, string[]>; conversations?: string[]; failActiveFlows?: boolean } = {}) {
  const keys = new Set<string>();
  const enqueued: EnqueueInput[] = [];
  const cancelled: { bookingId: string; reason: string; except?: string }[] = [];
  const store = {
    listOrganizationIds: vi.fn(async () => ["org_1"]),
    activeFlows: vi.fn(async (org: string, type: string) => {
      if (o.failActiveFlows) throw new Error("la base se cayó");
      return (o.flows?.[type] ?? []).map((id) => ({ id, organizationId: org, triggerConfig: null }));
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

const on = () => true;
const now = () => NOW;
const bookingEvent = (over: Partial<BookingEvent> = {}): BookingEvent => ({ organizationId: "org_1", bookingId: "bk_1", contactId: "ct_1", scheduledAt: BOOKING_AT, isTest: false, ...over });
const sale = (over: Partial<SaleCompletedInput> = {}): SaleCompletedInput => ({
  organizationId: "org_1",
  saleId: "ssl_1",
  contactId: "ct_1",
  amountCents: 125_000,
  paymentMethod: "efectivo",
  itemName: "Corte + Barba",
  bookingId: null,
  ...over,
});

describe("onBookingCompleted", () => {
  it("cancela los recordatorios (menos los flujos del propio disparador) y arranca los flujos de «Cita realizada», anclados a la cita", async () => {
    const { store, enqueued, cancelled } = fakeStore({ flows: { booking_completed: ["aut_r1", "aut_r2"], booking_created: ["aut_c"] } });
    expect(await onBookingCompleted(bookingEvent(), store, on, now)).toBe(2);
    expect(cancelled).toEqual([{ bookingId: "bk_1", reason: "booking_completed", except: "booking_completed" }]);
    expect(enqueued.map((e) => e.flowId)).toEqual(["aut_r1", "aut_r2"]);
    expect(enqueued[0]).toMatchObject({ organizationId: "org_1", contactId: "ct_1", bookingId: "bk_1", scheduledFor: NOW, dedupeKey: "booking_completed:bk_1" });
  });

  it("es idempotente: marcarla dos veces, o marcarla y luego cobrarla, arranca una sola vez", async () => {
    const { store } = fakeStore({ flows: { booking_completed: ["aut_r"] } });
    expect(await onBookingCompleted(bookingEvent(), store, on, now)).toBe(1);
    expect(await onBookingCompleted(bookingEvent(), store, on, now)).toBe(0);
    expect(await onBookingCompleted(bookingEvent({ scheduledAt: new Date("2026-11-26T10:00:00Z") }), store, on, now)).toBe(0);
  });

  it("una cita de prueba, un bloqueo, un contacto sin chat real o la app apagada no disparan nada", async () => {
    const t1 = fakeStore({ flows: { booking_completed: ["aut_r"] } });
    expect(await onBookingCompleted(bookingEvent({ isTest: true }), t1.store, on, now)).toBe(0);
    expect(await onBookingCompleted(bookingEvent({ contactId: null }), t1.store, on, now)).toBe(0);
    expect(t1.enqueued).toHaveLength(0);
    const t2 = fakeStore({ flows: { booking_completed: ["aut_r"] }, conversations: [] });
    expect(await onBookingCompleted(bookingEvent(), t2.store, on, now)).toBe(0);
    const t3 = fakeStore({ flows: { booking_completed: ["aut_r"] } });
    expect(await onBookingCompleted(bookingEvent(), t3.store, () => false, now)).toBe(0);
    for (const fn of Object.values(t3.store)) expect(fn).not.toHaveBeenCalled();
  });

  it("un fallo de la base nunca lanza hacia la agenda ni hacia Caja", async () => {
    const { store } = fakeStore({ failActiveFlows: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(onBookingCompleted(bookingEvent(), store, on, now)).resolves.toBe(0);
    spy.mockRestore();
  });

  it("solo arranca los flujos de su disparador, no los de cita confirmada ni no-show", async () => {
    const { store, enqueued } = fakeStore({ flows: { booking_confirmed: ["aut_k"], booking_no_show: ["aut_n"] } });
    expect(await onBookingCompleted(bookingEvent(), store, on, now)).toBe(0);
    expect(enqueued).toHaveLength(0);
  });
});

describe("onSaleCompleted", () => {
  it("arranca cada flujo de «Venta cobrada» con el contexto del cobro, SIN la cita en la ejecución (ya está realizada)", async () => {
    const { store, enqueued } = fakeStore({ flows: { sale_completed: ["aut_s1", "aut_s2"] } });
    expect(await onSaleCompleted(sale({ bookingId: "bk_7" }), store, on, now)).toBe(2);
    expect(enqueued[0]).toMatchObject({
      organizationId: "org_1",
      flowId: "aut_s1",
      contactId: "ct_1",
      scheduledFor: NOW,
      dedupeKey: "sale_completed:ssl_1",
      context: {
        serviceName: "Corte + Barba",
        sale: { saleId: "ssl_1", amountCents: 125_000, paymentMethod: "efectivo", itemName: "Corte + Barba", bookingId: "bk_7" },
      },
    });
    // Con una cita en la ejecución la guardia de citas la cancelaría (estado «realizada»): no debe viajar.
    expect(enqueued[0]).not.toHaveProperty("bookingId");
  });

  it("una sola vez por venta, y otra venta es otro disparo", async () => {
    const { store } = fakeStore({ flows: { sale_completed: ["aut_s"] } });
    expect(await onSaleCompleted(sale(), store, on, now)).toBe(1);
    expect(await onSaleCompleted(sale(), store, on, now)).toBe(0);
    expect(await onSaleCompleted(sale({ saleId: "ssl_2" }), store, on, now)).toBe(1);
  });

  it("sin cliente identificado, sin chat real o apagado, no dispara; sin nombre de lo vendido, no inventa {{servicio}}", async () => {
    const a = fakeStore({ flows: { sale_completed: ["aut_s"] } });
    expect(await onSaleCompleted(sale({ contactId: null }), a.store, on, now)).toBe(0);
    expect(a.store.activeFlows).not.toHaveBeenCalled();
    const b = fakeStore({ flows: { sale_completed: ["aut_s"] }, conversations: [] });
    expect(await onSaleCompleted(sale(), b.store, on, now)).toBe(0);
    const c = fakeStore({ flows: { sale_completed: ["aut_s"] } });
    expect(await onSaleCompleted(sale(), c.store, () => false, now)).toBe(0);
    expect(c.store.activeFlows).not.toHaveBeenCalled();
    const d = fakeStore({ flows: { sale_completed: ["aut_s"] } });
    await onSaleCompleted(sale({ itemName: null }), d.store, on, now);
    expect((d.enqueued[0]!.context as Record<string, unknown>).serviceName).toBeUndefined();
  });

  it("aislamiento: solo busca los flujos de su organización, y un fallo no lanza", async () => {
    const a = fakeStore({ flows: { sale_completed: ["aut_s"] } });
    await onSaleCompleted(sale({ organizationId: "org_9" }), a.store, on, now);
    expect(a.store.activeFlows).toHaveBeenCalledWith("org_9", "sale_completed");
    expect(a.store.hasRealConversation).toHaveBeenCalledWith("org_9", "ct_1");
    expect(a.enqueued[0]).toMatchObject({ organizationId: "org_9" });
    const roto = fakeStore({ failActiveFlows: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(onSaleCompleted(sale(), roto.store, on, now)).resolves.toBe(0);
    spy.mockRestore();
  });
});
