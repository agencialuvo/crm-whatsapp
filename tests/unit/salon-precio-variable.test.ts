import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * Servicios con precio fijo o variable. Variable: el monto se escribe al vender (y al editar la venta) y el agente
 * dice «Precio a consultar» en vez de «S/ 0.00». «Otro» (`isOther`) sigue igual: su detalle es obligatorio, vive
 * aparte del catálogo y el agente no lo lista.
 *
 * La base es un doble en memoria que graba lo que se consulta y se escribe; el esquema es el real.
 */

type Call = { method: string; args: unknown[] };
type Chain = { [method: string]: (...args: unknown[]) => Chain };
type Q = { kind: string; table: unknown; fields: Record<string, unknown> | undefined; calls: Call[]; values?: unknown };
const h = vi.hoisted(() => ({
  queries: [] as unknown[],
  results: null as null | ((q: unknown) => unknown),
  flow: null as null | { id: string; sourceId: string; exclusive: boolean; promptRules: string | null; serviceId: string | null; comboId: string | null },
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  const NOW = new Date("2026-03-10T15:00:00.000Z");
  function query(kind: string, table: unknown, fields?: Record<string, unknown>) {
    const q: Q = { kind, table, fields, calls: [], values: undefined };
    h.queries.push(q);
    const proxy: Chain = new Proxy({} as Chain, {
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
          if (prop === "set") q.values = args[0];
          return proxy;
        };
      },
    });
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
vi.mock("@/server/loyalty/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/loyalty/actions")>()),
  getBirthdayCampaign: async () => ({ enabled: false, serviceIds: [] }),
}));
vi.mock("@/server/branding", () => ({ getBranding: async () => ({ currency: "PEN" }) }));
vi.mock("@/server/attribution/ad-flow", () => ({ findActiveAdFlow: async () => h.flow }));

import { schema } from "@/lib/db";
import { PRICE_ON_REQUEST, priceLabel } from "@/lib/salon/format";
import { parseServiceRow } from "@/lib/salon/bulk";
import { saleInputSchema, serviceInputSchema } from "@/lib/salon/schemas";
import { getAdFlowContext } from "@/server/ai/ad-flow-context";
import { getBarbershopAiContext } from "@/server/ai/barbershop-context";
import { createService, updateService } from "@/server/business/catalog";
import { getSaleOptions, registerServiceSale, updateSale } from "@/server/business/sales-service";

const FIJO = { id: "srv_fijo", name: "Corte", priceCents: 2500, priceMode: "fixed", active: true, isOther: false, defaultCommissionPercentage: null };
const VARIABLE = { id: "srv_var", name: "Asesoría", priceCents: 0, priceMode: "variable", active: true, isOther: false, defaultCommissionPercentage: null };
const OTRO = { id: "srv_otro", name: "Otro", priceCents: 0, priceMode: "fixed", active: true, isOther: true, defaultCommissionPercentage: null };
const PROFESIONAL = { id: "stf_1", name: "Lucía", active: true, globalCommissionPercentage: 40 };

const qs = () => h.queries as Q[];
const insertsOf = (table: unknown) => qs().filter((q) => q.kind === "insert" && q.table === table);

/** Qué servicio devuelve la base cuando se pide uno de la tabla `service`. */
function servicios(...rows: (typeof FIJO)[]) {
  h.results = (raw) => {
    const q = raw as Q;
    if (q.kind !== "select") return undefined;
    if (q.table === schema.service) {
      // «Otro» se busca por `is_other`; el resto, por id: el doble devuelve la fila que corresponde a lo pedido.
      const where = q.calls.find((c) => c.method === "where")?.args[0];
      const text = where ? JSON.stringify(new PgDialect().sqlToQuery(where as never)) : "";
      const otro = rows.find((r) => r.isOther);
      if (otro && text.includes("is_other")) return [otro];
      return [rows.find((r) => !r.isOther && text.includes(r.id)) ?? rows.find((r) => !r.isOther) ?? otro];
    }
    if (q.table === schema.staff) return [PROFESIONAL];
    return undefined;
  };
}

