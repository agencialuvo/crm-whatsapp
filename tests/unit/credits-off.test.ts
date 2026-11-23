import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Monedas con `CREDITS` APAGADA (lo normal): ninguna operación toca la base ni cambia nada. Es la garantía de que
 * desplegar este código no altera el comportamiento de una instancia que no las usa. La base simulada LANZA si se
 * la toca, así que cualquier consulta escondida haría fallar estas pruebas.
 */

const getDb = vi.fn(() => {
  throw new Error("se tocó la base con CREDITS apagada");
});

vi.mock("@/lib/db", () => ({
  getDb,
  schema: new Proxy({}, { get: (_t, table) => new Proxy({}, { get: (_t2, col) => `${String(table)}.${String(col)}` }) }),
}));

type Credits = typeof import("@/server/credits");
let c: Credits;

const org = "org_x";
const now = new Date("2026-11-01T00:00:00Z");

beforeAll(async () => {
  c = await import("@/server/credits");
});

beforeEach(() => {
  getDb.mockClear();
  vi.stubEnv("CREDITS", "");
});

describe("con CREDITS apagada no pasa nada y no se toca la base", () => {
  it("la bandera está apagada", () => {
    expect(c.creditsEnabled()).toBe(false);
  });

  it("las operaciones que mueven saldo responden `disabled`", async () => {
    expect(await c.grantPeriodQuota({ organizationId: org, subscriptionId: "sub_1", periodStart: now, periodEnd: now, units: 1000 })).toEqual({ status: "disabled" });
    expect(await c.expirePeriodQuota({ organizationId: org, periodStart: now })).toEqual({ status: "disabled" });
    expect(await c.spendCredits({ organizationId: org, service: "ai", amount: 10, idempotencyKey: "k" })).toEqual({ status: "disabled" });
    expect(await c.applyTopup({ organizationId: org, units: 100, idempotencyKey: "k" })).toEqual({ status: "disabled" });
    expect(await c.refundTopup({ organizationId: org, topupId: "crt_1" })).toEqual({ status: "disabled" });
    expect(await c.adjustCredits({ organizationId: org, bucket: "topup", amount: 5, idempotencyKey: "k", actorUserId: "u", note: "x" })).toEqual({ status: "disabled" });
    expect(await c.configureCut({ organizationId: org, cutEnabled: true })).toEqual({ status: "disabled" });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("registrar uso, crear compras, fijar tarifas y reclamar avisos: no hacen nada", async () => {
    expect(await c.recordUsage({ organizationId: org, service: "ai" })).toEqual({ status: "disabled" });
    expect(await c.createTopupIntent({ organizationId: org, packId: "crk_1" })).toEqual({ status: "disabled" });
    expect(await c.setRate({ key: "ai.turn", service: "ai", unitKind: "per_turn", amount: 100 })).toEqual({ status: "disabled" });
    expect(await c.claimAlert({ organizationId: org, periodStart: now, threshold: "zero" })).toBe(false);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("las consultas dejan pasar siempre: sin saldo que mirar, sin corte", async () => {
    expect(await c.getCreditBalance(org)).toBeNull();
    expect(await c.checkCredit(org)).toEqual({ allow: true, wouldCut: false, reason: "off" });
    expect(await c.checkCredit(org, { amount: 1_000_000 })).toEqual({ allow: true, wouldCut: false, reason: "off" });
    expect(await c.reconcileCredits()).toEqual({ checked: 0, drifts: [], repaired: 0 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("con CREDITS=on sí se consulta la base (la bandera es lo único que decide)", async () => {
    vi.stubEnv("CREDITS", "on");
    expect(c.creditsEnabled()).toBe(true);
    // Sin cuenta que mirar, el corte deja pasar; el fallo de la base se registra y TAMBIÉN deja pasar.
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = await c.checkCredit(org);
    expect(gate).toEqual({ allow: true, wouldCut: false, reason: "error" });
    expect(getDb).toHaveBeenCalled();
    consola.mockRestore();
  });
});
