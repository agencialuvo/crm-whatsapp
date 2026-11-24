import { describe, expect, it, vi } from "vitest";
import {
  loyaltyFlowMatches,
  loyaltyRewardDedupeKey,
  manualBatchIdSchema,
  manualDedupeKey,
  manualOriginOf,
  manualRunContext,
  parseTriggerConfig,
  tagAddedDedupeKey,
  tagFlowMatches,
} from "@/lib/automation";
import { FLOW_TRIGGER_TYPES, flowCreateSchema, parseTriggerConfigFor } from "@/lib/automation-schemas";
import { describeTrigger } from "@/lib/automation-dto";
import { AutomationError } from "@/server/automation/http";
import { triggerManualFlow, type ManualDeps } from "@/server/automation/manual";
import { onLoyaltyRewardUnlocked, onTagAdded } from "@/server/automation/triggers";
import type { EnqueueInput, FlowRef, TriggerStore } from "@/server/automation/trigger-store";

/**
 * Paso 2 (sin base de datos): disparo manual, `tag_added`, `loyalty_reward_unlocked` y sus ajustes. El almacén
 * falso imita los índices únicos de `automation_run` y `automation_queue`.
 */

function fakeStore(o: { flows?: Record<string, FlowRef[]>; conversations?: string[] } = {}) {
  const keys = new Set<string>();
  const enqueued: EnqueueInput[] = [];
  const store = {
    listOrganizationIds: vi.fn(async () => ["org_1"]),
    activeFlows: vi.fn(async (_org: string, type: string) => o.flows?.[type] ?? []),
    timezone: vi.fn(async () => "UTC"),
    birthdayContacts: vi.fn(async () => [] as string[]),
    hasRealConversation: vi.fn(async (_org: string, contactId: string) => (o.conversations ?? ["ct_1"]).includes(contactId)),
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

describe("ajustes y llaves del paso 2", () => {
  it("los disparadores nuevos se pueden crear; booking_reminder sigue sin ejecutor", () => {
    for (const t of ["manual", "tag_added", "loyalty_reward_unlocked"]) {
      expect(FLOW_TRIGGER_TYPES as readonly string[]).toContain(t);
      expect(flowCreateSchema.safeParse({ name: "F", triggerType: t }).success, t).toBe(true);
    }
    expect(flowCreateSchema.safeParse({ name: "F", triggerType: "booking_reminder" }).success).toBe(false);
  });
  it("tag_added y loyalty_reward_unlocked: ajustes opcionales y estrictos", () => {
    expect(parseTriggerConfigFor("tag_added", {})).toEqual({ ok: true, value: null });
    expect(parseTriggerConfigFor("tag_added", { tagId: "tag_1" })).toEqual({ ok: true, value: { tagId: "tag_1" } });
    expect(parseTriggerConfigFor("tag_added", { tagId: "" }).ok).toBe(false);
    expect(parseTriggerConfigFor("tag_added", { otra: 1 }).ok).toBe(false);
    expect(parseTriggerConfigFor("loyalty_reward_unlocked", { stamps: 8 })).toEqual({ ok: true, value: { stamps: 8 } });
    for (const stamps of [0, -1, 1.5, 1001]) expect(parseTriggerConfigFor("loyalty_reward_unlocked", { stamps }).ok, String(stamps)).toBe(false);
    expect(parseTriggerConfigFor("manual", { x: 1 }).ok).toBe(false);
  });
  it("parseTriggerConfig lee tagId y stamps; sin ellos reacciona a cualquiera", () => {
    expect(parseTriggerConfig({ tagId: "tag_1", stamps: 8 })).toMatchObject({ tagId: "tag_1", stamps: 8 });
    expect(tagFlowMatches({}, "tag_x")).toBe(true);
    expect(tagFlowMatches({ tagId: "tag_x" }, "tag_x")).toBe(true);
    expect(tagFlowMatches({ tagId: "tag_y" }, "tag_x")).toBe(false);
    expect(loyaltyFlowMatches({}, 8)).toBe(true);
    expect(loyaltyFlowMatches({ stamps: 8 }, 8)).toBe(true);
    expect(loyaltyFlowMatches({ stamps: 4 }, 8)).toBe(false);
  });
  it("las llaves de idempotencia", () => {
    const at = new Date("2026-03-15T10:00:00.000Z");
    expect(tagAddedDedupeKey("tag_1", at)).toBe(`tag_added:tag_1:${at.getTime()}`);
    expect(tagAddedDedupeKey("tag_1", at)).not.toBe(tagAddedDedupeKey("tag_1", new Date(at.getTime() + 1)));
    expect(loyaltyRewardDedupeKey("ltr_1", 8)).toBe("loyalty_reward:ltr_1:8");
    expect(manualDedupeKey("b_abcdefgh")).toBe("manual:b_abcdefgh");
  });
  it("el batchId: 8 a 64 caracteres, solo letras, números, guion y guion bajo", () => {
    for (const ok of ["b_12345678", "abcdefgh", "a-b_c-d_e-f1"]) expect(manualBatchIdSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["corto", "con espacios 123", "ñandú-12345", "x".repeat(65), "", "a/b/c/d/e/f"]) {
      expect(manualBatchIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
  it("el origen manual viaja en el contexto y se lee de vuelta", () => {
    const ctx = manualRunContext("usr_1", "b_12345678");
    expect(ctx).toEqual({ source: "manual", triggeredBy: "usr_1", batchId: "b_12345678" });
    expect(manualOriginOf(ctx)).toEqual(ctx);
    expect(manualOriginOf({ bookingId: "bk_1" })).toBeNull();
    expect(manualOriginOf(null)).toBeNull();
    expect(manualOriginOf({ source: "manual" })).toEqual({ source: "manual", triggeredBy: "", batchId: "" });
  });
  it("frases del disparador con el nombre vivo de la etiqueta", () => {
    const tags = [{ id: "tag_1", name: "VIP", color: "slate" }];
    expect(describeTrigger("tag_added", null)).toBe("Cuando se le asigna una etiqueta a un contacto");
    expect(describeTrigger("tag_added", { tagId: "tag_1" }, [], null, tags)).toBe("Cuando se le asigna la etiqueta «VIP»");
    expect(describeTrigger("tag_added", { tagId: "tag_9" }, [], null, tags)).toContain("que ya no existe");
    expect(describeTrigger("loyalty_reward_unlocked", { stamps: 8 })).toBe("Cuando un cliente completa el premio de 8 sellos");
    expect(describeTrigger("loyalty_reward_unlocked", null)).toBe("Cuando un cliente desbloquea un premio de fidelidad");
  });
});

describe("triggerManualFlow", () => {
  const base = (over: Partial<ManualDeps> & { flow?: { triggerType: string; active: boolean } | null; conversations?: string[]; contact?: boolean } = {}) => {
    const { store, enqueued } = fakeStore({ conversations: over.conversations });
    const deps: ManualDeps = {
      store,
      loadFlow: vi.fn(async () => (over.flow === null ? null : { id: "aut_m", ...(over.flow ?? { triggerType: "manual", active: true }) })),
      contactExists: vi.fn(async () => over.contact ?? true),
      now: () => NOW,
    };
    return { deps, store, enqueued };
  };
  const input = { organizationId: "org_1", flowId: "aut_m", contactId: "ct_1", batchId: "b_12345678", triggeredBy: "usr_1" };
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (e) {
      expect(e).toBeInstanceOf(AutomationError);
      return (e as AutomationError).code;
    }
  };

  it("arranca la ejecución ahora, con la llave del lote y el origen en el contexto", async () => {
    const { deps, enqueued } = base();
    expect(await triggerManualFlow(input, deps)).toEqual({ started: true });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      organizationId: "org_1",
      flowId: "aut_m",
      contactId: "ct_1",
      dedupeKey: "manual:b_12345678",
      context: { source: "manual", triggeredBy: "usr_1", batchId: "b_12345678" },
    });
    expect(enqueued[0]!.scheduledFor).toEqual(NOW);
  });
  it("el mismo batchId (doble clic) no crea otra ejecución; otro batchId, sí", async () => {
    const { deps, enqueued } = base();
    expect((await triggerManualFlow(input, deps)).started).toBe(true);
    expect((await triggerManualFlow(input, deps)).started).toBe(false);
    expect((await triggerManualFlow({ ...input, batchId: "b_87654321" }, deps)).started).toBe(true);
    expect(enqueued.map((e) => e.dedupeKey)).toEqual(["manual:b_12345678", "manual:b_87654321"]);
  });
  it("otro contacto con el mismo batchId es otra ejecución", async () => {
    const { deps } = base({ conversations: ["ct_1", "ct_2"] });
    expect((await triggerManualFlow(input, deps)).started).toBe(true);
    expect((await triggerManualFlow({ ...input, contactId: "ct_2" }, deps)).started).toBe(true);
  });
  it("rechaza lo que no puede nacer: flujo ajeno, no manual, apagado, contacto o chat inexistente", async () => {
    expect(await code(triggerManualFlow(input, base({ flow: null }).deps))).toBe("not_found");
    expect(await code(triggerManualFlow(input, base({ flow: { triggerType: "lead_created", active: true } }).deps))).toBe("not_manual_flow");
    expect(await code(triggerManualFlow(input, base({ flow: { triggerType: "manual", active: false } }).deps))).toBe("flow_inactive");
    expect(await code(triggerManualFlow(input, base({ contact: false }).deps))).toBe("contact_not_found");
    const noChat = base({ conversations: [] });
    expect(await code(triggerManualFlow(input, noChat.deps))).toBe("no_conversation");
    expect(noChat.enqueued).toHaveLength(0);
  });
  it("sin chat real de WhatsApp (p. ej. el Laboratorio) no deja nada en la cola", async () => {
    const t = base({ conversations: [] });
    await code(triggerManualFlow(input, t.deps));
    expect(t.store.enqueueFirstStep).not.toHaveBeenCalled();
  });
});

describe("onTagAdded", () => {
  const at = new Date("2026-03-15T10:00:00.000Z");
  const ev = { organizationId: "org_1", contactId: "ct_1", tagId: "tag_vip", assignedAt: at };

  it("arranca los flujos de cualquier etiqueta y los de esa etiqueta, y no los de otra", async () => {
    const { store, enqueued } = fakeStore({
      flows: { tag_added: [flow("aut_any"), flow("aut_vip", { tagId: "tag_vip" }), flow("aut_otra", { tagId: "tag_otra" })] },
    });
    expect(await onTagAdded(ev, store, on, () => NOW)).toBe(2);
    expect(enqueued.map((e) => e.flowId).sort()).toEqual(["aut_any", "aut_vip"]);
    expect(enqueued[0]).toMatchObject({ dedupeKey: `tag_added:tag_vip:${at.getTime()}`, context: { tagId: "tag_vip" } });
  });
  it("el mismo aviso no duplica; quitar y volver a asignar (otra hora) rearma el flujo", async () => {
    const { store, enqueued } = fakeStore({ flows: { tag_added: [flow("aut_any")] } });
    expect(await onTagAdded(ev, store, on, () => NOW)).toBe(1);
    expect(await onTagAdded(ev, store, on, () => NOW)).toBe(0);
    expect(await onTagAdded({ ...ev, assignedAt: new Date(at.getTime() + 60_000) }, store, on, () => NOW)).toBe(1);
    expect(enqueued).toHaveLength(2);
  });
  it("apagado no consulta nada; sin chat real no encola; y nunca lanza", async () => {
    const off = fakeStore({ flows: { tag_added: [flow("aut_any")] } });
    expect(await onTagAdded(ev, off.store, () => false, () => NOW)).toBe(0);
    expect(off.store.activeFlows).not.toHaveBeenCalled();

    const noChat = fakeStore({ flows: { tag_added: [flow("aut_any")] }, conversations: [] });
    expect(await onTagAdded(ev, noChat.store, on, () => NOW)).toBe(0);
    expect(noChat.enqueued).toHaveLength(0);

    const broken = fakeStore();
    broken.store.activeFlows.mockRejectedValueOnce(new Error("la base se cayó"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await onTagAdded(ev, broken.store, on, () => NOW)).toBe(0);
    spy.mockRestore();
  });
});

describe("onLoyaltyRewardUnlocked", () => {
  const ev = {
    organizationId: "org_1",
    contactId: "ct_1",
    transactionId: "ltr_1",
    currentStamps: 8,
    unlocked: [
      { stamps: 4, title: "20% de descuento", rewardType: "percentage_discount" as const, discountPercentage: 20 },
      { stamps: 8, title: "Corte gratis", rewardType: "service_free" as const },
    ],
  };

  it("arranca una ejecución por premio cruzado, con el detalle del hito en el contexto", async () => {
    const { store, enqueued } = fakeStore({ flows: { loyalty_reward_unlocked: [flow("aut_l")] } });
    expect(await onLoyaltyRewardUnlocked(ev, store, on, () => NOW)).toBe(2);
    expect(enqueued.map((e) => e.dedupeKey)).toEqual(["loyalty_reward:ltr_1:4", "loyalty_reward:ltr_1:8"]);
    expect(enqueued[0]!.context).toEqual({
      loyalty: { milestoneStamps: 4, title: "20% de descuento", rewardType: "percentage_discount", discountPercentage: 20, currentStamps: 8, transactionId: "ltr_1" },
    });
    expect(enqueued[1]!.context).toEqual({
      loyalty: { milestoneStamps: 8, title: "Corte gratis", rewardType: "service_free", currentStamps: 8, transactionId: "ltr_1" },
    });
  });
  it("un flujo acotado a un hito solo reacciona a ese", async () => {
    const { store, enqueued } = fakeStore({ flows: { loyalty_reward_unlocked: [flow("aut_8", { stamps: 8 })] } });
    expect(await onLoyaltyRewardUnlocked(ev, store, on, () => NOW)).toBe(1);
    expect(enqueued[0]).toMatchObject({ flowId: "aut_8", dedupeKey: "loyalty_reward:ltr_1:8" });
  });
  it("avisar dos veces del mismo movimiento (reintento) no duplica", async () => {
    const { store, enqueued } = fakeStore({ flows: { loyalty_reward_unlocked: [flow("aut_l")] } });
    await onLoyaltyRewardUnlocked(ev, store, on, () => NOW);
    expect(await onLoyaltyRewardUnlocked(ev, store, on, () => NOW)).toBe(0);
    expect(enqueued).toHaveLength(2);
  });
  it("sin premios desbloqueados o apagado no hace nada", async () => {
    const { store } = fakeStore({ flows: { loyalty_reward_unlocked: [flow("aut_l")] } });
    expect(await onLoyaltyRewardUnlocked({ ...ev, unlocked: [] }, store, on, () => NOW)).toBe(0);
    expect(await onLoyaltyRewardUnlocked(ev, store, () => false, () => NOW)).toBe(0);
    expect(store.activeFlows).not.toHaveBeenCalled();
  });
});