beforeEach(() => {
  h.queries = [];
  h.results = null;
  h.flow = null;
});

describe("priceLabel", () => {
  it("variable → «Precio a consultar», nunca un monto; fijo → el monto", () => {
    expect(PRICE_ON_REQUEST).toBe("Precio a consultar");
    expect(priceLabel("variable", 0, "PEN")).toBe("Precio a consultar");
    expect(priceLabel("variable", 5000, "PEN")).toBe("Precio a consultar");
    expect(priceLabel("fixed", 2500, "PEN")).toContain("25.00");
    expect(priceLabel(undefined, 2500, "PEN")).toContain("25.00");
  });
});

describe("esquema del servicio", () => {
  const base = { name: "Asesoría", priceCents: 0 };
  it("acepta fixed y variable, o ninguno (fijo al crear); rechaza cualquier otro valor", () => {
    expect(serviceInputSchema.safeParse(base).success).toBe(true);
    expect(serviceInputSchema.safeParse({ ...base, priceMode: "fixed" }).success).toBe(true);
    expect(serviceInputSchema.safeParse({ ...base, priceMode: "variable" }).success).toBe(true);
    expect(serviceInputSchema.safeParse({ ...base, priceMode: "libre" }).success).toBe(false);
  });
  it("con precio variable el precio de referencia puede ser 0; un negativo sigue siendo inválido", () => {
    expect(serviceInputSchema.safeParse({ ...base, priceMode: "variable", priceCents: 0 }).success).toBe(true);
    expect(serviceInputSchema.safeParse({ ...base, priceMode: "variable", priceCents: -1 }).success).toBe(false);
  });
  it("la venta con un servicio variable sigue siendo una venta válida para el esquema (el servidor exige el monto)", () => {
    const venta = { items: [{ serviceId: "srv_var", amountCents: 7000 }], amountCents: 7000, paymentMethod: "efectivo" };
    expect(saleInputSchema.safeParse(venta).success).toBe(true);
  });
});

describe("catálogo: crear y editar con modalidad de precio", () => {
  beforeEach(() => {
    h.results = (raw) => {
      const q = raw as Q;
      if (q.kind === "insert" && q.table === schema.service) return [{ id: "srv_nuevo", ...(q.values as object), createdAt: new Date() }];
      if (q.kind === "update" && q.table === schema.service) return [{ ...FIJO, ...(q.values as object) }];
      return undefined;
    };
  });
  it("sin priceMode se crea fijo", async () => {
    const dto = await createService("org_a", { name: "Corte", priceCents: 2500 } as never);
    expect(insertsOf(schema.service)[0]!.values).toMatchObject({ priceMode: "fixed", priceCents: 2500 });
    expect(dto.priceMode).toBe("fixed");
  });
  it("variable se guarda y viaja en el DTO", async () => {
    const dto = await createService("org_a", { name: "Asesoría", priceCents: 0, priceMode: "variable" } as never);
    expect(insertsOf(schema.service)[0]!.values).toMatchObject({ priceMode: "variable", priceCents: 0 });
    expect(dto).toMatchObject({ priceMode: "variable", priceCents: 0 });
  });
  it("editar: cambiar la modalidad no toca nada más; sin priceMode en el PATCH no se pisa", async () => {
    await updateService("org_a", "srv_fijo", { priceMode: "variable" });
    const [u1] = qs().filter((q) => q.kind === "update" && q.table === schema.service);
    expect(u1!.values).toMatchObject({ priceMode: "variable" });
    expect(u1!.values).not.toHaveProperty("priceCents");
    h.queries = [];
    await updateService("org_a", "srv_fijo", { name: "Otro nombre" });
    const [u2] = qs().filter((q) => q.kind === "update" && q.table === schema.service);
    expect(u2!.values).not.toHaveProperty("priceMode");
  });
});

