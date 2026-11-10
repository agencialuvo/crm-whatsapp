import { describe, expect, it, vi } from "vitest";
import {
  BIRTHDAY_MAX_DAYS_BEFORE,
  birthdayTargetDate,
  birthdaysDueOn,
  parseTriggerConfig,
} from "@/lib/automation";
import { parseTriggerConfigFor, flowCreateSchema, flowPatchSchema } from "@/lib/automation-schemas";
import { runBirthdayTrigger } from "@/server/automation/triggers";
import type { EnqueueInput, FlowRef, TriggerStore } from "@/server/automation/trigger-store";

/**
 * Cumpleaños con adelanto (`daysOffset`): el saludo sale N días ANTES del cumpleaños. Validación,
 * aritmética de fechas (fin de mes, fin de año, bisiestos), zona horaria del negocio y textos.
 */

describe("daysOffset en el esquema", () => {
  it("birthday lo acepta de 0 a -30, entero; ausente vale 0", () => {
    for (const daysOffset of [0, -1, -2, -30]) {
      expect(parseTriggerConfigFor("birthday", { hour: 9, daysOffset }).ok).toBe(true);
    }
    expect(parseTriggerConfigFor("birthday", { daysOffset: -1 })).toEqual({ ok: true, value: { daysOffset: -1 } });
    expect(parseTriggerConfigFor("birthday", { hour: 9 })).toEqual({ ok: true, value: { hour: 9 } });
  });
  it("rechaza positivos, fraccionarios, fuera de rango y no numéricos, con el campo en el mensaje", () => {
    for (const daysOffset of [1, 2, -31, -0.5, "-1", null, NaN]) {
      const r = parseTriggerConfigFor("birthday", { daysOffset });
      expect(r.ok, String(daysOffset)).toBe(false);
      if (!r.ok) expect(r.message).toContain("daysOffset");
    }
    expect(BIRTHDAY_MAX_DAYS_BEFORE).toBe(30);
  });
  it("solo existe para birthday: los demás disparadores lo rechazan", () => {
    for (const type of ["stage_changed", "lead_created", "manual"] as const) {
      expect(parseTriggerConfigFor(type, { daysOffset: -1 }).ok, type).toBe(false);
    }
  });
  it("viaja por crear y editar el flujo", () => {
    expect(flowCreateSchema.safeParse({ name: "Aviso", triggerType: "birthday", triggerConfig: { hour: 9, daysOffset: -1 } }).success).toBe(true);
    expect(flowPatchSchema.safeParse({ triggerConfig: { daysOffset: -2 } }).success).toBe(true);
  });
  it("un flujo guardado sin daysOffset (los de antes) se lee como 0", () => {
    expect(parseTriggerConfig({ hour: 9 }).daysOffset).toBeUndefined();
    expect(birthdayTargetDate("2026-03-14", parseTriggerConfig({ hour: 9 }).daysOffset)).toBe("2026-03-14");
    expect(parseTriggerConfig({ hour: 9, daysOffset: -1 })).toEqual({ hour: 9, daysOffset: -1 });
  });
});

