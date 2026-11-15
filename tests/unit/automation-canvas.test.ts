import { describe, expect, it } from "vitest";
import { compileLinearEdges, type EdgeHandle } from "@/lib/automation";
import {
  autoLayout,
  graphPayloadSchema,
  handlesOf,
  normalizeColumn,
  toLinear,
  validateGraph,
} from "@/lib/automation-graph";

/**
 * Fase 5, parte pura: el contrato del `PUT /graph`, la validación de topología (la misma que corre en vivo en el
 * cliente y otra vez en el servidor), la conversión Visual → Simple con verificación y el auto-orden. Sin base de
 * datos ni React; lo que toca Postgres vive en `automation-canvas-live.test.ts`.
 */

/* ─── Constructores de nodos válidos ─── */

const trigger = (id = "trg", triggerType = "lead_created") => ({ id, type: "trigger", config: { triggerType, triggerConfig: null } });
const tag = (id: string) => ({ id, type: "add_tag", config: { tagId: "tag_1" } });
const delay = (id: string) => ({ id, type: "delay", config: { amount: 1, unit: "days" } });
const reply = (id: string, over: Record<string, unknown> = {}) => ({ id, type: "wait_reply", config: { ...over } });
const cond = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: "condition",
  config: { rule: { type: "tag_has", tagId: "tag_1" }, ...over },
});
const until = (id: string) => ({ id, type: "wait_until", config: { anchor: "booking.scheduledAt", offsetMinutes: -60 } });
const e = (source: string, target: string, sourceHandle: EdgeHandle | string = "default") => ({ source, target, sourceHandle });

const codes = (r: { errors: { code: string }[] }) => r.errors.map((x) => x.code);
const wcodes = (r: { warnings: { code: string }[] }) => r.warnings.map((x) => x.code);

describe("graphPayloadSchema", () => {
  const ok = { nodes: [{ id: "a", type: "add_tag", config: { tagId: "t" }, position: { x: 1.6, y: -2.4 } }], edges: [] };

  it("acepta un grafo y redondea las posiciones a entero", () => {
    const p = graphPayloadSchema.parse(ok);
    expect(p.nodes[0]!.position).toEqual({ x: 2, y: -2 });
    expect(p.edges).toEqual([]);
  });

  it("el asa es «default» por defecto y la config, vacía", () => {
    const p = graphPayloadSchema.parse({
      nodes: [
        { id: "a", type: "delay", position: { x: 0, y: 0 } },
        { id: "b", type: "delay", position: { x: 0, y: 0 } },
      ],
      edges: [{ source: "a", target: "b" }],
    });
    expect(p.edges[0]!.sourceHandle).toBe("default");
    expect(p.nodes[0]!.config).toEqual({});
  });

  it.each([
    ["tipo de nodo desconocido", { ...ok, nodes: [{ ...ok.nodes[0], type: "inventado" }] }],
    ["posición fuera de rango", { ...ok, nodes: [{ ...ok.nodes[0], position: { x: 100_001, y: 0 } }] }],
    ["posición no numérica", { ...ok, nodes: [{ ...ok.nodes[0], position: { x: "1", y: 0 } }] }],
    ["asa desconocida", { ...ok, edges: [{ source: "a", target: "a", sourceHandle: "norte" }] }],
    ["id vacío", { ...ok, nodes: [{ ...ok.nodes[0], id: "  " }] }],
    ["cámara con zoom absurdo", { ...ok, viewport: { x: 0, y: 0, zoom: 99 } }],
    ["demasiados nodos", { nodes: Array.from({ length: 52 }, (_, i) => ({ id: `n${i}`, type: "delay", position: { x: 0, y: 0 } })), edges: [] }],
  ])("rechaza: %s", (_n, body) => {
    expect(graphPayloadSchema.safeParse(body).success).toBe(false);
  });

  it("expectedUpdatedAt y viewport son opcionales", () => {
    expect(graphPayloadSchema.safeParse({ ...ok, expectedUpdatedAt: 1731600000000, viewport: { x: 0, y: 0, zoom: 1 } }).success).toBe(true);
    expect(graphPayloadSchema.safeParse({ ...ok, expectedUpdatedAt: 1.5 }).success).toBe(false);
  });
});

