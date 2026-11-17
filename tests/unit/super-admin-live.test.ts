import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 045 — Super Admin: planes, membresías y métricas, contra PostgreSQL REAL.
 *
 * Necesita una base con las migraciones aplicadas, así que NO corre con `pnpm test`: se enciende con
 *   RUN_DB_TESTS=1 corepack pnpm exec vitest run tests/unit/super-admin-live.test.ts
 * Crea sus propias organizaciones y usuarios temporales y los borra al terminar (el borrado en cascada se
 * lleva lo demás; la auditoría sobrevive a propósito y también se limpia aquí).
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("Super Admin contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let sql: (typeof import("drizzle-orm"))["sql"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let door: typeof import("@/server/saas/subscription");
  let dir: typeof import("@/server/super-admin/directory");
  let metricsLib: typeof import("@/server/super-admin/metrics");
  let saas: typeof import("@/lib/saas");
  let enforcement: typeof import("@/server/saas/enforcement");
  let signup: typeof import("@/server/auth/on-signup");
  let sector: typeof import("@/server/business/sector-setup");

  const uid = Date.now().toString(36);
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const P: Record<string, string> = {}; // slug → id del plan
  const actor = () => ({ userId: userIds[0]!, email: `sa-${uid}@vocero.test`, ip: "10.0.0.1" });
  const DAY = 86_400_000;
  const days = (n: number) => new Date(Date.now() + n * DAY);

  async function nuevaOrg(tag: string, owner = false): Promise<string> {
    const id = `org_sa${uid}${tag}`;
    await db.insert(schema.organization).values({ id, name: `Negocio ${tag} ${uid}`, createdAt: new Date() });
    orgIds.push(id);
    if (owner) {
      const u = `usr_sa${uid}${tag}`;
      await db.insert(schema.user).values({ id: u, name: `Dueño ${tag}`, email: `dueno-${tag}-${uid}@vocero.test`, emailVerified: true });
      userIds.push(u);
      await db.insert(schema.member).values({ id: `mem_sa${uid}${tag}`, organizationId: id, userId: u, role: "owner" });
    }
    return id;
  }

  async function darSub(
    orgId: string,
    slug: string,
    status: "trialing" | "active" | "past_due" | "canceled" | "paused",
    end: Date,
    over: Partial<typeof schema.subscription.$inferInsert> = {}
  ) {
    await db.insert(schema.subscription).values({
      id: `sub_sa${uid}${orgId.slice(-4)}${Math.random().toString(36).slice(2, 6)}`,
      organizationId: orgId,
      planId: P[slug]!,
      status,
      currentPeriodStart: new Date(),
      currentPeriodEnd: end,
      ...over,
    });
  }

  const subDe = async (orgId: string) => (await db.select().from(schema.subscription).where(eq(schema.subscription.organizationId, orgId)))[0];
  const eventosDe = async (orgId: string) =>
    await db.select().from(schema.subscriptionEvent).where(eq(schema.subscriptionEvent.organizationId, orgId)).orderBy(schema.subscriptionEvent.occurredAt, schema.subscriptionEvent.id);
  const auditoriaDe = async (orgId: string) => await db.select().from(schema.superAdminAudit).where(eq(schema.superAdminAudit.targetOrganizationId, orgId));

  beforeAll(async () => {
    ({ sql, eq, inArray } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    door = await import("@/server/saas/subscription");
    dir = await import("@/server/super-admin/directory");
    metricsLib = await import("@/server/super-admin/metrics");
    saas = await import("@/lib/saas");
    enforcement = await import("@/server/saas/enforcement");
    signup = await import("@/server/auth/on-signup");
    sector = await import("@/server/business/sector-setup");
    const { seedPlatformCatalog } = await import("@/server/seed/platform-catalog");
    await seedPlatformCatalog();
    const plans = await db.select().from(schema.plan);
    for (const p of plans) P[p.slug] = p.id;
    // el Super Admin que actúa (para el actor de la auditoría)
    const adminId = `usr_sa${uid}admin`;
    await db.insert(schema.user).values({ id: adminId, name: "Admin Prueba", email: `sa-${uid}@vocero.test`, emailVerified: true, isSuperAdmin: true });
    userIds.unshift(adminId);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.superAdminAudit).where(inArray(schema.superAdminAudit.targetOrganizationId, orgIds));
    await db.delete(schema.superAdminAudit).where(inArray(schema.superAdminAudit.actorUserId, userIds));
    await db.delete(schema.organization).where(inArray(schema.organization.id, orgIds));
    await db.delete(schema.user).where(inArray(schema.user.id, userIds));
  }, 60_000);

  it("0. la migración 0080 dejó el esquema, los 4 planes y retiró los anteriores", async () => {
    const cols = await db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where (table_name = 'user' and column_name = 'is_super_admin')
         or (table_name = 'plan' and column_name in ('trial_days', 'currency', 'sort_order'))
         or (table_name = 'subscription' and column_name in ('trial_started_at', 'converted_at', 'status_reason', 'status_changed_at'))`);
    expect([...cols]).toHaveLength(8);
    const tablas = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_name in ('subscription_event', 'super_admin_audit')`);
    expect([...tablas]).toHaveLength(2);
    for (const slug of ["demo", "emprendedor", "pro", "enterprise"]) expect(P[slug], slug).toBeTruthy();
    const [demo] = await db.select().from(schema.plan).where(eq(schema.plan.slug, "demo"));
    expect(demo).toMatchObject({ trialDays: 14, priceMonthlyCents: 0, active: true, currency: "PEN" });
    const precios = await db.select({ slug: schema.plan.slug, price: schema.plan.priceMonthlyCents }).from(schema.plan).where(inArray(schema.plan.slug, ["emprendedor", "pro", "enterprise"]));
    expect(Object.fromEntries(precios.map((p) => [p.slug, p.price]))).toEqual({ emprendedor: 7900, pro: 14900, enterprise: 29900 });
    for (const slug of ["basico", "salon"]) {
      const [legacy] = await db.select().from(schema.plan).where(eq(schema.plan.slug, slug));
      if (legacy) expect(legacy.active, slug).toBe(false);
    }
    const idx = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where indexname in ('sev_org_occurred_idx', 'sev_type_occurred_idx', 'saa_created_idx', 'saa_target_org_idx')`);
    expect([...idx]).toHaveLength(4);
  });

  it("1. el alta crea la organización en la DEMO: trialing, 14 días, plan demo y el evento trial_started", async () => {
    const userId = `usr_sa${uid}alta`;
    await db.insert(schema.user).values({ id: userId, name: "Alta Nueva", email: `alta-${uid}@vocero.test`, emailVerified: true });
    userIds.push(userId);
    const antes = new Set((await db.select({ id: schema.organization.id }).from(schema.organization)).map((o) => o.id));
    await signup.onOwnerRegistered(userId, "Alta Nueva", db, "salon");
    const nueva = (await db.select({ id: schema.organization.id }).from(schema.organization)).filter((o) => !antes.has(o.id));
    expect(nueva).toHaveLength(1);
    const orgId = nueva[0]!.id;
    orgIds.push(orgId);

    const sub = await subDe(orgId);
    expect(sub).toMatchObject({ status: "trialing", planId: P.demo });
    expect(sub!.trialStartedAt).toBeTruthy();
    const dias = (sub!.currentPeriodEnd.getTime() - sub!.currentPeriodStart.getTime()) / DAY;
    expect(Math.round(dias)).toBe(14);
    const ev = await eventosDe(orgId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "trial_started", toStatus: "trialing", toPlanName: "Demo", source: "signup", approximate: false });
    // y la Demo incluye todos los módulos: el menú del sector no nace bloqueado
    const access = await import("@/server/business/saas-guard").then((m) => m.getPlanAccess(orgId));
    expect(access.modules).toEqual(expect.arrayContaining(["agenda", "salon", "loyalty", "finances", "atribucion"]));
  }, 60_000);

  it("1b. sin la Demo en el catálogo, el alta cae al plan por sector y NO cuenta como prueba de conversión", async () => {
    const userId = `usr_sa${uid}fb`;
    await db.insert(schema.user).values({ id: userId, name: "Sin Demo", email: `fb-${uid}@vocero.test`, emailVerified: true });
    userIds.push(userId);
    await db.update(schema.plan).set({ active: false }).where(eq(schema.plan.slug, "demo"));
    let orgId = "";
    try {
      const antes = new Set((await db.select({ id: schema.organization.id }).from(schema.organization)).map((o) => o.id));
      await signup.onOwnerRegistered(userId, "Sin Demo", db, "salon");
      const nueva = (await db.select({ id: schema.organization.id }).from(schema.organization)).filter((o) => !antes.has(o.id));
      orgId = nueva[0]!.id;
      orgIds.push(orgId);
    } finally {
      await db.update(schema.plan).set({ active: true }).where(eq(schema.plan.slug, "demo"));
    }
    const sub = await subDe(orgId);
    expect(sub).toBeTruthy(); // jamás sin suscripción
    expect(sub!.planId).not.toBe(P.demo);
    const ev = await eventosDe(orgId);
    expect(ev[0]).toMatchObject({ type: "trial_started", approximate: true });
  }, 60_000);

  it("2. activar una prueba = conversión: converted_at, evento converted (source admin) y auditoría, todo en la misma operación", async () => {
    const org = await nuevaOrg("conv", true);
    await darSub(org, "demo", "trialing", days(9), { trialStartedAt: days(-5) });
    const r = await door.applySubscriptionAction({ organizationId: org, action: "activate", planId: P.pro, reason: "Pagó por transferencia", actor: actor() });
    expect(r).toMatchObject({ ok: true, status: "active", eventType: "converted" });
    const sub = await subDe(org);
    expect(sub).toMatchObject({ status: "active", planId: P.pro, cancelAtPeriodEnd: false, statusReason: "manual" });
    expect(sub!.convertedAt).toBeTruthy();
    expect(Math.round((sub!.currentPeriodEnd.getTime() - Date.now()) / DAY)).toBe(30);
    const ev = await eventosDe(org);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "converted", fromStatus: "trialing", toStatus: "active", fromPlanName: "Demo", toPlanName: "Pro", source: "admin", reason: "Pagó por transferencia", actorUserId: userIds[0] });
    const au = await auditoriaDe(org);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ action: "activate", actorEmail: `sa-${uid}@vocero.test`, reason: "Pagó por transferencia", ip: "10.0.0.1" });
    expect(au[0]!.before).toMatchObject({ status: "trialing", plan: "Demo" });
    expect(au[0]!.after).toMatchObject({ status: "active", plan: "Pro" });
  });

  it("3. cada acción de la tabla de transiciones: cambia, deja su evento y su auditoría; una inválida responde 409 y no escribe NADA", async () => {
    const org = await nuevaOrg("acc");
    await darSub(org, "demo", "trialing", days(3));
    const aplicar = (action: import("@/lib/saas").SubAction, extra: Record<string, unknown> = {}) =>
      door.applySubscriptionAction({ organizationId: org, action, reason: `motivo ${action}`, actor: actor(), ...extra });

    // extender la prueba: +7 días desde el fin vigente
    const fin0 = (await subDe(org))!.currentPeriodEnd.getTime();
    expect(await aplicar("extend_trial", { days: 7 })).toMatchObject({ ok: true, status: "trialing", eventType: "trial_extended" });
    expect((await subDe(org))!.currentPeriodEnd.getTime() - fin0).toBe(7 * DAY);

    // fijar el corte
    const corte = days(40);
    expect(await aplicar("set_period_end", { periodEnd: corte })).toMatchObject({ ok: true, eventType: "period_changed" });
    expect((await subDe(org))!.currentPeriodEnd.getTime()).toBe(corte.getTime());

    // cambiar de plan (sigue en prueba)
    expect(await aplicar("change_plan", { planId: P.emprendedor })).toMatchObject({ ok: true, status: "trialing", eventType: "plan_changed" });
    expect((await subDe(org))!.planId).toBe(P.emprendedor);

    // suspender → cancelar → reactivar
    expect(await aplicar("suspend")).toMatchObject({ ok: true, status: "paused" });
    expect((await subDe(org))!.statusReason).toBe("manual");
    expect(await aplicar("cancel")).toMatchObject({ ok: true, status: "canceled" });
    expect(await aplicar("reactivate", { planId: P.pro })).toMatchObject({ ok: true, status: "active", eventType: "reactivated" });

    // «cancelar al final del periodo»: sigue activa con la marca
    expect(await aplicar("cancel", { cancelAtPeriodEnd: true })).toMatchObject({ ok: true, status: "active" });
    expect((await subDe(org))).toMatchObject({ status: "active", cancelAtPeriodEnd: true });

    // una transición inválida: 409, y ni la suscripción, ni la historia, ni la auditoría cambian
    const antes = { sub: await subDe(org), ev: (await eventosDe(org)).length, au: (await auditoriaDe(org)).length };
    expect(await aplicar("reactivate", { planId: P.pro })).toMatchObject({ ok: false, status: 409, code: "invalid_transition" });
    expect(await aplicar("extend_trial", { days: 7 })).toMatchObject({ ok: false, status: 409 });
    expect(await aplicar("extend_trial", { days: 999 })).toMatchObject({ ok: false, status: 409 }); // activa: no es prueba (409 antes que los días)
    const despues = { sub: await subDe(org), ev: (await eventosDe(org)).length, au: (await auditoriaDe(org)).length };
    expect(despues.ev).toBe(antes.ev);
    expect(despues.au).toBe(antes.au);
    expect(despues.sub!.updatedAt.getTime()).toBe(antes.sub!.updatedAt.getTime());

    // un plan inexistente o retirado → 422
    expect(await aplicar("change_plan", { planId: "plan_no_existe" })).toMatchObject({ ok: false, status: 422, code: "plan_not_found" });

    // todos los pasos válidos dejaron UNA fila de historia y UNA de auditoría cada uno (7 acciones)
    expect((await eventosDe(org)).length).toBe(7);
    expect((await auditoriaDe(org)).length).toBe(7);
  });

  it("3b. asignar plan a una organización sin suscripción (anterior al módulo SaaS)", async () => {
    const org = await nuevaOrg("asg");
    expect(await subDe(org)).toBeUndefined();
    const r = await door.applySubscriptionAction({ organizationId: org, action: "assign", planId: P.enterprise, reason: "Cliente histórico", actor: actor() });
    expect(r).toMatchObject({ ok: true, status: "active", eventType: "assigned" });
    expect(await subDe(org)).toMatchObject({ status: "active", planId: P.enterprise });
    expect((await eventosDe(org))[0]).toMatchObject({ type: "assigned", fromStatus: null, toStatus: "active", toPlanName: "Enterprise" });
    // y la organización inexistente → 404
    expect(await door.applySubscriptionAction({ organizationId: "org_no_existe", action: "suspend", reason: "motivo", actor: actor() })).toMatchObject({ ok: false, status: 404 });
  });

  it("4. dos acciones SIMULTÁNEAS sobre la misma organización se serializan y la historia cuadra con el estado final", async () => {
    for (let i = 0; i < 6; i++) {
      const org = await nuevaOrg(`cc${i}`);
      await darSub(org, "pro", "active", days(20));
      const [a, b] = await Promise.all([
        door.applySubscriptionAction({ organizationId: org, action: "suspend", reason: "suspender a la vez", actor: actor() }),
        door.applySubscriptionAction({ organizationId: org, action: "cancel", reason: "cancelar a la vez", actor: actor() }),
      ]);
      const oks = [a, b].filter((x) => x.ok).length;
      const ev = await eventosDe(org);
      expect(ev.length, `ronda ${i}`).toBe(oks);
      expect(oks).toBeGreaterThanOrEqual(1);
      expect((await auditoriaDe(org)).length).toBe(oks);
      // el estado final es el del ÚLTIMO evento
      expect((await subDe(org))!.status).toBe(ev.at(-1)!.toStatus);
    }
  }, 60_000);

  it("5. el vencimiento: solo las pruebas vencidas de un plan de PRUEBA pasan a past_due (trial_ended); es idempotente", async () => {
    const vencidaDemo = await nuevaOrg("exp1");
    const vigenteDemo = await nuevaOrg("exp2");
    const vencidaPro = await nuevaOrg("exp3");
    const vencidaLegacy = await nuevaOrg("exp4");
    const sinSub = await nuevaOrg("exp5");
    await darSub(vencidaDemo, "demo", "trialing", days(-2));
    await darSub(vigenteDemo, "demo", "trialing", days(5));
    await darSub(vencidaPro, "pro", "trialing", days(-2));
    const [legacy] = await db.select().from(schema.plan).where(eq(schema.plan.slug, "basico"));
    if (legacy) P.basico = legacy.id;
    if (P.basico) await darSub(vencidaLegacy, "basico", "trialing", days(-60));
    void sinSub;

    const n1 = await door.expireTrials();
    expect(n1).toBeGreaterThanOrEqual(1);
    expect(await subDe(vencidaDemo)).toMatchObject({ status: "past_due", statusReason: "trial_ended" });
    expect((await eventosDe(vencidaDemo)).at(-1)).toMatchObject({ type: "expired", fromStatus: "trialing", toStatus: "past_due", source: "system", reason: "trial_ended" });
    expect((await subDe(vigenteDemo))!.status).toBe("trialing");
    expect((await subDe(vencidaPro))!.status).toBe("trialing"); // los planes de pago no vencen solos
    if (P.basico) expect((await subDe(vencidaLegacy))!.status).toBe("trialing"); // ni los planes anteriores
    expect(await subDe(sinSub)).toBeUndefined();

    const n2 = await door.expireTrials();
    expect((await eventosDe(vencidaDemo)).filter((e) => e.type === "expired")).toHaveLength(1);
    void n2;
    // una prueba vencida que PAGA después también es conversión
    const r = await door.applySubscriptionAction({ organizationId: vencidaDemo, action: "activate", planId: P.emprendedor, reason: "pagó tarde", actor: actor() });
    expect(r).toMatchObject({ ok: true, eventType: "converted" });
  }, 60_000);

  it("6. el directorio: dueño, plan, estado efectivo (incluida la prueba vencida derivada), filtros y búsqueda", async () => {
    const a = await nuevaOrg("dir1", true);
    const b = await nuevaOrg("dir2", true);
    await darSub(a, "demo", "trialing", days(-1)); // vencida (derivada: el temporizador aún no corrió)
    await darSub(b, "pro", "active", days(15));
    const todas = await dir.listOrganizations();
    const fa = todas.find((o) => o.id === a)!;
    const fb = todas.find((o) => o.id === b)!;
    expect(fa).toMatchObject({ planName: "Demo", status: "trial_expired", isTrialPlan: true, ownerName: "Dueño dir1", ownerEmail: `dueno-dir1-${uid}@vocero.test` });
    expect(fb).toMatchObject({ planName: "Pro", status: "active", priceMonthlyCents: 14900, daysLeft: null });
    expect(Object.keys(fa).sort()).toEqual([...(await import("@/lib/super-admin")).ORGANIZATION_ROW_FIELDS].sort());

    expect((await dir.listOrganizations({ status: "trial_expired" })).some((o) => o.id === a)).toBe(true);
    expect((await dir.listOrganizations({ status: "active", plan: P.pro })).map((o) => o.id)).toContain(b);
    expect((await dir.listOrganizations({ plan: "demo" })).map((o) => o.id)).toContain(a);
    // búsqueda por el correo del dueño, sin acentos ni mayúsculas
    expect((await dir.listOrganizations({ q: `DUENO-dir2-${uid}` })).map((o) => o.id)).toEqual([b]);
    expect((await dir.listOrganizations({ q: `Negocio dir1 ${uid}` })).map((o) => o.id)).toEqual([a]);
    expect((await dir.listOrganizations({ limit: 3 })).length).toBeLessThanOrEqual(3);
    // el detalle trae la historia y la auditoría
    await door.applySubscriptionAction({ organizationId: b, action: "suspend", reason: "revisión", actor: actor() });
    const det = await dir.getOrganizationDetail(b);
    expect(det!.events.at(0)).toMatchObject({ type: "status_changed", reason: "revisión", source: "admin", actorName: "Admin Prueba" });
    expect(det!.audit[0]).toMatchObject({ action: "suspend", actorEmail: `sa-${uid}@vocero.test` });
    expect(await dir.getOrganizationDetail("org_no_existe")).toBeNull();
  });

  it("7. las métricas contra datos sembrados: totales, plan × estado, conversión y MRR salen como a mano", async () => {
    // Un mundo CERRADO: se calcula sobre estas organizaciones aisladas, con lo que carga el panel de verdad.
    const mundo = {
      act1: await nuevaOrg("m1"),
      act2: await nuevaOrg("m2"),
      act3: await nuevaOrg("m3"),
      tri1: await nuevaOrg("m4"),
      tri2: await nuevaOrg("m5"),
      ven: await nuevaOrg("m6"),
      can: await nuevaOrg("m7"),
      pau: await nuevaOrg("m8"),
      nada: await nuevaOrg("m9"),
    };
    await darSub(mundo.act1, "emprendedor", "active", days(20), { convertedAt: days(-10) });
    await darSub(mundo.act2, "pro", "active", days(20), { convertedAt: days(-3), cancelAtPeriodEnd: true });
    await darSub(mundo.act3, "enterprise", "active", days(20), { convertedAt: days(-2) });
    await darSub(mundo.tri1, "demo", "trialing", days(6));
    await darSub(mundo.tri2, "demo", "trialing", days(10));
    await darSub(mundo.ven, "demo", "past_due", days(-4), { statusReason: "trial_ended" });
    await darSub(mundo.can, "pro", "canceled", days(-1));
    await darSub(mundo.pau, "pro", "paused", days(5));
    const ids = Object.values(mundo);

    const ev = (org: string, type: "trial_started" | "converted", at: Date) =>
      db.insert(schema.subscriptionEvent).values({ id: `sev_sa${uid}${Math.random().toString(36).slice(2, 10)}`, organizationId: org, type, source: "admin", occurredAt: at });
    // iniciaron 8 pruebas (las 8 con suscripción); convirtieron 3; 1 vencida, 1 cancelada y 1 suspendida sin convertir; 2 en curso
    for (const [k, org] of Object.entries(mundo)) if (k !== "nada") await ev(org, "trial_started", days(-30));
    await ev(mundo.act1, "converted", days(-20));
    await ev(mundo.act2, "converted", days(-26));
    await ev(mundo.act3, "converted", days(-28));

    const todas = await metricsLib.loadMetrics();
    // sobre el mundo cerrado: filtrar la carga real del panel a estas organizaciones
    const orgs = (await dir.loadOrganizations()).filter((o) => ids.includes(o.orgId));
    const eventos = (await dir.loadConversionEvents()).filter((e) => ids.includes(e.organizationId));
    const m = saas.computeMetrics(orgs, eventos, new Date());
    expect(m.totals).toMatchObject({ organizations: 9, active: 3, trialing: 2, pastDue: 1, canceled: 1, paused: 1, withoutSubscription: 1 });
    expect(m.totals.active + m.totals.trialing + m.totals.pastDue + m.totals.canceled + m.totals.paused + m.totals.withoutSubscription).toBe(9);
    const porPlan = Object.fromEntries(m.byPlan.map((p) => [p.name, p.total]));
    expect(porPlan).toMatchObject({ Demo: 3, Emprendedor: 1, Pro: 3, Enterprise: 1 });
    expect(m.mrr).toMatchObject({ mrrCents: 7900 + 14900 + 29900, activeCount: 3, churningMrrCents: 14900, currency: "PEN" });
    expect(m.conversion).toMatchObject({ started: 8, converted: 3, inProgress: 2, lost: 3 });
    expect(m.conversion.closedRate).toBeCloseTo(3 / 6, 6);
    expect(m.conversion.totalRate).toBeCloseTo(3 / 8, 6);
    expect(m.conversion.medianDaysToConvert).toBeCloseTo(4, 0); // 10, 4 y 2 días → mediana 4

    // y el dashboard REAL (toda la base) cumple las invariantes
    const conteo = await db.execute<{ n: number }>(sql`select count(*)::int as n from organization`);
    const n = [...conteo][0]!.n;
    expect(todas.totals.organizations).toBe(n);
    expect(todas.totals.active + todas.totals.trialing + todas.totals.pastDue + todas.totals.canceled + todas.totals.paused + todas.totals.withoutSubscription).toBe(n);
    expect(todas.signups).toHaveLength(30);
  }, 60_000);

  it("8. las filas APROXIMADAS (sembradas por la migración) no cuentan en la conversión real", async () => {
    const org = await nuevaOrg("apx");
    await darSub(org, "demo", "trialing", days(3));
    await db.insert(schema.subscriptionEvent).values({ id: `sev_sa${uid}apx`, organizationId: org, type: "trial_started", source: "system", approximate: true, occurredAt: days(-80) });
    const eventos = (await dir.loadConversionEvents()).filter((e) => e.organizationId === org);
    expect(eventos).toHaveLength(1);
    const c = saas.conversionOf((await dir.loadOrganizations()).filter((o) => o.orgId === org), eventos, new Date());
    expect(c.started).toBe(0);
    expect(c.excludedApproximate).toBe(1);
  });

  it("9. el cumplimiento (SAAS_ENFORCE): apagado no bloquea nada; encendido bloquea prueba vencida, suspendida y cancelada, y jamás a quien no tiene suscripción ni a un plan anterior vigente", async () => {
    const venc = await nuevaOrg("en1");
    const paus = await nuevaOrg("en2");
    const canc = await nuevaOrg("en3");
    const act = await nuevaOrg("en4");
    const vig = await nuevaOrg("en5");
    const sinSub = await nuevaOrg("en6");
    await darSub(venc, "demo", "trialing", days(-3));
    await darSub(paus, "pro", "paused", days(5));
    await darSub(canc, "pro", "canceled", days(5));
    await darSub(act, "pro", "active", days(5));
    await darSub(vig, "demo", "trialing", days(5));
    const [legacy] = await db.select().from(schema.plan).where(eq(schema.plan.slug, "basico"));
    let leg = "";
    if (legacy) {
      leg = await nuevaOrg("en7");
      P.basico = legacy.id;
      await darSub(leg, "basico", "trialing", days(-90));
    }
    const previo = process.env.SAAS_ENFORCE;
    try {
      enforcement.invalidateSubscriptionAccess();
      delete process.env.SAAS_ENFORCE;
      for (const o of [venc, paus, canc, act, vig, sinSub]) expect(await enforcement.subscriptionInactive(o), "apagado").toBeNull();

      process.env.SAAS_ENFORCE = "true";
      enforcement.invalidateSubscriptionAccess();
      expect((await enforcement.subscriptionInactive(venc))?.status).toBe("trial_expired");
      expect((await enforcement.subscriptionInactive(paus))?.status).toBe("paused");
      expect((await enforcement.subscriptionInactive(canc))?.status).toBe("canceled");
      expect(await enforcement.subscriptionInactive(act)).toBeNull();
      expect(await enforcement.subscriptionInactive(vig)).toBeNull();
      expect(await enforcement.subscriptionInactive(sinSub)).toBeNull();
      if (leg) expect(await enforcement.subscriptionInactive(leg)).toBeNull(); // un plan anterior no vence solo

      // el panel reactiva: la siguiente petición lo ve al instante (se invalida el caché)
      await door.applySubscriptionAction({ organizationId: paus, action: "reactivate", planId: P.pro, reason: "regularizó", actor: actor() });
      enforcement.invalidateSubscriptionAccess(paus);
      expect(await enforcement.subscriptionInactive(paus)).toBeNull();
    } finally {
      if (previo === undefined) delete process.env.SAAS_ENFORCE;
      else process.env.SAAS_ENFORCE = previo;
      enforcement.invalidateSubscriptionAccess();
    }
  }, 60_000);

  it("10. elegir el sector NO mueve un plan de la Demo ni uno contratado; solo reajusta una prueba con un plan anterior", async () => {
    const [cat] = await db.select().from(schema.businessCategory).limit(1);
    if (!cat) return;
    const demoOrg = await nuevaOrg("sec1");
    await darSub(demoOrg, "demo", "trialing", days(7));
    await sector.chooseSector(demoOrg, cat.key);
    expect((await subDe(demoOrg))!.planId).toBe(P.demo);

    const proOrg = await nuevaOrg("sec2");
    await darSub(proOrg, "pro", "trialing", days(7));
    await sector.chooseSector(proOrg, cat.key);
    expect((await subDe(proOrg))!.planId).toBe(P.pro);

    const [legacy] = await db.select().from(schema.plan).where(eq(schema.plan.slug, "basico"));
    if (legacy) {
      const legOrg = await nuevaOrg("sec3");
      P.basico = legacy.id;
      await darSub(legOrg, "basico", "trialing", days(7));
      const r = await sector.chooseSector(legOrg, cat.key);
      if (r.ok && r.planChanged) {
        expect((await subDe(legOrg))!.planId).not.toBe(legacy.id);
        expect((await eventosDe(legOrg)).at(-1)).toMatchObject({ type: "plan_changed", source: "system", reason: "sector_changed" });
      }
    }
  }, 60_000);

  it("11. la bandera is_super_admin: por omisión nadie la tiene, y un usuario normal no figura entre los Super Admin", async () => {
    const [u] = await db.select({ f: schema.user.isSuperAdmin }).from(schema.user).where(eq(schema.user.id, `usr_sa${uid}alta`));
    expect(u!.f).toBe(false);
    const admins = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.isSuperAdmin, true));
    expect(admins.map((a) => a.id)).toContain(userIds[0]);
    expect(admins.map((a) => a.id)).not.toContain(`usr_sa${uid}alta`);
  });
});
