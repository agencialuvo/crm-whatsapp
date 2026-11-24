import { describe, expect, it, vi } from "vitest";
import {
  CODE_JS_MAX_PER_FLOW,
  VARS_MAX_BYTES,
  VARS_MAX_KEYS,
  VAR_VALUE_MAX_CHARS,
  caseHandle,
  codeJsConfigSchema,
  conditionRuleSchema,
  evaluateCondition,
  evaluateSwitch,
  isCaseHandle,
  isEdgeHandle,
  mergeVars,
  readVars,
  renderVars,
  sanitizeVarValue,
  setVarConfigSchema,
  switchConfigSchema,
  type ConditionFacts,
  type SwitchCase,
} from "@/lib/automation";
import { STEP_TYPES, stepCreateSchema } from "@/lib/automation-schemas";
import { graphEdgeSchema, handlesOf, toLinear, validateGraph } from "@/lib/automation-graph";
import { PALETTE, canInsertOnEdge, defaultConfigFor, edgeLabelOf, outputsOf } from "@/lib/automation-canvas";
import { describeStep } from "@/lib/automation-dto";
import { assertStepAllowed } from "@/server/automation/flows";
import { classifyError, processRow, type Deps, type LogInput, type Row, type Step, type Target } from "@/server/automation/engine";
import { CODE_SANDBOX_LIMITS, runSandboxedCode } from "@/server/automation/sandbox";
import { codeJsEnabled } from "@/server/automation/flag";

/**
 * Paso 3 (sin base de datos): memoria entre nodos (`context.vars`), Switch, y el bloque de código con su sandbox real
 * (QuickJS/WASM: aquí SÍ se ejecuta el intérprete, no un doble).
 */

const NOW = new Date("2026-11-08T12:00:00.000Z");

/* ─── Variables ─── */

describe("variables de la ejecución", () => {
  it("sanitiza a escalares seguros: sin saltos ni caracteres de control, con tope", () => {
    expect(sanitizeVarValue("a\nb\u0000c")).toBe("a b c");
    expect(sanitizeVarValue("  hola  ")).toBe("hola");
    expect(sanitizeVarValue("x".repeat(VAR_VALUE_MAX_CHARS + 50))).toHaveLength(VAR_VALUE_MAX_CHARS);
    expect(sanitizeVarValue(5)).toBe(5);
    expect(sanitizeVarValue(true)).toBe(true);
    for (const bad of [Number.NaN, Infinity, {}, [], undefined, null, () => 1]) expect(sanitizeVarValue(bad)).toBeUndefined();
  });

  it("readVars solo lee context.vars y descarta lo corrupto", () => {
    expect(readVars({ bookingId: "b1", vars: { plan: "pro", n: 3, ok: true } })).toEqual({ plan: "pro", n: 3, ok: true });
    expect(readVars({ vars: { Mala: "x", "1x": "y", ok: "z", obj: { a: 1 }, nul: null } })).toEqual({ ok: "z" });
    for (const ctx of [null, undefined, {}, { vars: null }, { vars: [1, 2] }, { vars: "x" }, "x"]) expect(readVars(ctx)).toEqual({});
  });

  it("mergeVars funde sin tocar lo demás, borra con null y no muta la entrada", () => {
    const cur = { a: "1", b: "2" };
    const r = mergeVars(cur, { b: "dos", c: 3, a: null });
    expect(r).toEqual({ ok: true, vars: { b: "dos", c: 3 } });
    expect(cur).toEqual({ a: "1", b: "2" });
  });

  it("mergeVars rechaza claves y valores no válidos, y respeta los topes", () => {
    expect(mergeVars({}, { "Mala-Clave": "x" })).toMatchObject({ ok: false, code: "vars_invalid" });
    expect(mergeVars({}, { ok: { a: 1 } })).toMatchObject({ ok: false, code: "vars_invalid" });
    const many = Object.fromEntries(Array.from({ length: VARS_MAX_KEYS + 1 }, (_, i) => [`k${i}`, "x"]));
    expect(mergeVars({}, many)).toMatchObject({ ok: false, code: "vars_limit" });
    const fat = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, "y".repeat(VAR_VALUE_MAX_CHARS)]));
    expect(JSON.stringify(fat).length).toBeGreaterThan(VARS_MAX_BYTES);
    expect(mergeVars({}, fat)).toMatchObject({ ok: false, code: "vars_limit" });
  });

  it("renderVars lee {{vars.clave}}: vacío si no existe, sin fallar", () => {
    const vars = { plan: "Pro", puntos: 12, vip: true };
    expect(renderVars("Plan {{vars.plan}} · {{ vars.puntos }} pts · {{vars.vip}}", { name: "Ana", vars })).toBe("Plan Pro · 12 pts · true");
    expect(renderVars("Hola {{vars.nada}}!", { name: "Ana", vars })).toBe("Hola !");
    expect(renderVars("Hola {{vars.nada}}!", { name: "Ana" })).toBe("Hola !");
    expect(renderVars("{{vars.Mala-Clave}}", { name: null, vars })).toBe("");
    // Lo que no se reconoce se deja tal cual (como siempre); lo de siempre sigue igual.
    expect(renderVars("{{otra}} {{name}} {{fecha}}", { name: "Ana", fecha: "hoy" })).toBe("{{otra}} Ana hoy");
  });

  it("renderVars no vuelve a interpretar un valor insertado (un {{…}} dentro de un dato no se expande)", () => {
    expect(renderVars("A {{vars.x}} B", { name: "Ana", vars: { x: "{{name}}" } })).toBe("A {{name}} B");
    expect(renderVars("Hola {{name}}", { name: "{{vars.secreto}}", vars: { secreto: "S" } })).toBe("Hola {{vars.secreto}}");
  });

  it("set_var: clave en minúsculas, valor con tope", () => {
    expect(setVarConfigSchema.parse({ key: " Plan ", value: "x" })).toEqual({ key: "plan", value: "x" });
    expect(setVarConfigSchema.safeParse({ key: "1plan", value: "x" }).success).toBe(false);
    expect(setVarConfigSchema.safeParse({ key: "a-b", value: "x" }).success).toBe(false);
    expect(setVarConfigSchema.safeParse({ key: "k", value: "x".repeat(VAR_VALUE_MAX_CHARS + 1) }).success).toBe(false);
    expect(setVarConfigSchema.safeParse({ key: "k", value: "" }).success).toBe(true);
  });
});

