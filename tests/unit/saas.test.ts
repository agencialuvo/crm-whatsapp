import { describe, expect, it } from "vitest";
import {
  ACTION_LABEL,
  availableActions,
  computeMetrics,
  conversionOf,
  DAY_MS,
  decideTransition,
  effectiveStatus,
  mrrOf,
  PAID_PERIOD_DAYS,
  statusLabelOf,
  SUB_ACTIONS,
  type EventFacts,
  type OrgFacts,
  type PlanFacts,
  type SubAction,
  type SubFacts,
  type SubStatus,
} from "@/lib/saas";

/** 045 — Las reglas de la suscripción y las métricas del panel, sin base de datos. La contraparte SQL: super-admin-live. */

const NOW = new Date("2026-11-17T12:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

const demo: PlanFacts = { id: "plan_demo", name: "Demo", slug: "demo", priceMonthlyCents: 0, currency: "PEN", trialDays: 14, active: true };
const emp: PlanFacts = { id: "plan_emp", name: "Emprendedor", slug: "emprendedor", priceMonthlyCents: 7900, currency: "PEN", trialDays: null, active: true };
const pro: PlanFacts = { id: "plan_pro", name: "Pro", slug: "pro", priceMonthlyCents: 14900, currency: "PEN", trialDays: null, active: true };
const ent: PlanFacts = { id: "plan_ent", name: "Enterprise", slug: "enterprise", priceMonthlyCents: 29900, currency: "PEN", trialDays: null, active: true };
const basico: PlanFacts = { id: "plan_basico", name: "Básico", slug: "basico", priceMonthlyCents: 0, currency: "PEN", trialDays: null, active: false };

const sub = (status: SubStatus, end: Date, over: Partial<SubFacts> = {}): SubFacts => ({
  status,
  currentPeriodEnd: end,
  cancelAtPeriodEnd: false,
  statusReason: null,
  convertedAt: null,
  ...over,
});

describe("effectiveStatus", () => {
  it("una prueba vigente es trialing con sus días restantes (redondeados hacia arriba)", () => {
    expect(effectiveStatus(sub("trialing", days(14)), demo, NOW)).toEqual({ status: "trialing", daysLeft: 14 });
    expect(effectiveStatus(sub("trialing", new Date(NOW.getTime() + 3 * 3600_000)), demo, NOW)).toEqual({ status: "trialing", daysLeft: 1 });
  });

  it("una prueba de un plan de prueba con el periodo vencido se ve como trial_expired (aunque el temporizador no la haya persistido)", () => {
    expect(effectiveStatus(sub("trialing", days(-1)), demo, NOW)).toEqual({ status: "trial_expired", daysLeft: 0 });
  });

  it("los planes de pago y los anteriores NO vencen solos (hoy no vencían y siguen sin vencer)", () => {
    expect(effectiveStatus(sub("trialing", days(-40)), basico, NOW).status).toBe("trialing");
    expect(effectiveStatus(sub("trialing", days(-40)), pro, NOW).status).toBe("trialing");
    expect(effectiveStatus(sub("active", days(-40)), pro, NOW).status).toBe("active");
  });

  it("el resto de estados se devuelve tal cual, sin días", () => {
    for (const s of ["active", "past_due", "canceled", "paused"] as const) {
      expect(effectiveStatus(sub(s, days(5)), pro, NOW)).toEqual({ status: s, daysLeft: null });
    }
  });

  it("past_due por una prueba vencida se llama «Prueba vencida»; por un pago, «Pago vencido»", () => {
    expect(statusLabelOf("past_due", "trial_ended")).toBe("Prueba vencida");
    expect(statusLabelOf("past_due", "payment_failed")).toBe("Pago vencido");
    expect(statusLabelOf("trial_expired", null)).toBe("Prueba vencida");
  });
});

describe("decideTransition — la tabla completa", () => {
  const STATUSES: SubStatus[] = ["trialing", "active", "past_due", "canceled", "paused"];
  const decide = (action: SubAction, status: SubStatus | null, plan: PlanFacts | null, input = {}, over: Partial<SubFacts> = {}) =>
    decideTransition({
      action,
      from: status ? sub(status, days(5), over) : null,
      current: status ? plan : null,
      input,
      now: NOW,
    });

  it("assign: solo sin suscripción; un plan de prueba abre la prueba, uno de pago queda activo 30 días", () => {
    const d = decide("assign", null, null, { plan: demo });
    expect(d).toMatchObject({ ok: true, status: "trialing", eventType: "assigned", planId: demo.id });
    expect(d.ok && d.periodEnd?.getTime()).toBe(days(14).getTime());
    const p = decide("assign", null, null, { plan: pro });
    expect(p).toMatchObject({ ok: true, status: "active", eventType: "assigned" });
    expect(p.ok && p.periodEnd?.getTime()).toBe(days(PAID_PERIOD_DAYS).getTime());
    expect(decide("assign", null, null)).toMatchObject({ ok: false, code: "plan_required" });
    for (const s of STATUSES) expect(decide("assign", s, pro, { plan: pro })).toMatchObject({ ok: false, code: "invalid_transition" });
  });

  it("sin suscripción, solo se puede asignar", () => {
    for (const a of SUB_ACTIONS.filter((x) => x !== "assign")) {
      expect(decide(a, null, null, { plan: pro, days: 7, periodEnd: days(5) }), a).toMatchObject({ ok: false, code: "invalid_transition" });
    }
  });

  it("activate: desde trialing/past_due/paused/canceled a un plan de PAGO; nunca desde active", () => {
    for (const s of ["trialing", "past_due", "paused", "canceled"] as const) {
      const d = decide("activate", s, demo, { plan: pro });
      expect(d, s).toMatchObject({ ok: true, status: "active", planId: pro.id });
      expect(d.ok && d.periodEnd?.getTime()).toBe(days(PAID_PERIOD_DAYS).getTime());
    }
    expect(decide("activate", "active", pro, { plan: ent })).toMatchObject({ ok: false, code: "invalid_transition" });
    // sin plan de pago de destino (y el actual es de prueba) → plan_required
    expect(decide("activate", "trialing", demo)).toMatchObject({ ok: false, code: "plan_required" });
    expect(decide("activate", "trialing", demo, { plan: demo })).toMatchObject({ ok: false, code: "plan_required" });
    // si el plan actual ya es de pago, se activa con él
    expect(decide("activate", "past_due", pro)).toMatchObject({ ok: true, status: "active", planId: null });
  });

  it("activar una PRUEBA es la conversión (evento converted, marca isConversion); activar una suspendida no", () => {
    expect(decide("activate", "trialing", demo, { plan: emp })).toMatchObject({ eventType: "converted", isConversion: true });
    // una prueba vencida (past_due por trial_ended) que paga después también convierte
    expect(decide("activate", "past_due", demo, { plan: emp }, { statusReason: "trial_ended" })).toMatchObject({ eventType: "converted", isConversion: true });
    // una suspendida / cancelada que se reactiva NO es conversión
    expect(decide("activate", "paused", emp, {})).toMatchObject({ eventType: "reactivated", isConversion: false });
    expect(decide("reactivate", "canceled", emp)).toMatchObject({ eventType: "reactivated", isConversion: false });
    // una que ya convirtió no vuelve a convertir
    expect(decide("activate", "trialing", demo, { plan: emp }, { convertedAt: days(-3) })).toMatchObject({ isConversion: false });
  });

  it("reactivate: solo suspendida o cancelada, con plan de pago", () => {
    for (const s of ["paused", "canceled"] as const) expect(decide("reactivate", s, emp), s).toMatchObject({ ok: true, status: "active" });
    for (const s of ["trialing", "active", "past_due"] as const) expect(decide("reactivate", s, emp), s).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(decide("reactivate", "paused", demo)).toMatchObject({ ok: false, code: "plan_required" });
  });

  it("change_plan: cualquier estado, solo cambia el plan; el mismo plan es inválido", () => {
    for (const s of STATUSES) {
      const d = decide("change_plan", s, emp, { plan: pro });
      expect(d, s).toMatchObject({ ok: true, status: s, planId: pro.id, eventType: "plan_changed", periodEnd: null });
    }
    expect(decide("change_plan", "active", emp, { plan: emp })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(decide("change_plan", "active", emp)).toMatchObject({ ok: false, code: "plan_required" });
  });

  it("extend_trial: solo una prueba en curso o vencida de un plan de prueba; suma desde el fin (o desde hoy si ya venció)", () => {
    const d = decide("extend_trial", "trialing", demo, { days: 7 });
    expect(d).toMatchObject({ ok: true, status: "trialing", eventType: "trial_extended" });
    expect(d.ok && d.periodEnd?.getTime()).toBe(days(5 + 7).getTime()); // el fin vigente era hoy + 5
    // vencida: se reabre desde hoy
    const vencida = decideTransition({ action: "extend_trial", from: sub("past_due", days(-10), { statusReason: "trial_ended" }), current: demo, input: { days: 7 }, now: NOW });
    expect(vencida).toMatchObject({ ok: true, status: "trialing" });
    expect(vencida.ok && vencida.periodEnd?.getTime()).toBe(days(7).getTime());
    // no aplica
    expect(decide("extend_trial", "active", demo, { days: 7 })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(decide("extend_trial", "past_due", demo, { days: 7 }, { statusReason: "payment_failed" })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(decide("extend_trial", "trialing", pro, { days: 7 })).toMatchObject({ ok: false, code: "not_trial_plan" });
  });

  it("extend_trial: los días van de 1 a 90 y son enteros", () => {
    for (const bad of [0, -3, 91, 1.5, Number.NaN, undefined]) {
      expect(decide("extend_trial", "trialing", demo, { days: bad as number }), String(bad)).toMatchObject({ ok: false, code: "invalid_input" });
    }
    for (const good of [1, 14, 90]) expect(decide("extend_trial", "trialing", demo, { days: good })).toMatchObject({ ok: true });
  });

  it("set_period_end: solo en prueba o activa, con una fecha futura", () => {
    expect(decide("set_period_end", "active", pro, { periodEnd: days(20) })).toMatchObject({ ok: true, eventType: "period_changed", status: "active" });
    expect(decide("set_period_end", "trialing", demo, { periodEnd: days(20) })).toMatchObject({ ok: true });
    expect(decide("set_period_end", "active", pro, { periodEnd: days(-1) })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(decide("set_period_end", "active", pro, { periodEnd: new Date("x") })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(decide("set_period_end", "active", pro)).toMatchObject({ ok: false, code: "invalid_input" });
    for (const s of ["past_due", "paused", "canceled"] as const) expect(decide("set_period_end", s, pro, { periodEnd: days(5) }), s).toMatchObject({ ok: false, code: "invalid_transition" });
  });

  it("suspend: desde trialing/active/past_due; no desde paused ni canceled", () => {
    for (const s of ["trialing", "active", "past_due"] as const) expect(decide("suspend", s, pro), s).toMatchObject({ ok: true, status: "paused", statusReason: "manual" });
    for (const s of ["paused", "canceled"] as const) expect(decide("suspend", s, pro), s).toMatchObject({ ok: false, code: "invalid_transition" });
  });

  it("cancel: desde cualquier estado menos canceled; «al final del periodo» solo en una activa y la deja activa", () => {
    for (const s of ["trialing", "active", "past_due", "paused"] as const) expect(decide("cancel", s, pro), s).toMatchObject({ ok: true, status: "canceled" });
    expect(decide("cancel", "canceled", pro)).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(decide("cancel", "active", pro, { cancelAtPeriodEnd: true })).toMatchObject({ ok: true, status: "active", cancelAtPeriodEnd: true });
    expect(decide("cancel", "trialing", demo, { cancelAtPeriodEnd: true })).toMatchObject({ ok: false, code: "invalid_transition" });
  });

  it("toda acción tiene su etiqueta", () => {
    for (const a of SUB_ACTIONS) expect(ACTION_LABEL[a].length, a).toBeGreaterThan(2);
  });
});

describe("availableActions coincide con decideTransition", () => {
  it("ninguna acción que se ofrece en pantalla es una transición inválida (y todas las válidas se ofrecen, salvo la redundancia activate/reactivate)", () => {
    const cases: { status: SubStatus; plan: PlanFacts; reason?: string | null; eff: Parameters<typeof availableActions>[0] }[] = [
      { status: "trialing", plan: demo, eff: "trialing" },
      { status: "trialing", plan: demo, eff: "trial_expired" },
      { status: "past_due", plan: demo, reason: "trial_ended", eff: "past_due" },
      { status: "past_due", plan: pro, reason: "payment_failed", eff: "past_due" },
      { status: "active", plan: pro, eff: "active" },
      { status: "paused", plan: pro, eff: "paused" },
      { status: "canceled", plan: pro, eff: "canceled" },
    ];
    for (const c of cases) {
      const offered = availableActions(c.eff, c.plan.trialDays !== null, c.reason);
      for (const a of offered) {
        const d = decideTransition({
          action: a,
          from: sub(c.status, days(5), { statusReason: c.reason }),
          current: c.plan,
          input: { plan: a === "change_plan" ? ent : emp, days: 7, periodEnd: days(9) },
          now: NOW,
        });
        expect(d.ok, `${c.status}/${c.eff}: ${a} → ${d.ok ? "" : d.message}`).toBe(true);
      }
    }
    expect(availableActions(null, false)).toEqual(["assign"]);
  });
});

describe("mrrOf", () => {
  const org = (id: string, plan: PlanFacts | null, s: SubFacts | null, createdAt = days(-30)): OrgFacts => ({ orgId: id, createdAt, plan, sub: s });

  it("suma solo las activas de planes de pago; una prueba no es ingreso", () => {
    const orgs = [
      org("a", emp, sub("active", days(10))),
      org("b", pro, sub("active", days(10))),
      org("c", ent, sub("active", days(10))),
      org("d", demo, sub("trialing", days(10))),
      org("e", pro, sub("paused", days(10))),
      org("f", pro, sub("canceled", days(10))),
    ];
    const m = mrrOf(orgs, NOW);
    expect(m.mrrCents).toBe(7900 + 14900 + 29900);
    expect(m.activeCount).toBe(3);
    expect(m.arrCents).toBe(m.mrrCents * 12);
    expect(m.arpaCents).toBe(Math.round(m.mrrCents / 3));
  });

  it("separa el MRR en salida (cancelan al corte) y el ingreso en riesgo (past_due de pago)", () => {
    const m = mrrOf(
      [org("a", pro, sub("active", days(10), { cancelAtPeriodEnd: true })), org("b", emp, sub("active", days(10))), org("c", pro, sub("past_due", days(-3)))],
      NOW
    );
    expect(m.mrrCents).toBe(14900 + 7900);
    expect(m.churningMrrCents).toBe(14900);
    expect(m.atRiskCents).toBe(14900);
  });

  it("un plan en otra moneda no se suma y se avisa", () => {
    const usd: PlanFacts = { ...pro, id: "plan_usd", currency: "USD" };
    const m = mrrOf([org("a", usd, sub("active", days(10))), org("b", emp, sub("active", days(10)))], NOW);
    expect(m.mrrCents).toBe(7900);
    expect(m.mixedCurrency).toBe(true);
  });

  it("sin activas: todo en cero y sin dividir entre cero", () => {
    expect(mrrOf([], NOW)).toMatchObject({ mrrCents: 0, arpaCents: 0, activeCount: 0, mixedCurrency: false });
  });
});

describe("conversionOf", () => {
  const org = (id: string, plan: PlanFacts, s: SubFacts): OrgFacts => ({ orgId: id, createdAt: days(-60), plan, sub: s });
  const ev = (organizationId: string, type: EventFacts["type"], at: Date, approximate = false): EventFacts => ({ organizationId, type, occurredAt: at, approximate });

  // Seis pruebas iniciadas: 2 convirtieron, 1 vencida, 1 cancelada, 2 en curso.
  const orgs = [
    org("conv1", pro, sub("active", days(20))),
    org("conv2", emp, sub("active", days(20))),
    org("venc", demo, sub("past_due", days(-5), { statusReason: "trial_ended" })),
    org("canc", demo, sub("canceled", days(-5))),
    org("curso1", demo, sub("trialing", days(5))),
    org("curso2", demo, sub("trialing", days(9))),
  ];
  const events: EventFacts[] = [
    ev("conv1", "trial_started", days(-30)),
    ev("conv1", "converted", days(-20)), // 10 días
    ev("conv2", "trial_started", days(-30)),
    ev("conv2", "converted", days(-26)), // 4 días
    ev("venc", "trial_started", days(-30)),
    ev("canc", "trial_started", days(-30)),
    ev("curso1", "trial_started", days(-9)),
    ev("curso2", "trial_started", days(-5)),
  ];

  it("cuenta iniciadas, convertidas, en curso y perdidas", () => {
    const c = conversionOf(orgs, events, NOW);
    expect(c).toMatchObject({ started: 6, converted: 2, inProgress: 2, lost: 2 });
  });

  it("la tasa CERRADA no se deprime con las pruebas en curso: 2 / (2 + 2); la total es 2 / 6", () => {
    const c = conversionOf(orgs, events, NOW);
    expect(c.closedRate).toBeCloseTo(0.5, 6);
    expect(c.totalRate).toBeCloseTo(2 / 6, 6);
  });

  it("la mediana de días hasta convertir", () => {
    expect(conversionOf(orgs, events, NOW).medianDaysToConvert).toBeCloseTo(7, 6); // mediana de 10 y 4
  });

  it("las filas APROXIMADAS (sembradas por la migración) no cuentan, y se informa cuántas se dejaron fuera", () => {
    const withApprox = [...events, ev("legacy", "trial_started", days(-100), true)];
    const c = conversionOf([...orgs, org("legacy", basico, sub("trialing", days(5)))], withApprox, NOW);
    expect(c.started).toBe(6);
    expect(c.excludedApproximate).toBe(1);
  });

  it("sin pruebas cerradas, las tasas son null (no 0 %)", () => {
    const c = conversionOf([org("x", demo, sub("trialing", days(5)))], [ev("x", "trial_started", days(-2))], NOW);
    expect(c).toMatchObject({ started: 1, converted: 0, inProgress: 1, lost: 0, closedRate: null, totalRate: 0 });
    expect(conversionOf([], [], NOW)).toMatchObject({ started: 0, closedRate: null, totalRate: null, medianDaysToConvert: null });
  });

  it("por mes de inicio: 6 meses, el actual incluido, aunque no tengan pruebas", () => {
    const c = conversionOf(orgs, events, NOW);
    expect(c.byMonth).toHaveLength(6);
    expect(c.byMonth.at(-1)!.month).toBe("2026-11");
    expect(c.byMonth[0]!.month).toBe("2026-06");
    // las seis pruebas empezaron en octubre (hace 30 días) o noviembre (hace 9 y 5)
    const oct = c.byMonth.find((m) => m.month === "2026-10")!;
    expect(oct).toMatchObject({ started: 4, converted: 2 });
    expect(oct.closedRate).toBeCloseTo(0.5, 6);
    expect(c.byMonth.find((m) => m.month === "2026-11")).toMatchObject({ started: 2, converted: 0, closedRate: null });
  });

  it("una prueba suspendida sin convertir cuenta como perdida; una activada manualmente cuenta como convertida", () => {
    const c = conversionOf(
      [org("s", demo, sub("paused", days(5))), org("m", pro, sub("active", days(20)))],
      [ev("s", "trial_started", days(-5)), ev("m", "trial_started", days(-5)), ev("m", "converted", days(-1))],
      NOW
    );
    expect(c).toMatchObject({ started: 2, converted: 1, lost: 1 });
  });
});

describe("computeMetrics", () => {
  const mk = (id: string, plan: PlanFacts | null, s: SubFacts | null, createdAt = days(-3)): OrgFacts => ({ orgId: id, createdAt, plan, sub: s });
  const orgs: OrgFacts[] = [
    mk("a", emp, sub("active", days(10))),
    mk("b", pro, sub("active", days(10))),
    mk("c", demo, sub("trialing", days(7))),
    mk("d", demo, sub("trialing", days(-2))), // vencida derivada
    mk("e", demo, sub("past_due", days(-9), { statusReason: "trial_ended" })), // vencida persistida
    mk("f", pro, sub("canceled", days(10))),
    mk("g", ent, sub("paused", days(10))),
    mk("h", basico, sub("trialing", days(-40))), // plan anterior: nunca vence
    mk("i", null, null), // anterior al módulo SaaS
  ];

  it("la suma de los estados SIEMPRE da el total de organizaciones (incluido «sin suscripción»)", () => {
    const m = computeMetrics(orgs, [], NOW);
    const t = m.totals;
    expect(t.organizations).toBe(9);
    expect(t.active + t.trialing + t.pastDue + t.canceled + t.paused + t.withoutSubscription).toBe(t.organizations);
    expect(t).toMatchObject({ active: 2, trialing: 2, pastDue: 2, canceled: 1, paused: 1, withoutSubscription: 1 });
  });

  it("la matriz plan × estado suma por plan y agrupa los planes retirados como «Planes anteriores»", () => {
    const m = computeMetrics(orgs, [], NOW);
    const demoRow = m.byPlan.find((p) => p.planId === demo.id)!;
    expect(demoRow.total).toBe(3);
    expect(demoRow.counts).toMatchObject({ trialing: 1, pastDue: 2 });
    const legacy = m.byPlan.find((p) => p.legacy)!;
    expect(legacy).toMatchObject({ name: "Planes anteriores", total: 1 });
    // cada fila suma su total
    for (const p of m.byPlan) {
      expect(p.counts.active + p.counts.trialing + p.counts.pastDue + p.counts.canceled + p.counts.paused).toBe(p.total);
    }
    // los planes activos van de más barato a más caro, y los anteriores al final
    const activos = m.byPlan.filter((p) => !p.legacy).map((p) => p.priceMonthlyCents);
    expect(activos).toEqual([...activos].sort((a, b) => a - b));
    expect(m.byPlan.at(-1)!.legacy).toBe(true);
  });

  it("las altas de 30 días son una serie completa con ceros", () => {
    const m = computeMetrics(orgs, [], NOW);
    expect(m.signups).toHaveLength(30);
    expect(m.signups.reduce((n, s) => n + s.count, 0)).toBe(9);
    expect(m.signups.at(-1)!.day).toBe("2026-11-17");
  });

  it("trae MRR y conversión calculados con las mismas reglas", () => {
    const m = computeMetrics(orgs, [], NOW);
    expect(m.mrr.mrrCents).toBe(7900 + 14900);
    expect(m.computedAt).toBe(NOW.toISOString());
    expect(m.conversion.started).toBe(0);
  });

  it("sin organizaciones: todo en cero y no truena", () => {
    const m = computeMetrics([], [], NOW);
    expect(m.totals).toMatchObject({ organizations: 0, active: 0, withoutSubscription: 0 });
    expect(m.byPlan).toEqual([]);
    expect(m.mrr.mrrCents).toBe(0);
  });
});
