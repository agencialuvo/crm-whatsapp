import { describe, expect, it, vi } from "vitest";
import {
  evaluateCondition,
  evaluateSwitch,
  loyaltyStampDedupeKey,
  parseTriggerConfig,
  readLoyaltyContext,
  renderVars,
  stampFlowMatches,
  type ConditionFacts,
} from "@/lib/automation";
import { FLOW_TRIGGER_TYPES, TRIGGER_CONFIG_SCHEMAS, flowCreateSchema, parseTriggerConfigFor, stepCreateSchema } from "@/lib/automation-schemas";
import { CONDITION_RULE_LABELS, TRIGGER_HINTS, describeRule, describeTrigger, triggerLabel } from "@/lib/automation-dto";
import { PALETTE } from "@/lib/automation-canvas";
import { onLoyaltyStampEarned, type LoyaltyStampInput } from "@/server/automation/triggers";
import type { EnqueueInput, FlowRef, TriggerStore } from "@/server/automation/trigger-store";

/**
 * Paso 4 (sin base de datos): el disparador `loyalty_stamp_earned` (ajustes, filtros, idempotencia y contexto) y la regla
 * `loyalty_milestone_is`. El almacén falso imita el índice único de `automation_queue`.
 */

function fakeStore(flows: FlowRef[] = [], conversations: string[] = ["ct_1"]) {
  const keys = new Set<string>();
  const enqueued: EnqueueInput[] = [];
  const store = {
    listOrganizationIds: vi.fn(async () => ["org_1"]),
    activeFlows: vi.fn(async (_org: string, type: string) => (type === "loyalty_stamp_earned" ? flows : [])),
    timezone: vi.fn(async () => "UTC"),
    birthdayContacts: vi.fn(async () => [] as string[]),
    hasRealConversation: vi.fn(async (_o: string, c: string) => conversations.includes(c)),
    enqueueFirstStep: vi.fn(async (i: EnqueueInput) => {
      const k = [i.organizationId, i.flowId, i.contactId, i.dedupeKey].join("|");
      if (keys.has(k)) return false;
      keys.add(k);
      enqueued.push(i);
      return true;
    }),
    cancelPendingForBooking: vi.fn(async () => 0),
  } satisfies TriggerStore;
  return { store, enqueued };
}
const flow = (id: string, triggerConfig: unknown = null): FlowRef => ({ id, organizationId: "org_1", triggerConfig });
const NOW = new Date("2026-03-15T15:00:00.000Z");
const on = () => true;

const stamp = (over: Partial<LoyaltyStampInput> = {}): LoyaltyStampInput => ({
  organizationId: "org_1",
  contactId: "ct_1",
  transactionId: "ltr_1",
  currentStamps: 3,
  stampsAdded: 1,
  nextMilestone: { stamps: 4, title: "20% de descuento", rewardType: "percentage_discount", discountPercentage: 20 },
  stampsToNext: 1,
  ...over,
});

describe("loyalty_stamp_earned — ajustes", () => {
  it("es un disparador que se puede crear, con su etiqueta, su ayuda y su bloque en la paleta", () => {
    expect(FLOW_TRIGGER_TYPES as readonly string[]).toContain("loyalty_stamp_earned");
    expect(flowCreateSchema.safeParse({ name: "F", triggerType: "loyalty_stamp_earned" }).success).toBe(true);
    expect(triggerLabel("loyalty_stamp_earned")).toBe("Sello ganado");
    expect(TRIGGER_HINTS.loyalty_stamp_earned).toMatch(/CADA sello/);
    expect(PALETTE.some((p) => p.kind === "trigger" && p.triggerType === "loyalty_stamp_earned")).toBe(true);
  });

  it("acepta stamps, minStamps, ambos o ninguno, y rechaza claves raras y rangos imposibles", () => {
    const ok = (v: unknown) => TRIGGER_CONFIG_SCHEMAS.loyalty_stamp_earned.safeParse(v).success;
    expect(ok({})).toBe(true);
    expect(ok({ stamps: 3 })).toBe(true);
    expect(ok({ minStamps: 2 })).toBe(true);
    expect(ok({ stamps: 5, minStamps: 5 })).toBe(true);
    expect(ok({ stamps: 5, minStamps: 3 })).toBe(true);
    expect(ok({ stamps: 2, minStamps: 5 })).toBe(false); // nunca se activaría
    expect(ok({ stamps: 0 })).toBe(false);
    expect(ok({ minStamps: 1001 })).toBe(false);
    expect(ok({ sellos: 3 })).toBe(false);
  });

  it("parseTriggerConfigFor normaliza: sin ajustes → null; con ajustes, solo lo que importa", () => {
    expect(parseTriggerConfigFor("loyalty_stamp_earned", {})).toEqual({ ok: true, value: null });
    expect(parseTriggerConfigFor("loyalty_stamp_earned", { stamps: 3, minStamps: null })).toEqual({ ok: true, value: { stamps: 3 } });
    expect(parseTriggerConfigFor("loyalty_stamp_earned", { minStamps: 2 })).toEqual({ ok: true, value: { minStamps: 2 } });
    const mal = parseTriggerConfigFor("loyalty_stamp_earned", { stamps: 1, minStamps: 4 });
    expect(mal.ok).toBe(false);
    if (!mal.ok) expect(mal.message).toMatch(/minStamps/);
  });

  it("la descripción en la ficha cubre cada combinación", () => {
    const d = (c: Record<string, unknown> | null) => describeTrigger("loyalty_stamp_earned", c);
    expect(d(null)).toBe("Cada vez que un cliente gana un sello");
    expect(d({ stamps: 3 })).toBe("Cuando su tarjeta llega a 3 sellos");
    expect(d({ stamps: 1 })).toBe("Cuando su tarjeta llega a 1 sello");
    expect(d({ minStamps: 2 })).toBe("Con cada sello, desde que su tarjeta tiene 2 sellos");
    expect(d({ stamps: 5, minStamps: 3 })).toMatch(/llega a 5 sellos \(y al menos 3\)/);
  });
});

