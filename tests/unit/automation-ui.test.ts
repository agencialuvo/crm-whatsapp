import { describe, expect, it } from "vitest";
import {
  CREATABLE_TRIGGERS,
  STEP_GAP,
  activationBlock,
  clip,
  describeDelay,
  describeStep,
  describeTrigger,
  hourLabel,
  nextPositionY,
  reorderPositions,
  sortSteps,
  triggerLabel,
  type TemplateOption,
} from "@/lib/automation-dto";

/**
 * Automatizaciones (pantallas) — los textos que lee la persona y las reglas de orden. Sin React: lo
 * interactivo (formularios, diálogos) se comprueba en el navegador.
 */

const stages = [
  { id: "stg_1", name: "Nuevo" },
  { id: "stg_2", name: "Cotizado" },
];
const templates: TemplateOption[] = [
  { id: "tpl_1", name: "recordatorio_cita", language: "es", body: "Hola {{1}}", status: "approved" },
];
const step = (id: string, positionY: number, positionX = 0) => ({ id, positionX, positionY });

describe("disparadores", () => {
  it("solo se ofrecen los que hoy tienen quién los dispare", () => {
    expect([...CREATABLE_TRIGGERS]).toEqual(["birthday", "stage_changed", "lead_created"]);
  });
  it("etiquetas en español, y un tipo desconocido se muestra tal cual", () => {
    expect(triggerLabel("birthday")).toBe("Cumpleaños");
    expect(triggerLabel("stage_changed")).toBe("Cambio de etapa");
    expect(triggerLabel("lead_created")).toBe("Lead nuevo");
    expect(triggerLabel("otro_futuro")).toBe("otro_futuro");
  });
  it("hourLabel rellena con cero", () => {
    expect(hourLabel(9)).toBe("09:00");
    expect(hourLabel(10)).toBe("10:00");
    expect(hourLabel(0)).toBe("00:00");
  });
  it("cumpleaños: la hora configurada o las 10:00 por defecto", () => {
    expect(describeTrigger("birthday", { hour: 8 })).toBe("Cada cumpleaños, a las 08:00");
    expect(describeTrigger("birthday", null)).toBe("Cada cumpleaños, a las 10:00");
    expect(describeTrigger("birthday", { hour: "x" })).toBe("Cada cumpleaños, a las 10:00");
  });
  it("cambio de etapa: con etapa, sin etapa y con una etapa que ya no existe", () => {
    expect(describeTrigger("stage_changed", { toStageId: "stg_2" }, stages)).toBe("Cuando un lead pasa a «Cotizado»");
    expect(describeTrigger("stage_changed", null, stages)).toBe("Cuando un lead cambia de etapa");
    expect(describeTrigger("stage_changed", { toStageId: "stg_borrada" }, stages)).toContain("ya no existe");
  });
  it("lead nuevo y manual", () => {
    expect(describeTrigger("lead_created", null)).toBe("Cuando entra un lead nuevo");
    expect(describeTrigger("manual", null)).toBe("Se inicia a mano");
  });
});

