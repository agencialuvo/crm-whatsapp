import { describe, expect, it, vi } from "vitest";
import {
  BIRTHDAY_DEFAULT_HOUR,
  birthdayDedupeKey,
  birthdaySendAt,
  birthdaysDueOn,
  isLeapYear,
  leadCreatedDedupeKey,
  parseTriggerConfig,
  splitISODate,
  stageDedupeKey,
  stageFlowMatches,
} from "@/lib/automation";
import { onLeadCreated, onLeadStageChanged, runBirthdayTrigger } from "@/server/automation/triggers";
import type { EnqueueInput, FlowRef, TriggerStore } from "@/server/automation/trigger-store";

/**
 * Disparadores de automatizaciones: reglas puras y orquestación con un almacén falso que imita el
 * índice único de `automation_queue`. La base de datos real se prueba en
 * `automation-triggers-live.test.ts` (RUN_DB_TESTS=1).
 */

describe("reglas de cumpleaños", () => {
  it("isLeapYear", () => {
    expect([2024, 2028, 2000].every(isLeapYear)).toBe(true);
    expect([2026, 2027, 1900, 2100].some(isLeapYear)).toBe(false);
  });
  it("splitISODate", () => {
    expect(splitISODate("2026-03-14")).toEqual({ year: 2026, month: 3, day: 14 });
  });
  it("hoy es el único día, salvo el 29 de febrero", () => {
    expect(birthdaysDueOn("2026-03-14")).toEqual([{ day: 14, month: 3 }]);
    expect(birthdaysDueOn("2026-03-01")).toEqual([{ day: 1, month: 3 }]);
  });
  it("quien nació un 29 de febrero se saluda el 28 en año no bisiesto", () => {
    expect(birthdaysDueOn("2026-02-28")).toEqual([
      { day: 28, month: 2 },
      { day: 29, month: 2 },
    ]);
    expect(birthdaysDueOn("2027-02-28")).toHaveLength(2);
  });
  it("en año bisiesto el 29 es el 29, y el 28 no lo adelanta", () => {
    expect(birthdaysDueOn("2028-02-28")).toEqual([{ day: 28, month: 2 }]);
    expect(birthdaysDueOn("2028-02-29")).toEqual([{ day: 29, month: 2 }]);
  });
  it("la hora del saludo es local al negocio (10:00 por defecto)", () => {
    expect(BIRTHDAY_DEFAULT_HOUR).toBe(10);
    expect(birthdaySendAt("2026-03-14", undefined, "America/Lima")?.toISOString()).toBe("2026-03-14T15:00:00.000Z");
    expect(birthdaySendAt("2026-03-14", 8, "America/Lima")?.toISOString()).toBe("2026-03-14T13:00:00.000Z");
    expect(birthdaySendAt("2026-03-14", 10, "UTC")?.toISOString()).toBe("2026-03-14T10:00:00.000Z");
  });
  it("una hora fuera de rango cae a la de por defecto", () => {
    expect(birthdaySendAt("2026-03-14", 99, "UTC")?.toISOString()).toBe("2026-03-14T10:00:00.000Z");
    expect(birthdaySendAt("2026-03-14", 1.5, "UTC")?.toISOString()).toBe("2026-03-14T10:00:00.000Z");
  });
});

describe("configuración del disparador y llaves", () => {
  it("parseTriggerConfig tolera lo ausente o dañado", () => {
    expect(parseTriggerConfig(null)).toEqual({});
    expect(parseTriggerConfig(undefined)).toEqual({});
    expect(parseTriggerConfig("basura")).toEqual({});
    expect(parseTriggerConfig({ hour: 99 })).toEqual({});
    expect(parseTriggerConfig({ toStageId: "stg_1", hour: 8 })).toEqual({ toStageId: "stg_1", hour: 8 });
  });
  it("un flujo sin etapa reacciona a cualquiera; con etapa, solo a esa", () => {
    expect(stageFlowMatches({}, "stg_x")).toBe(true);
    expect(stageFlowMatches({ toStageId: null }, "stg_x")).toBe(true);
    expect(stageFlowMatches({ toStageId: "stg_x" }, "stg_x")).toBe(true);
    expect(stageFlowMatches({ toStageId: "stg_y" }, "stg_x")).toBe(false);
  });
  it("las llaves de idempotencia", () => {
    expect(birthdayDedupeKey(2026)).toBe("birthday:2026");
    expect(stageDedupeKey("ld_1", "stg_2")).toBe("stage:ld_1:stg_2");
    expect(leadCreatedDedupeKey("ld_1")).toBe("lead_created:ld_1");
  });
});

