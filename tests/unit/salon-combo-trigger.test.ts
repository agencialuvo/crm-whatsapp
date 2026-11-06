import { describe, expect, it } from "vitest";
import {
  buildComboTriggerInstruction,
  detectComboTrigger,
  type TriggerCombo,
} from "@/server/ai/combo-trigger";

const combo = (name: string, keywordTrigger: string | null, priceCents = 4500): TriggerCombo => ({
  name,
  description: "Corte, mascarilla y masaje",
  priceCents,
  keywordTrigger,
});

const fresh = combo("Combo Fresh", "COMBO_FRESH");
const vip = combo("Combo Fresh VIP", "COMBO_FRESH_VIP", 8000);
const sinClave = combo("Corte simple", null);
const all = [sinClave, fresh, vip];

describe("detectComboTrigger", () => {
  it.each([
    "COMBO_FRESH",
    "combo_fresh",
    "Hola, quiero el combo fresh",
    "Hola! vi el anuncio del Combo-Fresh",
    "COMBO FRESH por favor",
    "cómbo frésh",
  ])("detecta «%s»", (text) => {
    expect(detectComboTrigger(text, [sinClave, fresh])).toBe(fresh);
  });

  it("gana la palabra clave más larga cuando coinciden varias", () => {
    expect(detectComboTrigger("quiero el COMBO_FRESH_VIP", all)).toBe(vip);
    expect(detectComboTrigger("quiero el COMBO_FRESH", all)).toBe(fresh);
  });

  it("exige palabra completa", () => {
    expect(detectComboTrigger("combofreshisimo", all)).toBeNull();
    expect(detectComboTrigger("supercombo_fresh", all)).toBeNull();
  });

  it("sin coincidencia, sin texto o sin combos con clave devuelve null", () => {
    expect(detectComboTrigger("hola, ¿cuánto cuesta un corte?", all)).toBeNull();
    expect(detectComboTrigger("", all)).toBeNull();
    expect(detectComboTrigger(null, all)).toBeNull();
    expect(detectComboTrigger(undefined, all)).toBeNull();
    expect(detectComboTrigger("COMBO_FRESH", [sinClave])).toBeNull();
    expect(detectComboTrigger("COMBO_FRESH", [])).toBeNull();
  });
});

describe("buildComboTriggerInstruction", () => {
  const text = buildComboTriggerInstruction(fresh, "PEN");

  it("es prioritaria y nombra el combo, lo que incluye y el precio en la moneda del negocio", () => {
    expect(text).toContain("INSTRUCCIÓN PRIORITARIA");
    expect(text).toContain("Combo Fresh");
    expect(text).toContain("Corte, mascarilla y masaje");
    expect(text.replace(String.fromCharCode(160), " ")).toContain("S/ 45.00");
  });

  it("sin descripción (es opcional) salta «qué incluye» y renumera, sin inventar nada", () => {
    const sin = buildComboTriggerInstruction({ ...fresh, description: "" }, "PEN");
    expect(sin).not.toContain("qué incluye");
    expect(sin).toContain("1. Salúdalo");
    expect(sin).toContain("2. Dile el precio especial");
    expect(sin).toContain("3. Cierra invitándolo");
    expect(sin).not.toContain("4.");
  });

  it("ordena saludar reconociendo la promoción y no inventar", () => {
    expect(text).toContain("Salúdalo reconociendo");
    expect(text).toContain("no inventes");
  });
});
