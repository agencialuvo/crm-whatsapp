import { describe, expect, it } from "vitest";
import {
  CONDITION_RULE_TYPES,
  conditionRuleSchema,
  evaluateCondition,
  evaluateSwitch,
  loyaltyHitoWarning,
  loyaltyMilestoneLabel,
  readLoyaltyContext,
  renderVars,
  type ConditionFacts,
} from "@/lib/automation";
import { stampsToNextMilestone } from "@/lib/loyalty";
import { CONDITION_RULE_LABELS, describeRule } from "@/lib/automation-dto";
import { stepCreateSchema } from "@/lib/automation-schemas";
import { casesFromConfig, casesToConfig, caseErrors } from "@/components/automatizaciones/step-extras";

/**
 * Fidelización multi-hito: las variables `{{premio}}`, `{{descuento}}` y `{{sellos}}`, el aviso de un hito que ya no existe,
 * y las reglas `stamps_remaining_lte` y `stamps_between`. Lógica pura: sin base de datos ni navegador.
 */

const loyalty = { milestoneStamps: 8, title: "50% de descuento", discountPercentage: 50, currentStamps: 9 };
const base = { name: "Ana" };

describe("renderVars — variables de fidelidad", () => {
  it("{{premio}}, {{descuento}} y {{sellos}} salen del contexto del premio", () => {
    expect(renderVars("¡{{premio}}! {{descuento}}% con {{sellos}} sellos", { ...base, loyalty })).toBe("¡50% de descuento! 50% con 9 sellos");
  });

  it("sin context.loyalty quedan vacías (nunca «undefined» ni la llave a la vista)", () => {
    expect(renderVars("Premio: [{{premio}}] [{{descuento}}] [{{sellos}}]", { ...base })).toBe("Premio: [] [] []");
    expect(renderVars("x [{{premio}}]", { ...base, loyalty: null })).toBe("x []");
  });

  it("un premio que no es descuento deja {{descuento}} vacío; sin sellos actuales usa los del hito", () => {
    const l = { milestoneStamps: 4, title: "Corte gratis", discountPercentage: null, currentStamps: null };
    expect(renderVars("[{{descuento}}] [{{sellos}}] {{premio}}", { ...base, loyalty: l })).toBe("[] [4] Corte gratis");
  });

  it("un descuento de 0 % se escribe como 0 (no se confunde con «sin descuento»)", () => {
    expect(renderVars("{{descuento}}", { ...base, loyalty: { ...loyalty, discountPercentage: 0 } })).toBe("0");
  });

  it("no distingue mayúsculas y convive con las variables de siempre", () => {
    const out = renderVars("Hola {{name}}, {{PREMIO}} el {{fecha}} {{servicio}} {{vars.x}}", { name: "Ana", fecha: "hoy", servicio: "Corte", vars: { x: "1" }, loyalty });
    expect(out).toBe("Hola Ana, 50% de descuento el hoy Corte 1");
  });

  it("un dato que trae {{...}} no se expande una segunda vez (el título del premio es del negocio)", () => {
    expect(renderVars("{{premio}}", { ...base, loyalty: { ...loyalty, title: "{{name}} gratis" } })).toBe("{{name}} gratis");
  });

  it("lo que no se reconoce se deja tal cual", () => {
    expect(renderVars("{{otra}}", { ...base, loyalty })).toBe("{{otra}}");
  });
});

describe("readLoyaltyContext", () => {
  it("lee el contexto que deja el disparador", () => {
    expect(readLoyaltyContext({ loyalty: { milestoneStamps: 8, title: "T", rewardType: "x", discountPercentage: 50, currentStamps: 9, transactionId: "ltr_1" } })).toEqual({
      milestoneStamps: 8,
      title: "T",
      discountPercentage: 50,
      currentStamps: 9,
    });
  });
  it("ausente, mal formado o vacío → null; los tipos raros se ignoran campo a campo", () => {
    expect(readLoyaltyContext(null)).toBeNull();
    expect(readLoyaltyContext({})).toBeNull();
    expect(readLoyaltyContext({ loyalty: "x" })).toBeNull();
    expect(readLoyaltyContext({ loyalty: [] })).toBeNull();
    expect(readLoyaltyContext({ loyalty: { foo: 1 } })).toBeNull();
    expect(readLoyaltyContext({ loyalty: { title: 5, milestoneStamps: "8", currentStamps: 3 } })).toEqual({ milestoneStamps: null, title: null, discountPercentage: null, currentStamps: 3 });
  });
});

