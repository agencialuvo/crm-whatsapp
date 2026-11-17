/**
 * 045 — Reglas de la suscripción SaaS, puras: sin base de datos ni red, para probarlas con tablas de casos.
 * Las comparten el servidor (la puerta `server/saas/subscription.ts`, el temporizador y el panel) y la UI.
 */

export type SubStatus = "trialing" | "active" | "past_due" | "canceled" | "paused";
/** Lo que se muestra: una prueba vencida que el temporizador aún no persistió se ve como `trial_expired`. */
export type EffectiveStatus = SubStatus | "trial_expired";

export type SubEventType =
  | "trial_started"
  | "converted"
  | "reactivated"
  | "plan_changed"
  | "status_changed"
  | "trial_extended"
  | "period_changed"
  | "expired"
  | "assigned";

export type SubAction =
  | "assign"
  | "activate"
  | "change_plan"
  | "extend_trial"
  | "set_period_end"
  | "suspend"
  | "cancel"
  | "reactivate";

export const SUB_ACTIONS: readonly SubAction[] = [
  "assign",
  "activate",
  "change_plan",
  "extend_trial",
  "set_period_end",
  "suspend",
  "cancel",
  "reactivate",
];

export const DAY_MS = 86_400_000;
/** Periodo de un plan de pago recién activado. */
export const PAID_PERIOD_DAYS = 30;
export const TRIAL_EXTEND_MIN_DAYS = 1;
export const TRIAL_EXTEND_MAX_DAYS = 90;

export type PlanFacts = {
  id: string;
  name: string;
  slug: string;
  priceMonthlyCents: number;
  currency: string;
  /** Con valor = plan de PRUEBA (Demo). null = plan de pago. */
  trialDays: number | null;
  active: boolean;
};

export type SubFacts = {
  status: SubStatus;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  statusReason?: string | null;
  convertedAt?: Date | null;
};

export const isTrialPlan = (p: Pick<PlanFacts, "trialDays"> | null | undefined): boolean =>
  p != null && p.trialDays !== null && p.trialDays !== undefined && p.trialDays > 0;

const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * DAY_MS);

/**
 * El estado que ve el operador. Una prueba (plan de prueba en `trialing`) con el periodo vencido es
 * `trial_expired` aunque el temporizador todavía no la haya pasado a `past_due`. Los planes de pago y los
 * planes anteriores NO vencen solos: hoy no lo hacían y siguen sin hacerlo.
 */
export function effectiveStatus(
  sub: Pick<SubFacts, "status" | "currentPeriodEnd">,
  plan: Pick<PlanFacts, "trialDays"> | null,
  now: Date
): { status: EffectiveStatus; daysLeft: number | null } {
  if (sub.status === "trialing") {
    const left = Math.ceil((sub.currentPeriodEnd.getTime() - now.getTime()) / DAY_MS);
    if (isTrialPlan(plan) && sub.currentPeriodEnd.getTime() < now.getTime()) {
      return { status: "trial_expired", daysLeft: 0 };
    }
    return { status: "trialing", daysLeft: Math.max(left, 0) };
  }
  return { status: sub.status, daysLeft: null };
}

/* ---------- Transiciones ---------- */

export type TransitionInput = {
  /** Plan de destino (assign, activate, change_plan, reactivate). */
  plan?: PlanFacts | null;
  days?: number;
  periodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
};

export type Decision =
  | {
      ok: true;
      eventType: SubEventType;
      status: SubStatus;
      /** null = no cambia el plan. */
      planId: string | null;
      planName: string | null;
      periodStart: Date | null;
      periodEnd: Date | null;
      cancelAtPeriodEnd: boolean | null;
      statusReason: string | null;
      /** true = esta acción es la CONVERSIÓN de la prueba a pago (fija `converted_at`). */
      isConversion: boolean;
    }
  | { ok: false; code: "invalid_transition" | "plan_required" | "not_trial_plan" | "invalid_input"; message: string };

const fail = (code: Extract<Decision, { ok: false }>["code"], message: string): Decision => ({ ok: false, code, message });

type Ctx = {
  action: SubAction;
  /** null = la organización no tiene suscripción. */
  from: SubFacts | null;
  /** El plan que tiene hoy (null si no hay suscripción). */
  current: PlanFacts | null;
  input?: TransitionInput;
  now: Date;
};

/**
 * ¿Qué pasa si se aplica esta acción? Devuelve los valores nuevos y el tipo de evento, o por qué no se puede.
 * La tabla de la spec 045 (§4) es exactamente esta función.
 */