/* ─── Orquestación con un almacén falso ─── */

type FakeOpts = {
  orgs?: string[];
  flows?: Record<string, Partial<Record<string, FlowRef[]>>>; // org → tipo → flujos
  timezone?: Record<string, string>;
  birthdays?: Record<string, { day: number; month: number; contactId: string }[]>;
  conversations?: string[]; // contactIds con chat real
  flowsWithoutSteps?: string[];
  failActiveFlowsFor?: string;
};

function fakeStore(o: FakeOpts = {}) {
  const keys = new Set<string>();
  const enqueued: EnqueueInput[] = [];
  const store = {
    listOrganizationIds: vi.fn(async () => o.orgs ?? ["org_1"]),
    activeFlows: vi.fn(async (org: string, type: string) => {
      if (org === o.failActiveFlowsFor) throw new Error("la base se cayó");
      return o.flows?.[org]?.[type] ?? [];
    }),
    timezone: vi.fn(async (org: string) => o.timezone?.[org] ?? "UTC"),
    birthdayContacts: vi.fn(async (org: string, due: { day: number; month: number }[]) =>
      (o.birthdays?.[org] ?? [])
        .filter((b) => due.some((d) => d.day === b.day && d.month === b.month))
        .map((b) => b.contactId)
    ),
    hasRealConversation: vi.fn(async (_org: string, contactId: string) => (o.conversations ?? ["ct_1"]).includes(contactId)),
    enqueueFirstStep: vi.fn(async (i: EnqueueInput) => {
      if (o.flowsWithoutSteps?.includes(i.flowId)) return false;
      // El índice único: (org, flujo, contacto, llave).
      const k = [i.organizationId, i.flowId, i.contactId, i.dedupeKey].join("|");
      if (keys.has(k)) return false;
      keys.add(k);
      enqueued.push(i);
      return true;
    }),
  } satisfies TriggerStore;
  return { store, enqueued };
}

const flow = (id: string, triggerConfig: unknown = null, organizationId = "org_1"): FlowRef => ({ id, organizationId, triggerConfig });