describe("hito del disparador", () => {
  const programa = [
    { stamps: 4, title: "20% de descuento" },
    { stamps: 8, title: "50% de descuento" },
  ];
  it("el selector nombra cada hito por sus sellos y su premio", () => {
    expect(loyaltyMilestoneLabel({ stamps: 8, title: "50% de descuento" })).toBe("Sello 8 · 50% de descuento");
  });
  it("sin hito configurado o con uno vigente no hay aviso", () => {
    expect(loyaltyHitoWarning(null, programa)).toBeNull();
    expect(loyaltyHitoWarning(undefined, programa)).toBeNull();
    expect(loyaltyHitoWarning(4, programa)).toBeNull();
    expect(loyaltyHitoWarning(8, programa)).toBeNull();
  });
  it("un hito que el programa ya no tiene avisa que el flujo no se activará, y dice cuáles hay hoy", () => {
    const w = loyaltyHitoWarning(5, programa)!;
    expect(w).toMatch(/premio de 5 sellos ya no existe/);
    expect(w).toMatch(/hoy: 4, 8/);
    expect(w).toMatch(/no se activará/);
    expect(loyaltyHitoWarning(5, [])).toMatch(/ya no existe en tu programa de fidelidad\./);
  });
});

describe("stampsToNextMilestone", () => {
  const hitos = [{ stamps: 8 }, { stamps: 4 }];
  it.each([
    [0, 4],
    [3, 1],
    [4, 4], // alcanzó el 4: ahora le faltan 4 para el 8
    [7, 1],
    [8, null], // alcanzó todos
    [12, null],
  ])("con %i sellos faltan %s", (sellos, esperado) => {
    expect(stampsToNextMilestone(hitos, sellos)).toBe(esperado);
  });
  it("sin hitos no hay próximo", () => {
    expect(stampsToNextMilestone([], 3)).toBeNull();
  });
});

describe("reglas stamps_remaining_lte y stamps_between", () => {
  it("el esquema las acepta y las acota", () => {
    expect(conditionRuleSchema.safeParse({ type: "stamps_remaining_lte", stamps: 2 }).success).toBe(true);
    expect(conditionRuleSchema.safeParse({ type: "stamps_remaining_lte", stamps: 0 }).success).toBe(false);
    expect(conditionRuleSchema.safeParse({ type: "stamps_remaining_lte", stamps: 1001 }).success).toBe(false);
    expect(conditionRuleSchema.safeParse({ type: "stamps_between", min: 0, max: 3 }).success).toBe(true);
    expect(conditionRuleSchema.safeParse({ type: "stamps_between", min: 4, max: 4 }).success).toBe(true);
    expect(conditionRuleSchema.safeParse({ type: "stamps_between", min: -1, max: 3 }).success).toBe(false);
    expect(conditionRuleSchema.safeParse({ type: "stamps_between", min: 1.5, max: 3 }).success).toBe(false);
  });

  it("un rango invertido se rechaza con el error en el campo «max»", () => {
    const r = conditionRuleSchema.safeParse({ type: "stamps_between", min: 5, max: 2 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.path).toEqual(["max"]);
      expect(r.error.issues[0]!.message).toMatch(/igual o mayor/);
    }
  });

  it("también se validan dentro de un paso `condition` y de un `switch`", () => {
    const ok = stepCreateSchema.safeParse({ stepType: "condition", config: { rule: { type: "stamps_between", min: 1, max: 3 } } });
    expect(ok.success).toBe(true);
    const mal = stepCreateSchema.safeParse({ stepType: "condition", config: { rule: { type: "stamps_between", min: 9, max: 3 } } });
    expect(mal.success).toBe(false);
    const sw = stepCreateSchema.safeParse({
      stepType: "switch",
      config: { cases: [{ id: "a", label: "Cerca", rule: { type: "stamps_remaining_lte", stamps: 2 } }] },
    });
    expect(sw.success).toBe(true);
  });

  const f = (o: Partial<ConditionFacts>): ConditionFacts => ({ tagIds: [], stageId: null, booking: null, ...o });
  it.each([
    // [reglas, hechos, resultado]
    [{ type: "stamps_remaining_lte", stamps: 2 }, { stamps: 6, stampsToNextMilestone: 2 }, true],
    [{ type: "stamps_remaining_lte", stamps: 2 }, { stamps: 5, stampsToNextMilestone: 3 }, false],
    [{ type: "stamps_remaining_lte", stamps: 2 }, { stamps: 7, stampsToNextMilestone: 1 }, true],
    // Ya alcanzó todos los premios (o no hay programa): no «le falta poco», no se cumple.
    [{ type: "stamps_remaining_lte", stamps: 5 }, { stamps: 8, stampsToNextMilestone: null }, false],
    [{ type: "stamps_remaining_lte", stamps: 5 }, {}, false],
    [{ type: "stamps_between", min: 4, max: 7 }, { stamps: 4 }, true],
    [{ type: "stamps_between", min: 4, max: 7 }, { stamps: 7 }, true],
    [{ type: "stamps_between", min: 4, max: 7 }, { stamps: 3 }, false],
    [{ type: "stamps_between", min: 4, max: 7 }, { stamps: 8 }, false],
    // Sin tarjeta cuenta como 0 sellos.
    [{ type: "stamps_between", min: 0, max: 0 }, {}, true],
    [{ type: "stamps_between", min: 1, max: 3 }, {}, false],
  ] as const)("%j con %j → %s", (rule, facts, esperado) => {
    expect(evaluateCondition(rule as never, f(facts as never)).result).toBe(esperado);
  });

  it("un switch ordena por rangos: el primero que se cumple gana, y «Otro» si ninguno", () => {
    const cases = [
      { id: "cerca", label: "Casi", rule: { type: "stamps_remaining_lte", stamps: 1 } },
      { id: "medio", label: "Medio", rule: { type: "stamps_between", min: 4, max: 7 } },
    ] as never;
    expect(evaluateSwitch(cases, f({ stamps: 7, stampsToNextMilestone: 1 })).caseId).toBe("cerca");
    expect(evaluateSwitch(cases, f({ stamps: 5, stampsToNextMilestone: 3 })).caseId).toBe("medio");
    expect(evaluateSwitch(cases, f({ stamps: 1, stampsToNextMilestone: 3 })).handle).toBe("default");
  });
});