export function decideTransition({ action, from, current, input = {}, now }: Ctx): Decision {
  const status = from?.status ?? null;
  const target = input.plan ?? null;

  if (action === "assign") {
    if (from) return fail("invalid_transition", "La organización ya tiene una suscripción");
    if (!target) return fail("plan_required", "Elige el plan que se le asigna");
    return isTrialPlan(target)
      ? {
          ok: true,
          eventType: "assigned",
          status: "trialing",
          planId: target.id,
          planName: target.name,
          periodStart: now,
          periodEnd: addDays(now, target.trialDays ?? 14),
          cancelAtPeriodEnd: false,
          statusReason: null,
          isConversion: false,
        }
      : {
          ok: true,
          eventType: "assigned",
          status: "active",
          planId: target.id,
          planName: target.name,
          periodStart: now,
          periodEnd: addDays(now, PAID_PERIOD_DAYS),
          cancelAtPeriodEnd: false,
          statusReason: "manual",
          isConversion: false,
        };
  }

  if (!from || !status) return fail("invalid_transition", "La organización no tiene suscripción: asígnale un plan primero");

  switch (action) {
    case "activate":
    case "reactivate": {
      const allowed: SubStatus[] =
        action === "activate" ? ["trialing", "past_due", "paused", "canceled"] : ["paused", "canceled"];
      if (!allowed.includes(status)) {
        return fail("invalid_transition", `No se puede ${action === "activate" ? "activar" : "reactivar"} una suscripción ${status}`);
      }
      const plan = target ?? current;
      if (!plan || isTrialPlan(plan)) return fail("plan_required", "Elige un plan de pago para activar la suscripción");
      const wasTrial = status === "trialing" || from.statusReason === "trial_ended" || isTrialPlan(current);
      const isConversion = action === "activate" && !from.convertedAt && wasTrial;
      return {
        ok: true,
        eventType: isConversion ? "converted" : action === "reactivate" || status !== "past_due" ? "reactivated" : "status_changed",
        status: "active",
        planId: plan.id === current?.id ? null : plan.id,
        planName: plan.name,
        periodStart: now,
        periodEnd: addDays(now, PAID_PERIOD_DAYS),
        cancelAtPeriodEnd: false,
        statusReason: "manual",
        isConversion,
      };
    }

    case "change_plan": {
      if (!target) return fail("plan_required", "Elige el nuevo plan");
      if (target.id === current?.id) return fail("invalid_input", "La organización ya está en ese plan");
      return {
        ok: true,
        eventType: "plan_changed",
        status,
        planId: target.id,
        planName: target.name,
        periodStart: null,
        periodEnd: null,
        cancelAtPeriodEnd: null,
        statusReason: null,
        isConversion: false,
      };
    }

    case "extend_trial": {
      // Primero si la acción CABE en el estado (409); después, si lo que se pide es válido (422).
      const trialPastDue = status === "past_due" && from.statusReason === "trial_ended";
      if (status !== "trialing" && !trialPastDue) return fail("invalid_transition", "Solo se extiende una prueba en curso o vencida");
      if (!isTrialPlan(current)) return fail("not_trial_plan", "Solo los planes de prueba tienen días de prueba");
      const days = input.days;
      if (!Number.isInteger(days) || (days as number) < TRIAL_EXTEND_MIN_DAYS || (days as number) > TRIAL_EXTEND_MAX_DAYS) {
        return fail("invalid_input", `Los días deben ser entre ${TRIAL_EXTEND_MIN_DAYS} y ${TRIAL_EXTEND_MAX_DAYS}`);
      }
      const base = from.currentPeriodEnd.getTime() > now.getTime() ? from.currentPeriodEnd : now;
      return {
        ok: true,
        eventType: "trial_extended",
        status: "trialing",
        planId: null,
        planName: null,
        periodStart: null,
        periodEnd: addDays(base, days as number),
        cancelAtPeriodEnd: null,
        statusReason: null,
        isConversion: false,
      };
    }

    case "set_period_end": {
      if (status !== "trialing" && status !== "active") return fail("invalid_transition", "Solo se fija el corte de una suscripción en prueba o activa");
      const end = input.periodEnd;
      if (!(end instanceof Date) || Number.isNaN(end.getTime())) return fail("invalid_input", "Fecha de corte inválida");
      if (end.getTime() <= now.getTime()) return fail("invalid_input", "La fecha de corte debe ser futura");
      return {
        ok: true,
        eventType: "period_changed",
        status,
        planId: null,
        planName: null,
        periodStart: null,
        periodEnd: end,
        cancelAtPeriodEnd: null,
        statusReason: null,
        isConversion: false,
      };
    }

    case "suspend": {
      if (status !== "trialing" && status !== "active" && status !== "past_due") {
        return fail("invalid_transition", `No se puede suspender una suscripción ${status}`);
      }
      return {
        ok: true,
        eventType: "status_changed",
        status: "paused",
        planId: null,
        planName: null,
        periodStart: null,
        periodEnd: null,
        cancelAtPeriodEnd: null,
        statusReason: "manual",
        isConversion: false,
      };
    }

    case "cancel": {
      if (status === "canceled") return fail("invalid_transition", "La suscripción ya está cancelada");
      // «Al final del periodo»: sigue activa hasta el corte (solo tiene sentido si está activa).
      if (input.cancelAtPeriodEnd) {
        if (status !== "active") return fail("invalid_transition", "Solo una suscripción activa se cancela al final del periodo");
        return {
          ok: true,
          eventType: "status_changed",
          status: "active",
          planId: null,
          planName: null,
          periodStart: null,
          periodEnd: null,
          cancelAtPeriodEnd: true,
          statusReason: "manual",
          isConversion: false,
        };
      }
      return {
        ok: true,
        eventType: "status_changed",
        status: "canceled",
        planId: null,
        planName: null,
        periodStart: null,
        periodEnd: null,
        cancelAtPeriodEnd: false,
        statusReason: "manual",
        isConversion: false,
      };
    }
  }
}

