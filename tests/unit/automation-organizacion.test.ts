import { describe, expect, it } from "vitest";
import { CONDITION_RULE_TYPES, conditionRuleSchema } from "@/lib/automation";
import {
  PALETTE,
  PALETTE_CATEGORY_HINTS,
  PALETTE_CATEGORY_LABELS,
  ROLE_LABELS,
  STEP_META,
  TRIGGER_META,
  paletteMatches,
  stepTypeChoices,
  toneOfStepType,
  type PaletteCategory,
} from "@/lib/automation-canvas";
import { CONDITION_RULE_GROUPS, CONDITION_RULE_LABELS, CREATABLE_TRIGGERS, conditionRuleOptions } from "@/lib/automation-dto";
import { STEP_TYPES } from "@/lib/automation-schemas";

/**
 * Organización visual del editor de automatizaciones: los cuatro roles de la paleta (Inicia / Consulta y decide / Espera /
 * Actúa), el rol en cada tarjeta y el selector de reglas agrupado por tema. Es solo presentación: nada de esto toca el motor ni lo
 * que se guarda.
 */

const CATEGORIES: PaletteCategory[] = ["triggers", "decide", "wait", "actions", "end"];
const inCat = (c: PaletteCategory) => PALETTE.filter((i) => i.category === c);

describe("roles de la paleta", () => {
  it("hay cinco roles con nombre y una frase cada uno, y todo bloque pertenece a uno", () => {
    for (const c of CATEGORIES) {
      expect(PALETTE_CATEGORY_LABELS[c], c).toBeTruthy();
      expect(PALETTE_CATEGORY_HINTS[c], c).toBeTruthy();
      expect(inCat(c).length, c).toBeGreaterThan(0);
    }
    expect(PALETTE.every((i) => CATEGORIES.includes(i.category))).toBe(true);
    expect(CATEGORIES.map((c) => PALETTE_CATEGORY_LABELS[c])).toEqual(["Inicia el flujo", "Consulta y decide", "Espera", "Actúa", "Termina"]);
  });

  it("solo los disparadores inician; solo Condición y Switch deciden; solo las tres esperas esperan", () => {
    expect(inCat("triggers").every((i) => i.kind === "trigger")).toBe(true);
    expect(PALETTE.filter((i) => i.kind === "trigger").every((i) => i.category === "triggers")).toBe(true);
    expect(inCat("decide").map((i) => i.stepType)).toEqual(["condition", "switch"]);
    expect(inCat("wait").map((i) => i.stepType)).toEqual(["delay", "wait_until", "wait_reply"]);
    expect(inCat("actions").every((i) => i.kind === "step")).toBe(true);
    expect(inCat("end").map((i) => i.stepType)).toEqual(["end_flow"]);
  });

  it("los bloques nuevos están donde corresponde: «Cita realizada» y «Venta cobrada» inician; «Pasar a una persona» actúa", () => {
    const cat = (id: string) => PALETTE.find((i) => i.id === id)!;
    expect(cat("trigger:booking_completed")).toMatchObject({ category: "triggers", group: "Citas" });
    expect(cat("trigger:sale_completed")).toMatchObject({ category: "triggers", group: "Ventas" });
    expect(cat("step:human_handoff")).toMatchObject({ category: "actions", group: "CRM" });
    // Variable y código son datos que prepara el flujo: actúan, en su subgrupo «Datos» (antes estaban bajo «Lógica»).
    expect(cat("step:set_var")).toMatchObject({ category: "actions", group: "Datos" });
    expect(cat("step:code_js")).toMatchObject({ category: "actions", group: "Datos" });
  });

  it("dentro de «Inicia el flujo» cada subgrupo va junto y en orden: citas, ventas, fidelización, fechas, manual", () => {
    const groups = inCat("triggers").map((i) => i.group);
    expect([...new Set(groups)]).toEqual(["Contactos y pipeline", "Anuncios", "Citas", "Ventas", "Fidelización", "Fechas", "Manual"]);
    // «Citas» sigue el orden en que ocurren las cosas.
    expect(inCat("triggers").filter((i) => i.group === "Citas").map((i) => i.triggerType)).toEqual([
      "booking_created",
      "booking_confirmed",
      "booking_completed",
      "booking_no_show",
    ]);
    expect(inCat("triggers").filter((i) => i.group === "Fidelización").map((i) => i.triggerType)).toEqual(["loyalty_stamp_earned", "loyalty_reward_unlocked"]);
  });

  it("no cambió lo que se puede crear: los mismos disparadores y los mismos pasos, con los mismos ids", () => {
    expect(PALETTE.filter((i) => i.kind === "trigger").map((i) => i.triggerType).sort()).toEqual([...CREATABLE_TRIGGERS].sort());
    expect(PALETTE.filter((i) => i.kind === "step").map((i) => i.stepType).sort()).toEqual([...STEP_TYPES].sort());
    for (const i of PALETTE) expect(i.id).toBe(i.kind === "trigger" ? `trigger:${i.triggerType}` : `step:${i.stepType}`);
  });
});

