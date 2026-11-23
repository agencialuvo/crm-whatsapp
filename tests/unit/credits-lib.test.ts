import { describe, expect, it } from "vitest";
import {
  coinsToUnits,
  decideGate,
  formatCoins,
  idemKey,
  priceUsage,
  splitSpend,
  templateRateKey,
  thresholdFor,
  totalOf,
  UNITS_PER_COIN,
  unitsToCoins,
} from "@/lib/credits";
import { parseCreditsFlag } from "@/server/credits/flag";

/** Monedas — la parte pura: unidades, reparto del gasto, decisión de corte, tarifas y claves de idempotencia. */

describe("unidades", () => {
  it("1 moneda = 100 unidades, y ida y vuelta", () => {
    expect(UNITS_PER_COIN).toBe(100);
    expect(coinsToUnits(1)).toBe(100);
    expect(coinsToUnits(2.5)).toBe(250);
    expect(coinsToUnits(0.07)).toBe(7);
    expect(unitsToCoins(250)).toBe(2.5);
  });

  it("el redondeo de monedas fraccionarias no deja décimas sueltas", () => {
    // 0.1 + 0.2 en coma flotante no es 0.3: por eso todo se cuenta en unidades enteras.
    expect(coinsToUnits(0.1) + coinsToUnits(0.2)).toBe(coinsToUnits(0.3));
  });

  it("formatCoins muestra hasta 2 decimales", () => {
    expect(formatCoins(1250)).toBe("12.5");
    expect(formatCoins(100)).toBe("1");
    expect(formatCoins(7)).toBe("0.07");
  });
});

describe("reparto del gasto: primero la cuota del plan, luego las recargas", () => {
  it("cabe en la cuota: todo del plan", () => {
    expect(splitSpend({ planBalance: 1000, topupBalance: 500 }, 300)).toEqual({ fromPlan: 300, fromTopup: 0 });
  });

  it("justo la cuota: todo del plan", () => {
    expect(splitSpend({ planBalance: 300, topupBalance: 500 }, 300)).toEqual({ fromPlan: 300, fromTopup: 0 });
  });

  it("no cabe: el plan hasta 0 y el resto de las recargas", () => {
    expect(splitSpend({ planBalance: 300, topupBalance: 500 }, 450)).toEqual({ fromPlan: 300, fromTopup: 150 });
  });

  it("sin cuota: todo de las recargas", () => {
    expect(splitSpend({ planBalance: 0, topupBalance: 500 }, 200)).toEqual({ fromPlan: 0, fromTopup: 200 });
  });

  it("si no alcanza nada, el faltante también sale de las recargas (quedan en negativo)", () => {
    expect(splitSpend({ planBalance: 100, topupBalance: 50 }, 400)).toEqual({ fromPlan: 100, fromTopup: 300 });
    expect(splitSpend({ planBalance: 0, topupBalance: 0 }, 70)).toEqual({ fromPlan: 0, fromTopup: 70 });
  });

  it("siempre suma el monto y no toma de un plan en negativo", () => {
    for (const [plan, topup, amount] of [[0, 0, 5], [100, 100, 150], [5, 0, 1000], [-10, 20, 30]] as const) {
      const r = splitSpend({ planBalance: plan, topupBalance: topup }, amount);
      expect(r.fromPlan + r.fromTopup).toBe(amount);
      expect(r.fromPlan).toBeGreaterThanOrEqual(0);
      expect(r.fromPlan).toBeLessThanOrEqual(Math.max(plan, 0));
    }
  });

  it("el saldo total es plan + recargas", () => {
    expect(totalOf({ planBalance: 300, topupBalance: -50 })).toBe(250);
  });
});

