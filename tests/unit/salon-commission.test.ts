import { describe, expect, it } from "vitest";
import {
  resolveCommissionPercentage,
  splitAmount,
} from "@/lib/salon/commission";

/**
 * Módulo SALON — el reparto de cada venta. Es dinero: la regla de qué
 * porcentaje manda y la aritmética en centavos tienen que ser exactas.
 */

describe("resolveCommissionPercentage", () => {
  it("sin nada configurado NO hay comisión: no existe un porcentaje por defecto", () => {
    expect(resolveCommissionPercentage({})).toEqual({ percentage: 0, source: "none" });
    expect(splitAmount(5000, resolveCommissionPercentage({}).percentage)).toEqual({
      staffCommissionCents: 0,
      businessNetCents: 5000,
    });
  });

  it("manda lo más específico: venta → pacto → profesional → servicio", () => {
    const todo = { custom: 10, staffService: 20, staff: 30, service: 40 };
    expect(resolveCommissionPercentage(todo)).toEqual({ percentage: 10, source: "custom" });
    expect(resolveCommissionPercentage({ ...todo, custom: null })).toEqual({
      percentage: 20,
      source: "staff_service",
    });
    expect(resolveCommissionPercentage({ ...todo, custom: null, staffService: null })).toEqual({
      percentage: 30,
      source: "staff",
    });
    expect(
      resolveCommissionPercentage({ staffService: null, staff: null, service: 40 })
    ).toEqual({ percentage: 40, source: "service" });
  });

  it("un 0 % es un porcentaje válido (no cae al siguiente)", () => {
    expect(resolveCommissionPercentage({ custom: 0, staff: 50 })).toEqual({
      percentage: 0,
      source: "custom",
    });
  });

  it("ignora lo fuera de 0-100 o no numérico en vez de repartir mal", () => {
    expect(resolveCommissionPercentage({ custom: 150, staff: 35 })).toEqual({
      percentage: 35,
      source: "staff",
    });
    expect(resolveCommissionPercentage({ custom: -1, staffService: Number.NaN })).toEqual({
      percentage: 0,
      source: "none",
    });
  });
});

describe("splitAmount", () => {
  it("reparte en centavos enteros", () => {
    expect(splitAmount(2500, 50)).toEqual({ staffCommissionCents: 1250, businessNetCents: 1250 });
    expect(splitAmount(3000, 40)).toEqual({ staffCommissionCents: 1200, businessNetCents: 1800 });
  });

  it("extremos: 0 % y 100 %", () => {
    expect(splitAmount(2500, 0)).toEqual({ staffCommissionCents: 0, businessNetCents: 2500 });
    expect(splitAmount(2500, 100)).toEqual({ staffCommissionCents: 2500, businessNetCents: 0 });
  });

  it("el neto es el RESTO: nunca se pierde ni se inventa un centavo", () => {
    // 3333 × 33 % = 1099.89 → la comisión se redondea y el neto es lo que sobra.
    const r = splitAmount(3333, 33);
    expect(r.staffCommissionCents).toBe(1100);
    expect(r.staffCommissionCents + r.businessNetCents).toBe(3333);
  });

  it("comisión + neto = monto para cualquier monto y porcentaje", () => {
    for (let amount = 0; amount <= 20_000; amount += 137) {
      for (let pct = 0; pct <= 100; pct += 7) {
        const { staffCommissionCents, businessNetCents } = splitAmount(amount, pct);
        expect(Number.isInteger(staffCommissionCents)).toBe(true);
        expect(staffCommissionCents + businessNetCents).toBe(amount);
        expect(staffCommissionCents).toBeGreaterThanOrEqual(0);
        expect(businessNetCents).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
