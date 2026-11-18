import { describe, expect, it } from "vitest";
import {
  availableActions,
  computeMetrics,
  decidePayment,
  mrrOf,
  paymentGraceEndsAt,
  planChangeMode,
  type OrgFacts,
  type PlanFacts,
  type SubFacts,
} from "@/lib/saas";

const NOW = new Date("2026-12-01T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const demo: PlanFacts = { id: "plan_demo", name: "Demo", slug: "demo", priceMonthlyCents: 0, currency: "PEN", trialDays: 14, active: true };
const pro: PlanFacts = { id: "plan_pro", name: "Pro", slug: "pro", priceMonthlyCents: 14900, currency: "PEN", trialDays: null, active: true };
const emp: PlanFacts = { id: "plan_emp", name: "Emprendedor", slug: "emp", priceMonthlyCents: 7900, currency: "PEN", trialDays: null, active: true };
const sub = (o: Partial<SubFacts> = {}): SubFacts => ({ status: "active", currentPeriodEnd: day(10), cancelAtPeriodEnd: false, statusReason: "paid", convertedAt: day(-20), ...o });

describe("decidePayment — cobro aprobado", () => {
  it("el primer cobro desde la prueba es la CONVERSIÓN (una sola vez)", () => {
    const d = decidePayment({ event: { kind: "payment_approved", plan: pro }, from: sub({ status: "trialing", convertedAt: null, statusReason: null }), current: demo, now: NOW });
    expect(d).toMatchObject({ noop: false, eventType: "converted", status: "active", isConversion: true, planId: "plan_pro", statusReason: "paid", cancelAtPeriodEnd: false });
    if (!d.noop) expect(d.periodEnd).toEqual(day(30));
  });
  it("desde la prueba vencida (past_due/trial_ended) también convierte", () => {
    const d = decidePayment({ event: { kind: "payment_approved", plan: pro }, from: sub({ status: "past_due", convertedAt: null, statusReason: "trial_ended" }), current: demo, now: NOW });
    expect(d).toMatchObject({ noop: false, eventType: "converted", isConversion: true });
  });
  it("quien ya convirtió antes y vuelve a pagar es «reactivada», no otra conversión", () => {
    const d = decidePayment({ event: { kind: "payment_approved", plan: pro }, from: sub({ status: "canceled", statusReason: "mp_cancelled" }), current: pro, now: NOW });
    expect(d).toMatchObject({ noop: false, eventType: "reactivated", isConversion: false, needsReview: true });
  });
  it("la renovación extiende 30 días desde el fin vigente (un pago adelantado no pierde días)", () => {
    const d = decidePayment({ event: { kind: "payment_approved", plan: pro }, from: sub({ currentPeriodEnd: day(5) }), current: pro, now: NOW });
    expect(d).toMatchObject({ noop: false, eventType: "renewed", status: "active", isConversion: false, planId: null });
    if (!d.noop) expect(d.periodEnd).toEqual(day(35));
  });
  it("si el periodo ya venció, cuenta desde ahora", () => {
    const d = decidePayment({ event: { kind: "payment_approved", plan: pro }, from: sub({ currentPeriodEnd: day(-2) }), current: pro, now: NOW });
    if (!d.noop) expect(d.periodEnd).toEqual(day(30));
  });
  it("tras un rechazo, el reintento aprobado devuelve a activa", () => {
    const d = decidePayment({ event: { kind: "payment_approved", plan: pro }, from: sub({ status: "past_due", statusReason: "payment_failed", currentPeriodEnd: day(-1) }), current: pro, now: NOW });
    expect(d).toMatchObject({ noop: false, eventType: "reactivated", status: "active", statusReason: "paid" });
  });
  it("aplica el cambio de plan programado y lo limpia", () => {
    const d = decidePayment({ event: { kind: "payment_approved", plan: emp }, from: sub({ pendingPlanId: "plan_emp" }), current: pro, now: NOW });
    expect(d).toMatchObject({ noop: false, planId: "plan_emp", planName: "Emprendedor", clearPendingPlan: true });
  });
});

describe("decidePayment — rechazo, cancelación, pausa y reembolso", () => {
  it("rechazo sobre activa → past_due por payment_failed", () => {
    expect(decidePayment({ event: { kind: "payment_rejected" }, from: sub(), current: pro, now: NOW })).toMatchObject({
      noop: false,
      eventType: "payment_failed",
      status: "past_due",
      statusReason: "payment_failed",
    });
  });
  it.each([
    ["prueba", sub({ status: "trialing", convertedAt: null })],
    ["prueba vencida", sub({ status: "past_due", statusReason: "trial_ended", convertedAt: null })],
    ["ya rechazada", sub({ status: "past_due", statusReason: "payment_failed" })],
    ["suspendida", sub({ status: "paused" })],
  ])("rechazo sobre %s no cambia nada", (_n, from) => {
    expect(decidePayment({ event: { kind: "payment_rejected" }, from, current: pro, now: NOW }).noop).toBe(true);
  });
  it("solo «autorizada» no activa (espera al cobro)", () => {
    expect(decidePayment({ event: { kind: "preapproval_authorized" }, from: sub({ status: "trialing", convertedAt: null }), current: demo, now: NOW }).noop).toBe(true);
  });
  it("cancelada en MP con periodo vigente: sigue activa y se cancela al corte; repetida = noop", () => {
    const d = decidePayment({ event: { kind: "preapproval_cancelled" }, from: sub(), current: pro, now: NOW });
    expect(d).toMatchObject({ noop: false, status: "active", cancelAtPeriodEnd: true, statusReason: "mp_cancelled" });
    expect(decidePayment({ event: { kind: "preapproval_cancelled" }, from: sub({ cancelAtPeriodEnd: true }), current: pro, now: NOW }).noop).toBe(true);
  });
  it("cancelada con el periodo vencido, o tras agotar reintentos de cobro: canceled", () => {
    expect(decidePayment({ event: { kind: "preapproval_cancelled" }, from: sub({ currentPeriodEnd: day(-1) }), current: pro, now: NOW })).toMatchObject({ status: "canceled" });
    expect(decidePayment({ event: { kind: "preapproval_cancelled" }, from: sub({ status: "past_due", statusReason: "payment_failed" }), current: pro, now: NOW })).toMatchObject({
      status: "canceled",
      statusReason: "payment_failed",
    });
  });
  it("cancelada en MP sobre una prueba o suspendida: noop", () => {
    expect(decidePayment({ event: { kind: "preapproval_cancelled" }, from: sub({ status: "trialing", convertedAt: null }), current: demo, now: NOW }).noop).toBe(true);
    expect(decidePayment({ event: { kind: "preapproval_cancelled" }, from: sub({ status: "paused" }), current: pro, now: NOW }).noop).toBe(true);
  });
  it("pausada en MP: solo afecta a una activa", () => {
    expect(decidePayment({ event: { kind: "preapproval_paused" }, from: sub(), current: pro, now: NOW })).toMatchObject({ status: "paused", statusReason: "mp_paused" });
    expect(decidePayment({ event: { kind: "preapproval_paused" }, from: sub({ status: "canceled" }), current: pro, now: NOW }).noop).toBe(true);
  });
  it("reembolso o contracargo: no cambia el estado, queda a revisar", () => {
    expect(decidePayment({ event: { kind: "payment_refunded" }, from: sub(), current: pro, now: NOW })).toMatchObject({ noop: false, eventType: "refunded", status: "active", needsReview: true });
  });
  it("sin suscripción: noop", () => {
    expect(decidePayment({ event: { kind: "payment_rejected" }, from: null, current: null, now: NOW }).noop).toBe(true);
  });
});

describe("cambio de plan, gracia y acciones", () => {
  it("subir rige ya, bajar al corte, igual precio no es cambio", () => {
    expect(planChangeMode(7900, 14900)).toBe("immediate");
    expect(planChangeMode(14900, 7900)).toBe("scheduled");
    expect(planChangeMode(7900, 7900)).toBe("same");
  });
  it("la gracia cuenta desde el fin del periodo y solo para cobro fallido", () => {
    const base = { status: "past_due" as const, statusReason: "payment_failed", currentPeriodEnd: NOW };
    expect(paymentGraceEndsAt(base, 5)).toEqual(day(5));
    expect(paymentGraceEndsAt({ ...base, statusReason: "trial_ended" }, 5)).toBeNull();
    expect(paymentGraceEndsAt({ ...base, status: "active" as never }, 5)).toBeNull();
  });
  it("con la pasarela cobrando se ocultan activar/asignar (y reactivar una cancelada)", () => {
    expect(availableActions("active", false, "paid", "mercadopago")).toEqual(["change_plan", "set_period_end", "suspend", "cancel"]);
    expect(availableActions("past_due", false, "payment_failed", "mercadopago")).not.toContain("activate");
    expect(availableActions("canceled", false, "mp_cancelled", "mercadopago")).toEqual(["change_plan"]);
    expect(availableActions("paused", false, "mp_paused", "mercadopago")).toContain("reactivate");
    expect(availableActions("past_due", false, "trial_ended", null)).toContain("activate");
  });
});

describe("MRR y conversión con cobro automático", () => {
  const org = (id: string, plan: PlanFacts, s: SubFacts): OrgFacts => ({ orgId: id, createdAt: day(-40), plan, sub: s });
  it("el MRR usa el precio pactado y no el actual del plan", () => {
    const m = mrrOf([org("a", pro, sub({ billedAmountCents: 9900, billedCurrency: "PEN" })), org("b", pro, sub())], NOW);
    expect(m.mrrCents).toBe(9900 + 14900);
  });
  it("separa las conversiones por origen", () => {
    const s = (id: string): OrgFacts => org(id, pro, sub());
    const ev = (organizationId: string, type: "trial_started" | "converted", source: "signup" | "payment" | "admin", d: number) => ({ organizationId, type, source, occurredAt: day(d), approximate: false });
    const metrics = computeMetrics(
      [s("a"), s("b")],
      [ev("a", "trial_started", "signup", -30), ev("a", "converted", "payment", -20), ev("b", "trial_started", "signup", -30), ev("b", "converted", "admin", -25)],
      NOW
    );
    expect(metrics.conversion.converted).toBe(2);
    expect(metrics.conversion.convertedBy).toEqual({ payment: 1, manual: 1 });
  });
});
