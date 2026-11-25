import { describe, expect, it } from "vitest";
import { compileLinearEdges, endFlowConfigSchema } from "@/lib/automation";
import { PALETTE, canInsertOnEdge, defaultConfigFor, nodeKindOf, outputsOf, STEP_META, toneOfNodeKind } from "@/lib/automation-canvas";
import { GENERIC_STEP_NAME_PLACEHOLDER, describeStep, nextCopyName, stepLabel, stepNamePlaceholder } from "@/lib/automation-dto";
import { describeLog } from "@/lib/automation-monitor-dto";
import { handlesOf, toLinear, validateGraph } from "@/lib/automation-graph";
import { STEP_TYPES, parseStepConfig, stepCreateSchema } from "@/lib/automation-schemas";
import { assertStepAllowed } from "@/server/automation/flows";

/**
 * Cuatro ajustes de productividad y claridad: placeholder neutral en «Nombre», el paso «Terminar flujo», el nombre incremental de
 * una copia y los selectores. El clonado contra la base y el paso terminal por el motor están en `automation-productividad-live.test.ts`.
 */

describe("placeholder de «Nombre (opcional)»", () => {
  it("ningún ejemplo sugiere cumpleaños, fidelidad ni otro tema concreto", () => {
    for (const t of [...STEP_TYPES, "desconocido"]) {
      const p = stepNamePlaceholder(t);
      expect(p, t).toBeTruthy();
      expect(p, t).not.toMatch(/cumplea|saludo|sello|premio|fidelidad/i);
    }
    expect(GENERIC_STEP_NAME_PLACEHOLDER).toBe("Nombre del paso (opcional)");
  });
  it("cada tipo muestra algo útil para él, y los desconocidos el texto general", () => {
    expect(stepNamePlaceholder("condition")).toBe("Ej.: Validar si ya agendó");
    expect(stepNamePlaceholder("delay")).toMatch(/Esperar/);
    expect(stepNamePlaceholder("wait_until")).toMatch(/cita/);
    expect(stepNamePlaceholder("end_flow")).toBe("Ej.: Ya tiene cita");
    expect(stepNamePlaceholder("loquesea")).toBe(GENERIC_STEP_NAME_PLACEHOLDER);
  });
  it("todos los pasos con ejemplo propio empiezan con «Ej.:» (se distingue de un valor real)", () => {
    for (const t of STEP_TYPES) {
      const p = stepNamePlaceholder(t);
      expect(p === GENERIC_STEP_NAME_PLACEHOLDER || p.startsWith("Ej.: "), t).toBe(true);
    }
  });
});