describe("birthdayTargetDate", () => {
  it("0 es hoy; -1 mañana; -2 pasado mañana", () => {
    expect(birthdayTargetDate("2026-03-14", 0)).toBe("2026-03-14");
    expect(birthdayTargetDate("2026-03-14", undefined)).toBe("2026-03-14");
    expect(birthdayTargetDate("2026-03-14", -1)).toBe("2026-03-15");
    expect(birthdayTargetDate("2026-03-14", -2)).toBe("2026-03-16");
  });
  it("cruza fin de mes y de año", () => {
    expect(birthdayTargetDate("2026-03-31", -1)).toBe("2026-04-01");
    expect(birthdayTargetDate("2026-12-31", -1)).toBe("2027-01-01");
    expect(birthdayTargetDate("2026-12-30", -2)).toBe("2027-01-01");
  });
  it("febrero: año bisiesto y no bisiesto", () => {
    expect(birthdayTargetDate("2028-02-28", -1)).toBe("2028-02-29");
    expect(birthdayTargetDate("2027-02-28", -1)).toBe("2027-03-01");
    expect(birthdayTargetDate("2028-02-27", -2)).toBe("2028-02-29");
  });
  it("un valor inválido cae a 0 en vez de adelantar sin control", () => {
    expect(birthdayTargetDate("2026-03-14", 3)).toBe("2026-03-14");
    expect(birthdayTargetDate("2026-03-14", -99)).toBe("2026-03-14");
    expect(birthdayTargetDate("2026-03-14", -1.5)).toBe("2026-03-14");
  });
  it("combinado con birthdaysDueOn: quien nació un 29 de feb. se avisa el 27 en año no bisiesto", () => {
    // Su cumpleaños cae el 28 en 2027: «1 día antes» es el 27.
    expect(birthdaysDueOn(birthdayTargetDate("2027-02-27", -1))).toEqual([
      { day: 28, month: 2 },
      { day: 29, month: 2 },
    ]);
    // En 2028 (bisiesto) su día es el 29 y el 28 lo avisa.
    expect(birthdaysDueOn(birthdayTargetDate("2028-02-28", -1))).toEqual([{ day: 29, month: 2 }]);
  });
});

/* ─── El barrido, con un almacén falso ─── */

type Birthday = { day: number; month: number; contactId: string };

function fakeStore(flows: FlowRef[], birthdays: Birthday[], timezone = "America/Lima") {
  const keys = new Set<string>();
  const enqueued: EnqueueInput[] = [];
  const store = {
    listOrganizationIds: vi.fn(async () => ["org_1"]),
    activeFlows: vi.fn(async (_org: string, type: string) => (type === "birthday" ? flows : [])),
    timezone: vi.fn(async () => timezone),
    birthdayContacts: vi.fn(async (_org: string, due: { day: number; month: number }[]) =>
      birthdays.filter((b) => due.some((d) => d.day === b.day && d.month === b.month)).map((b) => b.contactId)
    ),
    hasRealConversation: vi.fn(async () => true),
    enqueueFirstStep: vi.fn(async (i: EnqueueInput) => {
      const k = [i.organizationId, i.flowId, i.contactId, i.dedupeKey].join("|");
      if (keys.has(k)) return false;
      keys.add(k);
      enqueued.push(i);
      return true;
    }),
  } satisfies TriggerStore;
  return { store, enqueued };
}
const flow = (id: string, triggerConfig: unknown = null): FlowRef => ({ id, organizationId: "org_1", triggerConfig });