/* ─── Reglas y Switch ─── */

const facts = (over: Partial<ConditionFacts> = {}): ConditionFacts => ({ tagIds: [], stageId: null, booking: null, ...over });

describe("var_equals y Switch", () => {
  it("var_equals compara texto contra texto; sin definir es vacío", () => {
    const rule = { type: "var_equals" as const, key: "plan", value: "pro" };
    expect(evaluateCondition(rule, facts({ vars: { plan: "pro" } })).result).toBe(true);
    expect(evaluateCondition(rule, facts({ vars: { plan: "free" } })).result).toBe(false);
    expect(evaluateCondition({ type: "var_equals", key: "n", value: "5" }, facts({ vars: { n: 5 } })).result).toBe(true);
    expect(evaluateCondition({ type: "var_equals", key: "n", value: "" }, facts()).result).toBe(true);
    expect(conditionRuleSchema.safeParse({ type: "var_equals", key: "Plan!", value: "x" }).success).toBe(false);
  });

  const cases: SwitchCase[] = [
    { id: "vip", label: "VIP", rule: { type: "tag_has", tagId: "t_vip" } },
    { id: "pro", label: "Pro", rule: { type: "var_equals", key: "plan", value: "pro" } },
  ];

  it("evalúa en orden: gana el primero que se cumple; si ninguno, `default`", () => {
    expect(evaluateSwitch(cases, facts({ tagIds: ["t_vip"], vars: { plan: "pro" } }))).toEqual({ handle: "case_vip", caseId: "vip" });
    expect(evaluateSwitch(cases, facts({ vars: { plan: "pro" } }))).toEqual({ handle: "case_pro", caseId: "pro" });
    expect(evaluateSwitch(cases, facts())).toEqual({ handle: "default", caseId: null });
  });

  it("la configuración exige 1 a 8 casos con ids únicos", () => {
    const ok = { cases: [{ id: "a1", label: "A", rule: { type: "birthday_today" } }] };
    expect(switchConfigSchema.safeParse(ok).success).toBe(true);
    expect(switchConfigSchema.safeParse({ cases: [] }).success).toBe(false);
    expect(switchConfigSchema.safeParse({ cases: [ok.cases[0], ok.cases[0]] }).success).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, label: `C${i}`, rule: { type: "birthday_today" } }));
    expect(switchConfigSchema.safeParse({ cases: nine }).success).toBe(false);
    expect(switchConfigSchema.safeParse({ cases: [{ id: "BAD ID", label: "A", rule: { type: "birthday_today" } }] }).success).toBe(false);
    expect(switchConfigSchema.safeParse({ cases: [{ id: "a1", label: "", rule: { type: "birthday_today" } }] }).success).toBe(false);
  });

  it("las asas de caso son `case_<id>` y se reconocen aparte de las estáticas", () => {
    expect(caseHandle("abc")).toBe("case_abc");
    expect(isCaseHandle("case_abc")).toBe(true);
    for (const bad of ["case_", "case_BAD", "case_a b", "caseabc", "default", `case_${"x".repeat(17)}`]) expect(isCaseHandle(bad), bad).toBe(false);
    expect(isEdgeHandle("default")).toBe(true);
    expect(isEdgeHandle("case_abc")).toBe(true);
    expect(isEdgeHandle("inventada")).toBe(false);
  });
});