describe("«Terminar flujo» (end_flow)", () => {
  it("es un tipo de paso con configuración vacía (el nombre es opcional) y no admite claves de más", () => {
    expect(STEP_TYPES).toContain("end_flow");
    expect(stepCreateSchema.safeParse({ stepType: "end_flow", config: {} }).success).toBe(true);
    expect(stepCreateSchema.safeParse({ stepType: "end_flow", config: { name: "Ya tiene cita" } }).success).toBe(true);
    expect(stepCreateSchema.safeParse({ stepType: "end_flow", config: { name: "x".repeat(121) } }).success).toBe(false);
    expect(parseStepConfig("end_flow", {})).toEqual({ ok: true, value: {} });
    expect(endFlowConfigSchema.parse({ name: "  Fin  " })).toEqual({ name: "Fin" });
  });

  it("tiene nombre, tarjeta y bloque propio: rol «Termina», nodo terminal sin salidas", () => {
    expect(stepLabel("end_flow")).toBe("Terminar flujo");
    expect(describeStep({ stepType: "end_flow", config: {} }).title).toBe("Terminar flujo");
    const item = PALETTE.find((i) => i.id === "step:end_flow")!;
    expect(item).toMatchObject({ kind: "step", category: "end", group: "Fin", tone: "end", icon: "CircleStop", label: "Terminar flujo" });
    expect(STEP_META.end_flow.tone).toBe("end");
    expect(nodeKindOf("end_flow")).toBe("end");
    expect(toneOfNodeKind("end")).toBe("end");
    expect(defaultConfigFor("end_flow")).toEqual({});
    expect(stepCreateSchema.safeParse({ stepType: "end_flow", config: defaultConfigFor("end_flow") }).success).toBe(true);
    // Sin salidas, y por eso no se puede insertar en medio de una conexión.
    expect(outputsOf("end_flow")).toEqual([]);
    expect(handlesOf("end_flow")).toEqual([]);
    expect(canInsertOnEdge("end_flow")).toBe(false);
  });

  it("no creó un bloque por cada regla: Condición y Switch siguen siendo los únicos que deciden", () => {
    expect(PALETTE.filter((i) => i.category === "decide").map((i) => i.stepType)).toEqual(["condition", "switch"]);
  });

  it("solo existe en el Modo Visual: la lista no lo crea", () => {
    expect(() => assertStepAllowed("end_flow", { canvas: false })).toThrowError(/Modo Visual/);
    expect(() => assertStepAllowed("end_flow", { canvas: true })).not.toThrow();
  });

  it("en la lista compilada nada sale de él, aunque tenga pasos detrás", () => {
    const edges = compileLinearEdges([
      { id: "a", stepType: "send_whatsapp", config: {} },
      { id: "b", stepType: "end_flow", config: {} },
      { id: "c", stepType: "send_whatsapp", config: {} },
    ]);
    expect(edges).toEqual([{ sourceStepId: "a", targetStepId: "b", sourceHandle: "default" }]);
  });

  it("la lista no puede mostrarlo: el flujo se queda en el Modo Visual, con el motivo", () => {
    const r = toLinear({
      nodes: [
        { id: "a", type: "condition", config: { rule: { type: "has_upcoming_booking" } } },
        { id: "e", type: "end_flow", config: {} },
      ],
      edges: [{ source: "a", target: "e", sourceHandle: "true" }],
      entryStepId: "a",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons[0]).toMatch(/Terminar flujo/);
  });

  describe("en la validación del lienzo", () => {
    const trigger = { id: "t", type: "trigger", config: { triggerType: "manual", triggerConfig: null } };
    const cond = { id: "c", type: "condition", config: { rule: { type: "has_upcoming_booking" }, ifTrue: "continue", ifFalse: "stop" } };
    const msg = { id: "m", type: "send_whatsapp", config: { content: "Hola" } };
    const end = { id: "e", type: "end_flow", config: {} };

    it("una rama «Sí» sin conectar avisa «el flujo termina ahí»…", () => {
      const v = validateGraph({
        nodes: [trigger, cond, msg],
        edges: [
          { source: "t", target: "c", sourceHandle: "default" },
          { source: "c", target: "m", sourceHandle: "false" },
        ],
      });
      expect(v.errors).toEqual([]);
      expect(v.warnings.map((w) => w.code)).toContain("open_output");
    });

    it("…y conectada a «Terminar flujo» deja de avisar: terminar es la decisión", () => {
      const v = validateGraph({
        nodes: [trigger, cond, msg, end],
        edges: [
          { source: "t", target: "c", sourceHandle: "default" },
          { source: "c", target: "e", sourceHandle: "true" },
          { source: "c", target: "m", sourceHandle: "false" },
        ],
      });
      expect(v.errors).toEqual([]);
      expect(v.warnings.map((w) => w.code)).not.toContain("open_output");
      expect(v.warnings.map((w) => w.code)).not.toContain("unreachable");
    });

    it("nada puede salir de él (error), y suelto, sin conexión, se avisa como bloque que no se alcanza", () => {
      const salida = validateGraph({
        nodes: [trigger, end, msg],
        edges: [
          { source: "t", target: "e", sourceHandle: "default" },
          { source: "e", target: "m", sourceHandle: "default" },
        ],
      });
      expect(salida.errors.map((x) => x.code)).toContain("invalid_handle");
      const suelto = validateGraph({ nodes: [trigger, msg, end], edges: [{ source: "t", target: "m", sourceHandle: "default" }] });
      expect(suelto.errors).toEqual([]);
      expect(suelto.warnings.map((w) => w.code)).toContain("unreachable");
    });

    it("una configuración inválida no se guarda", () => {
      const v = validateGraph({ nodes: [trigger, { id: "e", type: "end_flow", config: { name: 5 } }], edges: [{ source: "t", target: "e", sourceHandle: "default" }] });
      expect(v.errors.map((x) => x.code)).toContain("invalid_config");
    });
  });

  it("el historial lo explica con una línea clara", () => {
    const d = describeLog({
      status: "success",
      step: { id: "stp_1", stepType: "end_flow" },
      error: null,
      metadata: { step: { stepType: "end_flow", stepName: "Ya tiene cita", config: {} }, result: "ended", reason: "end_flow" },
    } as never);
    expect(d.title).toBe("Ya tiene cita");
    expect(d.outcome).toMatch(/terminó aquí, a propósito/);
    // Los demás pasos no llevan ese texto.
    expect(describeLog({ status: "success", step: null, error: null, metadata: { result: "paused" } } as never).outcome).toBeNull();
    expect(describeLog({ status: "success", step: null, error: null, metadata: null } as never).outcome).toBeNull();
  });
});

describe("nombre de la copia de un flujo", () => {
  it("la primera copia es «(copia)»; si existe, «(copia 2)», «(copia 3)»…", () => {
    expect(nextCopyName("Recordatorio", ["Recordatorio"])).toBe("Recordatorio (copia)");
    expect(nextCopyName("Recordatorio", ["Recordatorio", "Recordatorio (copia)"])).toBe("Recordatorio (copia 2)");
    expect(nextCopyName("Recordatorio", ["Recordatorio", "Recordatorio (copia)", "Recordatorio (copia 2)"])).toBe("Recordatorio (copia 3)");
  });
  it("llena el hueco más bajo y no depende del orden de la lista", () => {
    expect(nextCopyName("A", ["A", "A (copia 2)"])).toBe("A (copia)");
    expect(nextCopyName("A", ["A (copia 3)", "A (copia 2)", "A", "A (copia)"])).toBe("A (copia 4)");
  });
  it("copiar una copia no encadena sufijos", () => {
    expect(nextCopyName("Recordatorio (copia)", ["Recordatorio", "Recordatorio (copia)"])).toBe("Recordatorio (copia 2)");
    expect(nextCopyName("Recordatorio (copia 2)", ["Recordatorio", "Recordatorio (copia)", "Recordatorio (copia 2)"])).toBe("Recordatorio (copia 3)");
    expect(nextCopyName("Recordatorio (copia 7)", ["Recordatorio (copia 7)"])).toBe("Recordatorio (copia)");
  });
  it("compara sin mayúsculas, acentos ni espacios de más", () => {
    expect(nextCopyName("Sello", ["sello (COPIA)"])).toBe("Sello (copia 2)");
    expect(nextCopyName("Reseña", ["reseña", "RESENA (copia)  "])).toBe("Reseña (copia 2)");
  });
  it("respeta el tope de 120 caracteres recortando el origen, nunca el sufijo, y sigue siendo único", () => {
    const largo = "x".repeat(120);
    const a = nextCopyName(largo, [largo]);
    expect(a.length).toBeLessThanOrEqual(120);
    expect(a.endsWith(" (copia)")).toBe(true);
    const b = nextCopyName(largo, [largo, a]);
    expect(b.length).toBeLessThanOrEqual(120);
    expect(b.endsWith(" (copia 2)")).toBe(true);
    expect(b).not.toBe(a);
  });
  it("un nombre vacío no produce una copia sin nombre", () => {
    expect(nextCopyName("   ", [])).toBe("Flujo (copia)");
  });
});