describe("textos de las reglas nuevas", () => {
  it("toda regla tiene su etiqueta en el selector", () => {
    for (const t of CONDITION_RULE_TYPES) expect(CONDITION_RULE_LABELS[t], t).toBeTruthy();
    expect(CONDITION_RULE_TYPES).toContain("stamps_remaining_lte");
    expect(CONDITION_RULE_TYPES).toContain("stamps_between");
  });
  it("describeRule las explica en una frase", () => {
    expect(describeRule({ type: "stamps_remaining_lte", stamps: 2 })).toBe("Le faltan como máximo 2 sellos para su próximo premio");
    expect(describeRule({ type: "stamps_remaining_lte", stamps: 1 })).toBe("Le falta como máximo 1 sello para su próximo premio");
    expect(describeRule({ type: "stamps_between", min: 4, max: 7 })).toBe("Su tarjeta tiene entre 4 y 7 sellos");
    expect(describeRule({ type: "stamps_between" })).toMatch(/sin configurar/);
    expect(describeRule({ type: "stamps_remaining_lte" })).toMatch(/sin configurar/);
  });
});

describe("casos del Switch con las reglas nuevas (formulario ↔ configuración)", () => {
  it("el rango y «faltan N» viajan del formulario a la regla y vuelven", () => {
    const raw = [
      { id: "a", label: "Casi", rule: { type: "stamps_remaining_lte", stamps: 2 } },
      { id: "b", label: "Rango", rule: { type: "stamps_between", min: 4, max: 7 } },
    ];
    const forms = casesFromConfig(raw);
    expect(forms[0]).toMatchObject({ type: "stamps_remaining_lte", stamps: "2" });
    expect(forms[1]).toMatchObject({ type: "stamps_between", min: "4", max: "7" });
    expect(casesToConfig(forms)).toEqual(raw);
  });

  it("caseErrors avisa de un rango invertido en el campo «max» del caso", () => {
    const forms = casesFromConfig([{ id: "b", label: "Rango", rule: { type: "stamps_between", min: 9, max: 3 } }]);
    expect(caseErrors(forms)).toEqual({ "case.0.max": "El máximo debe ser igual o mayor que el mínimo" });
    expect(caseErrors(casesFromConfig([{ id: "b", label: "R", rule: { type: "stamps_between", min: 3, max: 3 } }]))).toEqual({});
  });
});
