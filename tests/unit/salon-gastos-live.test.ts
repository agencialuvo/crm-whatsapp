import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Gastos contra PostgreSQL REAL (`pnpm test:db`): crear con cada presentación, ocultar nombres de las
 * sugerencias (y que reaparezcan al reusarlos), devengo dentro del mes, borrado y aislamiento entre
 * organizaciones. Necesita DOS organizaciones; borra todo lo que crea.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("gastos contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let svc: typeof import("@/server/business/expenses");
  let resolvePeriod: (typeof import("@/server/analytics/period"))["resolvePeriod"];

  const tag = Date.now().toString(36);
  let orgA = "";
  let orgB = "";
  const created: string[] = [];

  const base = { totalPriceCents: 1000, expenseDate: "2026-11-20" };
  const make = async (org: string, input: Parameters<typeof svc.createExpense>[1]) => {
    const { id } = await svc.createExpense(org, input);
    created.push(id);
    return id;
  };
  const period = (from: string, to: string) => resolvePeriod({ from, to, timezone: "America/Lima" });

  beforeAll(async () => {
    ({ eq, and, inArray } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    svc = await import("@/server/business/expenses");
    ({ resolvePeriod } = await import("@/server/analytics/period"));
    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    expect(orgs.length, "hacen falta dos organizaciones").toBeGreaterThanOrEqual(2);
    orgA = orgs[0]!.id;
    orgB = orgs[1]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    if (created.length) await db.delete(schema.expenseItem).where(inArray(schema.expenseItem.id, created));
    for (const org of [orgA, orgB]) {
      await db.delete(schema.expenseNameHidden).where(eq(schema.expenseNameHidden.organizationId, org));
    }
  });

  it("guarda y devuelve cada presentación con sus campos", async () => {
    const m = await make(orgA, { ...base, name: `Aceite ${tag}`, quantity: 2, presentation: "measure", measureUnit: "l" });
    const p = await make(orgA, { ...base, name: `Caja ${tag}`, quantity: 3, presentation: "package", unitsPerPackage: 12 });
    const s = await make(orgA, { ...base, name: `Licencia ${tag}`, quantity: 1, presentation: "service" });
    const rep = await svc.getExpensesReport(orgA, period("2026-11-01", "2026-11-30"));
    const byId = new Map(rep.items.map((i) => [i.id, i]));
    expect(byId.get(m)).toMatchObject({ presentation: "measure", measureUnit: "l", unitsPerPackage: null, quantity: 2 });
    expect(byId.get(p)).toMatchObject({ presentation: "package", unitsPerPackage: 12, measureUnit: null });
    expect(byId.get(s)).toMatchObject({ presentation: "service", unitsPerPackage: null, measureUnit: null });
  });

  it("devengo: un gasto fechado más adelante del mes ya cuenta en el periodo del mes completo", async () => {
    const id = await make(orgA, { ...base, name: `Alquiler ${tag}`, isFixed: true, totalPriceCents: 80_000, expenseDate: "2026-11-28" });
    const hastaHoy = await svc.getExpensesReport(orgA, period("2026-11-01", "2026-11-10"));
    const mesCompleto = await svc.getExpensesReport(orgA, period("2026-11-01", "2026-11-30"));
    expect(hastaHoy.items.some((i) => i.id === id)).toBe(false);
    const item = mesCompleto.items.find((i) => i.id === id);
    expect(item?.expenseDate).toBe("2026-11-28");
    expect(mesCompleto.summary.byKind.fixed.totalCents).toBeGreaterThanOrEqual(80_000);
    expect(mesCompleto.summary.realNetCents).toBe(
      mesCompleto.summary.revenueCents - mesCompleto.summary.commissionsCents - mesCompleto.summary.expensesCents
    );
  });

  it("ocultar un nombre lo saca de las sugerencias sin tocar los gastos; reusarlo lo devuelve", async () => {
    const name = `Insumo oculto ${tag}`;
    await make(orgA, { ...base, name });
    const before = await svc.listExpenseNames(orgA, "variable");
    expect(before.map((n) => n.name)).toContain(name);

    await svc.hideExpenseName(orgA, "variable", `  ${name.toUpperCase()}  `);
    await svc.hideExpenseName(orgA, "variable", name); // idempotente
    const hiddenList = await svc.listExpenseNames(orgA, "variable");
    expect(hiddenList.map((n) => n.name)).not.toContain(name);

    // El gasto sigue en la tabla y en los totales.
    const rep = await svc.getExpensesReport(orgA, period("2026-11-01", "2026-11-30"));
    expect(rep.items.some((i) => i.name === name)).toBe(true);

    // Otra organización no se ve afectada.
    await make(orgB, { ...base, name });
    expect((await svc.listExpenseNames(orgB, "variable")).map((n) => n.name)).toContain(name);

    // Volver a usar el nombre lo hace reaparecer.
    await make(orgA, { ...base, name });
    expect((await svc.listExpenseNames(orgA, "variable")).map((n) => n.name)).toContain(name);
    const left = await db
      .select()
      .from(schema.expenseNameHidden)
      .where(and(eq(schema.expenseNameHidden.organizationId, orgA), eq(schema.expenseNameHidden.nameKey, name.toLowerCase())));
    expect(left).toHaveLength(0);
  });

  it("ocultar es por tipo: un nombre fijo no oculta el variable", async () => {
    const name = `Mixto ${tag}`;
    await make(orgA, { ...base, name, isFixed: true });
    await make(orgA, { ...base, name });
    await svc.hideExpenseName(orgA, "fixed", name);
    expect((await svc.listExpenseNames(orgA, "fixed")).map((n) => n.name)).not.toContain(name);
    expect((await svc.listExpenseNames(orgA, "variable")).map((n) => n.name)).toContain(name);
  });

  it("borrar quita el gasto y recalcula; no se puede borrar ni editar el de otra organización", async () => {
    const id = await make(orgA, { ...base, name: `Borrar ${tag}`, totalPriceCents: 5_000 });
    const antes = await svc.getExpensesReport(orgA, period("2026-11-01", "2026-11-30"));
    await expect(svc.deleteExpense(orgB, id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.updateExpense(orgB, id, { ...base, name: "x1" })).rejects.toMatchObject({ status: 404 });
    await svc.deleteExpense(orgA, id);
    const despues = await svc.getExpensesReport(orgA, period("2026-11-01", "2026-11-30"));
    expect(despues.summary.expensesCents).toBe(antes.summary.expensesCents - 5_000);
    expect(despues.items.some((i) => i.id === id)).toBe(false);
  });

  it("editar cambia de presentación y limpia lo que ya no aplica", async () => {
    const id = await make(orgA, { ...base, name: `Editar ${tag}`, quantity: 2, presentation: "package", unitsPerPackage: 6 });
    await svc.updateExpense(orgA, id, { ...base, name: `Editar ${tag}`, quantity: 5, presentation: "measure", measureUnit: "g" });
    const [row] = await db.select().from(schema.expenseItem).where(eq(schema.expenseItem.id, id));
    expect(row).toMatchObject({ presentation: "measure", measureUnit: "g", unitsPerPackage: null, quantity: 5 });
  });
});