/* ---------- Métricas ---------- */

export type OrgFacts = {
  orgId: string;
  createdAt: Date;
  plan: PlanFacts | null;
  sub: SubFacts | null;
};

export type EventFacts = {
  organizationId: string;
  type: SubEventType;
  occurredAt: Date;
  approximate: boolean;
};

export type StatusCounts = { active: number; trialing: number; pastDue: number; canceled: number; paused: number };

export type PlanBreakdown = {
  /** `legacy` agrupa los planes retirados. */
  planId: string;
  name: string;
  priceMonthlyCents: number;
  legacy: boolean;
  total: number;
  counts: StatusCounts;
};

export type ConversionMonth = { month: string; started: number; converted: number; closedRate: number | null };

export type ConversionMetrics = {
  started: number;
  converted: number;
  inProgress: number;
  /** Pruebas vencidas, canceladas o suspendidas SIN haber convertido. */
  lost: number;
  /** convirtieron / (convirtieron + perdidas): las pruebas en curso no la deprimen. null si no hay pruebas cerradas. */
  closedRate: number | null;
  /** convirtieron / iniciaron. */
  totalRate: number | null;
  medianDaysToConvert: number | null;
  /** Filas aproximadas de la migración que NO cuentan. */
  excludedApproximate: number;
  byMonth: ConversionMonth[];
};

export type MrrMetrics = {
  currency: string;
  mrrCents: number;
  arrCents: number;
  activeCount: number;
  arpaCents: number;
  /** MRR de las activas que ya pidieron cancelar al final del periodo. */
  churningMrrCents: number;
  /** Lo que dejaría de entrar si las `past_due` de planes de pago no regularizan. */
  atRiskCents: number;
  /** Hubo planes activos en otra moneda: no se suman (se avisa). */
  mixedCurrency: boolean;
};

export type Metrics = {
  totals: StatusCounts & { organizations: number; withoutSubscription: number };
  byPlan: PlanBreakdown[];
  conversion: ConversionMetrics;
  mrr: MrrMetrics;
  signups: { day: string; count: number }[];
  computedAt: string;
};

const emptyCounts = (): StatusCounts => ({ active: 0, trialing: 0, pastDue: 0, canceled: 0, paused: 0 });

function bump(counts: StatusCounts, status: EffectiveStatus): void {
  if (status === "active") counts.active++;
  else if (status === "trialing") counts.trialing++;
  else if (status === "past_due" || status === "trial_expired") counts.pastDue++;
  else if (status === "canceled") counts.canceled++;
  else if (status === "paused") counts.paused++;
}