describe("stampFlowMatches", () => {
  const m = (cfg: unknown, n: number) => stampFlowMatches(parseTriggerConfig(cfg), n);
  it.each([
    [null, 1, true],
    [{}, 9, true],
    [{ stamps: 3 }, 3, true],
    [{ stamps: 3 }, 2, false],
    [{ stamps: 3 }, 4, false],
    [{ minStamps: 3 }, 2, false],
    [{ minStamps: 3 }, 3, true],
    [{ minStamps: 3 }, 7, true],
    [{ stamps: 5, minStamps: 3 }, 5, true],
    [{ stamps: 5, minStamps: 3 }, 4, false],
    // Un JSON dañado no apaga el flujo: cae a «cualquier sello».
    [{ stamps: "tres" }, 1, true],
  ])("config %j con %i sellos → %s", (cfg, n, esperado) => {
    expect(m(cfg, n)).toBe(esperado);
  });
});

describe("onLoyaltyStampEarned", () => {
  it("arranca una ejecución por flujo, con la llave por movimiento y el contexto del sello y del próximo premio", async () => {
    const { store, enqueued } = fakeStore([flow("aut_a"), flow("aut_b")]);
    expect(await onLoyaltyStampEarned(stamp(), store, on, () => NOW)).toBe(2);
    expect(enqueued.map((e) => [e.flowId, e.dedupeKey])).toEqual([
      ["aut_a", "loyalty_stamp:ltr_1"],
      ["aut_b", "loyalty_stamp:ltr_1"],
    ]);
    expect(enqueued[0]!.dedupeKey).toBe(loyaltyStampDedupeKey("ltr_1"));
    expect(enqueued[0]!.context).toEqual({
      loyalty: {
        currentStamps: 3,
        stampsAdded: 1,
        stampsToNext: 1,
        nextMilestone: { stamps: 4, title: "20% de descuento", rewardType: "percentage_discount", discountPercentage: 20 },
        transactionId: "ltr_1",
      },
    });
  });

  it("el contexto del sello NO trae los campos del hito (no se confunde con un premio) y sus variables se leen bien", () => {
    const ctx = { loyalty: { currentStamps: 3, stampsAdded: 1, stampsToNext: 1, nextMilestone: { stamps: 4, title: "20% de descuento" }, transactionId: "ltr_1" } };
    expect(ctx.loyalty).not.toHaveProperty("milestoneStamps");
    const l = readLoyaltyContext(ctx);
    expect(l).toMatchObject({ currentStamps: 3, stampsAdded: 1, stampsToNext: 1, nextTitle: "20% de descuento", milestoneStamps: null, title: null });
    expect(renderVars("Llevas {{sellos}}; te faltan {{faltan}} para {{proximo_premio}}. [{{premio}}]", { name: "Ana", loyalty: l })).toBe(
      "Llevas 3; te faltan 1 para 20% de descuento. []"
    );
  });

  it("sin próximo premio (ya los tiene todos) {{faltan}} y {{proximo_premio}} salen vacías", () => {
    const l = readLoyaltyContext({ loyalty: { currentStamps: 8, stampsAdded: 1, stampsToNext: null, nextMilestone: null } });
    expect(renderVars("[{{faltan}}][{{proximo_premio}}][{{sellos}}]", { name: "Ana", loyalty: l })).toBe("[][][8]");
  });

  it("un flujo acotado al sello exacto o al mínimo solo reacciona cuando toca", async () => {
    const flows = [flow("exacto", { stamps: 3 }), flow("minimo", { minStamps: 5 }), flow("rango", { stamps: 6, minStamps: 5 }), flow("todos")];
    const a = fakeStore(flows);
    await onLoyaltyStampEarned(stamp({ currentStamps: 3 }), a.store, on, () => NOW);
    expect(a.enqueued.map((e) => e.flowId)).toEqual(["exacto", "todos"]);
    const b = fakeStore(flows);
    await onLoyaltyStampEarned(stamp({ currentStamps: 6, transactionId: "ltr_2" }), b.store, on, () => NOW);
    expect(b.enqueued.map((e) => e.flowId)).toEqual(["minimo", "rango", "todos"]);
    const c = fakeStore(flows);
    await onLoyaltyStampEarned(stamp({ currentStamps: 2, transactionId: "ltr_3" }), c.store, on, () => NOW);
    expect(c.enqueued.map((e) => e.flowId)).toEqual(["todos"]);
  });

  it("avisar dos veces del mismo movimiento (reintento) no duplica; otro movimiento sí arranca", async () => {
    const { store, enqueued } = fakeStore([flow("aut_a")]);
    await onLoyaltyStampEarned(stamp(), store, on, () => NOW);
    expect(await onLoyaltyStampEarned(stamp(), store, on, () => NOW)).toBe(0);
    expect(await onLoyaltyStampEarned(stamp({ transactionId: "ltr_2", currentStamps: 4 }), store, on, () => NOW)).toBe(1);
    expect(enqueued).toHaveLength(2);
  });

  it("apagado, sin sellos sumados o sin chat real de WhatsApp no arranca nada, y nunca lanza", async () => {
    const a = fakeStore([flow("aut_a")]);
    expect(await onLoyaltyStampEarned(stamp(), a.store, () => false, () => NOW)).toBe(0);
    expect(a.store.activeFlows).not.toHaveBeenCalled();
    expect(await onLoyaltyStampEarned(stamp({ stampsAdded: 0 }), a.store, on, () => NOW)).toBe(0);
    expect(await onLoyaltyStampEarned(stamp({ contactId: "ct_otro" }), a.store, on, () => NOW)).toBe(0);
    const roto = fakeStore([flow("aut_a")]);
    roto.store.enqueueFirstStep.mockRejectedValueOnce(new Error("bd caída"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await onLoyaltyStampEarned(stamp(), roto.store, on, () => NOW)).toBe(0);
    spy.mockRestore();
  });

  it("sin próximo premio el contexto lo dice con null (no inventa uno)", async () => {
    const { store, enqueued } = fakeStore([flow("aut_a")]);
    await onLoyaltyStampEarned(stamp({ currentStamps: 8, nextMilestone: null, stampsToNext: null }), store, on, () => NOW);
    expect(enqueued[0]!.context).toMatchObject({ loyalty: { currentStamps: 8, stampsToNext: null, nextMilestone: null } });
  });
});

describe("regla loyalty_milestone_is", () => {
  const f = (o: Partial<ConditionFacts>): ConditionFacts => ({ tagIds: [], stageId: null, booking: null, ...o });

  it("el esquema la acepta y la acota", () => {
    const ok = (stamps: number) => stepCreateSchema.safeParse({ stepType: "condition", config: { rule: { type: "loyalty_milestone_is", stamps } } }).success;
    expect(ok(8)).toBe(true);
    expect(ok(0)).toBe(false);
    expect(ok(1001)).toBe(false);
  });

  it.each([
    [{ loyaltyMilestoneStamps: 8 }, 8, true],
    [{ loyaltyMilestoneStamps: 4 }, 8, false],
    // Sin premio en el disparo (otro tipo de flujo, o el de cada sello): no se cumple.
    [{ loyaltyMilestoneStamps: null }, 8, false],
    [{}, 8, false],
  ])("hechos %j contra el sello %i → %s", (facts, stamps, esperado) => {
    expect(evaluateCondition({ type: "loyalty_milestone_is", stamps }, f(facts)).result).toBe(esperado);
  });

  it("un switch reparte un flujo de «cualquier premio» según el hito", () => {
    const cases = [
      { id: "cuatro", label: "Sello 4", rule: { type: "loyalty_milestone_is", stamps: 4 } },
      { id: "ocho", label: "Sello 8", rule: { type: "loyalty_milestone_is", stamps: 8 } },
    ] as never;
    expect(evaluateSwitch(cases, f({ loyaltyMilestoneStamps: 8 })).caseId).toBe("ocho");
    expect(evaluateSwitch(cases, f({ loyaltyMilestoneStamps: 4 })).caseId).toBe("cuatro");
    expect(evaluateSwitch(cases, f({ loyaltyMilestoneStamps: 6 })).handle).toBe("default");
  });

  it("tiene etiqueta en el selector y frase en la tarjeta", () => {
    expect(CONDITION_RULE_LABELS.loyalty_milestone_is).toMatch(/premio/);
    expect(describeRule({ type: "loyalty_milestone_is", stamps: 8 })).toBe("El premio que activó el flujo es el del sello 8");
    expect(describeRule({ type: "loyalty_milestone_is" })).toMatch(/sin configurar/);
  });
});