describe("buscador de la paleta por rol", () => {
  const find = (q: string) => PALETTE.filter((i) => paletteMatches(i, q)).map((i) => i.id);
  it("escribir el rol enseña los bloques de ese rol", () => {
    expect(find("decide")).toEqual(expect.arrayContaining(["step:condition", "step:switch"]));
    expect(find("inicia")).toEqual(expect.arrayContaining(["trigger:sale_completed", "trigger:booking_completed", "trigger:manual"]));
    expect(find("actua")).toEqual(expect.arrayContaining(["step:send_whatsapp", "step:human_handoff", "step:set_var"]));
    expect(find("espera")).toEqual(expect.arrayContaining(["step:delay", "step:wait_until", "step:wait_reply"]));
  });
  it("buscar por nombre y subgrupo sigue funcionando, con acentos y mayúsculas", () => {
    expect(find("VENTA")).toContain("trigger:sale_completed");
    expect(find("ventas")).toEqual(["trigger:sale_completed"]);
    expect(find("persona")).toEqual(["step:human_handoff"]);
    expect(find("realizada")).toContain("trigger:booking_completed");
    expect(find("zzzz")).toEqual([]);
  });
  it("sin la categoría (quien llama con el contrato anterior) también funciona", () => {
    expect(paletteMatches({ label: "Cita realizada", hint: "x", group: "Citas" }, "citas")).toBe(true);
    expect(paletteMatches({ label: "Cita realizada", hint: "x", group: "Citas" }, "")).toBe(true);
  });
});

describe("rol en la tarjeta", () => {
  it("cada tono tiene su palabra, y mensajes y CRM comparten «Actúa»", () => {
    expect(ROLE_LABELS).toEqual({ trigger: "Inicia", condition: "Decide", wait: "Espera", message: "Actúa", crm: "Actúa", end: "Termina" });
  });
  it("el rol de una tarjeta coincide con el rol de la paleta para TODOS los bloques", () => {
    const roleOfCategory: Record<PaletteCategory, string> = { triggers: "Inicia", decide: "Decide", wait: "Espera", actions: "Actúa", end: "Termina" };
    for (const i of PALETTE) expect(ROLE_LABELS[i.tone], i.id).toBe(roleOfCategory[i.category]);
  });
  it("toneOfStepType lee los metadatos y un tipo desconocido se ve neutro", () => {
    for (const t of STEP_TYPES) expect(toneOfStepType(t), t).toBe(STEP_META[t].tone);
    expect(toneOfStepType("loquesea")).toBe("crm");
    for (const t of CREATABLE_TRIGGERS) expect(TRIGGER_META[t].tone).toBe("trigger");
  });
});

