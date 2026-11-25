import { describe, expect, it } from "vitest";
import { HUMAN_HANDOFF_NOTE_MAX, humanHandoffConfigSchema } from "@/lib/automation";
import { STEP_TYPES, parseStepConfig, stepCreateSchema } from "@/lib/automation-schemas";
import { describeStep, stepLabel } from "@/lib/automation-dto";
import { PALETTE, defaultConfigFor, nodeKindOf, outputsOf } from "@/lib/automation-canvas";
import { handoffConversation } from "@/server/automation/handoff";
import { HANDOFF_LABEL } from "@/lib/analytics";

/**
 * Paso 5 — `human_handoff`, lo que no necesita base de datos: el esquema del paso, su nombre y descripción, su bloque en el
 * lienzo y los motivos de traspaso. El motor está en `automation-compliance.test.ts` y la acción real, en
 * `automation-handoff-live.test.ts`.
 */

describe("esquema del paso", () => {
  it("es un tipo de paso más, y su configuración no exige nada (la nota es opcional)", () => {
    expect(STEP_TYPES).toContain("human_handoff");
    expect(stepCreateSchema.safeParse({ stepType: "human_handoff", config: {} }).success).toBe(true);
    expect(stepCreateSchema.safeParse({ stepType: "human_handoff", config: { name: "Escalar", note: "Ganó un premio" } }).success).toBe(true);
    expect(parseStepConfig("human_handoff", {})).toEqual({ ok: true, value: {} });
  });

  it("la nota admite hasta el tope y se recorta; más se rechaza", () => {
    expect(humanHandoffConfigSchema.parse({ note: "  hola  " })).toEqual({ note: "hola" });
    expect(humanHandoffConfigSchema.safeParse({ note: "x".repeat(HUMAN_HANDOFF_NOTE_MAX) }).success).toBe(true);
    expect(humanHandoffConfigSchema.safeParse({ note: "x".repeat(HUMAN_HANDOFF_NOTE_MAX + 1) }).success).toBe(false);
    expect(humanHandoffConfigSchema.safeParse({ note: 5 }).success).toBe(false);
  });

  it("un tipo de paso vecino mal escrito sigue sin aceptarse", () => {
    expect(stepCreateSchema.safeParse({ stepType: "handoff", config: {} }).success).toBe(false);
    expect(stepCreateSchema.safeParse({ stepType: "human_handoff", config: { note: "x".repeat(501) } }).success).toBe(false);
  });
});

describe("textos de la tarjeta", () => {
  it("tiene su nombre y la describe, con o sin nota", () => {
    expect(stepLabel("human_handoff")).toBe("Pasar a una persona");
    const sin = describeStep({ stepType: "human_handoff", config: {} });
    expect(sin.title).toBe("Pasar la conversación a una persona");
    expect(sin.detail).toBe("Apaga la IA en esa conversación y avisa en la bandeja.");
    const con = describeStep({ stepType: "human_handoff", config: { note: "Confirmar el canje" } });
    expect(con.detail).toContain("Nota: «Confirmar el canje».");
  });
  it("una nota larga se recorta en la tarjeta", () => {
    expect((describeStep({ stepType: "human_handoff", config: { note: "z".repeat(400) } }).detail ?? "").length).toBeLessThan(220);
  });
});

describe("bloque del lienzo", () => {
  it("está en la paleta de acciones, nace con una configuración válida y es un nodo de acción de una sola salida", () => {
    const item = PALETTE.find((p) => p.kind === "step" && p.stepType === "human_handoff");
    expect(item).toMatchObject({ label: "Pasar a una persona", category: "actions", group: "CRM", icon: "Headset" });
    expect(stepCreateSchema.safeParse({ stepType: "human_handoff", config: defaultConfigFor("human_handoff") }).success).toBe(true);
    expect(nodeKindOf("human_handoff")).toBe("action");
    expect(outputsOf("human_handoff", {}).map((o) => o.id)).toEqual(["default"]);
  });
});

describe("motivo del traspaso", () => {
  it("«automatizacion» tiene etiqueta en las analíticas y los motivos de siempre no cambian", () => {
    expect(HANDOFF_LABEL.automatizacion).toMatch(/automatización/);
    for (const k of ["cliente", "modelo", "error", "ventana", "hostilidad", "manual_reply"]) expect(HANDOFF_LABEL[k], k).toBeTruthy();
  });
  it("la acción real está disponible para el worker", () => {
    expect(typeof handoffConversation).toBe("function");
  });
});