/* ─── Grafo ─── */

const trig = { id: "trigger", type: "trigger", config: { triggerType: "manual", triggerConfig: null } };
const sw = (cases: string[]) => ({
  id: "sw",
  type: "switch",
  config: { cases: cases.map((id) => ({ id, label: id, rule: { type: "birthday_today" } })) },
});
const msg = (id: string) => ({ id, type: "send_whatsapp", config: { content: "Hola" } });

describe("grafo con Switch", () => {
  it("las salidas del switch salen de su configuración (una por caso + default)", () => {
    expect(handlesOf("switch", sw(["a", "b"]).config)).toEqual(["case_a", "case_b", "default"]);
    expect(handlesOf("switch", undefined)).toEqual(["default"]);
    expect(handlesOf("switch", { cases: [{ id: "a" }, { id: "a" }, { id: "BAD" }, {}] })).toEqual(["case_a", "default"]);
    // El resto de los tipos no cambia.
    expect(handlesOf("condition")).toEqual(["true", "false"]);
  });

  it("outputsOf pinta lo mismo que el servidor acepta, con el nombre de cada caso", () => {
    const config = sw(["a", "b"]).config;
    expect(outputsOf("switch", config).map((o) => o.id)).toEqual(handlesOf("switch", config));
    expect(outputsOf("switch", config).map((o) => o.label)).toEqual(["a", "b", "Otro"]);
    expect(edgeLabelOf("case_a", "switch", config)).toBe("a");
    expect(edgeLabelOf("default", "switch", config)).toBe("Otro");
    expect(edgeLabelOf("default", "send_whatsapp", {})).toBeUndefined();
    expect(edgeLabelOf("true", "condition", {})).toBe("Sí");
  });

  it("validateGraph acepta las aristas de caso y rechaza las huérfanas (caso quitado o renombrado)", () => {
    const edges = (handle: string) => [
      { source: "trigger", target: "sw", sourceHandle: "default" },
      { source: "sw", target: "m1", sourceHandle: handle },
    ];
    const good = validateGraph({ nodes: [trig, sw(["a"]), msg("m1")], edges: edges("case_a") });
    expect(good.errors).toEqual([]);
    const orphan = validateGraph({ nodes: [trig, sw(["b"]), msg("m1")], edges: edges("case_a") });
    expect(orphan.errors.map((e) => e.code)).toContain("invalid_handle");
    const missing = validateGraph({ nodes: [trig, sw(["a"]), msg("m1")], edges: edges("case_zzz") });
    expect(missing.errors.map((e) => e.code)).toContain("invalid_handle");
  });

  it("una salida por asa: dos aristas del mismo caso es duplicate_handle", () => {
    const r = validateGraph({
      nodes: [trig, sw(["a"]), msg("m1"), msg("m2")],
      edges: [
        { source: "trigger", target: "sw", sourceHandle: "default" },
        { source: "sw", target: "m1", sourceHandle: "case_a" },
        { source: "sw", target: "m2", sourceHandle: "case_a" },
      ],
    });
    expect(r.errors.map((e) => e.code)).toContain("duplicate_handle");
  });

  it("avisa de las salidas sin conectar del switch (incluida «Otro»)", () => {
    const r = validateGraph({
      nodes: [trig, sw(["a", "b"]), msg("m1")],
      edges: [
        { source: "trigger", target: "sw", sourceHandle: "default" },
        { source: "sw", target: "m1", sourceHandle: "case_a" },
      ],
    });
    expect(r.errors).toEqual([]);
    const open = r.warnings.find((w) => w.code === "open_output");
    expect(open?.nodeIds).toEqual(["sw"]);
    expect(open?.message).toContain("«Caso»");
    expect(open?.message).toContain("«Siguiente»");
  });

  it("«La cita está confirmada» dentro de un caso exige un disparador de cita", () => {
    const withRule = { id: "sw", type: "switch", config: { cases: [{ id: "a", label: "A", rule: { type: "booking_confirmed" } }] } };
    const edges = [{ source: "trigger", target: "sw", sourceHandle: "default" }];
    expect(validateGraph({ nodes: [trig, withRule], edges }).errors.map((e) => e.code)).toContain("requires_booking");
    const bookingTrig = { ...trig, config: { triggerType: "booking_created", triggerConfig: null } };
    expect(validateGraph({ nodes: [bookingTrig, withRule], edges }).errors.map((e) => e.code)).not.toContain("requires_booking");
  });

  it("el esquema de la arista acepta case_<id> y rechaza asas inventadas", () => {
    expect(graphEdgeSchema.parse({ source: "a", target: "b", sourceHandle: "case_abc" }).sourceHandle).toBe("case_abc");
    expect(graphEdgeSchema.parse({ source: "a", target: "b" }).sourceHandle).toBe("default");
    for (const sourceHandle of ["inventada", "case_", "CASE_a", "case_a b"]) {
      expect(graphEdgeSchema.safeParse({ source: "a", target: "b", sourceHandle }).success, sourceHandle).toBe(false);
    }
  });

  it("un flujo con Switch no se puede pasar al Modo Simple (toLinear lo rechaza con el motivo)", () => {
    const r = toLinear({
      nodes: [sw(["a"]), msg("m1")].map((n) => ({ id: n.id, type: n.type, config: n.config as Record<string, unknown> })),
      edges: [{ source: "sw", target: "m1", sourceHandle: "case_a" }],
      entryStepId: "sw",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons[0]).toContain("Switch");
  });

  it("un Switch no se inserta en medio de una conexión (varias salidas)", () => {
    expect(canInsertOnEdge("switch")).toBe(false);
    expect(canInsertOnEdge("set_var")).toBe(true);
    expect(canInsertOnEdge("code_js")).toBe(true);
    expect(canInsertOnEdge("condition")).toBe(false);
  });

  it("hay un tope de bloques de código por flujo", () => {
    const code = (id: string) => ({ id, type: "code_js", config: { code: "return {};" } });
    const nodes = [trig, ...Array.from({ length: CODE_JS_MAX_PER_FLOW + 1 }, (_, i) => code(`c${i}`))];
    expect(validateGraph({ nodes, edges: [] }).errors.map((e) => e.code)).toContain("too_many_code_nodes");
    expect(validateGraph({ nodes: nodes.slice(0, CODE_JS_MAX_PER_FLOW + 0), edges: [] }).errors.map((e) => e.code)).not.toContain("too_many_code_nodes");
  });
});

describe("catálogo de bloques del Paso 3", () => {
  it("los tres tipos existen, tienen forma en la paleta y su config por defecto", () => {
    for (const t of ["set_var", "switch", "code_js"]) {
      expect(STEP_TYPES as readonly string[]).toContain(t);
      expect(PALETTE.some((i) => i.stepType === t), t).toBe(true);
    }
    expect(defaultConfigFor("switch")).toEqual({ cases: [] });
    expect(codeJsConfigSchema.safeParse(defaultConfigFor("code_js")).success).toBe(true);
    expect(stepCreateSchema.safeParse({ stepType: "set_var", config: { key: "plan", value: "pro" } }).success).toBe(true);
    expect(stepCreateSchema.safeParse({ stepType: "code_js", config: { code: "   " } }).success).toBe(false);
  });
  it("describeStep resume cada uno", () => {
    expect(describeStep({ stepType: "set_var", config: { key: "plan", value: "Pro" } }).title).toBe("Guardar «plan» = «Pro»");
    expect(describeStep({ stepType: "switch", config: sw(["a", "b"]).config }).title).toContain("2 casos");
    expect(describeStep({ stepType: "code_js", config: { code: "a\nb" } }).detail).toContain("2 líneas");
  });
  it("la bandera de plataforma del código está apagada por defecto y el Switch exige el lienzo", () => {
    const prev = process.env.AUTOMATION_CODE_JS;
    try {
      delete process.env.AUTOMATION_CODE_JS;
      expect(codeJsEnabled()).toBe(false);
      expect(() => assertStepAllowed("code_js", { canvas: true })).toThrow(/no está activado/);
      process.env.AUTOMATION_CODE_JS = "on";
      expect(codeJsEnabled()).toBe(true);
      expect(() => assertStepAllowed("code_js", { canvas: true })).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.AUTOMATION_CODE_JS;
      else process.env.AUTOMATION_CODE_JS = prev;
    }
    expect(() => assertStepAllowed("switch", { canvas: false })).toThrow(/Modo Visual/);
    expect(() => assertStepAllowed("switch", { canvas: true })).not.toThrow();
    expect(() => assertStepAllowed("set_var", { canvas: false })).not.toThrow();
  });
});

/* ─── Motor ─── */

const baseRow: Row = {
  id: "que_1",
  organizationId: "org_1",
  flowId: "aut_1",
  contactId: "ct_1",
  stepId: "stp_1",
  attempts: 1,
  maxAttempts: 5,
  bookingId: null,
  runId: "run_1",
  createdAt: new Date("2026-11-08T11:00:00.000Z"),
};

function setup(over: {
  step: Partial<Step> & Pick<Step, "stepType" | "config">;
  context?: Record<string, unknown>;
  contactFacts?: Partial<ConditionFacts>;
  runCode?: Deps["runCode"] | null;
  alreadySucceeded?: boolean;
}) {
  const logs: LogInput[] = [];
  const step: Step = { id: "stp_1", flowId: "aut_1", ...over.step };
  const target: Target = { conversationId: "cv_1", channel: "whatsapp", isTest: false, lastInboundAt: new Date(NOW.getTime() - 3_600_000), contactName: "Ana" };
  const deps = {
    now: () => NOW,
    loadStep: vi.fn(async () => step),
    isFlowActive: vi.fn(async () => true),
    loadBooking: vi.fn(async () => null),
    flowTriggerType: vi.fn(async () => "manual"),
    timezone: vi.fn(async () => "UTC"),
    runStatus: vi.fn(async () => "running"),
    runContext: vi.fn(async () => over.context ?? {}),
    contactFacts: vi.fn(async () => ({ tagIds: ["t_vip"], stageId: "st_1", ...over.contactFacts })),
    sendMedia: vi.fn(async () => ({ messageId: "m" })),
    loadMedia: vi.fn(async () => ({ ok: true as const, bytes: 1, mimeType: "image/png", fileName: "a.png" })),
    isOptedOut: vi.fn(async () => false),
    recentAutomaticSends: vi.fn(async () => [] as Date[]),
    defer: vi.fn(async () => {}),
    applyTag: vi.fn(async () => "added" as const),
    moveContactToStage: vi.fn(async (_o: string, _c: string, stageId: string) => ({ status: "moved" as const, toStageId: stageId, fromStageId: null })),
    loadTarget: vi.fn(async () => target),
    templateStatus: vi.fn(async () => null),
    sendText: vi.fn(async () => ({ messageId: "msg_1" })),
    sendTemplate: vi.fn(async () => ({ messageId: "msg_2" })),
    waMessageIdOf: vi.fn(async () => null),
    hasSuccessLog: vi.fn(async () => over.alreadySucceeded ?? false),
    writeLog: vi.fn(async (e: LogInput) => void logs.push(e)),
    completeAndAdvance: vi.fn(async () => null),
    markFailed: vi.fn(async () => undefined),
    markCancelled: vi.fn(async () => undefined),
    reschedule: vi.fn(async () => undefined),
    ...(over.runCode === null ? {} : { runCode: over.runCode ?? vi.fn(async () => ({ ok: true as const, vars: {}, durationMs: 1, outputChars: 2 })) }),
  } satisfies Deps;
  return { deps, logs, row: baseRow, run: () => processRow(baseRow, deps) };
}

describe("processRow — set_var", () => {
  it("guarda la variable junto con el avance, con {{…}} ya resuelto, y no vuelca el valor al historial", async () => {
    const t = setup({
      step: { stepType: "set_var", config: { key: "saludo", value: "Hola {{name}} ({{vars.plan}})" } },
      context: { bookingId: "bk_1", vars: { plan: "Pro" } },
    });
    expect(await t.run()).toBe("completed");
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, NOW, { vars: { saludo: "Hola Ana (Pro)" } });
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toMatchObject({ status: "success" });
    expect(t.logs[0]!.metadata).toMatchObject({ key: "saludo", valueChars: "Hola Ana (Pro)".length });
    expect(JSON.stringify(t.logs[0]!.metadata.payload ?? {})).not.toContain("Hola Ana");
    expect(t.deps.sendText).not.toHaveBeenCalled();
  });

  it("pasarse del tope de variables falla a la vista y de forma definitiva (no avanza)", async () => {
    const full = Object.fromEntries(Array.from({ length: VARS_MAX_KEYS }, (_, i) => [`k${i}`, "x"]));
    const t = setup({ step: { stepType: "set_var", config: { key: "nueva", value: "x" } }, context: { vars: full } });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "vars_limit");
    expect(t.deps.completeAndAdvance).not.toHaveBeenCalled();
    expect(t.logs[0]).toMatchObject({ status: "failed" });
  });

  it("repetirlo tras una caída vuelve a ejecutarse (no se salta por el éxito ya registrado: el dato y el avance van juntos)", async () => {
    const t = setup({ step: { stepType: "set_var", config: { key: "k", value: "v" } }, alreadySucceeded: true });
    expect(await t.run()).toBe("completed");
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, NOW, { vars: { k: "v" } });
  });

  it("sin ejecución (tarea antigua) no hay dónde guardar: falla a la vista", async () => {
    const t = setup({ step: { stepType: "set_var", config: { key: "k", value: "v" } } });
    const row = { ...t.row, runId: null };
    expect(await processRow(row, t.deps)).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(row, "set_var_requires_run");
  });

  it("una configuración inválida falla a la vista", async () => {
    const t = setup({ step: { stepType: "set_var", config: { key: "Mala Clave", value: "v" } } });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "invalid_step_config");
  });
});

