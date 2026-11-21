import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Equipo opcional — un negocio sin profesionales vende igual: la venta guarda `staff_id = null`, no hay comisión
 * (todo es del negocio) y las ventas sin profesional NO desaparecen de Caja ni del historial (los `JOIN` con `staff`
 * son `LEFT`). Con profesional, el reparto de siempre no cambia.
 *
 * La base es un doble en memoria que graba lo que se consulta y se escribe; el esquema es el real.
 */

type Call = { method: string; args: unknown[] };
type Chain = { [method: string]: (...args: unknown[]) => Chain };
const h = vi.hoisted(() => ({
  /** Cada consulta armada: tipo, tabla principal, campos pedidos y los métodos encadenados. */
  queries: [] as { kind: string; table: unknown; fields: Record<string, unknown> | undefined; calls: Call[]; values?: unknown }[],
  results: null as null | ((q: { kind: string; table: unknown; fields: Record<string, unknown> | undefined }) => unknown),
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  const NOW = new Date("2026-03-10T15:00:00.000Z");
  function query(kind: string, table: unknown, fields?: Record<string, unknown>) {
    const q = { kind, table, fields, calls: [] as Call[], values: undefined as unknown };
    h.queries.push(q);
    const proxy: Chain = new Proxy(
      {} as Chain,
      {
        get(_t, prop: string) {
          if (prop === "then") {
            const r = h.results?.(q);
            const value = r !== undefined ? r : kind === "insert" ? [{ createdAt: NOW }] : [];
            return (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve(value).then(ok, err);
          }
          return (...args: unknown[]) => {
            q.calls.push({ method: prop, args });
            if (prop === "from") q.table = args[0];
            if (prop === "values") q.values = args[0];
            return proxy;
          };
        },
      }
    );
    return proxy;
  }
  const db = {
    select: (fields?: Record<string, unknown>) => ({ from: (t: unknown) => query("select", t, fields).from!(t) }),
    insert: (t: unknown) => query("insert", t),
    update: (t: unknown) => query("update", t),
    delete: (t: unknown) => query("delete", t),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };
  return { ...original, getDb: () => db };
});
vi.mock("@/server/events/bus", () => ({ publish: vi.fn() }));
vi.mock("@/server/leads/auto-stage", () => ({ advanceLeadForContact: vi.fn() }));

import { schema } from "@/lib/db";
import { clientCreateSchema, saleEditSchema, saleInputSchema } from "@/lib/salon/schemas";
import { NO_STAFF_LABEL } from "@/lib/salon/staff-fields";
import { getSalesReport, registerServiceSale } from "@/server/business/sales-service";

const SERVICIO = { id: "srv_1", name: "Asesoría", priceCents: 5000, active: true, isOther: false, defaultCommissionPercentage: null };
const PROFESIONAL = { id: "stf_1", name: "Lucía", active: true, globalCommissionPercentage: 40 };

const insertsOf = (table: unknown) => h.queries.filter((q) => q.kind === "insert" && q.table === table);
const selectsFrom = (table: unknown) => h.queries.filter((q) => q.kind === "select" && q.table === table);

beforeEach(() => {
  h.queries = [];
  h.results = (q) => {
    if (q.kind !== "select") return undefined;
    if (q.table === schema.service) return [SERVICIO];
    if (q.table === schema.staff) return [PROFESIONAL];
    return undefined;
  };
});

const venta = { items: [{ serviceId: "srv_1" }], amountCents: 5000, paymentMethod: "efectivo" as const };

describe("esquemas: «quién atendió» es opcional, pero nunca una cadena vacía", () => {
  const carrito = { items: [{ serviceId: "srv_1" }], amountCents: 3000 };
  it("la venta acepta staffId ausente, nulo o un id; rechaza \"\"", () => {
    expect(saleInputSchema.safeParse({ ...venta }).success).toBe(true);
    expect(saleInputSchema.safeParse({ ...venta, staffId: null }).success).toBe(true);
    expect(saleInputSchema.safeParse({ ...venta, staffId: "stf_1" }).success).toBe(true);
    expect(saleInputSchema.safeParse({ ...venta, staffId: "" }).success).toBe(false);
  });
  it("editar una venta: igual", () => {
    expect(saleEditSchema.safeParse({ ...carrito }).success).toBe(true);
    expect(saleEditSchema.safeParse({ ...carrito, staffId: null }).success).toBe(true);
    expect(saleEditSchema.safeParse({ ...carrito, staffId: "" }).success).toBe(false);
  });
  it("el alta de un cliente con su primera compra: igual", () => {
    const alta = { name: "Ana", items: [{ serviceId: "srv_1" }], amountCents: 3000, paymentMethod: "efectivo" } as const;
    expect(clientCreateSchema.safeParse(alta).success).toBe(true);
    expect(clientCreateSchema.safeParse({ ...alta, staffId: null }).success).toBe(true);
    expect(clientCreateSchema.safeParse({ ...alta, staffId: "" }).success).toBe(false);
  });
});

describe("cobrar sin profesional", () => {
  it("guarda staff_id nulo, sin comisión: todo el monto es del negocio", async () => {
    const r = await registerServiceSale("org_a", { ...venta });
    const [fila] = insertsOf(schema.serviceSale);
    expect(fila!.values).toMatchObject({ staffId: null, amountCents: 5000, staffCommissionCents: 0, businessNetCents: 5000 });
    expect(r.sale).toMatchObject({ staffId: null, staffName: NO_STAFF_LABEL, staffCommissionCents: 0, businessNetCents: 5000 });
    expect(r.commissionPercentage).toBe(0);
    expect(r.commissionSource).toBe("none");
  });

  it("no busca ningún profesional ni exige que alguien dé el servicio", async () => {
    await registerServiceSale("org_a", { ...venta });
    expect(selectsFrom(schema.staff)).toHaveLength(0);
    expect(selectsFrom(schema.serviceStaff)).toHaveLength(0);
    expect(selectsFrom(schema.staffServiceCommission)).toHaveLength(0);
  });

  it("ni siquiera una comisión puntual reparte nada sin profesional", async () => {
    const r = await registerServiceSale("org_a", { ...venta, customCommissionPercentage: 50 });
    expect(insertsOf(schema.serviceSale)[0]!.values).toMatchObject({ staffCommissionCents: 0, businessNetCents: 5000 });
    expect(r.commissionPercentage).toBe(0);
  });

  it("el ítem de la venta se guarda igual", async () => {
    await registerServiceSale("org_a", { ...venta });
    expect(insertsOf(schema.serviceSaleItem)[0]!.values).toEqual([
      expect.objectContaining({ serviceId: "srv_1", amountCents: 5000, position: 0 }),
    ]);
  });
});

describe("cobrar con profesional: el reparto de siempre", () => {
  it("el porcentaje global del profesional sigue mandando", async () => {
    const r = await registerServiceSale("org_a", { ...venta, staffId: "stf_1" });
    expect(insertsOf(schema.serviceSale)[0]!.values).toMatchObject({ staffId: "stf_1", staffCommissionCents: 2000, businessNetCents: 3000 });
    expect(r.sale).toMatchObject({ staffId: "stf_1", staffName: "Lucía" });
    expect(r.commissionSource).toBe("staff");
  });

  it("un profesional que no existe sigue siendo 404", async () => {
    h.results = (q) => (q.kind === "select" && q.table === schema.staff ? [] : q.table === schema.service ? [SERVICIO] : undefined);
    await expect(registerServiceSale("org_a", { ...venta, staffId: "stf_x" })).rejects.toMatchObject({ code: "staff_not_found", status: 404 });
  });
});

describe("Caja y reportes no pierden las ventas sin profesional", () => {
  const periodo = {
    start: new Date("2026-03-01T05:00:00Z"),
    end: new Date("2026-04-01T05:00:00Z"),
    timezone: "America/Lima",
    dto: { from: "2026-03-01", to: "2026-03-31", days: 31 },
  } as unknown as Parameters<typeof getSalesReport>[1];

  const sinProfesional = {
    id: "sls_1",
    createdAt: new Date("2026-03-10T15:00:00Z"),
    customerName: "Cliente de mostrador",
    contactId: null,
    staffId: null,
    staffName: null,
    serviceName: "Asesoría",
    comboName: null,
    paymentMethod: "efectivo",
    amountCents: 5000,
    staffCommissionCents: 0,
    businessNetCents: 5000,
    bookingId: null,
    birthdayDiscount: false,
    stamped: false,
    redeemed: false,
  };

  function programar(opts: { hayEquipo: boolean }) {
    h.results = (q) => {
      if (q.kind !== "select") return undefined;
      const f = q.fields ?? {};
      if ("serviceName" in f && "paymentMethod" in f && "stamped" in f) return [sinProfesional];
      if ("commission" in f) return [{ staffId: null, staffName: null, count: 1, revenue: 5000, commission: 0 }];
      if ("net" in f) return [{ count: 1, revenue: 5000, commissions: 0, net: 5000 }];
      if ("method" in f) return [{ method: "efectivo", count: 1, amount: 5000 }];
      if (q.table === schema.staff) return opts.hayEquipo ? [{ id: "stf_1" }] : [];
      return [];
    };
  }

  it("la fila y el desglose «por profesional» salen como «Sin asignar»", async () => {
    programar({ hayEquipo: false });
    const r = await getSalesReport("org_a", periodo);
    expect(r.rows[0]).toMatchObject({ staffId: null, staffName: NO_STAFF_LABEL, staffCommissionCents: 0 });
    expect(r.byStaff).toEqual([
      { staffId: null, staffName: NO_STAFF_LABEL, count: 1, revenueCents: 5000, commissionCents: 0, netCents: 5000 },
    ]);
    expect(r.totals).toMatchObject({ count: 1, revenueCents: 5000, commissionsCents: 0 });
  });

  it("los JOIN con staff son LEFT (un INNER las dejaría fuera de Caja pero dentro de los totales)", async () => {
    programar({ hayEquipo: false });
    await getSalesReport("org_a", periodo);
    const joinsConStaff = h.queries.flatMap((q) => q.calls.filter((c) => c.args[0] === schema.staff && /join/i.test(c.method)));
    expect(joinsConStaff.length).toBeGreaterThanOrEqual(2);
    expect(joinsConStaff.every((c) => c.method === "leftJoin")).toBe(true);
  });

  it("teamInUse: falso sin profesionales ni ventas atribuidas", async () => {
    programar({ hayEquipo: false });
    expect((await getSalesReport("org_a", periodo)).teamInUse).toBe(false);
  });

  it("teamInUse: verdadero si hay un profesional dado de alta", async () => {
    programar({ hayEquipo: true });
    expect((await getSalesReport("org_a", periodo)).teamInUse).toBe(true);
  });

  it("teamInUse: verdadero si ya hubo ventas con profesional, aunque hoy no haya equipo (comisiones históricas)", async () => {
    h.results = (q) => {
      if (q.kind !== "select") return undefined;
      const f = q.fields ?? {};
      if ("serviceName" in f) return [];
      if ("commission" in f || "net" in f || "method" in f) return [];
      if (q.table === schema.staff) return [];
      if (q.table === schema.serviceSale) return [{ id: "sls_viejo" }];
      return [];
    };
    expect((await getSalesReport("org_a", periodo)).teamInUse).toBe(true);
  });
});