describe("runBirthdayTrigger", () => {
  // 03:00 UTC del 15 de marzo = 22:00 del 14 de marzo en Lima.
  const NOW = new Date("2026-03-15T03:00:00.000Z");
  const base = (extra: FakeOpts = {}) =>
    fakeStore({
      flows: { org_1: { birthday: [flow("aut_b")] } },
      timezone: { org_1: "America/Lima" },
      birthdays: {
        org_1: [
          { day: 14, month: 3, contactId: "ct_lima" },
          { day: 15, month: 3, contactId: "ct_utc" },
        ],
      },
      ...extra,
    });

  it("usa el día del NEGOCIO (no el del servidor): en Lima todavía es 14", async () => {
    const { store, enqueued } = base();
    const run = await runBirthdayTrigger(NOW, store);
    expect(store.birthdayContacts).toHaveBeenCalledWith("org_1", [{ day: 14, month: 3 }]);
    expect(enqueued.map((e) => e.contactId)).toEqual(["ct_lima"]);
    expect(run).toEqual({ organizations: 1, flows: 1, contacts: 1, enqueued: 1 });
  });

  it("programa el saludo a las 10:00 locales con la llave del año", async () => {
    const { store, enqueued } = base();
    await runBirthdayTrigger(NOW, store);
    expect(enqueued[0]).toMatchObject({
      organizationId: "org_1",
      flowId: "aut_b",
      contactId: "ct_lima",
      dedupeKey: "birthday:2026",
    });
    expect(enqueued[0]!.scheduledFor.toISOString()).toBe("2026-03-14T15:00:00.000Z");
  });

  it("respeta la hora configurada en el flujo", async () => {
    const { store, enqueued } = base({ flows: { org_1: { birthday: [flow("aut_b", { hour: 8 })] } } });
    await runBirthdayTrigger(NOW, store);
    expect(enqueued[0]!.scheduledFor.toISOString()).toBe("2026-03-14T13:00:00.000Z");
  });

  it("repetir el barrido (o reiniciar la app) no duplica nada en el mismo año", async () => {
    const { store, enqueued } = base();
    expect((await runBirthdayTrigger(NOW, store)).enqueued).toBe(1);
    expect((await runBirthdayTrigger(NOW, store)).enqueued).toBe(0);
    expect((await runBirthdayTrigger(new Date(NOW.getTime() + 3_600_000), store)).enqueued).toBe(0);
    expect(enqueued).toHaveLength(1);
  });

  it("el año siguiente vuelve a saludar", async () => {
    const { store, enqueued } = base();
    await runBirthdayTrigger(NOW, store);
    await runBirthdayTrigger(new Date("2027-03-15T03:00:00.000Z"), store);
    expect(enqueued.map((e) => e.dedupeKey)).toEqual(["birthday:2026", "birthday:2027"]);
  });

  it("cada flujo activo recibe a los cumpleañeros, una vez", async () => {
    const { store, enqueued } = base({ flows: { org_1: { birthday: [flow("aut_1"), flow("aut_2")] } } });
    const run = await runBirthdayTrigger(NOW, store);
    expect(run.enqueued).toBe(2);
    expect(enqueued.map((e) => e.flowId).sort()).toEqual(["aut_1", "aut_2"]);
  });

  it("una organización sin flujo de cumpleaños no consulta contactos", async () => {
    const { store } = fakeStore({ orgs: ["org_1"], flows: {} });
    const run = await runBirthdayTrigger(NOW, store);
    expect(store.birthdayContacts).not.toHaveBeenCalled();
    expect(run).toEqual({ organizations: 0, flows: 0, contacts: 0, enqueued: 0 });
  });

  it("un flujo sin pasos no encola nada", async () => {
    const { store } = base({ flowsWithoutSteps: ["aut_b"] });
    expect((await runBirthdayTrigger(NOW, store)).enqueued).toBe(0);
  });

  it("si una organización falla, las demás se procesan igual", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { store, enqueued } = fakeStore({
      orgs: ["org_malo", "org_1"],
      failActiveFlowsFor: "org_malo",
      flows: { org_1: { birthday: [flow("aut_b")] } },
      timezone: { org_1: "America/Lima" },
      birthdays: { org_1: [{ day: 14, month: 3, contactId: "ct_lima" }] },
    });
    const run = await runBirthdayTrigger(NOW, store);
    expect(enqueued.map((e) => e.contactId)).toEqual(["ct_lima"]);
    expect(run.enqueued).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("el 29 de febrero se saluda el 28 en año no bisiesto", async () => {
    const { store, enqueued } = fakeStore({
      flows: { org_1: { birthday: [flow("aut_b")] } },
      birthdays: { org_1: [{ day: 29, month: 2, contactId: "ct_bisiesto" }] },
    });
    await runBirthdayTrigger(new Date("2027-02-28T12:00:00.000Z"), store);
    expect(enqueued.map((e) => e.contactId)).toEqual(["ct_bisiesto"]);
  });
});

describe("onLeadStageChanged", () => {
  const ev = { organizationId: "org_1", leadId: "ld_1", contactId: "ct_1", toStageId: "stg_X" };
  const on = () => true;
  const T0 = new Date("2026-03-15T12:00:00.000Z");
  const flows = {
    org_1: {
      stage_changed: [flow("aut_any"), flow("aut_x", { toStageId: "stg_X" }), flow("aut_y", { toStageId: "stg_Y" })],
    },
  };

  it("encola el primer paso de los flujos que reaccionan a esa etapa, y solo de esos", async () => {
    const { store, enqueued } = fakeStore({ flows });
    expect(await onLeadStageChanged(ev, store, on, () => T0)).toBe(2);
    expect(enqueued.map((e) => e.flowId).sort()).toEqual(["aut_any", "aut_x"]);
    expect(enqueued[0]).toMatchObject({ contactId: "ct_1", dedupeKey: "stage:ld_1:stg_X", scheduledFor: T0 });
  });

  it("el mismo cambio procesado dos veces no duplica", async () => {
    const { store, enqueued } = fakeStore({ flows });
    await onLeadStageChanged(ev, store, on);
    expect(await onLeadStageChanged(ev, store, on)).toBe(0);
    expect(enqueued).toHaveLength(2);
  });

  it("ir y volver a una etapa no repite el mensaje; una etapa distinta sí dispara", async () => {
    const { store, enqueued } = fakeStore({ flows });
    await onLeadStageChanged(ev, store, on); // entra a X
    await onLeadStageChanged({ ...ev, toStageId: "stg_Y" }, store, on); // pasa a Y (aut_any y aut_y)
    expect(await onLeadStageChanged(ev, store, on)).toBe(0); // vuelve a X: ya se mandó
    expect(enqueued.map((e) => `${e.flowId}@${e.dedupeKey}`).sort()).toEqual([
      "aut_any@stage:ld_1:stg_X",
      "aut_any@stage:ld_1:stg_Y",
      "aut_x@stage:ld_1:stg_X",
      "aut_y@stage:ld_1:stg_Y",
    ]);
  });

  it("dos leads distintos en la misma etapa disparan por separado", async () => {
    const { store } = fakeStore({ flows, conversations: ["ct_1", "ct_2"] });
    await onLeadStageChanged(ev, store, on);
    expect(await onLeadStageChanged({ ...ev, leadId: "ld_2", contactId: "ct_2" }, store, on)).toBe(2);
  });

  it("sin chat de WhatsApp real no encola nada", async () => {
    const { store } = fakeStore({ flows, conversations: [] });
    expect(await onLeadStageChanged(ev, store, on)).toBe(0);
    expect(store.enqueueFirstStep).not.toHaveBeenCalled();
  });

  it("sin flujos activos de ese tipo no consulta conversaciones", async () => {
    const { store } = fakeStore({ flows: {} });
    expect(await onLeadStageChanged(ev, store, on)).toBe(0);
    expect(store.hasRealConversation).not.toHaveBeenCalled();
  });

  it("con las automatizaciones apagadas no toca ni la base", async () => {
    const { store } = fakeStore({ flows });
    expect(await onLeadStageChanged(ev, store, () => false)).toBe(0);
    expect(store.activeFlows).not.toHaveBeenCalled();
  });

  it("nunca lanza: un fallo de la base devuelve 0 (no cuesta el movimiento del lead)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { store } = fakeStore({ flows, failActiveFlowsFor: "org_1" });
    await expect(onLeadStageChanged(ev, store, on)).resolves.toBe(0);
    err.mockRestore();
  });
});