describe("runBirthdayTrigger con daysOffset", () => {
  // 15:00 UTC del 14 de marzo = 10:00 del 14 de marzo en Lima.
  const NOW = new Date("2026-03-14T15:00:00.000Z");
  const people: Birthday[] = [
    { day: 14, month: 3, contactId: "ct_hoy" },
    { day: 15, month: 3, contactId: "ct_manana" },
    { day: 16, month: 3, contactId: "ct_pasado" },
  ];

  it("sin daysOffset (o 0) saluda a quien cumple hoy, como siempre", async () => {
    const { store, enqueued } = fakeStore([flow("a"), flow("b", { daysOffset: 0 })], people);
    await runBirthdayTrigger(NOW, store);
    expect(enqueued.map((e) => `${e.flowId}:${e.contactId}`)).toEqual(["a:ct_hoy", "b:ct_hoy"]);
  });
  it("-1 saluda hoy a quien cumple MAÑANA, y -2 a quien cumple pasado mañana", async () => {
    const { store, enqueued } = fakeStore([flow("uno", { daysOffset: -1 }), flow("dos", { daysOffset: -2 })], people);
    await runBirthdayTrigger(NOW, store);
    expect(enqueued.map((e) => `${e.flowId}:${e.contactId}`)).toEqual(["uno:ct_manana", "dos:ct_pasado"]);
  });
  it("el mensaje sale HOY a la hora del flujo (hora de Lima), no el día del cumpleaños", async () => {
    const { store, enqueued } = fakeStore([flow("uno", { hour: 9, daysOffset: -1 })], people);
    await runBirthdayTrigger(NOW, store);
    // 09:00 del 14 de marzo en Lima = 14:00 UTC del 14.
    expect(enqueued[0]!.scheduledFor.toISOString()).toBe("2026-03-14T14:00:00.000Z");
  });
  it("el «hoy» es el del negocio: a las 22:00 en Lima (ya es mañana en UTC) manda el día de Lima", async () => {
    // 03:00 UTC del 15 = 22:00 del 14 en Lima. «1 día antes» = quien cumple el 15.
    const { store, enqueued } = fakeStore([flow("uno", { daysOffset: -1 })], people);
    await runBirthdayTrigger(new Date("2026-03-15T03:00:00.000Z"), store);
    expect(enqueued.map((e) => e.contactId)).toEqual(["ct_manana"]);
    // Y en UTC puro (otro negocio) el mismo instante ya es el día 15: quien cumple el 16.
    const utc = fakeStore([flow("uno", { daysOffset: -1 })], people, "UTC");
    await runBirthdayTrigger(new Date("2026-03-15T03:00:00.000Z"), utc.store);
    expect(utc.enqueued.map((e) => e.contactId)).toEqual(["ct_pasado"]);
  });
  it("pide los contactos una sola vez por fecha, aunque varios flujos miren la misma", async () => {
    const { store } = fakeStore([flow("a", { daysOffset: -1 }), flow("b", { daysOffset: -1 }), flow("c")], people);
    await runBirthdayTrigger(NOW, store);
    expect(store.birthdayContacts).toHaveBeenCalledTimes(2);
  });
  it("repetir el barrido no duplica el aviso", async () => {
    const { store, enqueued } = fakeStore([flow("uno", { daysOffset: -1 })], people);
    await runBirthdayTrigger(NOW, store);
    await runBirthdayTrigger(NOW, store);
    expect(enqueued).toHaveLength(1);
  });
  it("la llave de idempotencia lleva el año del CUMPLEAÑOS: el 31 de dic. avisa del 1 de ene. del año siguiente", async () => {
    const { store, enqueued } = fakeStore([flow("uno", { daysOffset: -1 })], [{ day: 1, month: 1, contactId: "ct_ano" }], "UTC");
    await runBirthdayTrigger(new Date("2026-12-31T12:00:00.000Z"), store);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.dedupeKey).toBe("birthday:2027");
    // El día en que cae el cumpleaños, el flujo -1 ya no lo vuelve a avisar (mira al 2 de ene.).
    const again = await runBirthdayTrigger(new Date("2027-01-01T12:00:00.000Z"), store);
    expect(again.enqueued).toBe(0);
  });
  it("29 de febrero: en año no bisiesto, «1 día antes» es el 27", async () => {
    const leap: Birthday[] = [{ day: 29, month: 2, contactId: "ct_bisiesto" }];
    const a = fakeStore([flow("uno", { daysOffset: -1 })], leap, "UTC");
    await runBirthdayTrigger(new Date("2027-02-27T12:00:00.000Z"), a.store);
    expect(a.enqueued.map((e) => e.contactId)).toEqual(["ct_bisiesto"]);
    // En 2028 (bisiesto) se avisa el 28, y el 27 no.
    const b = fakeStore([flow("uno", { daysOffset: -1 })], leap, "UTC");
    await runBirthdayTrigger(new Date("2028-02-27T12:00:00.000Z"), b.store);
    expect(b.enqueued).toHaveLength(0);
    await runBirthdayTrigger(new Date("2028-02-28T12:00:00.000Z"), b.store);
    expect(b.enqueued.map((e) => e.contactId)).toEqual(["ct_bisiesto"]);
  });
  it("un daysOffset dañado en la base no apaga el flujo: se comporta como 0", async () => {
    const { store, enqueued } = fakeStore([flow("a", { daysOffset: 5 })], people);
    await runBirthdayTrigger(NOW, store);
    // El JSON inválido cae a los valores por defecto (mismo día).
    expect(enqueued.map((e) => e.contactId)).toEqual(["ct_hoy"]);
  });
});