describe("tipo de paso en el Modo Simple", () => {
  it("se agrupa por rol, con lo más usado primero, y no pierde ningún paso", () => {
    const choices = stepTypeChoices();
    expect([...new Set(choices.map((c) => c.group))]).toEqual(["Actúa", "Espera", "Consulta y decide", "Termina"]);
    expect(choices.map((c) => c.value).sort()).toEqual([...STEP_TYPES].sort());
    expect(choices[0]).toMatchObject({ value: "send_whatsapp", label: "Enviar mensaje de WhatsApp", group: "Actúa" });
    // Los de un grupo van seguidos (así lo exige el desplegable).
    const seen = new Set<string>();
    choices.forEach((c, k) => {
      if (k > 0 && choices[k - 1]!.group !== c.group) expect(seen.has(c.group), c.group).toBe(false);
      seen.add(c.group);
    });
  });
});

describe("selector de reglas agrupado", () => {
  it("cada regla está en UN solo grupo y ninguna se quedó fuera", () => {
    const todas = CONDITION_RULE_GROUPS.flatMap((g) => g.rules);
    expect(new Set(todas).size).toBe(todas.length);
    expect([...todas].sort()).toEqual([...CONDITION_RULE_TYPES].sort());
  });

  it("los temas y su orden", () => {
    expect(CONDITION_RULE_GROUPS.map((g) => g.label)).toEqual(["Citas", "Fidelización", "Contacto", "Datos del flujo"]);
    const grupoDe = (r: string) => CONDITION_RULE_GROUPS.find((g) => (g.rules as readonly string[]).includes(r))!.label;
    for (const r of ["has_upcoming_booking", "has_confirmed_upcoming_booking", "upcoming_booking_days_lte", "visited_within_days", "inactive_for_days_gte", "visits_gte", "booking_confirmed"]) {
      expect(grupoDe(r), r).toBe("Citas");
    }
    for (const r of ["stamps_gte", "stamps_between", "stamps_remaining_lte", "loyalty_milestone_is"]) expect(grupoDe(r), r).toBe("Fidelización");
    for (const r of ["tag_has", "tag_missing", "stage_is", "birthday_today"]) expect(grupoDe(r), r).toBe("Contacto");
    expect(grupoDe("var_equals")).toBe("Datos del flujo");
  });

  it("las opciones traen valor, etiqueta y grupo, los de un grupo juntos, y cada valor lo acepta el esquema", () => {
    const opts = conditionRuleOptions(true);
    expect(opts.map((o) => o.value).sort()).toEqual([...CONDITION_RULE_TYPES].sort());
    for (const o of opts) {
      expect(o.label, o.value).toBe(CONDITION_RULE_LABELS[o.value]);
      expect(o.group, o.value).toBeTruthy();
    }
    const seen = new Set<string>();
    opts.forEach((o, k) => {
      if (k > 0 && opts[k - 1]!.group !== o.group) expect(seen.has(o.group), o.group).toBe(false);
      seen.add(o.group);
    });
    // Un tipo de regla sin campos se valida con el esquema real (los demás se cubren en sus propias pruebas).
    expect(conditionRuleSchema.safeParse({ type: "has_confirmed_upcoming_booking" }).success).toBe(true);
  });

  it("«La cita está confirmada» (la del disparo) solo se ofrece en flujos de cita, salvo que el bloque ya la tenga", () => {
    expect(conditionRuleOptions(false).some((o) => o.value === "booking_confirmed")).toBe(false);
    expect(conditionRuleOptions(true).some((o) => o.value === "booking_confirmed")).toBe(true);
    expect(conditionRuleOptions(false, "booking_confirmed").some((o) => o.value === "booking_confirmed")).toBe(true);
    // Fuera de flujos de cita se ofrece todo lo demás, incluidas las reglas nuevas de citas.
    const fuera = conditionRuleOptions(false).map((o) => o.value);
    for (const r of ["has_confirmed_upcoming_booking", "upcoming_booking_days_lte", "inactive_for_days_gte", "visits_gte", "stamps_remaining_lte", "stamps_between", "loyalty_milestone_is"]) {
      expect(fuera, r).toContain(r);
    }
    expect(fuera).toHaveLength(CONDITION_RULE_TYPES.length - 1);
  });
});