const monthKey = (d: Date): string => d.toISOString().slice(0, 7);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function mrrOf(orgs: readonly OrgFacts[], now: Date, baseCurrency = "PEN"): MrrMetrics {
  let mrr = 0;
  let churning = 0;
  let atRisk = 0;
  let active = 0;
  let mixed = false;
  for (const o of orgs) {
    if (!o.sub || !o.plan) continue;
    const eff = effectiveStatus(o.sub, o.plan, now).status;
    if (isTrialPlan(o.plan)) continue; // una prueba no es ingreso
    if (eff === "active") {
      if (o.plan.currency !== baseCurrency) {
        mixed = true;
        continue;
      }
      mrr += o.plan.priceMonthlyCents;
      active++;
      if (o.sub.cancelAtPeriodEnd) churning += o.plan.priceMonthlyCents;
    } else if (eff === "past_due" && o.plan.priceMonthlyCents > 0 && o.plan.currency === baseCurrency) {
      atRisk += o.plan.priceMonthlyCents;
    }
  }
  return {
    currency: baseCurrency,
    mrrCents: mrr,
    arrCents: mrr * 12,
    activeCount: active,
    arpaCents: active > 0 ? Math.round(mrr / active) : 0,
    churningMrrCents: churning,
    atRiskCents: atRisk,
    mixedCurrency: mixed,
  };
}

/**
 * Conversión Demo → pago sobre la HISTORIA (eventos no aproximados). La tasa «cerrada» deja fuera a las
 * pruebas todavía en curso: no es que no hayan convertido, es que aún no les toca.
 */
export function conversionOf(orgs: readonly OrgFacts[], events: readonly EventFacts[], now: Date): ConversionMetrics {
  const byOrg = new Map<string, EventFacts[]>();
  let excluded = 0;
  for (const e of events) {
    if (e.approximate) {
      excluded++;
      continue;
    }
    const list = byOrg.get(e.organizationId) ?? [];
    list.push(e);
    byOrg.set(e.organizationId, list);
  }
  const orgById = new Map(orgs.map((o) => [o.orgId, o]));

  let started = 0;
  let converted = 0;
  let inProgress = 0;
  let lost = 0;
  const days: number[] = [];
  const months = new Map<string, { started: number; converted: number; lost: number }>();

  for (const [orgId, list] of byOrg) {
    const start = list.filter((e) => e.type === "trial_started").sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())[0];
    if (!start) continue;
    started++;
    const conv = list.filter((e) => e.type === "converted").sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())[0];
    const m = months.get(monthKey(start.occurredAt)) ?? { started: 0, converted: 0, lost: 0 };
    m.started++;
    if (conv) {
      converted++;
      m.converted++;
      days.push(Math.max(0, (conv.occurredAt.getTime() - start.occurredAt.getTime()) / DAY_MS));
    } else {
      const org = orgById.get(orgId);
      const eff = org?.sub ? effectiveStatus(org.sub, org.plan, now).status : null;
      if (eff === "trialing") inProgress++;
      else if (eff === "trial_expired" || eff === "past_due" || eff === "canceled" || eff === "paused") {
        lost++;
        m.lost++;
      }
    }
    months.set(monthKey(start.occurredAt), m);
  }

  const rate = (c: number, l: number): number | null => (c + l > 0 ? c / (c + l) : null);
  // Últimos 6 meses incluido el actual, aunque no tengan pruebas (la serie no «salta»).
  const byMonth: ConversionMonth[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = monthKey(d);
    const m = months.get(key) ?? { started: 0, converted: 0, lost: 0 };
    byMonth.push({ month: key, started: m.started, converted: m.converted, closedRate: rate(m.converted, m.lost) });
  }

  return {
    started,
    converted,
    inProgress,
    lost,
    closedRate: rate(converted, lost),
    totalRate: started > 0 ? converted / started : null,
    medianDaysToConvert: median(days),
    excludedApproximate: excluded,
    byMonth,
  };
}