describe("handlesOf", () => {
  it("cada tipo tiene sus asas", () => {
    expect(handlesOf("condition")).toEqual(["true", "false"]);
    expect(handlesOf("wait_reply")).toEqual(["confirmed", "declined", "reschedule", "other", "timeout"]);
    expect(handlesOf("wait_until")).toEqual(["default", "late"]);
    for (const t of ["trigger", "delay", "send_whatsapp", "add_tag", "remove_tag", "set_stage"]) expect(handlesOf(t)).toEqual(["default"]);
  });
});

describe("validateGraph — estructura", () => {
  it("un flujo en fila es válido y sin avisos", () => {
    const r = validateGraph({ nodes: [trigger(), tag("a"), delay("b")], edges: [e("trg", "a"), e("a", "b")] });
    expect(r).toEqual({ errors: [], warnings: [] });
  });

  it("un grafo vacío (solo el disparador) es válido: no hace nada, sin error", () => {
    expect(validateGraph({ nodes: [trigger()], edges: [] })).toEqual({ errors: [], warnings: [] });
  });

  it("exactamente un disparador", () => {
    expect(codes(validateGraph({ nodes: [tag("a")], edges: [] }))).toContain("trigger_count");
    const two = validateGraph({ nodes: [trigger("t1"), trigger("t2")], edges: [] });
    expect(codes(two)).toContain("trigger_count");
    expect(two.errors.find((x) => x.code === "trigger_count")!.nodeIds).toEqual(["t1", "t2"]);
  });

  it("ids repetidos", () => {
    expect(codes(validateGraph({ nodes: [trigger(), tag("a"), tag("a")], edges: [] }))).toContain("duplicate_node");
  });

  it("una arista a un nodo que no existe", () => {
    expect(codes(validateGraph({ nodes: [trigger(), tag("a")], edges: [e("trg", "a"), e("a", "fantasma")] }))).toContain("edge_dangling");
    expect(codes(validateGraph({ nodes: [trigger(), tag("a")], edges: [e("fantasma", "a")] }))).toContain("edge_dangling");
  });

  it("nada lleva de vuelta al disparador", () => {
    expect(codes(validateGraph({ nodes: [trigger(), tag("a")], edges: [e("trg", "a"), e("a", "trg")] }))).toContain("edge_to_trigger");
  });

  it("el disparador solo puede llevar a un bloque", () => {
    const r = validateGraph({ nodes: [trigger(), tag("a"), tag("b")], edges: [e("trg", "a"), e("trg", "b", "default")] });
    // La segunda arista repite el asa «default» del disparador.
    expect(codes(r)).toContain("duplicate_handle");
  });

  it("el asa debe existir en ese tipo de bloque", () => {
    const r1 = validateGraph({ nodes: [trigger(), cond("c"), tag("a")], edges: [e("trg", "c"), e("c", "a", "default")] });
    expect(codes(r1)).toContain("invalid_handle");
    const r2 = validateGraph({ nodes: [trigger(), tag("a"), tag("b")], edges: [e("trg", "a"), e("a", "b", "true")] });
    expect(codes(r2)).toContain("invalid_handle");
    const r3 = validateGraph({ nodes: [trigger(), reply("w"), tag("a")], edges: [e("trg", "w"), e("w", "a", "late")] });
    expect(codes(r3)).toContain("invalid_handle");
  });

  it("una salida lleva a un solo destino", () => {
    const r = validateGraph({ nodes: [trigger(), cond("c"), tag("a"), tag("b")], edges: [e("trg", "c"), e("c", "a", "true"), e("c", "b", "true")] });
    expect(codes(r)).toContain("duplicate_handle");
  });

  it("más de 50 bloques", () => {
    const nodes = [trigger(), ...Array.from({ length: 51 }, (_, i) => tag(`n${i}`))];
    expect(codes(validateGraph({ nodes, edges: [] }))).toContain("too_many_steps");
  });
});