describe("cobrar un servicio de precio variable", () => {
  const venta = (items: object[], amountCents: number) => ({ items, amountCents, paymentMethod: "efectivo" as const });

  it("sin monto: 422 price_required, y no se escribe nada", async () => {
    servicios(VARIABLE);
    await expect(registerServiceSale("org_a", venta([{ serviceId: "srv_var" }], 7000))).rejects.toMatchObject({ code: "price_required", status: 422 });
    expect(insertsOf(schema.serviceSale)).toHaveLength(0);
  });

  it("con monto cero o ausente tampoco", async () => {
    servicios(VARIABLE);
    await expect(registerServiceSale("org_a", venta([{ serviceId: "srv_var", amountCents: 0 }], 7000))).rejects.toMatchObject({ code: "price_required" });
  });

  it("con monto: el ítem se guarda con ese monto y la venta con el total", async () => {
    servicios(VARIABLE);
    const r = await registerServiceSale("org_a", venta([{ serviceId: "srv_var", amountCents: 7000 }], 7000));
    expect(insertsOf(schema.serviceSale)[0]!.values).toMatchObject({ amountCents: 7000, serviceId: "srv_var" });
    expect(insertsOf(schema.serviceSaleItem)[0]!.values).toEqual([expect.objectContaining({ serviceId: "srv_var", amountCents: 7000 })]);
    expect(r.sale.items[0]).toMatchObject({ name: "Asesoría", amountCents: 7000, other: false, variable: true });
  });

  it("la comisión se calcula sobre el monto escrito", async () => {
    servicios(VARIABLE);
    const r = await registerServiceSale("org_a", { ...venta([{ serviceId: "srv_var", amountCents: 10_000 }], 10_000), staffId: "stf_1" });
    expect(insertsOf(schema.serviceSale)[0]!.values).toMatchObject({ staffCommissionCents: 4000, businessNetCents: 6000 });
    expect(r.commissionSource).toBe("staff");
  });

  it("la forma de un solo ítem (sin carrito): el total cobrado es el monto del servicio variable", async () => {
    servicios(VARIABLE);
    await registerServiceSale("org_a", { serviceId: "srv_var", amountCents: 7000, paymentMethod: "efectivo" });
    expect(insertsOf(schema.serviceSaleItem)[0]!.values).toEqual([expect.objectContaining({ serviceId: "srv_var", amountCents: 7000 })]);
  });

  it("un carrito mezcla fijo y variable: el total se reparte sobre los precios de cada uno", async () => {
    h.results = (raw) => {
      const q = raw as Q;
      if (q.kind !== "select") return undefined;
      if (q.table === schema.service) {
        const text = JSON.stringify(new PgDialect().sqlToQuery(q.calls.find((c) => c.method === "where")!.args[0] as never));
        return [text.includes("srv_var") ? VARIABLE : FIJO];
      }
      return undefined;
    };
    await registerServiceSale("org_a", venta([{ serviceId: "srv_fijo" }, { serviceId: "srv_var", amountCents: 7500 }], 10_000));
    expect(insertsOf(schema.serviceSaleItem)[0]!.values).toEqual([
      expect.objectContaining({ serviceId: "srv_fijo", amountCents: 2500 }),
      expect.objectContaining({ serviceId: "srv_var", amountCents: 7500 }),
    ]);
  });
});

describe("el servicio de precio FIJO no cambia", () => {
  it("su precio sale del catálogo aunque el cliente mande otro monto en el ítem", async () => {
    servicios(FIJO);
    await registerServiceSale("org_a", { items: [{ serviceId: "srv_fijo", amountCents: 1 }], amountCents: 2500, paymentMethod: "efectivo" });
    expect(insertsOf(schema.serviceSaleItem)[0]!.values).toEqual([expect.objectContaining({ serviceId: "srv_fijo", amountCents: 2500 })]);
  });
});