/** El dashboard completo. La suma de los estados SIEMPRE da el total de organizaciones. */
export function computeMetrics(orgs: readonly OrgFacts[], events: readonly EventFacts[], now: Date): Metrics {
  const totals = { ...emptyCounts(), organizations: orgs.length, withoutSubscription: 0 };
  const plans = new Map<string, PlanBreakdown>();
  const legacy: PlanBreakdown = { planId: "legacy", name: "Planes anteriores", priceMonthlyCents: 0, legacy: true, total: 0, counts: emptyCounts() };

  for (const o of orgs) {
    if (!o.sub || !o.plan) {
      totals.withoutSubscription++;
      continue;
    }
    const eff = effectiveStatus(o.sub, o.plan, now).status;
    bump(totals, eff);
    const row = o.plan.active
      ? (plans.get(o.plan.id) ??
        plans
          .set(o.plan.id, { planId: o.plan.id, name: o.plan.name, priceMonthlyCents: o.plan.priceMonthlyCents, legacy: false, total: 0, counts: emptyCounts() })
          .get(o.plan.id)!)
      : legacy;
    row.total++;
    bump(row.counts, eff);
  }

  const byPlan = [...plans.values()].sort((a, b) => a.priceMonthlyCents - b.priceMonthlyCents || a.name.localeCompare(b.name));
  if (legacy.total > 0) byPlan.push(legacy);

  // Altas de los últimos 30 días (UTC), con ceros: la serie no «salta».
  const signups: { day: string; count: number }[] = [];
  const perDay = new Map<string, number>();
  for (const o of orgs) {
    const key = o.createdAt.toISOString().slice(0, 10);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  for (let i = 29; i >= 0; i--) {
    const key = new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10);
    signups.push({ day: key, count: perDay.get(key) ?? 0 });
  }

  return {
    totals,
    byPlan,
    conversion: conversionOf(orgs, events, now),
    mrr: mrrOf(orgs, now),
    signups,
    computedAt: now.toISOString(),
  };
}

/* ---------- Presentación ---------- */

export const STATUS_LABEL: Record<EffectiveStatus, string> = {
  trialing: "En prueba",
  trial_expired: "Prueba vencida",
  active: "Activa",
  past_due: "Pago vencido",
  canceled: "Cancelada",
  paused: "Suspendida",
};

export type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info";

export const STATUS_TONE: Record<EffectiveStatus, BadgeTone> = {
  trialing: "info",
  trial_expired: "warning",
  active: "success",
  past_due: "warning",
  canceled: "neutral",
  paused: "danger",
};

/** `past_due` por una prueba vencida se llama «Prueba vencida», no «Pago vencido». */
export function statusLabelOf(status: EffectiveStatus, statusReason: string | null | undefined): string {
  if (status === "past_due" && statusReason === "trial_ended") return STATUS_LABEL.trial_expired;
  return STATUS_LABEL[status];
}

export const ACTION_LABEL: Record<SubAction, string> = {
  assign: "Asignar plan",
  activate: "Activar plan de pago",
  change_plan: "Cambiar de plan",
  extend_trial: "Extender la prueba",
  set_period_end: "Fijar fecha de corte",
  suspend: "Suspender",
  cancel: "Cancelar",
  reactivate: "Reactivar",
};

/**
 * Qué acciones se le ofrecen a una fila del directorio. Es la tabla de `decideTransition` vista desde la
 * pantalla; una prueba comprueba que las dos coinciden (ninguna acción ofrecida es una transición inválida).
 */
export function availableActions(
  status: EffectiveStatus | null,
  trialPlan: boolean,
  statusReason?: string | null
): SubAction[] {
  if (status === null) return ["assign"];
  switch (status) {
    case "trialing":
    case "trial_expired":
      return ["activate", "change_plan", ...(trialPlan ? (["extend_trial"] as SubAction[]) : []), "set_period_end", "suspend", "cancel"];
    case "past_due":
      return [
        "activate",
        "change_plan",
        ...(trialPlan && statusReason === "trial_ended" ? (["extend_trial"] as SubAction[]) : []),
        "suspend",
        "cancel",
      ];
    case "active":
      return ["change_plan", "set_period_end", "suspend", "cancel"];
    case "paused":
      return ["reactivate", "change_plan", "cancel"];
    case "canceled":
      return ["reactivate", "change_plan"];
  }
}

export type StatusFilter = EffectiveStatus | "none";

/**
 * El filtro de estado del directorio. «Prueba vencida» incluye la derivada (`trial_expired`) y la ya persistida
 * (`past_due` por `trial_ended`); «Pago vencido» es el `past_due` que NO viene de una prueba. Sin suscripción = `none`.
 */
export function matchesStatusFilter(
  status: EffectiveStatus | null,
  statusReason: string | null | undefined,
  filter: StatusFilter
): boolean {
  if (filter === "none") return status === null;
  if (status === null) return false;
  const pruebaVencida = status === "trial_expired" || (status === "past_due" && statusReason === "trial_ended");
  if (filter === "trial_expired") return pruebaVencida;
  if (filter === "past_due") return status === "past_due" && !pruebaVencida;
  return status === filter;
}
