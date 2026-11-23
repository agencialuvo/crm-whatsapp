import { and, count, desc, eq, gte, lt, sql, sum } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { creditsEnabled } from "./flag";
import { balanceOf } from "./internal";

/**
 * Monedas — lo que el Super Admin necesita para calibrar y operar: el consumo por organización y servicio, el estado
 * de cada cuenta y los `wouldCut` (lo que el corte HABRÍA bloqueado en modo sombra). Solo LECTURA, de TODAS las
 * organizaciones: por eso no pasa por `scoped()` y solo se llama desde rutas `withSuperAdmin`. No depende de la
 * bandera `CREDITS` (apagada también se puede mirar lo que quedó), pero informa si está encendida.
 */

export type AccountView = {
  planBalance: number;
  topupBalance: number;
  total: number;
  unlimited: boolean;
  cutEnabled: boolean;
  overdraftLimit: number;
  periodStart: string | null;
  periodEnd: string | null;
  /** Cuota concedida en el periodo vigente (concesión + ajustes de plan). */
  quota: number;
};

export type ServiceUsage = {
  /** Llamadas medidas (IA: cada intento; WhatsApp: cada envío). */
  events: number;
  /** IA: llamadas con respuesta válida (≈ turnos). WhatsApp: = envíos. */
  okEvents: number;
  tokensIn: number;
  tokensOut: number;
  /** Unidades que se descontaron (en modo sombra: las que se habrían descontado igual, pues se asienta siempre). */
  chargedUnits: number;
  /** Eventos válidos en los que el corte habría bloqueado. */
  wouldCutEvents: number;
  /** IA: llamadas con llave del entorno (las únicas que consumen monedas). */
  envEvents: number;
};

export type OrgCalibrationRow = {
  organizationId: string;
  organizationName: string;
  account: AccountView | null;
  ai: ServiceUsage;
  aiLab: ServiceUsage;
  whatsapp: ServiceUsage;
  wouldCutEvents: number;
};

export type CalibrationReport = {
  enabled: boolean;
  from: string;
  to: string;
  totals: { organizations: number; withAccount: number; cutEnabled: number; chargedUnits: number; wouldCutEvents: number; orgsThatWouldBeCut: number };
  rows: OrgCalibrationRow[];
  /** Hay más organizaciones que filas devueltas. */
  truncated: boolean;
};

const empty = (): ServiceUsage => ({ events: 0, okEvents: 0, tokensIn: 0, tokensOut: 0, chargedUnits: 0, wouldCutEvents: 0, envEvents: 0 });

/**
 * Un intento de IA válido, o cualquier envío de WhatsApp: la unidad que de verdad cuenta. Es una FUNCIÓN y no una
 * constante: leer `schema.creditUsage` al cargar el módulo rompería a quien mockea `@/lib/db` con un esquema parcial
 * (todo lo que importa la puerta lo cargaría).
 */
const okEvent = () => sql`(${schema.creditUsage.service} = 'whatsapp' or (${schema.creditUsage.meta}->>'valid') = 'true')`;

async function quotaByPeriod(accounts: { organizationId: string; planPeriodStart: Date | null }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const withPeriod = accounts.filter((a) => a.planPeriodStart);
  if (withPeriod.length === 0) return out;
  const l = schema.creditLedger;
  const rows = await getDb()
    .select({ organizationId: l.organizationId, periodStart: l.periodStart, quota: sum(l.amount) })
    .from(l)
    .where(and(eq(l.kind, "grant"), eq(l.bucket, "plan"), gte(l.createdAt, new Date(0))))
    .groupBy(l.organizationId, l.periodStart);
  const byKey = new Map(rows.map((r) => [`${r.organizationId}|${r.periodStart?.getTime()}`, Number(r.quota ?? 0)]));
  for (const a of withPeriod) out.set(a.organizationId, byKey.get(`${a.organizationId}|${a.planPeriodStart!.getTime()}`) ?? 0);
  return out;
}

function viewOf(acc: typeof schema.creditAccount.$inferSelect, quota: number): AccountView {
  const b = balanceOf(acc);
  return {
    planBalance: b.plan,
    topupBalance: b.topup,
    total: b.total,
    unlimited: acc.unlimited,
    cutEnabled: acc.cutEnabled,
    overdraftLimit: acc.overdraftLimit,
    periodStart: acc.planPeriodStart?.toISOString() ?? null,
    periodEnd: acc.planPeriodEnd?.toISOString() ?? null,
    quota,
  };
}