describe("validateGraph — configuración y disparador", () => {
  it("una configuración que su esquema rechaza es un error del bloque", () => {
    const r = validateGraph({ nodes: [trigger(), { id: "a", type: "add_tag", config: {} }], edges: [e("trg", "a")] });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ code: "invalid_config", nodeIds: ["a"] });
    expect(r.errors[0]!.message).toMatch(/Configura el bloque/);
  });

  it("un bloque de tipo desconocido", () => {
    expect(codes(validateGraph({ nodes: [trigger(), { id: "x", type: "rayo", config: {} }], edges: [] }))).toContain("invalid_node");
  });

  it("el disparador necesita un tipo válido y ajustes válidos", () => {
    expect(codes(validateGraph({ nodes: [{ id: "trg", type: "trigger", config: {} }], edges: [] }))).toContain("invalid_trigger");
    expect(codes(validateGraph({ nodes: [{ id: "trg", type: "trigger", config: { triggerType: "volcan" } }], edges: [] }))).toContain("invalid_trigger");
    expect(codes(validateGraph({ nodes: [{ id: "trg", type: "trigger", config: { triggerType: "ad_referral", triggerConfig: { sourceId: "" } } }], edges: [] }))).toContain("invalid_trigger");
    expect(validateGraph({ nodes: [{ id: "trg", type: "trigger", config: { triggerType: "ad_referral", triggerConfig: { sourceId: "123" } } }], edges: [] }).errors).toEqual([]);
  });

  it("«esperar hasta la cita» y «la cita está confirmada» exigen un disparador de cita", () => {
    const nodes = (t: string) => [trigger("trg", t), until("w"), cond("c", { rule: { type: "booking_confirmed" } })];
    const edges = [e("trg", "w"), e("w", "c")];
    const bad = validateGraph({ nodes: nodes("lead_created"), edges });
    expect(bad.errors.filter((x) => x.code === "requires_booking").map((x) => x.nodeIds![0]).sort()).toEqual(["c", "w"]);
    for (const t of ["booking_created", "booking_confirmed", "booking_no_show"]) {
      expect(codes(validateGraph({ nodes: nodes(t), edges }))).not.toContain("requires_booking");
    }
  });
});

describe("validateGraph — avisos", () => {
  it("un disparador sin conectar avisa que el flujo no hará nada", () => {
    const r = validateGraph({ nodes: [trigger(), tag("a")], edges: [] });
    expect(r.errors).toEqual([]);
    expect(wcodes(r)).toEqual(expect.arrayContaining(["no_entry", "unreachable"]));
  });

  it("los bloques inalcanzables se avisan con sus ids (y se guarda igual)", () => {
    const r = validateGraph({ nodes: [trigger(), tag("a"), tag("huerfano"), tag("otro")], edges: [e("trg", "a")] });
    expect(r.errors).toEqual([]);
    const w = r.warnings.find((x) => x.code === "unreachable")!;
    expect(w.nodeIds).toEqual(["huerfano", "otro"]);
    expect(w.message).toMatch(/2 bloques no se alcanzan/);
  });

  it("las salidas sin conectar de un nodo ramificado avisan que el flujo termina ahí", () => {
    const r = validateGraph({ nodes: [trigger(), cond("c"), tag("a")], edges: [e("trg", "c"), e("c", "a", "true")] });
    const w = r.warnings.find((x) => x.code === "open_output")!;
    expect(w.nodeIds).toEqual(["c"]);
    expect(w.message).toContain("«No»");
    expect(w.message).toContain("termina");

    const wr = validateGraph({ nodes: [trigger(), reply("w"), tag("a")], edges: [e("trg", "w"), e("w", "a", "confirmed")] });
    expect(wr.warnings.find((x) => x.code === "open_output")!.message).toContain("«Dice que no»");
    // Un paso normal sin salida es solo el final del flujo: sin aviso.
    expect(wcodes(validateGraph({ nodes: [trigger(), tag("a")], edges: [e("trg", "a")] }))).not.toContain("open_output");
    // `wait_until` solo avisa por «Si ya pasó»; su «Siguiente» sin conectar es el final normal.
    const wu = validateGraph({ nodes: [trigger("trg", "booking_created"), until("w")], edges: [e("trg", "w")] });
    expect(wu.warnings.find((x) => x.code === "open_output")!.message).toContain("«Si ya pasó»");
  });
});