describe("«Otro» (isOther) sigue igual", () => {
  it("cobra el monto escrito con su detalle, sin marcarse como variable", async () => {
    servicios(OTRO);
    const r = await registerServiceSale("org_a", {
      items: [{ other: true, amountCents: 3000, note: "Peinado para evento" }],
      amountCents: 3000,
      paymentMethod: "efectivo",
    });
    expect(r.sale.items[0]).toMatchObject({ other: true, variable: false, amountCents: 3000, note: "Peinado para evento", name: "Otro: Peinado para evento" });
  });

  it("el detalle sigue siendo obligatorio en el esquema", () => {
    const sinDetalle = { items: [{ other: true, amountCents: 3000 }], amountCents: 3000, paymentMethod: "efectivo" };
    expect(saleInputSchema.safeParse(sinDetalle).success).toBe(false);
  });

  it("no entra al catálogo del agente", async () => {
    h.results = (raw) => {
      const q = raw as Q;
      if (q.kind === "select" && q.table === schema.service) return [{ id: "srv_fijo", name: "Corte", description: null, price: 2500, priceMode: "fixed", duration: 30 }];
      return undefined;
    };
    await getBarbershopAiContext("org_a");
    const consulta = qs().find((q) => q.kind === "select" && q.table === schema.service)!;
    const where = new PgDialect().sqlToQuery(consulta.calls.find((c) => c.method === "where")!.args[0] as never);
    expect(where.sql).toContain("is_other");
    expect(where.params).toContain(false);
  });
});

describe("editar una venta con un servicio variable", () => {
  const actual = {
    id: "sls_1",
    organizationId: "org_a",
    staffId: "stf_1",
    contactId: null,
    customerName: "Cliente de mostrador",
    amountCents: 7000,
    staffCommissionCents: 2800,
    businessNetCents: 4200,
    birthdayDiscount: false,
    createdAt: new Date("2026-03-10T15:00:00Z"),
  };
  function programar() {
    h.results = (raw) => {
      const q = raw as Q;
      if (q.kind !== "select") return undefined;
      if (q.table === schema.serviceSale) return [actual];
      if (q.table === schema.staff) return [PROFESIONAL];
      if (q.table === schema.service) return [VARIABLE];
      return undefined;
    };
  }

  it("sin el monto del servicio variable: 422 price_required y la venta no se toca", async () => {
    programar();
    await expect(
      updateSale("org_a", "sls_1", { items: [{ serviceId: "srv_var" }], staffId: "stf_1", amountCents: 7000 }, "usr_1")
    ).rejects.toMatchObject({ code: "price_required", status: 422 });
    expect(qs().filter((q) => q.kind === "update" && q.table === schema.serviceSale)).toHaveLength(0);
  });

  it("con el monto: pasa la validación de precio y reparte la comisión sobre él", async () => {
    programar();
    await updateSale("org_a", "sls_1", { items: [{ serviceId: "srv_var", amountCents: 9000 }], staffId: "stf_1", amountCents: 9000 }, "usr_1").catch((e) => {
      // Lo que venga después de resolver los ítems (auditoría, sello) no es lo que se prueba aquí.
      expect((e as { code?: string }).code).not.toBe("price_required");
    });
    const cambio = qs().find((q) => q.kind === "update" && q.table === schema.serviceSale);
    expect(cambio?.values).toMatchObject({ amountCents: 9000, staffCommissionCents: 3600, businessNetCents: 5400 });
  });
});

describe("opciones de la caja", () => {
  it("cada servicio trae su modalidad de precio", async () => {
    await getSaleOptions("org_a");
    const consulta = qs().find((q) => q.kind === "select" && q.table === schema.service && q.fields && "durationMinutes" in q.fields)!;
    expect(Object.keys(consulta.fields!)).toContain("priceMode");
  });
});

