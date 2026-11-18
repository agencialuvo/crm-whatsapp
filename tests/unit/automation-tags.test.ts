import { describe, expect, it, vi } from "vitest";
import {
  addTagConfigSchema,
  compileLinearEdges,
  conditionConfigSchema,
  conditionHandle,
  evaluateCondition,
  setStageConfigSchema,
  type ConditionFacts,
} from "@/lib/automation";
import { STEP_TYPES, parseStepConfig, stepCreateSchema } from "@/lib/automation-schemas";
import { describeRule, describeStep } from "@/lib/automation-dto";
import { TAG_COLORS, tagAssignSchema, tagCreateSchema, tagKey, tagPatchSchema } from "@/lib/tags";
import { processRow, type Deps, type Row, type Step } from "@/server/automation/engine";

/**
 * Fase 2: etiquetas, acciones de CRM y condición. Reglas puras (evaluador, esquemas, textos) y los
 * ejecutores del motor con dobles — sin base de datos ni red. Lo que toca Postgres vive en
 * `automation-tags-live.test.ts`.
 */

const facts = (over: Partial<ConditionFacts> = {}): ConditionFacts => ({
  tagIds: ["tag_vip"],
  stageId: "stg_citado",
  booking: null,
  ...over,
});

describe("evaluateCondition", () => {
  it("tag_has / tag_missing", () => {
    expect(evaluateCondition({ type: "tag_has", tagId: "tag_vip" }, facts())).toEqual({ result: true });
    expect(evaluateCondition({ type: "tag_has", tagId: "tag_otra" }, facts())).toEqual({ result: false });
    expect(evaluateCondition({ type: "tag_missing", tagId: "tag_otra" }, facts())).toEqual({ result: true });
    expect(evaluateCondition({ type: "tag_missing", tagId: "tag_vip" }, facts())).toEqual({ result: false });
    // Sin etiquetas, «no tiene» es verdadero.
    expect(evaluateCondition({ type: "tag_missing", tagId: "tag_vip" }, facts({ tagIds: [] }))).toEqual({ result: true });
  });

  it("stage_is compara por id, y un lead sin etapa nunca coincide", () => {
    expect(evaluateCondition({ type: "stage_is", stageId: "stg_citado" }, facts())).toEqual({ result: true });
    expect(evaluateCondition({ type: "stage_is", stageId: "stg_nuevo" }, facts())).toEqual({ result: false });
    expect(evaluateCondition({ type: "stage_is", stageId: "stg_citado" }, facts({ stageId: null }))).toEqual({ result: false });
  });

  it("booking_confirmed mira confirmed_at de la cita en contexto; sin cita es falso", () => {
    const rule = { type: "booking_confirmed" } as const;
    expect(evaluateCondition(rule, facts({ booking: { confirmedAt: new Date() } })).result).toBe(true);
    expect(evaluateCondition(rule, facts({ booking: { confirmedAt: null } })).result).toBe(false);
    expect(evaluateCondition(rule, facts({ booking: {} })).result).toBe(false);
    expect(evaluateCondition(rule, facts({ booking: null })).result).toBe(false);
  });
});

describe("ramas del modo simple (resultado → asa → arista)", () => {
  it("por defecto: si se cumple sigue; si no, termina", () => {
    const cfg = conditionConfigSchema.parse({ rule: { type: "booking_confirmed" } });
    expect(cfg).toMatchObject({ ifTrue: "continue", ifFalse: "stop" });
    expect(conditionHandle({ result: true })).toBe("true");
    expect(conditionHandle({ result: false })).toBe("false");
    // Compilado: «true» lleva al siguiente; «false» no tiene arista (termina).
    const edges = compileLinearEdges([
      { id: "c", stepType: "condition", config: cfg },
      { id: "n", stepType: "add_tag", config: {} },
    ]);
    expect(edges).toEqual([{ sourceStepId: "c", targetStepId: "n", sourceHandle: "true" }]);
  });

  it("las ramas son independientes (skip en verdadero, continuar en falso)", () => {
    const cfg = conditionConfigSchema.parse({ rule: { type: "tag_has", tagId: "t" }, ifTrue: "skip_next", ifFalse: "continue" });
    const edges = compileLinearEdges([
      { id: "c", stepType: "condition", config: cfg },
      { id: "a", stepType: "add_tag", config: {} },
      { id: "b", stepType: "add_tag", config: {} },
    ]);
    expect(edges).toContainEqual({ sourceStepId: "c", targetStepId: "b", sourceHandle: "true" });
    expect(edges).toContainEqual({ sourceStepId: "c", targetStepId: "a", sourceHandle: "false" });
  });
});

