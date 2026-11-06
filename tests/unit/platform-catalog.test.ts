import { describe, expect, it } from "vitest";
import { BASE_CATEGORIES, DEFAULT_PLAN } from "@/server/seed/platform-catalog";

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

  it("el plan por defecto es válido: precio no negativo, WhatsApp y límites enteros", () => {
    expect(DEFAULT_PLAN.priceMonthlyCents ?? 0).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_PLAN.features.channels).toContain("whatsapp");
    expect(Number.isInteger(DEFAULT_PLAN.features.maxStaff)).toBe(true);
  });
});
