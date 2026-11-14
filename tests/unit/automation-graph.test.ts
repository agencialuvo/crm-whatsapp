import { describe, expect, it, vi } from "vitest";
import { EDGE_HANDLES, compileLinearEdges, conditionHandle, type CompiledEdge, type GraphStepInput } from "@/lib/automation";
import { emitAutomationEvent } from "@/server/automation/events";
import { processRow, type Deps, type Row, type Step } from "@/server/automation/engine";
import type { EnqueueInput, FlowRef, TriggerStore } from "@/server/automation/trigger-store";

/**
 * Fase 3, parte pura: la compilación de la lista lineal a aristas, el punto de entrada de eventos y lo que el
 * intérprete hace con un `run` cancelado. Sin base de datos ni red; lo que toca Postgres vive en
 * `automation-graph-live.test.ts`.
 */

const s = (id: string, stepType = "add_tag", config: Record<string, unknown> = {}): GraphStepInput => ({ id, stepType, config });
const e = (a: string, b: string, h: CompiledEdge["sourceHandle"] = "default"): CompiledEdge => ({
  sourceStepId: a,
  targetStepId: b,
  sourceHandle: h,
});

describe("compileLinearEdges", () => {
  it("sin pasos o con uno solo no hay aristas", () => {
    expect(compileLinearEdges([])).toEqual([]);
    expect(compileLinearEdges([s("a")])).toEqual([]);
  });

  it("una fila de acciones: cada paso lleva «default» al siguiente", () => {
    expect(compileLinearEdges([s("a"), s("b", "delay"), s("c", "send_whatsapp")])).toEqual([e("a", "b"), e("b", "c")]);
  });

  describe("condition", () => {
    const cond = (config: Record<string, unknown>) => s("c", "condition", config);

    it("por defecto: verdadero sigue, falso termina (sin arista y sin «default»)", () => {
      expect(compileLinearEdges([cond({}), s("n")])).toEqual([e("c", "n", "true")]);
    });

    it.each([
      ["continue", "continue", [e("c", "n", "true"), e("c", "n", "false")]],
      ["skip_next", "stop", [e("c", "m", "true")]],
      ["stop", "skip_next", [e("c", "m", "false")]],
      ["stop", "stop", []],
    ] as const)("ifTrue=%s, ifFalse=%s", (ifTrue, ifFalse, expected) => {
      // Solo las aristas que salen de la condición (n → m es una «default» ajena).
      expect(compileLinearEdges([cond({ ifTrue, ifFalse }), s("n"), s("m")]).filter((x) => x.sourceStepId === "c")).toEqual(expected);
    });

    it("skip_next en el penúltimo paso no tiene a dónde ir: termina", () => {
      expect(compileLinearEdges([cond({ ifTrue: "skip_next" }), s("n")])).toEqual([]);
    });
  });

  describe("wait_until", () => {
    const wait = (lateAction?: string) => s("w", "wait_until", lateAction ? { lateAction } : {});

    it("«default» al siguiente y «late» según lateAction (por defecto, omitir el siguiente)", () => {
      const from = (steps: GraphStepInput[]) => compileLinearEdges(steps).filter((x) => x.sourceStepId === "w");
      expect(from([wait(), s("n"), s("m")])).toEqual([e("w", "n"), e("w", "m", "late")]);
      expect(from([wait("continue"), s("n"), s("m")])).toEqual([e("w", "n"), e("w", "n", "late")]);
      expect(from([wait("stop"), s("n"), s("m")])).toEqual([e("w", "n")]);
    });
  });

  it("nunca repite (paso, asa) y es determinista", () => {
    const steps = [s("a"), s("c", "condition", { ifTrue: "continue", ifFalse: "continue" }), s("w", "wait_until"), s("x"), s("y")];
    const edges = compileLinearEdges(steps);
    const keys = edges.map((x) => `${x.sourceStepId}:${x.sourceHandle}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(compileLinearEdges(steps)).toEqual(edges);
  });

  it("una configuración rota no rompe la compilación (usa los valores por defecto)", () => {
    expect(() => compileLinearEdges([s("c", "condition", { ifTrue: 42 as never }), s("n")])).not.toThrow();
    expect(() => compileLinearEdges([{ id: "x", stepType: "condition", config: null }, s("n")])).not.toThrow();
  });
});

describe("asas", () => {
  it("el catálogo incluye las nueve asas y la condición mapea a true/false", () => {
    expect(EDGE_HANDLES).toEqual(["default", "true", "false", "late", "timeout", "confirmed", "declined", "reschedule", "other"]);
    expect(conditionHandle({ result: true })).toBe("true");
    expect(conditionHandle({ result: false })).toBe("false");
  });
});

/* ─── emitAutomationEvent ─── */

function fakeStore(over: { flows?: FlowRef[]; realChat?: boolean; started?: (i: EnqueueInput) => boolean } = {}) {
  const calls: EnqueueInput[] = [];
  const store = {
    activeFlows: vi.fn(async () => over.flows ?? []),
    hasRealConversation: vi.fn(async () => over.realChat ?? true),
    enqueueFirstStep: vi.fn(async (i: EnqueueInput) => {
      calls.push(i);
      return over.started ? over.started(i) : true;
    }),
  } as unknown as TriggerStore;
  return { store, calls };
}
const flow = (id: string, triggerConfig: unknown = null): FlowRef => ({ id, organizationId: "org_1", triggerConfig });
const NOW = new Date("2026-11-14T15:00:00Z");
const base = { organizationId: "org_1", trigger: "lead_created", contactId: "ct_1", dedupeKey: "lead_created:ld_1" } as const;

describe("emitAutomationEvent", () => {
  it("sin flujos activos no hace nada (ni mira el chat)", async () => {
    const t = fakeStore();
    expect(await emitAutomationEvent(base, t.store, () => NOW)).toBe(0);
    expect(t.store.hasRealConversation).not.toHaveBeenCalled();
  });

  it("sin chat real no arranca nada", async () => {
    const t = fakeStore({ flows: [flow("aut_1")], realChat: false });
    expect(await emitAutomationEvent(base, t.store, () => NOW)).toBe(0);
    expect(t.calls).toHaveLength(0);
  });

  it("arranca una ejecución por flujo, con la llave, la hora y la cita del evento", async () => {
    const t = fakeStore({ flows: [flow("aut_1"), flow("aut_2")] });
    const n = await emitAutomationEvent({ ...base, trigger: "booking_created", bookingId: "bk_1" }, t.store, () => NOW);
    expect(n).toBe(2);
    expect(t.calls).toEqual([
      { organizationId: "org_1", flowId: "aut_1", contactId: "ct_1", scheduledFor: NOW, dedupeKey: "lead_created:ld_1", bookingId: "bk_1" },
      { organizationId: "org_1", flowId: "aut_2", contactId: "ct_1", scheduledFor: NOW, dedupeKey: "lead_created:ld_1", bookingId: "bk_1" },
    ]);
    expect(t.store.activeFlows).toHaveBeenCalledWith("org_1", "booking_created");
  });

  it("`matches` acota los flujos y `scheduledFor` manda sobre «ahora»", async () => {
    const at = new Date("2026-11-15T10:00:00Z");
    const t = fakeStore({ flows: [flow("aut_1", { toStageId: "x" }), flow("aut_2", { toStageId: "y" })] });
    const n = await emitAutomationEvent(
      { ...base, trigger: "stage_changed", scheduledFor: at, matches: (f) => (f.triggerConfig as { toStageId: string }).toStageId === "y" },
      t.store,
      () => NOW
    );
    expect(n).toBe(1);
    expect(t.calls[0]).toMatchObject({ flowId: "aut_2", scheduledFor: at });
    expect(t.calls[0]).not.toHaveProperty("bookingId");
  });

  it("solo cuenta las ejecuciones nuevas: un evento repetido (llave ya usada) no suma", async () => {
    const t = fakeStore({ flows: [flow("aut_1"), flow("aut_2")], started: (i) => i.flowId === "aut_2" });
    expect(await emitAutomationEvent(base, t.store, () => NOW)).toBe(1);
  });
});

/* ─── Intérprete: run cancelado en vuelo ─── */

const baseRow: Row = {
  id: "que_1",
  organizationId: "org_1",
  flowId: "aut_1",
  contactId: "ct_1",
  stepId: "stp_1",
  attempts: 1,
  maxAttempts: 5,
  bookingId: null,
  runId: "arn_1",
};

function engineSetup(step: Pick<Step, "stepType" | "config">, over: { runStatus?: Deps["runStatus"]; success?: boolean } = {}) {
  const deps = {
    now: () => NOW,
    loadStep: vi.fn(async () => ({ id: "stp_1", flowId: "aut_1", ...step })),
    isFlowActive: vi.fn(async () => true),
    loadBooking: vi.fn(async () => null),
    flowTriggerType: vi.fn(async () => "lead_created"),
    timezone: vi.fn(async () => "UTC"),
    contactFacts: vi.fn(async () => ({ tagIds: [] as string[], stageId: null as string | null })),
    applyTag: vi.fn(async () => "added" as const),
    moveContactToStage: vi.fn(async (_o: string, _c: string, stageId: string) => ({
      status: "moved" as const,
      toStageId: stageId,
      fromStageId: null as string | null,
    })),
    loadTarget: vi.fn(async () => null),
    templateStatus: vi.fn(async () => null),
    sendText: vi.fn(async () => ({ messageId: "m" })),
    sendTemplate: vi.fn(async () => ({ messageId: "m" })),
    waMessageIdOf: vi.fn(async () => null),
    hasSuccessLog: vi.fn(async () => over.success ?? false),
    writeLog: vi.fn(async () => undefined),
    completeAndAdvance: vi.fn(async () => null),
    markFailed: vi.fn(async () => undefined),
    markCancelled: vi.fn(async () => undefined),
    reschedule: vi.fn(async () => undefined),
    ...(over.runStatus ? { runStatus: vi.fn(over.runStatus) } : {}),
  } satisfies Deps;
  return { deps, run: () => processRow(baseRow, deps) };
}

describe("intérprete — la ejecución manda", () => {
  const TAG = { stepType: "add_tag", config: { tagId: "tag_1" } };

  it.each(["cancelled", "failed", "completed", null])("un run %s cancela la tarea en vuelo sin ejecutar su paso", async (status) => {
    const t = engineSetup(TAG, { runStatus: async () => status });
    expect(await t.run()).toBe("cancelled");
    expect(t.deps.markCancelled).toHaveBeenCalledWith(baseRow, "run_cancelled");
    expect(t.deps.applyTag).not.toHaveBeenCalled();
    expect(t.deps.completeAndAdvance).not.toHaveBeenCalled();
  });

  it.each(["running", "waiting"])("un run %s sigue su camino", async (status) => {
    const t = engineSetup(TAG, { runStatus: async () => status });
    expect(await t.run()).toBe("completed");
    expect(t.deps.applyTag).toHaveBeenCalled();
  });

  it("una tarea sin run (anterior a esta fase) no consulta nada y termina igual", async () => {
    const t = engineSetup(TAG, { runStatus: async () => "cancelled" });
    const row = { ...baseRow, runId: null };
    expect(await processRow(row, t.deps)).toBe("completed");
    expect(t.deps.runStatus).not.toHaveBeenCalled();
  });

  it("una acción ya registrada con éxito se cierra sin repetirse; una condición se vuelve a evaluar (su asa no se guardó)", async () => {
    const action = engineSetup(TAG, { success: true });
    expect(await action.run()).toBe("completed");
    expect(action.deps.applyTag).not.toHaveBeenCalled();
    expect(action.deps.completeAndAdvance).toHaveBeenCalledWith(baseRow, NOW);

    const cond = engineSetup({ stepType: "condition", config: { rule: { type: "tag_has", tagId: "tag_1" } } }, { success: true });
    expect(await cond.run()).toBe("completed");
    expect(cond.deps.contactFacts).toHaveBeenCalled();
    expect(cond.deps.completeAndAdvance).toHaveBeenCalledWith(baseRow, NOW, { handle: "false" });
  });
});