describe("la decisión de corte", () => {
  const base = { overdraftLimit: 0, cutEnabled: true, unlimited: false };

  it("con saldo: pasa", () => {
    expect(decideGate({ ...base, total: 500 })).toEqual({ allow: true, wouldCut: false, reason: "ok" });
  });

  it("en cero y con el corte activo: se corta", () => {
    expect(decideGate({ ...base, total: 0 })).toEqual({ allow: false, wouldCut: true, reason: "exhausted" });
  });

  it("en negativo y con el corte activo: se corta", () => {
    expect(decideGate({ ...base, total: -30 })).toEqual({ allow: false, wouldCut: true, reason: "exhausted" });
  });

  it("MODO SOMBRA (corte apagado): pasa igual, pero dice que habría cortado", () => {
    expect(decideGate({ ...base, cutEnabled: false, total: 0 })).toEqual({ allow: true, wouldCut: true, reason: "exhausted" });
    expect(decideGate({ ...base, cutEnabled: false, total: 500 })).toEqual({ allow: true, wouldCut: false, reason: "ok" });
  });

  it("el sobregiro tolera un poco de negativo antes de cortar", () => {
    const g = { ...base, overdraftLimit: 500 };
    expect(decideGate({ ...g, total: 0 }).allow).toBe(true);
    expect(decideGate({ ...g, total: -499 }).allow).toBe(true);
    expect(decideGate({ ...g, total: -500 }).allow).toBe(false);
    expect(decideGate({ ...g, total: -600 }).allow).toBe(false);
  });

  it("con un monto conocido (una plantilla), pide que alcance", () => {
    expect(decideGate({ ...base, total: 40, amount: 50 }).allow).toBe(false);
    expect(decideGate({ ...base, total: 50, amount: 50 }).allow).toBe(true);
    expect(decideGate({ ...base, overdraftLimit: 20, total: 40, amount: 50 }).allow).toBe(true);
  });

  it("un plan sin tope nunca se corta", () => {
    expect(decideGate({ ...base, unlimited: true, total: -999_999 })).toEqual({ allow: true, wouldCut: false, reason: "unlimited" });
  });
});

describe("el umbral de aviso", () => {
  const q = 1000;
  it("sin cuota no hay aviso", () => {
    expect(thresholdFor({ planBalance: 0, topupBalance: 0, quota: 0 })).toBeNull();
  });
  it("se usó poco: ninguno", () => {
    expect(thresholdFor({ planBalance: 900, topupBalance: 0, quota: q })).toBeNull();
    expect(thresholdFor({ planBalance: 201, topupBalance: 0, quota: q })).toBeNull();
  });
  it("80 % usado de la cuota: aviso", () => {
    expect(thresholdFor({ planBalance: 200, topupBalance: 0, quota: q })).toBe("warn80");
    expect(thresholdFor({ planBalance: 10, topupBalance: 0, quota: q })).toBe("warn80");
  });
  it("cuota agotada pero con recargas: «agotada»", () => {
    expect(thresholdFor({ planBalance: 0, topupBalance: 300, quota: q })).toBe("exhausted");
  });
  it("sin nada: «cero»", () => {
    expect(thresholdFor({ planBalance: 0, topupBalance: 0, quota: q })).toBe("zero");
    expect(thresholdFor({ planBalance: 0, topupBalance: -40, quota: q })).toBe("zero");
  });
});