describe("processRow — los mensajes leen las variables", () => {
  it("send_whatsapp resuelve {{vars.clave}} con lo que dejaron los pasos anteriores", async () => {
    const t = setup({
      step: { stepType: "send_whatsapp", config: { content: "Hola {{name}}, tu plan es {{vars.plan}}{{vars.nada}}." } },
      context: { vars: { plan: "Pro" } },
    });
    expect(await t.run()).toBe("completed");
    expect(t.deps.sendText).toHaveBeenCalledWith({ organizationId: "org_1", conversationId: "cv_1", text: "Hola Ana, tu plan es Pro." });
  });
});

describe("processRow — switch", () => {
  const config = {
    cases: [
      { id: "vip", label: "VIP", rule: { type: "tag_has", tagId: "t_vip" } },
      { id: "pro", label: "Pro", rule: { type: "var_equals", key: "plan", value: "pro" } },
    ],
  };
  it("sale por el primer caso que se cumple y lo deja en el historial", async () => {
    const t = setup({ step: { stepType: "switch", config } });
    expect(await t.run()).toBe("completed");
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, NOW, { handle: "case_vip" });
    expect(t.logs[0]!.metadata).toMatchObject({ caseId: "vip", caseLabel: "VIP", handle: "case_vip" });
  });
  it("lee las variables de la ejecución (var_equals) y, sin coincidencia, sale por default", async () => {
    const pro = setup({ step: { stepType: "switch", config }, contactFacts: { tagIds: [] }, context: { vars: { plan: "pro" } } });
    await pro.run();
    expect(pro.deps.completeAndAdvance).toHaveBeenCalledWith(pro.row, NOW, { handle: "case_pro" });
    const none = setup({ step: { stepType: "switch", config }, contactFacts: { tagIds: [] }, context: { vars: { plan: "free" } } });
    await none.run();
    expect(none.deps.completeAndAdvance).toHaveBeenCalledWith(none.row, NOW, { handle: "default" });
    expect(none.logs[0]!.metadata).toMatchObject({ caseId: null, handle: "default" });
  });
  it("no consulta el contexto si ningún caso usa variables", async () => {
    const t = setup({ step: { stepType: "switch", config: { cases: [config.cases[0]] } } });
    await t.run();
    expect(t.deps.runContext).not.toHaveBeenCalled();
  });
  it("se reevalúa tras una caída (no se salta por el éxito ya registrado)", async () => {
    const t = setup({ step: { stepType: "switch", config }, alreadySucceeded: true });
    await t.run();
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, NOW, { handle: "case_vip" });
  });
  it("una condición también puede leer variables", async () => {
    const t = setup({
      step: { stepType: "condition", config: { rule: { type: "var_equals", key: "plan", value: "pro" } } },
      context: { vars: { plan: "pro" } },
    });
    await t.run();
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, NOW, { handle: "true" });
  });
});

