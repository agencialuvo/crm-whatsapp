import { describe, expect, it } from "vitest";
import { ORGANIZATION_ROW_FIELDS, organizationsQuerySchema, subscriptionActionSchema } from "@/lib/super-admin";
import { toRow, type OrgRecord } from "@/server/super-admin/directory";

/** 045 — Los contratos del panel: validación de entrada y minimización de datos. */

describe("subscriptionActionSchema", () => {
  const ok = { action: "suspend", reason: "No pagó la renovación" };

  it("exige un MOTIVO de 3 a 300 caracteres en toda acción", () => {
    expect(subscriptionActionSchema.safeParse(ok).success).toBe(true);
    expect(subscriptionActionSchema.safeParse({ action: "suspend" }).success).toBe(false);
    expect(subscriptionActionSchema.safeParse({ ...ok, reason: "  " }).success).toBe(false);
    expect(subscriptionActionSchema.safeParse({ ...ok, reason: "ab" }).success).toBe(false);
    expect(subscriptionActionSchema.safeParse({ ...ok, reason: "x".repeat(301) }).success).toBe(false);
    expect(subscriptionActionSchema.safeParse({ ...ok, reason: "x".repeat(300) }).success).toBe(true);
  });

  it("solo acepta las 8 acciones conocidas", () => {
    for (const a of ["assign", "activate", "change_plan", "extend_trial", "set_period_end", "suspend", "cancel", "reactivate"]) {
      expect(subscriptionActionSchema.safeParse({ action: a, reason: "motivo" }).success, a).toBe(true);
    }
    expect(subscriptionActionSchema.safeParse({ action: "delete_org", reason: "motivo" }).success).toBe(false);
    expect(subscriptionActionSchema.safeParse({ action: "grant", reason: "motivo" }).success).toBe(false);
  });

  it("los días son enteros y la fecha de corte es AAAA-MM-DD o un ISO", () => {
    expect(subscriptionActionSchema.safeParse({ action: "extend_trial", days: 7, reason: "motivo" }).success).toBe(true);
    expect(subscriptionActionSchema.safeParse({ action: "extend_trial", days: 7.5, reason: "motivo" }).success).toBe(false);
    expect(subscriptionActionSchema.safeParse({ action: "set_period_end", periodEnd: "2026-12-31", reason: "motivo" }).success).toBe(true);
    expect(subscriptionActionSchema.safeParse({ action: "set_period_end", periodEnd: "2026-12-31T12:00:00Z", reason: "motivo" }).success).toBe(true);
    expect(subscriptionActionSchema.safeParse({ action: "set_period_end", periodEnd: "mañana", reason: "motivo" }).success).toBe(false);
  });
});

describe("organizationsQuerySchema", () => {
  it("acota el límite a 5 000 y valida el estado", () => {
    expect(organizationsQuerySchema.parse({}).limit).toBe(5000);
    expect(organizationsQuerySchema.safeParse({ limit: "9999" }).success).toBe(false);
    expect(organizationsQuerySchema.safeParse({ status: "trial_expired" }).success).toBe(true);
    expect(organizationsQuerySchema.safeParse({ status: "none" }).success).toBe(true);
    expect(organizationsQuerySchema.safeParse({ status: "hackeado" }).success).toBe(false);
  });
});

describe("minimización de datos", () => {
  const rec: OrgRecord = {
    orgId: "org_1",
    name: "Barbería Luna",
    createdAt: new Date("2026-11-01T00:00:00Z"),
    ownerName: "Ana",
    ownerEmail: "ana@luna.pe",
    plan: { id: "plan_demo", name: "Demo", slug: "demo", priceMonthlyCents: 0, currency: "PEN", trialDays: 14, active: true },
    sub: { status: "trialing", currentPeriodEnd: new Date("2026-11-15T00:00:00Z"), cancelAtPeriodEnd: false, statusReason: null, convertedAt: null },
    billing: { mpStatus: null, lastPaymentAt: null, nextPaymentAt: null, pendingPlanId: null },
  };

  it("una fila del directorio tiene EXACTAMENTE los campos de la lista blanca (nada de teléfonos, tokens ni mensajes)", () => {
    const row = toRow(rec, new Date("2026-11-10T00:00:00Z"));
    expect(Object.keys(row).sort()).toEqual([...ORGANIZATION_ROW_FIELDS].sort());
    const json = JSON.stringify(row).toLowerCase();
    for (const prohibido of ["token", "secret", "password", "phone", "message", "conversation", "credential"]) {
      expect(json, prohibido).not.toContain(prohibido);
    }
  });

  it("la fila de una organización sin suscripción sale completa, con estado null", () => {
    const row = toRow({ ...rec, plan: null, sub: null }, new Date());
    expect(row).toMatchObject({ status: null, planId: null, planName: null, daysLeft: null, currentPeriodEnd: null });
    expect(Object.keys(row).sort()).toEqual([...ORGANIZATION_ROW_FIELDS].sort());
  });

  it("una prueba vencida se ve como trial_expired en el directorio", () => {
    expect(toRow(rec, new Date("2026-11-20T00:00:00Z")).status).toBe("trial_expired");
  });
});
