import { describe, expect, it } from "vitest";
import { EDGE_HANDLES } from "@/lib/automation";
import {
  KNOWN_STEP_TYPES,
  PALETTE,
  TRIGGER_NODE_ID,
  defaultConfigFor,
  defaultTriggerConfig,
  edgeId,
  edgeLabelOf,
  fromServerGraph,
  isNewNodeId,
  newNodeId,
  nodeKindOf,
  outputsOf,
  sameStepConfig,
  toPayload,
  type ServerGraph,
} from "@/lib/automation-canvas";
import { CREATABLE_TRIGGERS } from "@/lib/automation-dto";
import { graphPayloadSchema, handlesOf, validateGraph } from "@/lib/automation-graph";
import { STEP_TYPES, parseStepConfig, parseTriggerConfigFor, type StepType } from "@/lib/automation-schemas";

/**
 * Fase 5, la capa del lienzo que no es React: la paleta, cómo nace cada bloque, qué salidas se pintan y la
 * conversión entre lo que guarda el servidor y lo que dibuja el lienzo (ida y vuelta sin perder nada).
 */

describe("la paleta", () => {
  it("ofrece los disparadores, la lógica y las acciones pedidas", () => {
    const labels = (cat: string) => PALETTE.filter((i) => i.category === cat).map((i) => i.label);
    expect(labels("triggers")).toEqual(["Lead nuevo", "Cambio de etapa", "Anuncio", "Cita agendada", "Cita confirmada", "No asistió", "Cumpleaños"]);
    expect(labels("logic")).toEqual(["Condición (Sí / No)", "Esperar tiempo", "Esperar hasta la cita", "Esperar respuesta"]);
    expect(labels("actions")).toEqual(["Enviar WhatsApp", "Enviar multimedia", "Asignar etiqueta", "Quitar etiqueta", "Cambiar etapa"]);
  });

  it("los disparadores de la paleta son EXACTAMENTE los que la pantalla deja crear", () => {
    const fromPalette = PALETTE.filter((i) => i.kind === "trigger").map((i) => i.triggerType);
    expect([...fromPalette].sort()).toEqual([...CREATABLE_TRIGGERS].sort());
  });

  it("cada bloque de la paleta es un tipo que la API acepta (nada se guarda para no hacer nada)", () => {
    for (const i of PALETTE) {
      if (i.soon) continue;
      if (i.kind === "trigger") expect(parseTriggerConfigFor(i.triggerType!, {}).ok, i.id).toBe(true);
      else expect(STEP_TYPES as readonly string[], i.id).toContain(i.stepType);
    }
  });

  it("todos los pasos que acepta la API están en la paleta, salvo lo que aún no existe", () => {
    const inPalette = new Set(PALETTE.filter((i) => i.kind === "step" && i.stepType).map((i) => i.stepType));
    for (const t of STEP_TYPES) expect(inPalette.has(t), t).toBe(true);
  });

  it("«Enviar multimedia» se muestra pero no se puede soltar (el motor aún no envía medios)", () => {
    const media = PALETTE.find((i) => i.id === "soon:media")!;
    expect(media).toMatchObject({ soon: true, kind: "step" });
    expect(media.stepType).toBeUndefined();
  });

  it("los bloques de cita lo avisan", () => {
    expect(PALETTE.find((i) => i.stepType === "wait_until")!.needsBooking).toBe(true);
    expect(PALETTE.filter((i) => i.needsBooking)).toHaveLength(1);
  });

  it("los ids son únicos", () => {
    const ids = PALETTE.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("cada tipo de bloque tiene forma en el lienzo", () => {
  it("nodeKindOf cubre todos los tipos (y los de acción comparten nodo)", () => {
    expect(nodeKindOf("trigger")).toBe("trigger");
    expect(nodeKindOf("send_whatsapp")).toBe("message");
    expect(nodeKindOf("delay")).toBe("wait");
    expect(nodeKindOf("wait_until")).toBe("wait");
    expect(nodeKindOf("condition")).toBe("condition");
    expect(nodeKindOf("wait_reply")).toBe("waitReply");
    for (const t of ["add_tag", "remove_tag", "set_stage"]) expect(nodeKindOf(t)).toBe("action");
    for (const t of KNOWN_STEP_TYPES) expect(nodeKindOf(t)).toBeTruthy();
  });

  it("las salidas que se pintan son exactamente las asas que el servidor acepta para ese tipo", () => {
    for (const t of ["trigger", ...STEP_TYPES]) {
      expect(outputsOf(t).map((o) => o.id), t).toEqual(handlesOf(t));
    }
  });

  it("las salidas llevan rótulo legible; una sola salida es el «Siguiente» normal", () => {
    expect(outputsOf("condition")).toEqual([
      { id: "true", label: "Sí" },
      { id: "false", label: "No" },
    ]);
    expect(outputsOf("wait_reply").map((o) => o.label)).toEqual(["Confirma", "No", "Reagendar", "Otra cosa", "Sin resp."]);
    expect(outputsOf("wait_until").map((o) => o.label)).toEqual(["Siguiente", "Si ya pasó"]);
    expect(outputsOf("add_tag")).toEqual([{ id: "default", label: "Siguiente" }]);
  });

  it("solo las aristas de asas que ramifican llevan texto", () => {
    expect(edgeLabelOf("default")).toBeUndefined();
    expect(edgeLabelOf(null)).toBeUndefined();
    expect(edgeLabelOf(undefined)).toBeUndefined();
    expect(edgeLabelOf("true")).toBe("Sí");
    expect(edgeLabelOf("false")).toBe("No");
    expect(edgeLabelOf("confirmed")).toBe("Confirma");
    expect(edgeLabelOf("late")).toBe("Si ya pasó");
    for (const h of EDGE_HANDLES) if (h !== "default") expect(edgeLabelOf(h)).toBeTruthy();
  });
});

describe("cómo nace cada bloque", () => {
  it("esperar un día, la cita 1 día antes y «esperar respuesta» ya nacen válidos", () => {
    for (const t of ["delay", "wait_until", "wait_reply"] as StepType[]) {
      expect(parseStepConfig(t, defaultConfigFor(t)).ok, t).toBe(true);
    }
    expect(defaultConfigFor("delay")).toEqual({ amount: 1, unit: "days" });
    expect(defaultConfigFor("wait_until")).toMatchObject({ offsetMinutes: -1440, lateAction: "skip_next" });
    expect(defaultConfigFor("wait_reply")).toMatchObject({ timeoutMinutes: 10080, onConfirmed: "continue", onTimeout: "stop", confirmBooking: true });
  });

  it("lo que falta por decidir (etiqueta, etapa, mensaje, regla) nace vacío y la validación pide configurarlo", () => {
    for (const t of ["add_tag", "remove_tag", "set_stage", "send_whatsapp", "condition"] as StepType[]) {
      expect(defaultConfigFor(t), t).toEqual({});
      expect(parseStepConfig(t, defaultConfigFor(t)).ok, t).toBe(false);
    }
    const v = validateGraph({
      nodes: [
        { id: "trigger", type: "trigger", config: { triggerType: "lead_created", triggerConfig: null } },
        { id: "a", type: "add_tag", config: defaultConfigFor("add_tag") },
      ],
      edges: [{ source: "trigger", target: "a", sourceHandle: "default" }],
    });
    expect(v.errors.map((e) => e.code)).toEqual(["invalid_config"]);
  });

  it("el disparador de cumpleaños nace con su hora de siempre; los demás, sin ajustes", () => {
    expect(defaultTriggerConfig("birthday")).toEqual({ hour: 10, daysOffset: 0 });
    expect(parseTriggerConfigFor("birthday", defaultTriggerConfig("birthday")).ok).toBe(true);
    for (const t of CREATABLE_TRIGGERS.filter((x) => x !== "birthday")) expect(defaultTriggerConfig(t)).toBeNull();
  });
});

describe("del servidor al lienzo y de vuelta", () => {
  const server: ServerGraph = {
    flow: { triggerType: "booking_created", triggerConfig: null },
    nodes: [
      { id: "stp_a", type: "wait_reply", config: { timeoutMinutes: 60 }, position: { x: 0, y: 160 } },
      { id: "stp_b", type: "add_tag", config: { tagId: "tag_1" }, position: { x: -200, y: 320 } },
      { id: "stp_c", type: "send_whatsapp", config: { content: "Hola" }, position: { x: 200, y: 320 } },
    ],
    edges: [
      { id: "edg_1", source: "stp_a", target: "stp_b", sourceHandle: "confirmed" },
      { id: "edg_2", source: "stp_a", target: "stp_c", sourceHandle: "timeout" },
    ],
    entryStepId: "stp_a",
    editorMode: "canvas",
    viewport: { x: 5, y: 6, zoom: 0.8, trigger: { x: 10, y: 20 } },
    updatedAt: 1731600000000,
  };

  it("el disparador es un nodo más: en su posición guardada, y su salida es la entrada del flujo", () => {
    const { nodes, edges } = fromServerGraph(server);
    const trg = nodes.find((n) => n.id === TRIGGER_NODE_ID)!;
    expect(trg).toMatchObject({ type: "trigger", position: { x: 10, y: 20 }, data: { kind: "trigger", triggerType: "booking_created", triggerConfig: null } });
    expect(edges[0]).toEqual({ id: edgeId(TRIGGER_NODE_ID, "default"), source: TRIGGER_NODE_ID, target: "stp_a", sourceHandle: "default" });
    expect(nodes.filter((n) => n.id !== TRIGGER_NODE_ID).map((n) => n.type)).toEqual(["waitReply", "action", "message"]);
  });

  it("sin cámara guardada, el disparador queda en el origen; sin entrada, no hay arista del disparador", () => {
    const { nodes, edges } = fromServerGraph({ ...server, viewport: null, entryStepId: null });
    expect(nodes[0]!.position).toEqual({ x: 0, y: 0 });
    expect(edges.every((e) => e.source !== TRIGGER_NODE_ID)).toBe(true);
  });

  it("IDA Y VUELTA: lo que el servidor guardó se vuelve a mandar igual (y es un payload que la ruta acepta)", () => {
    const { nodes, edges } = fromServerGraph(server);
    const payload = toPayload(nodes, edges, { viewport: { x: 5, y: 6, zoom: 0.8 }, expectedUpdatedAt: server.updatedAt });
    const parsed = graphPayloadSchema.parse(payload);

    expect(parsed.expectedUpdatedAt).toBe(server.updatedAt);
    expect(parsed.viewport).toEqual({ x: 5, y: 6, zoom: 0.8 });
    const trg = parsed.nodes.find((n) => n.type === "trigger")!;
    expect(trg).toMatchObject({ id: "trigger", config: { triggerType: "booking_created", triggerConfig: null }, position: { x: 10, y: 20 } });
    expect(parsed.nodes.filter((n) => n.type !== "trigger").map((n) => [n.id, n.type, n.position])).toEqual([
      ["stp_a", "wait_reply", { x: 0, y: 160 }],
      ["stp_b", "add_tag", { x: -200, y: 320 }],
      ["stp_c", "send_whatsapp", { x: 200, y: 320 }],
    ]);
    // Las aristas: la del disparador (entrada) + las dibujadas, con su asa.
    expect(parsed.edges.map((e) => `${e.source}|${e.sourceHandle}|${e.target}`)).toEqual([
      "trigger|default|stp_a",
      "stp_a|confirmed|stp_b",
      "stp_a|timeout|stp_c",
    ]);
    // Y es un grafo válido: nada que arreglar al guardar lo que acabamos de cargar.
    const v = validateGraph({ nodes: parsed.nodes, edges: parsed.edges });
    expect(v.errors).toEqual([]);
  });

  it("sin cámara ni versión esperada no se mandan (son opcionales en el contrato)", () => {
    const { nodes, edges } = fromServerGraph(server);
    const payload = toPayload(nodes, edges);
    expect(payload).not.toHaveProperty("viewport");
    expect(payload).not.toHaveProperty("expectedUpdatedAt");
    expect(graphPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("un asa ausente se manda como «default»", () => {
    const payload = toPayload(
      [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: { kind: "trigger", triggerType: "lead_created", triggerConfig: null } },
        { id: "a", type: "action", position: { x: 0, y: 100 }, data: { kind: "step", stepType: "add_tag", config: { tagId: "t" } } },
      ],
      [{ id: "e", source: "trigger", target: "a" }]
    );
    expect(payload.edges[0]!.sourceHandle).toBe("default");
  });
});

describe("ids de bloques nuevos", () => {
  it("son temporales, únicos y se reconocen", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newNodeId()));
    expect(ids.size).toBe(500);
    for (const id of ids) {
      expect(isNewNodeId(id)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(64);
    }
    expect(isNewNodeId("stp_abc123")).toBe(false);
    expect(isNewNodeId("trigger")).toBe(false);
  });
});

describe("sameStepConfig (abrir un bloque sin tocarlo no es un cambio)", () => {
  it("la configuración guardada y la que entrega el formulario (ya con los valores por defecto) son la misma", () => {
    // El servidor guarda lo que escribió la API; el formulario entrega el resultado del esquema, con todo relleno.
    const stored = { timeoutMinutes: 120 };
    const fromForm = { timeoutMinutes: 120, onConfirmed: "continue", onDeclined: "stop", onReschedule: "stop", onOther: "stop", onTimeout: "stop", confirmBooking: true };
    expect(sameStepConfig("wait_reply", stored, fromForm)).toBe(true);
  });

  it("no depende del orden de las claves", () => {
    expect(sameStepConfig("delay", { unit: "days", amount: 1 }, { amount: 1, unit: "days" })).toBe(true);
  });

  it("un cambio real sí se detecta", () => {
    expect(sameStepConfig("delay", { amount: 1, unit: "days" }, { amount: 2, unit: "days" })).toBe(false);
    expect(sameStepConfig("add_tag", { tagId: "a" }, { tagId: "b" })).toBe(false);
  });

  it("una configuración guardada inválida (aún sin configurar) se compara tal cual", () => {
    expect(sameStepConfig("add_tag", {}, {})).toBe(true);
    expect(sameStepConfig("add_tag", {}, { tagId: "t" })).toBe(false);
  });
});