describe("processRow — code_js", () => {
  const step = { stepType: "code_js", config: { code: "return { vars: { x: 1 } };" } };

  it("pasa solo datos acotados (sin teléfono, sin bookingId, sin vars del disparo) y deja las variables con el avance", async () => {
    const runCode = vi.fn(async (_i: { code: string; input: unknown }) => ({ ok: true as const, vars: { x: 1, borrar: null }, durationMs: 3, outputChars: 20 }));
    const t = setup({ step, runCode, context: { bookingId: "bk_1", source: "manual", vars: { borrar: "z" } } });
    expect(await t.run()).toBe("completed");
    const arg = runCode.mock.calls[0]![0] as { code: string; input: Record<string, unknown> };
    expect(arg.code).toBe(step.config.code);
    expect(arg.input).toEqual({
      now: baseRow.createdAt!.toISOString(),
      contact: { name: "Ana", tagIds: ["t_vip"], stageId: "st_1" },
      context: { source: "manual" },
      vars: { borrar: "z" },
    });
    expect(JSON.stringify(arg.input)).not.toMatch(/phone|bk_1/);
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, NOW, { vars: { x: 1, borrar: null } });
    // Trazabilidad sin volcar valores.
    expect(t.logs[0]!.metadata).toMatchObject({ keys: ["x", "borrar"], durationMs: 3, outputChars: 20 });
    expect(JSON.stringify(t.logs[0]!.metadata.keys)).not.toContain("z");
  });

  it.each(["code_error", "code_timeout", "code_memory", "code_output_invalid", "code_input_too_large"] as const)(
    "%s es definitivo: falla a la vista, no reintenta y no avanza",
    async (code) => {
      const t = setup({ step, runCode: vi.fn(async () => ({ ok: false as const, code, message: "boom" })) });
      expect(await t.run()).toBe("failed");
      expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, code);
      expect(t.deps.reschedule).not.toHaveBeenCalled();
      expect(t.deps.completeAndAdvance).not.toHaveBeenCalled();
      expect(t.logs[0]).toMatchObject({ status: "failed" });
      expect(t.logs[0]!.metadata).toMatchObject({ error: code, detail: "boom" });
    }
  );

  it("sin sandbox cableado (o bandera apagada) falla a la vista y no ejecuta nada", async () => {
    const off = setup({ step, runCode: null });
    expect(await off.run()).toBe("failed");
    expect(off.deps.markFailed).toHaveBeenCalledWith(off.row, "code_js_disabled");
    const disabled = setup({ step, runCode: vi.fn(async () => ({ ok: false as const, code: "code_js_disabled" as const, message: "off" })) });
    expect(await disabled.run()).toBe("failed");
    expect(disabled.deps.markFailed).toHaveBeenCalledWith(disabled.row, "code_js_disabled");
  });

  it("si la salida revienta el tope de variables, falla sin avanzar", async () => {
    const big = Object.fromEntries(Array.from({ length: VARS_MAX_KEYS + 1 }, (_, i) => [`k${i}`, "x"]));
    const t = setup({ step, runCode: vi.fn(async () => ({ ok: true as const, vars: big, durationMs: 1, outputChars: 1 })) });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "vars_limit");
    expect(t.deps.completeAndAdvance).not.toHaveBeenCalled();
  });

  it("sin ejecución no hay dónde guardar: falla a la vista", async () => {
    const t = setup({ step });
    const row = { ...t.row, runId: null };
    expect(await processRow(row, t.deps)).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(row, "code_js_requires_run");
  });

  it("se vuelve a ejecutar tras una caída (puro y determinista), no se salta por el éxito registrado", async () => {
    const t = setup({ step, alreadySucceeded: true });
    await t.run();
    expect(t.deps.runCode).toHaveBeenCalledTimes(1);
  });
});

