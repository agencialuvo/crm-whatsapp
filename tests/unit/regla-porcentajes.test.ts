import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clampPercent } from "@/lib/percent";

describe("clampPercent: todo porcentaje va de 0 a 100", () => {
  it("deja pasar lo válido", () => {
    expect(clampPercent("0")).toBe("0");
    expect(clampPercent("50")).toBe("50");
    expect(clampPercent("100")).toBe("100");
  });
  it("nunca pasa de 100", () => {
    expect(clampPercent("101")).toBe("100");
    expect(clampPercent("999")).toBe("100");
    expect(clampPercent("12345")).toBe("100");
  });
  it("no admite negativos, decimales ni letras", () => {
    expect(clampPercent("-5")).toBe("5");
    expect(clampPercent("12.5")).toBe("100"); // sin punto: 125 → tope 100
    expect(clampPercent("1e2")).toBe("12");
    expect(clampPercent("abc")).toBe("");
  });
  it("vacío sigue vacío (en varios campos significa «la regla de siempre»)", () => {
    expect(clampPercent("")).toBe("");
  });
  it("sin ceros a la izquierda", () => {
    expect(clampPercent("007")).toBe("7");
    expect(clampPercent("000")).toBe("0");
  });
});

/** Todo campo con límite de porcentaje (max=100) debe pasar por `clampPercent` al teclear. */
describe("regla: los campos de porcentaje usan clampPercent", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
    });
  }
  it("los componentes con un campo de porcentaje lo importan", () => {
    const offenders = files("src/components").filter((f) => {
      const src = readFileSync(f, "utf8");
      const hasPercentField = /max=\{100\}/.test(src) || /label="[^"]*\(%\)"/.test(src);
      return hasPercentField && !src.includes("clampPercent");
    });
    expect(offenders).toEqual([]);
  });
});
