import { describe, expect, it } from "vitest";
import {
  buildExpenseSummary,
  expenseItemInputSchema,
  expenseQuantityLabel,
  expenseTotalUnits,
  expenseUnitCostCents,
} from "@/lib/salon/expenses";
import { appNavGroups } from "@/lib/nav";

const ok = {
  name: "Cuchillas de afeitar",
  quantity: 100,
  totalPriceCents: 2500,
  expenseDate: "2026-10-20",
};

describe("gastos — un gasto", () => {
  it("el precio es el total pagado: no se multiplica por la cantidad", () => {
    const r = expenseItemInputSchema.parse(ok);
    expect(r).toMatchObject({ quantity: 100, totalPriceCents: 2500, isFixed: false });
    expect(r.notes).toBeNull();
    expect(expenseItemInputSchema.parse({ ...ok, notes: " caja de 100 " }).notes).toBe("caja de 100");
  });

  it("exige nombre, precio ≥ 0 y fecha AAAA-MM-DD", () => {
    for (const bad of [
      { name: "a" },
      { totalPriceCents: -1 },
      { totalPriceCents: Number.NaN },
      { expenseDate: "20/10/2026" },
    ]) {
      expect(expenseItemInputSchema.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(expenseItemInputSchema.safeParse({ ...ok, totalPriceCents: 0 }).success).toBe(true);
  });

  it("rechaza un precio que no cabe en la base", () => {
    expect(expenseItemInputSchema.safeParse({ ...ok, totalPriceCents: 2_000_001_000 }).success).toBe(false);
  });
});

describe("gastos — cantidad de referencia", () => {
  it("la cantidad es opcional: sin ella el gasto es válido y queda en null", () => {
    const { quantity: _q, ...sinCantidad } = ok;
    expect(expenseItemInputSchema.parse(sinCantidad).quantity).toBeNull();
    expect(expenseItemInputSchema.parse({ ...ok, quantity: null }).quantity).toBeNull();
  });

  it("si viene, debe ser un entero entre 1 y 100 000", () => {
    for (const bad of [{ quantity: 0 }, { quantity: 1.5 }, { quantity: Number.NaN }, { quantity: 100_001 }]) {
      expect(expenseItemInputSchema.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("no cambia el precio: es solo una referencia", () => {
    expect(expenseItemInputSchema.parse({ ...ok, quantity: 3 }).totalPriceCents).toBe(2500);
  });
});

describe("gastos — paquetes y unidades por paquete", () => {
  it("guarda paquetes, unidades por paquete y unidad sin tocar el precio", () => {
    const r = expenseItemInputSchema.parse({ ...ok, quantity: 3, unitsPerPackage: 100 });
    expect(r).toMatchObject({ quantity: 3, unitsPerPackage: 100, totalPriceCents: 2500 });
    expect(expenseTotalUnits(r)).toBe(300);
  });

  it("unidades sueltas: sin unidades por paquete el total es la cantidad", () => {
    const r = expenseItemInputSchema.parse({ ...ok, quantity: 5 });
    expect(r.unitsPerPackage).toBeNull();
    expect(expenseTotalUnits(r)).toBe(5);
    expect(expenseTotalUnits({ quantity: null, unitsPerPackage: null })).toBeNull();
  });

  it("sin cantidad no se guardan unidades por paquete", () => {
    const { quantity: _q, ...sin } = ok;
    expect(expenseItemInputSchema.parse({ ...sin, unitsPerPackage: 10 }).unitsPerPackage).toBeNull();
  });

  it("la docena ya no es una presentación", () => {
    expect(expenseItemInputSchema.safeParse({ ...ok, presentation: "dozen", quantity: 2 }).success).toBe(false);
  });

  it("volumen / peso: exige su unidad y no lleva paquete", () => {
    expect(expenseItemInputSchema.safeParse({ ...ok, presentation: "measure", quantity: 2 }).success).toBe(false);
    const r = expenseItemInputSchema.parse({
      ...ok,
      presentation: "measure",
      measureUnit: "kg",
      quantity: 2,
      unitsPerPackage: 9,
    });
    expect(r).toMatchObject({ presentation: "measure", measureUnit: "kg", unitsPerPackage: null, quantity: 2 });
    expect(expenseItemInputSchema.safeParse({ ...ok, presentation: "measure", measureUnit: "oz", quantity: 1 }).success).toBe(false);
  });

  it("servicio / licencia: sin paquete ni unidad de medida", () => {
    const r = expenseItemInputSchema.parse({
      ...ok,
      presentation: "service",
      quantity: 3,
      unitsPerPackage: 4,
      measureUnit: "l",
    });
    expect(r).toMatchObject({ presentation: "service", unitsPerPackage: null, measureUnit: null });
  });

  it("la unidad de medida solo se guarda en volumen / peso", () => {
    expect(
      expenseItemInputSchema.parse({ ...ok, presentation: "units", quantity: 1, measureUnit: "g" }).measureUnit
    ).toBeNull();
  });

  it("unidades: no lleva paquete aunque llegue", () => {
    const r = expenseItemInputSchema.parse({ ...ok, presentation: "units", quantity: 3, unitsPerPackage: 9 });
    expect(r).toMatchObject({ presentation: "units", unitsPerPackage: null });
    expect(expenseTotalUnits(r)).toBe(3);
  });

  it("paquete / caja: exige las unidades por paquete cuando hay cantidad", () => {
    const bad = expenseItemInputSchema.safeParse({ ...ok, presentation: "package", quantity: 1 });
    expect(bad.success).toBe(false);
    const good = expenseItemInputSchema.parse({ ...ok, presentation: "package", quantity: 1, unitsPerPackage: 100 });
    expect(expenseTotalUnits(good)).toBe(100);
  });

  it("sin cantidad no hay presentación", () => {
    const { quantity: _q, ...sin } = ok;
    expect(expenseItemInputSchema.parse({ ...sin, presentation: "measure", measureUnit: "l" })).toMatchObject({
      presentation: null,
      unitsPerPackage: null,
      measureUnit: null,
    });
  });

  it("rechaza unidades por paquete inválidas", () => {
    for (const bad of [{ unitsPerPackage: 0 }, { unitsPerPackage: 1.5 }, { unitsPerPackage: 100_001 }]) {
      expect(expenseItemInputSchema.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("un gasto fijo ignora todo el detalle", () => {
    const r = expenseItemInputSchema.parse({
      name: "Alquiler",
      isFixed: true,
      totalPriceCents: 1,
      expenseDate: "2026-10-01",
      quantity: 2,
      unitsPerPackage: 5,
    });
    expect(r).toMatchObject({ quantity: null, unitsPerPackage: null });
  });
});

describe("gastos — costo por unidad y etiquetas", () => {
  it("costo por unidad en centavos enteros, redondeado; el total no cambia", () => {
    expect(expenseUnitCostCents({ totalPriceCents: 1000, quantity: 3, unitsPerPackage: null })).toBe(333);
    expect(expenseUnitCostCents({ totalPriceCents: 2500, quantity: 2, unitsPerPackage: 50 })).toBe(25);
  });

  it("sin cantidad o sin precio no hay costo por unidad", () => {
    expect(expenseUnitCostCents({ totalPriceCents: 1000, quantity: null, unitsPerPackage: null })).toBeNull();
    expect(expenseUnitCostCents({ totalPriceCents: 0, quantity: 4, unitsPerPackage: null })).toBeNull();
  });

  it("etiqueta de cantidad por presentación", () => {
    const base = { quantity: 3, unitsPerPackage: null, measureUnit: null, presentation: null };
    expect(expenseQuantityLabel({ ...base, quantity: null })).toBeNull();
    expect(expenseQuantityLabel({ ...base, presentation: "units" })).toEqual({ main: "3 und", sub: null });
    expect(expenseQuantityLabel({ ...base, presentation: "package", unitsPerPackage: 12 })).toEqual({
      main: "3 paq × 12",
      sub: "= 36 und",
    });
    expect(expenseQuantityLabel({ ...base, presentation: "measure", measureUnit: "kg" })).toEqual({ main: "3 kg", sub: null });
    expect(expenseQuantityLabel({ ...base, presentation: "service" })).toEqual({ main: "3 srv", sub: null });
  });
});

describe("gastos — fijo o variable", () => {
  const fixed = { name: "Alquiler", isFixed: true, totalPriceCents: 80_000, expenseDate: "2026-10-01" };

  it("por defecto es variable", () => {
    expect(expenseItemInputSchema.parse(ok).isFixed).toBe(false);
  });

  it("un gasto fijo es un solo monto y no lleva cantidad", () => {
    expect(expenseItemInputSchema.parse(fixed)).toMatchObject({
      isFixed: true,
      quantity: null,
      totalPriceCents: 80_000,
    });
  });

  it("un gasto fijo ignora la cantidad que llegue", () => {
    expect(expenseItemInputSchema.parse({ ...fixed, quantity: 7 }).quantity).toBeNull();
  });
});

describe("gastos — ganancia neta real", () => {
  it("ingresos − comisiones − gastos", () => {
    const s = buildExpenseSummary({
      revenueCents: 100_000,
      commissionsCents: 50_000,
      expensesCents: 12_000,
      byKind: { fixed: { count: 0, totalCents: 0 }, variable: { count: 0, totalCents: 0 } },
    });
    expect(s.netBeforeExpensesCents).toBe(50_000);
    expect(s.realNetCents).toBe(38_000);
  });

  it("puede ser negativa si se gastó más de lo que quedó", () => {
    expect(
      buildExpenseSummary({
        revenueCents: 20_000,
        commissionsCents: 10_000,
        expensesCents: 25_000,
        byKind: { fixed: { count: 0, totalCents: 0 }, variable: { count: 0, totalCents: 0 } },
      }).realNetCents
    ).toBe(-15_000);
  });

  it("sin gastos, la ganancia real es la neta de Caja", () => {
    const s = buildExpenseSummary({
      revenueCents: 9_000,
      commissionsCents: 4_500,
      expensesCents: 0,
      byKind: { fixed: { count: 0, totalCents: 0 }, variable: { count: 0, totalCents: 0 } },
    });
    expect(s.realNetCents).toBe(s.netBeforeExpensesCents);
  });
});

describe("gastos — menú", () => {
  it("«Gastos» es solo del dueño y el administrador, con la bandera SALON", () => {
    const hrefs = (o: Parameters<typeof appNavGroups>[0]) =>
      appNavGroups(o).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs({ salon: true, role: "owner" })).toContain("/gastos");
    expect(hrefs({ salon: true, role: "admin" })).toContain("/gastos");
    expect(hrefs({ salon: true, role: "member" })).not.toContain("/gastos");
    expect(hrefs({ salon: false, role: "owner" })).not.toContain("/gastos");
  });
});
