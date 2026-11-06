import { describe, expect, it } from "vitest";
import { pickInitialPlan, type PlanCandidate } from "@/server/business/plan-selection";
import { BASE_CATEGORIES, BASE_PLANS } from "@/server/seed/platform-catalog";

const plan = (slug: string, price: number, modules: string[], active = true): PlanCandidate => ({
  id: `plan_${slug}`,
  slug,
  active,
  priceMonthlyCents: price,
  features: { modules },
});

describe("plan inicial según el sector", () => {
  const basico = plan("basico", 0, ["agenda"]);
  const salon = plan("salon", 0, ["agenda", "salon", "loyalty", "finances"]);

  it("elige el más barato que cubre TODOS los módulos del sector", () => {
    expect(pickInitialPlan([basico, salon], ["agenda", "salon", "loyalty", "finances"])?.slug).toBe("salon");
    expect(pickInitialPlan([basico, salon], ["agenda"])?.slug).toBe("basico");
  });

  it("a igual precio gana el de menos módulos; el precio manda sobre el tamaño", () => {
    const caro = plan("pro", 5000, ["agenda", "salon", "loyalty", "finances", "atribucion"]);
    const medio = plan("medio", 2000, ["agenda", "salon", "loyalty", "finances"]);
    expect(pickInitialPlan([caro, medio], ["agenda", "salon"])?.slug).toBe("medio");
    expect(pickInitialPlan([salon, plan("todo", 0, ["agenda", "salon", "loyalty", "finances", "atribucion"])], ["agenda"])?.slug).toBe("salon");
  });

  it("ignora los planes inactivos", () => {
    expect(pickInitialPlan([plan("salon", 0, ["agenda", "salon"], false), basico], ["agenda", "salon"])?.slug).toBe("basico");
  });

  it("si ninguno cubre todo, el que cubre más; sin planes, null", () => {
    expect(pickInitialPlan([basico, plan("otro", 0, ["agenda", "salon"])], ["agenda", "salon", "finances"])?.slug).toBe("otro");
    expect(pickInitialPlan([], ["agenda"])).toBeNull();
    expect(pickInitialPlan([plan("x", 0, ["agenda"], false)], ["agenda"])).toBeNull();
  });

  it("sector sin módulos declarados: el plan más barato", () => {
    expect(pickInitialPlan([salon, basico], [])?.slug).toBe("basico");
  });
});

describe("catálogo base: ningún sector nace bloqueado", () => {
  it("el plan inicial de cada categoría incluye todos sus módulos por defecto", () => {
    const candidatos = BASE_PLANS.map((p, i) => ({
      id: `plan_${i}`,
      slug: p.slug,
      active: p.active ?? true,
      priceMonthlyCents: p.priceMonthlyCents ?? 0,
      features: { modules: p.features.modules as readonly string[] },
    }));
    for (const c of BASE_CATEGORIES) {
      const elegido = pickInitialPlan(candidatos, c.defaultModules ?? []);
      expect(elegido, c.key).not.toBeNull();
      for (const m of c.defaultModules ?? []) expect(elegido!.features.modules, `${c.key}:${m}`).toContain(m);
    }
  });

  it("los slugs de los planes base son únicos", () => {
    const slugs = BASE_PLANS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
