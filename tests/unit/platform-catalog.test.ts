import { describe, expect, it } from "vitest";
import { BASE_CATEGORIES, BASE_PLANS, DEMO_PLAN, ENTERPRISE_PLAN, EMPRENDEDOR_PLAN, PRO_PLAN } from "@/server/seed/platform-catalog";

describe("catálogo base de la plataforma", () => {
  it("las categorías tienen llave única y las cuatro etiquetas completas", () => {
    const keys = BASE_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(["salon", "health", "services"]));
    for (const c of BASE_CATEGORIES) {
      for (const k of ["staffName", "serviceName", "resourceName", "clientName"] as const) {
        expect(c.labels[k].trim()).not.toBe("");
      }
    }
  });

  it("los módulos por defecto de cada categoría son conocidos y sin repetir", () => {
    const conocidos = ["agenda", "salon", "atribucion", "loyalty", "finances"];
    for (const c of BASE_CATEGORIES) {
      const mods = c.defaultModules ?? [];
      expect(new Set(mods).size).toBe(mods.length);
      for (const m of mods) expect(conocidos).toContain(m);
    }
  });

  it("hay exactamente 4 planes: Demo (prueba de 14 días), Emprendedor, Pro y Enterprise", () => {
    expect(BASE_PLANS.map((p) => p.slug)).toEqual(["demo", "emprendedor", "pro", "enterprise"]);
    expect(DEMO_PLAN.trialDays).toBe(14);
    expect(DEMO_PLAN.priceMonthlyCents).toBe(0);
    for (const p of [EMPRENDEDOR_PLAN, PRO_PLAN, ENTERPRISE_PLAN]) expect(p.trialDays ?? null).toBeNull();
  });

  it("los precios son los acordados (centavos de sol): 79 · 149 · 299", () => {
    expect([EMPRENDEDOR_PLAN, PRO_PLAN, ENTERPRISE_PLAN].map((p) => p.priceMonthlyCents)).toEqual([7900, 14900, 29900]);
    for (const p of BASE_PLANS) expect(p.currency).toBe("PEN");
  });

  it("la Demo incluye todo lo que incluye Pro (la prueba enseña el producto completo)", () => {
    for (const m of PRO_PLAN.features.modules) expect(DEMO_PLAN.features.modules).toContain(m);
    for (const c of PRO_PLAN.features.channels) expect(DEMO_PLAN.features.channels).toContain(c);
  });

  it("Enterprise es ilimitado y cada plan es válido: WhatsApp incluido y límites enteros", () => {
    expect(ENTERPRISE_PLAN.features.maxStaff).toBe(-1);
    expect(ENTERPRISE_PLAN.features.maxMonthlyAiTurns).toBe(-1);
    for (const p of BASE_PLANS) {
      expect(p.features.channels).toContain("whatsapp");
      expect(Number.isInteger(p.features.maxStaff)).toBe(true);
      expect(Number.isInteger(p.features.maxMonthlyAiTurns)).toBe(true);
    }
  });

  it("Básico y Salón ya no se siembran (la migración 0080 los retira)", () => {
    const slugs = BASE_PLANS.map((p) => p.slug);
    expect(slugs).not.toContain("basico");
    expect(slugs).not.toContain("salon");
  });
});