describe("validateGraph — ciclos", () => {
  it("un ciclo sin ninguna espera es un ERROR (giraría sin parar en la cola)", () => {
    const r = validateGraph({
      nodes: [trigger(), tag("a"), tag("b")],
      edges: [e("trg", "a"), e("a", "b"), e("b", "a")],
    });
    const c = r.errors.find((x) => x.code === "cycle_without_wait")!;
    expect(c).toBeDefined();
    expect([...c.nodeIds!].sort()).toEqual(["a", "b"]);
  });

  it("un bloque que se apunta a sí mismo, sin espera, es un error", () => {
    expect(codes(validateGraph({ nodes: [trigger(), tag("a")], edges: [e("trg", "a"), e("a", "a")] }))).toContain("cycle_without_wait");
  });

  it("un ciclo con una espera (delay, wait_reply o wait_until) es válido, con aviso", () => {
    for (const [wait, handle] of [[delay("w"), "default"], [reply("w"), "timeout"], [until("w"), "late"]] as const) {
      const r = validateGraph({
        nodes: [trigger("trg", "booking_created"), tag("a"), wait],
        edges: [e("trg", "a"), e("a", "w"), e("w", "a", handle)],
      });
      expect(codes(r), String(wait.type)).not.toContain("cycle_without_wait");
      expect(wcodes(r), String(wait.type)).toContain("cycle");
    }
  });

  it("el clásico «si no responde, recuérdale y vuelve a esperar» es válido", () => {
    const r = validateGraph({
      nodes: [trigger(), reply("w", { timeoutMinutes: 60 }), tag("recordar"), tag("fin")],
      edges: [e("trg", "w"), e("w", "fin", "confirmed"), e("w", "recordar", "timeout"), e("recordar", "w")],
    });
    expect(r.errors).toEqual([]);
    expect(wcodes(r)).toContain("cycle");
  });

  it("un ciclo que cruza una espera pero tiene otro ciclo sin espera sigue siendo error", () => {
    // w → a; a:true → b → a (ciclo SIN espera); a:false → w (ciclo con espera).
    const r = validateGraph({
      nodes: [trigger(), delay("w"), cond("a"), tag("b")],
      edges: [e("trg", "w"), e("w", "a"), e("a", "b", "true"), e("b", "a"), e("a", "w", "false")],
    });
    expect(codes(r)).toContain("cycle_without_wait");
    expect(wcodes(r)).not.toContain("cycle");
  });

  it("una cadena larguísima no desborda la pila (la detección es iterativa)", () => {
    const n = 20_000;
    const nodes = [trigger(), ...Array.from({ length: n }, (_, i) => tag(`n${i}`))];
    const edges = [e("trg", "n0"), ...Array.from({ length: n - 1 }, (_, i) => e(`n${i}`, `n${i + 1}`))];
    // El límite de 50 bloques se avisa como error, pero no debe reventar ni tardar.
    const r = validateGraph({ nodes, edges });
    expect(codes(r)).toContain("too_many_steps");
    expect(codes(r)).not.toContain("cycle_without_wait");
  });
});

/* ─── toLinear ─── */

const lin = (nodes: ReturnType<typeof tag>[], edges: ReturnType<typeof e>[], entryStepId: string | null) =>
  toLinear({ nodes: nodes as never, edges, entryStepId });