describe("pasos", () => {
  it("esperas con singular y plural", () => {
    expect(describeDelay(1, "days")).toBe("Esperar 1 día");
    expect(describeDelay(2, "days")).toBe("Esperar 2 días");
    expect(describeDelay(1, "hours")).toBe("Esperar 1 hora");
    expect(describeDelay(30, "minutes")).toBe("Esperar 30 minutos");
  });
  it("un paso de espera", () => {
    expect(describeStep({ stepType: "delay", config: { amount: 2, unit: "hours" } })).toEqual({
      title: "Esperar 2 horas",
      detail: null,
    });
  });
  it("un mensaje usa su nombre, o el del tipo, y muestra el texto", () => {
    expect(describeStep({ stepType: "send_whatsapp", config: { name: "Saludo", content: "Hola {{name}}" } })).toEqual({
      title: "Saludo",
      detail: "«Hola {{name}}»",
    });
    expect(describeStep({ stepType: "send_whatsapp", config: { content: "Hola" } }).title).toBe(
      "Enviar mensaje de WhatsApp"
    );
  });
  it("una plantilla se muestra por su nombre; si ya no existe, se avisa", () => {
    expect(describeStep({ stepType: "send_whatsapp", config: { templateId: "tpl_1" } }, templates).detail).toBe(
      "Plantilla: recordatorio_cita"
    );
    expect(describeStep({ stepType: "send_whatsapp", config: { templateId: "tpl_x" } }, templates).detail).toBe(
      "Plantilla: ya no existe"
    );
  });
  it("mensaje y plantilla juntos", () => {
    expect(
      describeStep({ stepType: "send_whatsapp", config: { content: "Hola", templateId: "tpl_1" } }, templates).detail
    ).toBe("«Hola» · Plantilla: recordatorio_cita");
  });
  it("un tipo sin ejecutor se marca, no se oculta", () => {
    expect(describeStep({ stepType: "condition", config: {} }).detail).toContain("todavía no se puede ejecutar");
  });
  it("clip aplana espacios y corta con puntos suspensivos", () => {
    expect(clip("  hola \n  mundo ", 50)).toBe("hola mundo");
    expect(clip("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("orden de los pasos", () => {
  it("sortSteps: arriba antes que abajo, izquierda antes que derecha, y el id desempata", () => {
    const sorted = sortSteps([step("c", 200), step("b", 0, 50), step("a", 0, 10), step("z", 0, 10)]);
    expect(sorted.map((s) => s.id)).toEqual(["a", "z", "b", "c"]);
  });
  it("sortSteps no modifica la lista que recibe", () => {
    const input = [step("b", 100), step("a", 0)];
    sortSteps(input);
    expect(input.map((s) => s.id)).toEqual(["b", "a"]);
  });
  it("nextPositionY: el primero en 0 y los demás al final", () => {
    expect(nextPositionY([])).toBe(0);
    expect(nextPositionY([step("a", 0), step("b", 250)])).toBe(250 + STEP_GAP);
    expect(nextPositionY([step("a", -40)])).toBe(-40 + STEP_GAP);
  });

  it("reorderPositions: mover un paso hacia abajo reescribe solo lo que cambia", () => {
    const steps = [step("a", 0), step("b", 100), step("c", 200)];
    // a baja una posición: b, a, c → b pasa a 0 y a a 100; c no cambia.
    expect(reorderPositions(steps, 0, 1)).toEqual([
      { id: "b", positionX: 0, positionY: 0 },
      { id: "a", positionX: 0, positionY: 100 },
    ]);
  });
  it("reorderPositions: mover hacia arriba", () => {
    const steps = [step("a", 0), step("b", 100), step("c", 200)];
    expect(reorderPositions(steps, 2, 1)).toEqual([
      { id: "c", positionX: 0, positionY: 100 },
      { id: "b", positionX: 0, positionY: 200 },
    ]);
  });
  it("reorderPositions: normaliza posiciones desordenadas a una columna", () => {
    const steps = [step("a", 7, 30), step("b", 90, 4)];
    expect(reorderPositions(steps, 0, 1)).toEqual([
      { id: "b", positionX: 0, positionY: 0 },
      { id: "a", positionX: 0, positionY: 100 },
    ]);
  });
  it("reorderPositions: sin movimiento o fuera de rango no cambia nada", () => {
    const steps = [step("a", 0), step("b", 100)];
    expect(reorderPositions(steps, 1, 1)).toEqual([]);
    expect(reorderPositions(steps, 0, -1)).toEqual([]);
    expect(reorderPositions(steps, 1, 2)).toEqual([]);
    expect(reorderPositions([], 0, 0)).toEqual([]);
  });
  it("tras reordenar, el orden resultante es el pedido", () => {
    const steps = [step("a", 0), step("b", 100), step("c", 200), step("d", 300)];
    const updates = reorderPositions(steps, 3, 0);
    const after = steps.map((s) => ({ ...s, ...(updates.find((u) => u.id === s.id) ?? {}) }));
    expect(sortSteps(after).map((s) => s.id)).toEqual(["d", "a", "b", "c"]);
  });
});

describe("encender", () => {
  it("sin pasos no se puede encender, con pasos sí, y apagar siempre se puede", () => {
    expect(activationBlock(0, false)).toContain("al menos un paso");
    expect(activationBlock(1, false)).toBeNull();
    expect(activationBlock(0, true)).toBeNull();
    expect(activationBlock(3, true)).toBeNull();
  });
});
