import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Equipo opcional y precio variable contra PostgreSQL REAL (`pnpm test:db`): una venta SIN profesional (`staffId`
 * null) aparece en el reporte, el historial y el desglose («Sin asignar») sin perderse en los joins; la tarjeta de
 * comisiones sigue a `teamInUse`; un servicio de precio variable exige el monto y «Otro» sigue igual; y el contexto
 * de IA dice «Precio a consultar». Crea su propia organización y la borra al final.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("ventas sin equipo y precio variable contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let sales: typeof import("@/server/business/sales-service");
  let period: typeof import("@/server/analytics/period");
  let aiCtx: typeof import("@/server/ai/barbershop-context");

  const tag = Date.now().toString(36);
  const org = `org_sl${tag}`;
  const fijo = `srv_sl${tag}f`;
  const variable = `srv_sl${tag}v`;
  const staffId = `stf_sl${tag}`;

  /** Siempre por el esquema real: `amountCents` es el total cobrado y es obligatorio. */
  let saleInputSchema: (typeof import("@/lib/salon/schemas"))["saleInputSchema"];
  let saleEditSchema: (typeof import("@/lib/salon/schemas"))["saleEditSchema"];
  const sale = (over: Record<string, unknown>) =>
    saleInputSchema.parse({ paymentMethod: "efectivo", customerName: "Cliente Mostrador", amountCents: 5000, ...over });
  const periodo = () => period.resolvePeriod({ timezone: "America/Lima" });

  beforeAll(async () => {
    process.env.SALON = "on";
    ({ eq } = await import("drizzle-orm"));
    const m = await import("@/lib/db");
    db = m.getDb();
    schema = m.schema;
    sales = await import("@/server/business/sales-service");
    period = await import("@/server/analytics/period");
    aiCtx = await import("@/server/ai/barbershop-context");
    ({ saleInputSchema, saleEditSchema } = await import("@/lib/salon/schemas"));
    await db.insert(schema.organization).values({ id: org, name: `Sin equipo live ${tag}` });
    await db.insert(schema.service).values([
      { id: fijo, organizationId: org, name: "Sesión fija", priceCents: 5000 },
      { id: variable, organizationId: org, name: "Asesoría a medida", priceCents: 0, priceMode: "variable" },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.serviceSale).where(eq(schema.serviceSale.organizationId, org));
    await db.delete(schema.organization).where(eq(schema.organization.id, org));
  });

  it("sin profesionales: teamInUse es false", async () => {
    expect(await sales.teamInUse(org)).toBe(false);
  });

  it("una venta sin profesional se guarda con staff_id NULL y sin comisión", async () => {
    const r = await sales.registerServiceSale(org, sale({ serviceId: fijo, staffId: null }));
    expect(r.sale.staffId).toBeNull();
    expect(r.sale.amountCents).toBe(5000);
    expect(r.sale.staffCommissionCents).toBe(0);
    expect(r.sale.businessNetCents).toBe(5000);
    const [row] = await db.select().from(schema.serviceSale).where(eq(schema.serviceSale.id, r.sale.id));
    expect(row?.staffId).toBeNull();
  });

  it("aparece en el reporte, el historial y el desglose «Sin asignar» (no se pierde por el join)", async () => {
    const rep = await sales.getSalesReport(org, periodo());
    expect(rep.totals.count).toBe(1);
    expect(rep.totals.revenueCents).toBe(5000);
    expect(rep.rows).toHaveLength(1);
    expect(rep.rows[0]!.staffId).toBeNull();
    expect(rep.byStaff).toEqual([
      expect.objectContaining({ staffId: null, staffName: "Sin asignar", count: 1, revenueCents: 5000, commissionCents: 0 }),
    ]);
    expect(rep.teamInUse).toBe(false);
  });

  it("precio variable: sin monto → 422 price_required; con monto se cobra ese monto", async () => {
    await expect(
      sales.registerServiceSale(org, sale({ serviceId: variable, amountCents: 0 }))
    ).rejects.toMatchObject({ status: 422, code: "price_required" });
    const r = await sales.registerServiceSale(org, sale({ serviceId: variable, amountCents: 12345 }));
    expect(r.sale.amountCents).toBe(12345);
  });

  it("«Otro» sigue igual: el monto lo escribe quien vende y crea el servicio comodín", async () => {
    const r = await sales.registerServiceSale(org, sale({ other: true, amountCents: 777, otherNote: "Extra" }));
    expect(r.sale.amountCents).toBe(777);
    const otros = await db.select().from(schema.service).where(eq(schema.service.organizationId, org));
    expect(otros.filter((s) => s.isOther)).toHaveLength(1);
  });

  it("editar una venta a un servicio variable también exige el monto", async () => {
    const r = await sales.registerServiceSale(org, sale({ serviceId: fijo }));
    const edit = saleEditSchema.parse({
      items: [{ serviceId: variable }],
      staffId: null,
      amountCents: 0,
      paymentMethod: "efectivo",
    });
    await expect(sales.updateSale(org, r.sale.id, edit, "usr_live")).rejects.toMatchObject({ status: 422, code: "price_required" });
    const ok = saleEditSchema.parse({ items: [{ serviceId: variable, amountCents: 9000 }], staffId: null, amountCents: 9000, paymentMethod: "efectivo" });
    await sales.updateSale(org, r.sale.id, ok, "usr_live");
  });

  it("con un profesional: la comisión se calcula y teamInUse pasa a true; sin él, sigue «Sin asignar»", async () => {
    await db.insert(schema.staff).values({ id: staffId, organizationId: org, name: "Ana" });
    expect(await sales.teamInUse(org)).toBe(true);
    const r = await sales.registerServiceSale(org, sale({ serviceId: fijo, staffId }));
    expect(r.sale.staffId).toBe(staffId);
    const rep = await sales.getSalesReport(org, periodo());
    expect(rep.teamInUse).toBe(true);
    const ids = rep.byStaff.map((b) => b.staffId).sort();
    expect(ids).toEqual([null, staffId].sort());
    // el desglose suma el total del reporte
    expect(rep.byStaff.reduce((a, b) => a + b.revenueCents, 0)).toBe(rep.totals.revenueCents);
    // filtrar por profesional no arrastra las ventas sin asignar
    const solo = await sales.getSalesReport(org, periodo(), staffId);
    expect(solo.rows.every((x) => x.staffId === staffId)).toBe(true);
  });

  it("el contexto de IA dice «Precio a consultar» para el variable y no lista «Otro»", async () => {
    const ctx = await aiCtx.getBarbershopAiContext(org);
    expect(ctx).toContain("Asesoría a medida");
    expect(ctx).toContain("Precio a consultar");
    expect(ctx).not.toMatch(/\bOtro\b/);
  });
});