describe("esquemas de los pasos nuevos", () => {
  it("add_tag / remove_tag / set_stage exigen su id", () => {
    expect(addTagConfigSchema.safeParse({}).success).toBe(false);
    expect(addTagConfigSchema.safeParse({ tagId: "  " }).success).toBe(false);
    expect(addTagConfigSchema.safeParse({ tagId: "tag_1" }).success).toBe(true);
    expect(setStageConfigSchema.safeParse({}).success).toBe(false);
    expect(setStageConfigSchema.safeParse({ stageId: "stg_1" }).success).toBe(true);
  });

  it("condition valida la regla por tipo", () => {
    for (const rule of [{ type: "tag_has" }, { type: "tag_missing", tagId: "" }, { type: "stage_is" }, { type: "otra" }]) {
      expect(conditionConfigSchema.safeParse({ rule }).success).toBe(false);
    }
    expect(conditionConfigSchema.safeParse({ rule: { type: "booking_confirmed" } }).success).toBe(true);
    expect(conditionConfigSchema.safeParse({ rule: { type: "stage_is", stageId: "stg_1" }, ifTrue: "salta" }).success).toBe(false);
  });

  it("la API acepta los pasos nuevos y parseStepConfig los cubre todos", () => {
    expect(STEP_TYPES).toEqual(expect.arrayContaining(["add_tag", "remove_tag", "set_stage", "condition"]));
    const ok = stepCreateSchema.safeParse({ stepType: "set_stage", config: { stageId: "stg_1" } });
    expect(ok.success).toBe(true);
    // Todos exigen algo, salvo «Esperar respuesta»: todo en ella tiene valor por defecto (7 días, solo «confirmó» sigue).
    for (const t of STEP_TYPES.filter((x) => x !== "wait_reply")) expect(parseStepConfig(t, {}).ok).toBe(false);
    expect(parseStepConfig("wait_reply", {}).ok).toBe(true);
    expect(parseStepConfig("add_tag", { tagId: "tag_1" })).toEqual({ ok: true, value: { tagId: "tag_1" } });
    const bad = parseStepConfig("condition", { rule: { type: "tag_has" } });
    expect(bad.ok).toBe(false);
  });
});

describe("contratos de etiqueta", () => {
  it("nombre recortado, con tope, y color de la paleta", () => {
    expect(tagCreateSchema.parse({ name: "  VIP  " })).toEqual({ name: "VIP", color: "slate" });
    expect(tagCreateSchema.safeParse({ name: "" }).success).toBe(false);
    expect(tagCreateSchema.safeParse({ name: "x".repeat(41) }).success).toBe(false);
    expect(tagCreateSchema.safeParse({ name: "VIP", color: "#ff0000" }).success).toBe(false);
    for (const color of TAG_COLORS) expect(tagCreateSchema.safeParse({ name: "a", color }).success).toBe(true);
    expect(tagPatchSchema.safeParse({}).success).toBe(false);
  });
  it("asignar: una existente o una nueva, no mezcladas", () => {
    expect(tagAssignSchema.safeParse({ tagId: "tag_1" }).success).toBe(true);
    expect(tagAssignSchema.safeParse({ name: "Nueva" }).success).toBe(true);
    expect(tagAssignSchema.safeParse({ tagId: "tag_1", name: "Nueva" }).success).toBe(false);
    expect(tagAssignSchema.safeParse({}).success).toBe(false);
  });
  it("tagKey ignora mayúsculas y espacios", () => {
    expect(tagKey("  VIP ")).toBe(tagKey("vip"));
    expect(tagKey("Cita Pendiente")).not.toBe(tagKey("Cita"));
  });
});

describe("textos de las tarjetas", () => {
  const refs = { tags: [{ id: "tag_vip", name: "VIP", color: "blue" }], stages: [{ id: "stg_1", name: "Citado" }] };
  it("resuelven nombres por id y avisan si ya no existen", () => {
    expect(describeStep({ stepType: "add_tag", config: { tagId: "tag_vip" } }, [], refs).title).toBe("Agregar etiqueta «VIP»");
    expect(describeStep({ stepType: "remove_tag", config: { tagId: "tag_vip" } }, [], refs).title).toBe("Quitar etiqueta «VIP»");
    expect(describeStep({ stepType: "add_tag", config: { tagId: "borrada" } }, [], refs).title).toContain("ya no existe");
    expect(describeStep({ stepType: "set_stage", config: { stageId: "stg_1" } }, [], refs).title).toBe("Mover a la etapa «Citado»");
    expect(describeStep({ stepType: "set_stage", config: { stageId: "stg_1" } }, [], refs).detail).toContain("No dispara");
  });
  it("la condición dice la regla y las dos ramas", () => {
    const d = describeStep(
      { stepType: "condition", config: { rule: { type: "tag_has", tagId: "tag_vip" }, ifTrue: "skip_next", ifFalse: "stop" } },
      [],
      refs
    );
    expect(d.title).toBe("Si: El contacto tiene la etiqueta «VIP»");
    expect(d.detail).toBe("Sí → omitir el siguiente paso y continuar · No → terminar el flujo");
    expect(describeRule({ type: "booking_confirmed" })).toBe("La cita está confirmada");
    expect(describeRule({ type: "stage_is", stageId: "x" }, refs)).toContain("que ya no existe");
  });
});