describe("toLinear", () => {
  it("un grafo vacío es una lista vacía", () => {
    expect(lin([], [], null)).toEqual({ ok: true, order: [], configs: {} });
  });

  it("una fila de acciones: el orden es el del camino y las configuraciones no cambian", () => {
    const r = lin([tag("a"), delay("b"), tag("c")] as never, [e("a", "b"), e("b", "c")], "a");
    expect(r).toMatchObject({ ok: true, order: ["a", "b", "c"] });
    if (r.ok) expect(r.configs.b).toEqual({ amount: 1, unit: "days" });
  });

  it("el orden sigue el camino aunque los nodos lleguen desordenados", () => {
    const r = lin([tag("c"), tag("a"), tag("b")], [e("a", "b"), e("b", "c")], "a");
    expect(r).toMatchObject({ ok: true, order: ["a", "b", "c"] });
  });

  it("deriva las acciones de las ramas: siguiente = continue, el de después = skip_next, sin arista = stop", () => {
    const r = lin(
      [cond("c"), tag("a"), tag("b")] as never,
      [e("c", "a", "true"), e("c", "b", "false"), e("a", "b")],
      "c"
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.configs.c).toMatchObject({ ifTrue: "continue", ifFalse: "skip_next" });
    const stop = lin([cond("c"), tag("a")] as never, [e("c", "a", "true")], "c");
    if (stop.ok) expect(stop.configs.c).toMatchObject({ ifTrue: "continue", ifFalse: "stop" });
  });

  it("wait_reply: cada intención se convierte en su acción", () => {
    const r = lin(
      [reply("w"), tag("a"), tag("b")] as never,
      [e("w", "a", "confirmed"), e("w", "b", "timeout"), e("a", "b")],
      "w"
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.configs.w).toMatchObject({ onConfirmed: "continue", onDeclined: "stop", onReschedule: "stop", onOther: "stop", onTimeout: "skip_next" });
    }
  });

  it("wait_until: el asa «late» se convierte en lateAction", () => {
    const r = lin([until("w"), tag("a"), tag("b")] as never, [e("w", "a"), e("w", "b", "late"), e("a", "b")], "w");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.configs.w).toMatchObject({ lateAction: "skip_next" });
  });

  it("IDA Y VUELTA: lo que la lista compila se puede volver a leer igual (todas las combinaciones de una condición)", () => {
    const actions = ["continue", "skip_next", "stop"] as const;
    for (const ifTrue of actions) {
      for (const ifFalse of actions) {
        const steps = [
          { id: "c", stepType: "condition", config: { rule: { type: "tag_has", tagId: "t" }, ifTrue, ifFalse } },
          { id: "a", stepType: "add_tag", config: { tagId: "t" } },
          { id: "b", stepType: "add_tag", config: { tagId: "t" } },
          { id: "z", stepType: "add_tag", config: { tagId: "t" } },
        ];
        const edges = compileLinearEdges(steps).map((x) => ({ source: x.sourceStepId, target: x.targetStepId, sourceHandle: x.sourceHandle }));
        const back = toLinear({ nodes: steps.map((s) => ({ id: s.id, type: s.stepType, config: s.config })), edges, entryStepId: "c" });
        expect(back.ok, `${ifTrue}/${ifFalse}`).toBe(true);
        if (back.ok) {
          expect(back.order).toEqual(["c", "a", "b", "z"]);
          expect(back.configs.c).toMatchObject({ ifTrue, ifFalse });
        }
      }
    }
  });

  it("IDA Y VUELTA con wait_reply: las cinco ramas", () => {
    const actions = ["continue", "skip_next", "stop"] as const;
    for (const a of actions) {
      for (const b of actions) {
        const cfg = { onConfirmed: a, onDeclined: b, onReschedule: a, onOther: b, onTimeout: a };
        const steps = [
          { id: "w", stepType: "wait_reply", config: cfg },
          { id: "x", stepType: "add_tag", config: {} },
          { id: "y", stepType: "add_tag", config: {} },
          { id: "z", stepType: "add_tag", config: {} },
        ];
        const edges = compileLinearEdges(steps).map((x) => ({ source: x.sourceStepId, target: x.targetStepId, sourceHandle: x.sourceHandle }));
        const back = toLinear({ nodes: steps.map((s) => ({ id: s.id, type: s.stepType, config: s.config })), edges, entryStepId: "w" });
        expect(back.ok, `${a}/${b}`).toBe(true);
        if (back.ok) expect(back.configs.w).toMatchObject(cfg);
      }
    }
  });

  describe("lo que NO cabe en una lista (se bloquea, no se destruye)", () => {
    it("sin paso de entrada", () => {
      const r = lin([tag("a")], [], null);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasons[0]).toMatch(/disparador no está conectado/);
    });

    it("un ciclo", () => {
      const r = lin([tag("a"), delay("b")] as never, [e("a", "b"), e("b", "a")], "a");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasons.join(" ")).toMatch(/ciclo/);
    });

    it("un bloque fuera del camino principal (huérfano o en otra rama)", () => {
      const r = lin([tag("a"), tag("b"), tag("huerfano")], [e("a", "b")], "a");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasons.join(" ")).toMatch(/fuera del camino principal/);
    });

    it("una rama que salta a un bloque lejano", () => {
      const r = lin(
        [cond("c"), tag("a"), tag("b"), tag("far")] as never,
        [e("c", "a", "true"), e("c", "far", "false"), e("a", "b"), e("b", "far")],
        "c"
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasons.join(" ")).toMatch(/«No» lleva a un bloque que la lista no puede representar/);
    });

    it("dos ramas que llevan a dos bloques distintos que no son el siguiente ni el de después", () => {
      const r = lin(
        [cond("c"), tag("a"), tag("b"), tag("x"), tag("y")] as never,
        [e("c", "x", "true"), e("c", "y", "false"), e("a", "b")],
        "c"
      );
      expect(r.ok).toBe(false);
    });

    it("una condición cuyas dos ramas van a bloques distintos que forman dos caminos", () => {
      // c → (true) a → fin ; c → (false) b → fin : «b» no está en el camino principal.
      const r = lin([cond("c"), tag("a"), tag("b")] as never, [e("c", "a", "true"), e("c", "b", "false")], "c");
      // `b` es el «de después» de c, pero `a` no lo continúa: la lista recompilada tendría a→b, que no se dibujó.
      expect(r.ok).toBe(false);
    });
  });
});