describe("onLeadCreated", () => {
  const ev = { organizationId: "org_1", leadId: "ld_1", contactId: "ct_1" };
  const on = () => true;
  const flows = { org_1: { lead_created: [flow("aut_new")], stage_changed: [flow("aut_st")] } };

  it("encola solo los flujos de lead nuevo, con su llave por lead", async () => {
    const { store, enqueued } = fakeStore({ flows });
    expect(await onLeadCreated(ev, store, on)).toBe(1);
    expect(enqueued[0]).toMatchObject({ flowId: "aut_new", dedupeKey: "lead_created:ld_1" });
  });
  it("no duplica si el evento se procesa de nuevo", async () => {
    const { store } = fakeStore({ flows });
    await onLeadCreated(ev, store, on);
    expect(await onLeadCreated(ev, store, on)).toBe(0);
  });
  it("apagado, o sin chat real, no hace nada; y nunca lanza", async () => {
    expect(await onLeadCreated(ev, fakeStore({ flows }).store, () => false)).toBe(0);
    expect(await onLeadCreated(ev, fakeStore({ flows, conversations: [] }).store, on)).toBe(0);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(onLeadCreated(ev, fakeStore({ flows, failActiveFlowsFor: "org_1" }).store, on)).resolves.toBe(0);
    err.mockRestore();
  });
});