/* ─── Motor ─── */

const NOW = new Date("2026-11-14T15:00:00Z");
const baseRow: Row = {
  id: "que_1",
  organizationId: "org_1",
  flowId: "aut_1",
  contactId: "ct_1",
  stepId: "stp_1",
  attempts: 1,
  maxAttempts: 5,
  bookingId: null,
};

function setup(
  step: Pick<Step, "stepType" | "config">,
  over: {
    facts?: { tagIds: string[]; stageId: string | null };
    booking?: { status: string; scheduledAt: Date; confirmedAt?: Date | null } | null;
    trigger?: string;
    row?: Partial<Row>;
    applyTag?: Deps["applyTag"];
    moveContactToStage?: Deps["moveContactToStage"];
  } = {}
) {
  const logs: { status: string; metadata: Record<string, unknown> }[] = [];
  const deps = {
    now: () => NOW,
    loadStep: vi.fn(async () => ({ id: "stp_1", flowId: "aut_1", ...step })),
    isFlowActive: vi.fn(async () => true),
    loadBooking: vi.fn(async () => over.booking ?? null),
    flowTriggerType: vi.fn(async () => over.trigger ?? "lead_created"),
    timezone: vi.fn(async () => "UTC"),
    contactFacts: vi.fn(async () => over.facts ?? { tagIds: [], stageId: null }),
    sendMedia: vi.fn(async () => ({ messageId: "msg_media" })),
    loadMedia: vi.fn(async () => ({ ok: true as const, bytes: 1, mimeType: "image/png", fileName: "a.png" })),
    isOptedOut: vi.fn(async () => false),
    recentAutomaticSends: vi.fn(async () => [] as Date[]),
    defer: vi.fn(async () => {}),
    applyTag: vi.fn(over.applyTag ?? (async () => "added" as const)),
    moveContactToStage: vi.fn(
      over.moveContactToStage ??
        (async (_o: string, _c: string, stageId: string) => ({ status: "moved" as const, toStageId: stageId, fromStageId: "stg_0" }))
    ),
    loadTarget: vi.fn(async () => null),
    templateStatus: vi.fn(async () => null),
    sendText: vi.fn(async () => ({ messageId: "m" })),
    sendTemplate: vi.fn(async () => ({ messageId: "m" })),
    waMessageIdOf: vi.fn(async () => null),
    hasSuccessLog: vi.fn(async () => false),
    writeLog: vi.fn(async (e: { status: string; metadata: Record<string, unknown> }) => void logs.push(e)),
    completeAndAdvance: vi.fn(async () => null),
    markFailed: vi.fn(async () => undefined),
    markCancelled: vi.fn(async () => undefined),
    reschedule: vi.fn(async () => undefined),
  } satisfies Deps;
  const row = { ...baseRow, ...over.row };
  return { deps, logs, row, run: () => processRow(row, deps) };
}

describe("motor — add_tag / remove_tag", () => {
  it("asigna, registra y avanza sin tocar el chat", async () => {
    const t = setup({ stepType: "add_tag", config: { tagId: "tag_1" } });
    expect(await t.run()).toBe("completed");
    expect(t.deps.applyTag).toHaveBeenCalledWith("org_1", "ct_1", "tag_1", "add");
    expect(t.deps.sendText).not.toHaveBeenCalled();
    expect(t.deps.loadTarget).not.toHaveBeenCalled();
    expect(t.logs[0]).toMatchObject({ status: "success", metadata: { tagId: "tag_1", result: "added" } });
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, NOW);
  });

  it("remove_tag usa el modo quitar; si ya no la tenía, avanza igual (idempotente)", async () => {
    const t = setup({ stepType: "remove_tag", config: { tagId: "tag_1" } }, { applyTag: async () => "unchanged" });
    expect(await t.run()).toBe("completed");
    expect(t.deps.applyTag).toHaveBeenCalledWith("org_1", "ct_1", "tag_1", "remove");
    expect(t.logs[0]!.metadata.result).toBe("unchanged");
  });

  it("una etiqueta borrada falla a la vista, sin avanzar", async () => {
    const t = setup({ stepType: "add_tag", config: { tagId: "tag_1" } }, { applyTag: async () => "tag_not_found" });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "tag_not_found");
    expect(t.deps.completeAndAdvance).not.toHaveBeenCalled();
    expect(t.logs[0]).toMatchObject({ status: "failed" });
  });

  it("una configuración inválida falla a la vista", async () => {
    const t = setup({ stepType: "add_tag", config: {} });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "invalid_step_config");
    expect(t.deps.applyTag).not.toHaveBeenCalled();
  });
});