describe("tarifas", () => {
  it("por turno: la tarifa, sin importar los tokens", () => {
    expect(priceUsage({ unitKind: "per_turn", amount: 100 }, { tokens: 99_999 })).toBe(100);
  });

  it("por mensaje: tarifa × cantidad", () => {
    expect(priceUsage({ unitKind: "per_message", amount: 8 }, { quantity: 3 })).toBe(24);
    expect(priceUsage({ unitKind: "per_message", amount: 8 }, {})).toBe(8);
  });

  it("por 1.000 tokens: se redondea hacia arriba, con mínimo de 1 unidad", () => {
    expect(priceUsage({ unitKind: "per_1k_tokens", amount: 50 }, { tokens: 1000 })).toBe(50);
    expect(priceUsage({ unitKind: "per_1k_tokens", amount: 50 }, { tokens: 1001 })).toBe(51);
    expect(priceUsage({ unitKind: "per_1k_tokens", amount: 50 }, { tokens: 2500 })).toBe(125);
    expect(priceUsage({ unitKind: "per_1k_tokens", amount: 50 }, { tokens: 1 })).toBe(1);
    expect(priceUsage({ unitKind: "per_1k_tokens", amount: 50 }, { tokens: 0 })).toBe(1);
  });

  it("una tarifa de 0 se mide pero no se cobra (mensajes libres)", () => {
    expect(priceUsage({ unitKind: "per_message", amount: 0 }, { quantity: 10 })).toBe(0);
    expect(priceUsage({ unitKind: "per_1k_tokens", amount: 0 }, { tokens: 5000 })).toBe(0);
    expect(priceUsage({ unitKind: "per_turn", amount: 0 }, {})).toBe(0);
  });

  it("siempre entero y nunca negativo", () => {
    for (const k of ["per_turn", "per_message", "per_1k_tokens"] as const) {
      const n = priceUsage({ unitKind: k, amount: 7 }, { tokens: 333, quantity: 2 });
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });

  it("la clave de tarifa de una plantilla sale de su categoría", () => {
    expect(templateRateKey("MARKETING")).toBe("wa.template.marketing");
    expect(templateRateKey(" utility ")).toBe("wa.template.utility");
    expect(templateRateKey("authentication")).toBe("wa.template.authentication");
    expect(templateRateKey("algo_raro")).toBe("wa.template.other");
    expect(templateRateKey(null)).toBe("wa.template.other");
  });
});

describe("claves de idempotencia", () => {
  const d = new Date("2026-11-01T00:00:00.000Z");

  it("salen de lo que originó la operación, no de cuándo se intentó", () => {
    expect(idemKey.grant("sub_1", d)).toBe("period:sub_1:2026-11-01T00:00:00.000Z");
    expect(idemKey.expire(d)).toBe("expire:2026-11-01T00:00:00.000Z");
    expect(idemKey.aiTurn("cv_1", "msg_9")).toBe("ai:cv_1:msg_9");
    expect(idemKey.waMessage("msg_5")).toBe("wa:msg_5");
    expect(idemKey.topup("crt_1")).toBe("topup:crt_1");
    expect(idemKey.refund("crt_1")).toBe("refund:crt_1");
  });

  it("repetir los mismos datos da la misma clave; cambiar un dato, otra", () => {
    expect(idemKey.grant("sub_1", d)).toBe(idemKey.grant("sub_1", new Date(d.getTime())));
    expect(idemKey.grant("sub_1", d)).not.toBe(idemKey.grant("sub_2", d));
    expect(idemKey.aiTurn("cv_1", "msg_1")).not.toBe(idemKey.aiTurn("cv_1", "msg_2"));
  });

  it("cada tipo de operación tiene su propio espacio de nombres (no chocan)", () => {
    const keys = [idemKey.grant("x", d), idemKey.expire(d), idemKey.aiTurn("x", "y"), idemKey.waMessage("x"), idemKey.topup("x"), idemKey.refund("x")];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("la segunda fila de un gasto partido deriva de la primera", () => {
    expect(idemKey.secondRow("wa:msg_5")).toBe("wa:msg_5~topup");
  });
});

describe("la bandera CREDITS", () => {
  it("apagada por defecto; solo ciertos valores la encienden", () => {
    expect(parseCreditsFlag(undefined)).toBe(false);
    expect(parseCreditsFlag("")).toBe(false);
    expect(parseCreditsFlag("off")).toBe(false);
    expect(parseCreditsFlag("shadow")).toBe(false);
    for (const v of ["on", "ON", "1", "true", "si", "sí", "yes", " on "]) expect(parseCreditsFlag(v), v).toBe(true);
  });
});