/* ─── Posiciones ─── */

describe("autoLayout y normalizeColumn", () => {
  it("una fila: una columna centrada, un nivel por bloque, bajo el disparador", () => {
    const l = autoLayout(["a", "b", "c"], [{ source: "a", target: "b" }, { source: "b", target: "c" }], "a");
    expect(l.trigger).toEqual({ x: 0, y: 0 });
    expect(l.steps.a).toEqual({ x: 0, y: 160 });
    expect(l.steps.b).toEqual({ x: 0, y: 320 });
    expect(l.steps.c).toEqual({ x: 0, y: 480 });
  });

  it("una ramificación reparte los hermanos en horizontal, centrados", () => {
    const l = autoLayout(["c", "a", "b"], [{ source: "c", target: "a" }, { source: "c", target: "b" }], "c");
    expect(l.steps.a!.y).toBe(l.steps.b!.y);
    expect(l.steps.a!.x + l.steps.b!.x).toBe(0);
    expect(l.steps.a!.x).not.toBe(l.steps.b!.x);
    expect(l.steps.c!.y).toBeLessThan(l.steps.a!.y);
  });

  it("un bloque con dos caminos queda en el nivel del más corto", () => {
    const l = autoLayout(
      ["c", "a", "b"],
      [{ source: "c", target: "a" }, { source: "c", target: "b" }, { source: "a", target: "b" }],
      "c"
    );
    expect(l.steps.b!.y).toBe(l.steps.a!.y);
  });

  it("lo inalcanzable va debajo y todas las posiciones son enteras y distintas", () => {
    const ids = ["a", "b", "x1", "x2", "x3", "x4", "x5"];
    const l = autoLayout(ids, [{ source: "a", target: "b" }], "a");
    const maxReach = Math.max(l.steps.a!.y, l.steps.b!.y);
    for (const id of ["x1", "x2", "x3", "x4", "x5"]) expect(l.steps[id]!.y).toBeGreaterThan(maxReach);
    for (const p of Object.values(l.steps)) {
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
    }
    expect(new Set(Object.values(l.steps).map((p) => `${p.x},${p.y}`)).size).toBe(ids.length);
  });

  it("sin entrada, todo es inalcanzable pero se acomoda igual", () => {
    const l = autoLayout(["a", "b"], [], null);
    expect(Object.keys(l.steps)).toEqual(["a", "b"]);
  });

  it("ciclos no cuelgan el recorrido", () => {
    const l = autoLayout(["a", "b"], [{ source: "a", target: "b" }, { source: "b", target: "a" }], "a");
    expect(l.steps.a!.y).toBeLessThan(l.steps.b!.y);
  });

  it("normalizeColumn deja la lista en una columna en el orden dado (lo que el Modo Simple entiende)", () => {
    expect(normalizeColumn(["z", "y"])).toEqual({ z: { x: 0, y: 0 }, y: { x: 0, y: 100 } });
  });
});