describe("motor — set_stage", () => {
  it("mueve por stageId y deja constancia de que lo hizo la automatización", async () => {
    const t = setup({ stepType: "set_stage", config: { stageId: "stg_9" } });
    expect(await t.run()).toBe("completed");
    expect(t.deps.moveContactToStage).toHaveBeenCalledWith("org_1", "ct_1", "stg_9");
    expect(t.logs[0]!.metadata).toMatchObject({ stageId: "stg_9", fromStageId: "stg_0", result: "moved", triggeredByAutomation: true });
  });

  it("si ya estaba en la etapa, avanza (sin cambio)", async () => {
    const t = setup(
      { stepType: "set_stage", config: { stageId: "stg_9" } },
      { moveContactToStage: async () => ({ status: "unchanged", toStageId: "stg_9", fromStageId: "stg_9" }) }
    );
    expect(await t.run()).toBe("completed");
    expect(t.logs[0]!.metadata.result).toBe("unchanged");
  });

  it.each(["stage_not_found", "contact_has_no_lead"] as const)("%s falla a la vista", async (status) => {
    const t = setup({ stepType: "set_stage", config: { stageId: "stg_9" } }, { moveContactToStage: async () => ({ status }) });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, status);
    expect(t.deps.completeAndAdvance).not.toHaveBeenCalled();
  });
});

describe("motor — condition", () => {
  const cond = (config: Record<string, unknown>) => ({ stepType: "condition", config });

  it("verdadero con las acciones por defecto: continúa", async () => {
    const t = setup(cond({ rule: { type: "tag_has", tagId: "tag_1" } }), { facts: { tagIds: ["tag_1"], stageId: null } });
    expect(await t.run()).toBe("completed");
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, NOW, { handle: "true" });
    expect(t.logs[0]!.metadata).toMatchObject({ result: true, branch: "true", handle: "true" });
  });

  it("falso: sale por el asa «false» (con las acciones por defecto no hay arista y el flujo termina)", async () => {
    const t = setup(cond({ rule: { type: "tag_has", tagId: "tag_1" } }));
    expect(await t.run()).toBe("completed");
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, NOW, { handle: "false" });
    expect(t.logs[0]!.metadata).toMatchObject({ result: false, branch: "false", handle: "false" });
  });

  it("el motor ya no lee ifTrue/ifFalse: solo elige el asa", async () => {
    const t = setup(cond({ rule: { type: "tag_missing", tagId: "tag_1" }, ifTrue: "skip_next" }));
    expect(await t.run()).toBe("completed");
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, NOW, { handle: "true" });
  });

  it("stage_is lee la etapa de ahora", async () => {
    const t = setup(cond({ rule: { type: "stage_is", stageId: "stg_2" } }), { facts: { tagIds: [], stageId: "stg_2" } });
    await t.run();
    expect(t.logs[0]!.metadata.result).toBe(true);
  });

  it("booking_confirmed lee confirmed_at de la cita de la tarea", async () => {
    const booking = { status: "agendada", scheduledAt: new Date(NOW.getTime() + 86_400_000), confirmedAt: new Date() };
    const yes = setup(cond({ rule: { type: "booking_confirmed" } }), { booking, trigger: "booking_created", row: { bookingId: "bk_1" } });
    await yes.run();
    expect(yes.logs[0]!.metadata.result).toBe(true);

    const no = setup(cond({ rule: { type: "booking_confirmed" } }), {
      booking: { ...booking, confirmedAt: null },
      trigger: "booking_created",
      row: { bookingId: "bk_1" },
    });
    await no.run();
    expect(no.logs[0]!.metadata.result).toBe(false);
  });

  it("la vigencia de la cita corta ANTES de evaluar (no resucita una cita cancelada)", async () => {
    const t = setup(cond({ rule: { type: "booking_confirmed" } }), {
      booking: { status: "cancelada", scheduledAt: new Date(NOW.getTime() + 3_600_000) },
      trigger: "booking_created",
      row: { bookingId: "bk_1" },
    });
    expect(await t.run()).toBe("cancelled");
    expect(t.deps.contactFacts).not.toHaveBeenCalled();
  });

  it("una configuración inválida falla a la vista", async () => {
    const t = setup(cond({ rule: { type: "tag_has" } }));
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "invalid_step_config");
  });
});