describe("el agente no dice «S/ 0.00» de un servicio variable", () => {
  it("catálogo del negocio: «Precio a consultar» para el variable y el monto para el fijo", async () => {
    h.results = (raw) => {
      const q = raw as Q;
      if (q.kind === "select" && q.table === schema.service) {
        return [
          { id: "srv_fijo", name: "Corte", description: null, price: 2500, priceMode: "fixed", duration: 30 },
          { id: "srv_var", name: "Asesoría", description: null, price: 0, priceMode: "variable", duration: null },
        ];
      }
      return undefined;
    };
    const texto = await getBarbershopAiContext("org_a");
    expect(texto).toContain("- Corte: S/");
    expect(texto).toContain("25.00");
    expect(texto).toMatch(/- Asesoría: Precio a consultar/);
    expect(texto).not.toMatch(/Asesoría: S\/\s*0/);
  });

  it("flujo por anuncio: el precio del servicio variable sale como «Precio a consultar»", async () => {
    h.flow = { id: "flow_1", sourceId: "ad_1", exclusive: false, promptRules: null, serviceId: "srv_var", comboId: null };
    h.results = (raw) => {
      const q = raw as Q;
      if (q.kind === "select" && q.table === schema.service) {
        return [{ id: "srv_var", name: "Asesoría", description: null, priceCents: 0, priceMode: "variable", durationMinutes: null }];
      }
      return undefined;
    };
    const ctx = await getAdFlowContext("org_a", "ad_1");
    expect(ctx?.target?.priceLabel).toBe("Precio a consultar");
  });

  it("flujo por anuncio con un servicio fijo: sigue dando el monto", async () => {
    h.flow = { id: "flow_1", sourceId: "ad_1", exclusive: false, promptRules: null, serviceId: "srv_fijo", comboId: null };
    h.results = (raw) => {
      const q = raw as Q;
      if (q.kind === "select" && q.table === schema.service) {
        return [{ id: "srv_fijo", name: "Corte", description: null, priceCents: 2500, priceMode: "fixed", durationMinutes: 30 }];
      }
      return undefined;
    };
    const ctx = await getAdFlowContext("org_a", "ad_1");
    expect(ctx?.target?.priceLabel).toContain("25.00");
  });
});

describe("carga masiva de servicios con precio variable", () => {
  const base = { tipo: "servicio", nombre: "Asesoría", precio: "" };
  it("precio_variable = si: el precio puede ir vacío (referencia 0)", () => {
    const r = parseServiceRow(2, { ...base, precio_variable: "si" });
    expect(r.ok && r.data.input).toMatchObject({ priceMode: "variable", priceCents: 0 });
  });
  it("precio_variable = si con un precio: queda como referencia", () => {
    const r = parseServiceRow(2, { ...base, precio: "80", precio_variable: "si" });
    expect(r.ok && r.data.input).toMatchObject({ priceMode: "variable", priceCents: 8000 });
  });
  it("sin la columna o en «no», es fijo y el precio sigue siendo obligatorio", () => {
    expect(parseServiceRow(2, { ...base, precio: "25" }).ok).toBe(true);
    const sinPrecio = parseServiceRow(2, { ...base, precio_variable: "no" });
    expect(!sinPrecio.ok && sinPrecio.errors.map((e) => e.column)).toContain("precio");
    const fijo = parseServiceRow(2, { ...base, precio: "25" });
    expect(fijo.ok && fijo.data.input).toMatchObject({ priceMode: "fixed" });
  });
  it("las ofertas ignoran la columna: siempre son de precio fijo", () => {
    const r = parseServiceRow(2, { tipo: "oferta", nombre: "Combo", precio: "60", precio_variable: "si" });
    expect(r.ok && r.data.input).not.toHaveProperty("priceMode");
  });
  it("un valor que no es si/no se reporta en su columna", () => {
    const r = parseServiceRow(2, { ...base, precio: "25", precio_variable: "quizá" });
    expect(!r.ok && r.errors.map((e) => e.column)).toContain("precio_variable");
  });
});