describe("classifyError — StepError", () => {
  it("un error de paso tipado (tope de variables) es definitivo; uno sin tipo se sigue reintentando", () => {
    const e = Object.assign(new Error("tope"), { name: "StepError", code: "vars_limit" });
    expect(classifyError(e)).toMatchObject({ recoverable: false, code: "vars_limit" });
    expect(classifyError(new Error("fetch failed")).recoverable).toBe(true);
  });
});

/* ─── Sandbox (QuickJS/WASM real) ─── */

const run = (code: string, input: unknown = { now: NOW.toISOString(), contact: { name: "Ana" }, context: {}, vars: {} }) =>
  runSandboxedCode({ code, input });

describe("sandbox del bloque de código", () => {
  it("ejecuta el código sobre `input` y devuelve solo { vars }", async () => {
    const r = await run(`const n = (input.contact.name || "").toUpperCase(); return { vars: { saludo: "Hola " + n, largo: n.length, ok: true, borrar: null } };`);
    expect(r).toMatchObject({ ok: true, vars: { saludo: "Hola ANA", largo: 3, ok: true, borrar: null } });
    if (r.ok) expect(r.durationMs).toBeLessThan(CODE_SANDBOX_LIMITS.timeoutMs);
  });

  it("devolver nada o null es «sin cambios»; el resultado debe ser un objeto con solo `vars`", async () => {
    expect(await run(`return;`)).toMatchObject({ ok: true, vars: {} });
    expect(await run(`return null;`)).toMatchObject({ ok: true, vars: {} });
    expect(await run(`return {};`)).toMatchObject({ ok: true, vars: {} });
    for (const body of [`return [1];`, `return 5;`, `return "x";`, `return { otra: 1 };`, `return { vars: [1] };`, `return { vars: { a: { b: 1 } } };`, `return { vars: { a: [1] } };`]) {
      expect(await run(body), body).toMatchObject({ ok: false, code: "code_output_invalid" });
    }
  });

  it("no ve process, require, fetch, módulos ni las claves del servidor", async () => {
    process.env.__TEST_SECRET_STEP3 = "no-debe-salir";
    try {
      const r = await run(
        `return { vars: { p: typeof process, r: typeof require, f: typeof fetch, m: typeof module, b: typeof Buffer, w: typeof WebAssembly, t: typeof setTimeout, g: typeof globalThis.process } };`
      );
      expect(r).toMatchObject({ ok: true, vars: { p: "undefined", r: "undefined", f: "undefined", m: "undefined", b: "undefined", t: "undefined", g: "undefined" } });
      const leak = await run(`try { return { vars: { s: String(process.env.__TEST_SECRET_STEP3) } }; } catch (e) { return { vars: { s: "bloqueado" } }; }`);
      expect(leak).toMatchObject({ ok: true, vars: { s: "bloqueado" } });
      expect(JSON.stringify(leak)).not.toContain("no-debe-salir");
    } finally {
      delete process.env.__TEST_SECRET_STEP3;
    }
  });

  it("no se escapa por el constructor de Function (el truco que rompe a node:vm)", async () => {
    const r = await run(`try { return { vars: { x: String(this.constructor.constructor("return typeof process")()) } }; } catch (e) { return { vars: { x: "error" } }; }`);
    // Dentro de QuickJS `Function` existe, pero su «globalThis» es el del intérprete: no hay `process`.
    expect(r).toMatchObject({ ok: true, vars: { x: expect.stringMatching(/^(undefined|error)$/) } });
  });

  it("un bucle infinito se corta por tiempo (no cuelga el proceso)", async () => {
    const started = Date.now();
    const r = await run(`while (true) {}`);
    expect(r).toMatchObject({ ok: false, code: "code_timeout" });
    expect(Date.now() - started).toBeLessThan(CODE_SANDBOX_LIMITS.timeoutMs + 1500);
  });

  it("el exceso de memoria falla con un código propio, sin tumbar al anfitrión", async () => {
    const r = await run(`const a = []; while (true) { a.push("x".repeat(100000)); }`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["code_memory", "code_timeout", "code_error"]).toContain(r.code);
  });

  it("la recursión sin fin falla (tope de pila) en vez de reventar", async () => {
    const r = await run(`function f() { return f() + 1; } return { vars: { x: f() } };`);
    expect(r).toMatchObject({ ok: false, code: "code_error" });
  });

  it("los errores del código (sintaxis, excepciones) son code_error con un mensaje corto", async () => {
    const syntax = await run(`return {{;`);
    expect(syntax).toMatchObject({ ok: false, code: "code_error" });
    const thrown = await run(`throw new Error("a propósito");`);
    expect(thrown).toMatchObject({ ok: false, code: "code_error" });
    if (!thrown.ok) expect(thrown.message).toContain("a propósito");
  });

  it("Date y Math.random no están disponibles: el resultado es repetible (la hora entra como input.now)", async () => {
    expect(await run(`return { vars: { x: Math.random() } };`)).toMatchObject({ ok: false, code: "code_error" });
    expect(await run(`return { vars: { x: Date.now() } };`)).toMatchObject({ ok: false, code: "code_error" });
    const a = await run(`return { vars: { hoy: input.now.slice(0, 10) } };`);
    const b = await run(`return { vars: { hoy: input.now.slice(0, 10) } };`);
    expect(a).toMatchObject({ ok: true, vars: { hoy: "2026-11-08" } });
    expect(b).toMatchObject({ ok: true, vars: { hoy: "2026-11-08" } });
  });

  it("no se pasa de los topes de entrada y de salida", async () => {
    const big = { blob: "x".repeat(CODE_SANDBOX_LIMITS.inputMaxChars) };
    expect(await run(`return {};`, big)).toMatchObject({ ok: false, code: "code_input_too_large" });
    const out = await run(`return { vars: { a: "x".repeat(${CODE_SANDBOX_LIMITS.outputMaxChars + 10}) } };`);
    expect(out).toMatchObject({ ok: false, code: "code_output_invalid" });
  });

  it("el dato de entrada no se interpreta como código (comillas y cierres en el nombre del contacto)", async () => {
    const evil = `"); throw new Error("inyectado"); //`;
    const r = await run(`return { vars: { n: input.contact.name } };`, { now: NOW.toISOString(), contact: { name: evil }, context: {}, vars: {} });
    expect(r).toMatchObject({ ok: true, vars: { n: evil } });
  });

  it("cada ejecución es independiente: nada se comparte entre una y otra", async () => {
    await run(`globalThis.__guardado = 42; return {};`);
    expect(await run(`return { vars: { x: typeof globalThis.__guardado } };`)).toMatchObject({ ok: true, vars: { x: "undefined" } });
  });

  it("un código pasado de largo se rechaza sin ejecutarse", async () => {
    expect(await run(`return {}; //${"x".repeat(5000)}`)).toMatchObject({ ok: false, code: "code_error" });
  });
});