/** El reporte de calibración de todas las organizaciones en un rango. Ordenado: más `wouldCut` primero, luego más consumo. */
export async function calibrationReport(input: { from: Date; to: Date; limit?: number }): Promise<CalibrationReport> {
  const u = schema.creditUsage;
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 2000);
  const db = getDb();

  const usageRows = await db
    .select({
      organizationId: u.organizationId,
      service: u.service,
      events: count(),
      okEvents: sql<number>`count(*) filter (where ${okEvent()})`,
      tokensIn: sum(u.tokensIn),
      tokensOut: sum(u.tokensOut),
      chargedUnits: sum(u.chargedUnits),
      wouldCutEvents: sql<number>`count(*) filter (where ${u.wouldCut} and ${okEvent()})`,
      envEvents: sql<number>`count(*) filter (where ${u.source} = 'env')`,
    })
    .from(u)
    .where(and(gte(u.createdAt, input.from), lt(u.createdAt, input.to)))
    .groupBy(u.organizationId, u.service);

  const accounts = await db.select().from(schema.creditAccount);
  const quotas = await quotaByPeriod(accounts);

  const byOrg = new Map<string, OrgCalibrationRow>();
  const row = (organizationId: string): OrgCalibrationRow => {
    let r = byOrg.get(organizationId);
    if (!r) {
      r = { organizationId, organizationName: "", account: null, ai: empty(), aiLab: empty(), whatsapp: empty(), wouldCutEvents: 0 };
      byOrg.set(organizationId, r);
    }
    return r;
  };
  for (const a of accounts) row(a.organizationId).account = viewOf(a, quotas.get(a.organizationId) ?? 0);
  for (const r of usageRows) {
    const target = row(r.organizationId);
    const slot = r.service === "ai" ? target.ai : r.service === "ai_lab" ? target.aiLab : target.whatsapp;
    slot.events = Number(r.events);
    slot.okEvents = Number(r.okEvents);
    slot.tokensIn = Number(r.tokensIn ?? 0);
    slot.tokensOut = Number(r.tokensOut ?? 0);
    slot.chargedUnits = Number(r.chargedUnits ?? 0);
    slot.wouldCutEvents = Number(r.wouldCutEvents);
    slot.envEvents = Number(r.envEvents);
  }
  for (const r of byOrg.values()) r.wouldCutEvents = r.ai.wouldCutEvents + r.whatsapp.wouldCutEvents;

  const ids = [...byOrg.keys()];
  if (ids.length > 0) {
    const names = await db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization);
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    for (const r of byOrg.values()) r.organizationName = nameOf.get(r.organizationId) ?? r.organizationId;
  }

  const all = [...byOrg.values()].sort(
    (a, b) =>
      b.wouldCutEvents - a.wouldCutEvents ||
      b.ai.chargedUnits + b.whatsapp.chargedUnits - (a.ai.chargedUnits + a.whatsapp.chargedUnits) ||
      a.organizationName.localeCompare(b.organizationName)
  );
  return {
    enabled: creditsEnabled(),
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    totals: {
      organizations: all.length,
      withAccount: all.filter((r) => r.account).length,
      cutEnabled: all.filter((r) => r.account?.cutEnabled).length,
      chargedUnits: all.reduce((s, r) => s + r.ai.chargedUnits + r.whatsapp.chargedUnits, 0),
      wouldCutEvents: all.reduce((s, r) => s + r.wouldCutEvents, 0),
      orgsThatWouldBeCut: all.filter((r) => r.wouldCutEvents > 0).length,
    },
    rows: all.slice(0, limit),
    truncated: all.length > limit,
  };
}

export type LedgerEntryView = {
  id: string;
  createdAt: string;
  kind: string;
  bucket: string;
  service: string | null;
  amount: number;
  note: string | null;
  actorUserId: string | null;
};

export type WouldCutView = {
  id: string;
  createdAt: string;
  service: string;
  category: string | null;
  chargedUnits: number;
  conversationId: string | null;
};

export type OrgCreditDetail = {
  enabled: boolean;
  organizationId: string;
  organizationName: string;
  account: AccountView | null;
  ledger: LedgerEntryView[];
  wouldCut: WouldCutView[];
  wouldCutTotal: number;
};

/** Una organización en detalle: su cuenta, los últimos movimientos del libro y los últimos `wouldCut`. `null` si no existe. */
export async function orgCreditDetail(organizationId: string, range: { from: Date; to: Date }): Promise<OrgCreditDetail | null> {
  const db = getDb();
  const [org] = await db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  if (!org) return null;

  const [acc] = await db.select().from(schema.creditAccount).where(scoped(schema.creditAccount.organizationId, organizationId)).limit(1);
  const quotas = acc ? await quotaByPeriod([acc]) : new Map<string, number>();

  const l = schema.creditLedger;
  const ledger = await db
    .select()
    .from(l)
    .where(scoped(l.organizationId, organizationId, gte(l.createdAt, new Date(0))))
    .orderBy(desc(l.createdAt))
    .limit(50);

  const u = schema.creditUsage;
  const cutWhere = scoped(u.organizationId, organizationId, eq(u.wouldCut, true), okEvent(), gte(u.createdAt, range.from), lt(u.createdAt, range.to));
  const [{ total }] = (await db.select({ total: count() }).from(u).where(cutWhere)) as [{ total: number }];
  const cuts = await db.select().from(u).where(cutWhere).orderBy(desc(u.createdAt)).limit(50);

  return {
    enabled: creditsEnabled(),
    organizationId,
    organizationName: org.name,
    account: acc ? viewOf(acc, quotas.get(organizationId) ?? 0) : null,
    ledger: ledger.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      kind: r.kind,
      bucket: r.bucket,
      service: r.service,
      amount: r.amount,
      note: r.note,
      actorUserId: r.actorUserId,
    })),
    wouldCut: cuts.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString(), service: r.service, category: r.category, chargedUnits: r.chargedUnits, conversationId: r.conversationId })),
    wouldCutTotal: Number(total),
  };
}
