import { afterEach, describe, expect, it } from "vitest";
import {
  FLOW_TRIGGER_TYPES,
  MAX_STEPS_PER_FLOW,
  STEP_TYPES,
  flowCreateSchema,
  flowPatchSchema,
  parseStepConfig,
  parseTriggerConfigFor,
  stepCreateSchema,
  stepPatchSchema,
} from "@/lib/automation-schemas";
import { AutomationError, automationErrorResponse, automationGate } from "@/server/automation/http";
import type { SessionContext } from "@/lib/auth/session";

/**
 * API de gestión de automatizaciones — contratos Zod y guarda de entrada. El servicio contra
 * Postgres se prueba en `automation-flows-live.test.ts`; las rutas, en `scripts/e2e-automations.mjs`.
 */

describe("flowCreateSchema", () => {
  it("acepta los disparadores que hoy tienen quién los ejecute", () => {
    for (const triggerType of FLOW_TRIGGER_TYPES) {
      expect(flowCreateSchema.safeParse({ name: "F", triggerType }).success).toBe(true);
    }
  });
  it("rechaza los disparadores sin ejecutor, con un mensaje que lo explica", () => {
    for (const triggerType of ["booking_reminder", "tag_added", "inventado"]) {
      const r = flowCreateSchema.safeParse({ name: "F", triggerType });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]!.message).toContain("triggerType debe ser uno de");
    }
  });
  it("exige un nombre y lo recorta", () => {
    expect(flowCreateSchema.safeParse({ name: "   ", triggerType: "manual" }).success).toBe(false);
    expect(flowCreateSchema.safeParse({ triggerType: "manual" }).success).toBe(false);
    expect(flowCreateSchema.parse({ name: "  Hola  ", triggerType: "manual" }).name).toBe("Hola");
    expect(flowCreateSchema.safeParse({ name: "x".repeat(121), triggerType: "manual" }).success).toBe(false);
  });
  it("es estricto: `active` (y cualquier clave desconocida) se rechaza en vez de ignorarse", () => {
    expect(flowCreateSchema.safeParse({ name: "F", triggerType: "manual", active: true }).success).toBe(false);
    expect(flowCreateSchema.safeParse({ name: "F", triggerType: "manual", organizationId: "org_x" }).success).toBe(false);
  });
});

describe("flowPatchSchema", () => {
  it("acepta nombre, ajustes y active, y exige al menos uno", () => {
    expect(flowPatchSchema.safeParse({ name: "Nuevo" }).success).toBe(true);
    expect(flowPatchSchema.safeParse({ active: true }).success).toBe(true);
    expect(flowPatchSchema.safeParse({ triggerConfig: null }).success).toBe(true);
    expect(flowPatchSchema.safeParse({}).success).toBe(false);
  });
  it("el tipo del disparador no se cambia", () => {
    expect(flowPatchSchema.safeParse({ triggerType: "manual" }).success).toBe(false);
  });
});

describe("parseTriggerConfigFor", () => {
  it("birthday acepta una hora 0-23 y rechaza el resto", () => {
    expect(parseTriggerConfigFor("birthday", { hour: 9 })).toEqual({ ok: true, value: { hour: 9 } });
    for (const hour of [24, -1, 1.5, "9"]) expect(parseTriggerConfigFor("birthday", { hour }).ok).toBe(false);
  });
  it("stage_changed acepta la etapa, o ninguna para cualquier cambio", () => {
    expect(parseTriggerConfigFor("stage_changed", { toStageId: "stg_1" })).toEqual({ ok: true, value: { toStageId: "stg_1" } });
    expect(parseTriggerConfigFor("stage_changed", {})).toEqual({ ok: true, value: null });
    expect(parseTriggerConfigFor("stage_changed", { toStageId: null })).toEqual({ ok: true, value: null });
  });
  it("lead_created y manual no llevan ajustes: una clave es un error", () => {
    for (const t of ["lead_created", "manual"] as const) {
      expect(parseTriggerConfigFor(t, null)).toEqual({ ok: true, value: null });
      expect(parseTriggerConfigFor(t, { hour: 9 }).ok).toBe(false);
    }
  });
  it("una clave desconocida es un error, no algo que se guarde en silencio", () => {
    const r = parseTriggerConfigFor("birthday", { hour: 9, otra: 1 });
    expect(r.ok).toBe(false);
  });
});

describe("stepCreateSchema", () => {
  it("send_whatsapp con mensaje o con plantilla", () => {
    expect(stepCreateSchema.safeParse({ stepType: "send_whatsapp", config: { content: "Hola" } }).success).toBe(true);
    expect(stepCreateSchema.safeParse({ stepType: "send_whatsapp", config: { templateId: "tpl_1" } }).success).toBe(true);
  });
  it("send_whatsapp sin mensaje ni plantilla se rechaza", () => {
    expect(stepCreateSchema.safeParse({ stepType: "send_whatsapp", config: {} }).success).toBe(false);
  });
  it("delay valida cantidad y unidad", () => {
    expect(stepCreateSchema.safeParse({ stepType: "delay", config: { amount: 2, unit: "hours" } }).success).toBe(true);
    for (const config of [{ amount: 0, unit: "hours" }, { amount: 1, unit: "weeks" }, { amount: 1.5, unit: "days" }, {}]) {
      expect(stepCreateSchema.safeParse({ stepType: "delay", config }).success).toBe(false);
    }
  });
  it("la config de un tipo no vale para otro", () => {
    expect(stepCreateSchema.safeParse({ stepType: "delay", config: { content: "Hola" } }).success).toBe(false);
    expect(stepCreateSchema.safeParse({ stepType: "send_whatsapp", config: { amount: 1, unit: "days" } }).success).toBe(false);
  });
  it("condition y add_tag aún no se aceptan, y se dice por qué", () => {
    for (const stepType of ["condition", "add_tag", "inventado"]) {
      const r = stepCreateSchema.safeParse({ stepType, config: {} });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]!.message).toContain("stepType debe ser uno de");
    }
    expect(STEP_TYPES).toEqual(["send_whatsapp", "delay"]);
  });
  it("las posiciones valen 0 por defecto y se acotan a enteros razonables", () => {
    const ok = stepCreateSchema.parse({ stepType: "delay", config: { amount: 1, unit: "days" } });
    expect(ok).toMatchObject({ positionX: 0, positionY: 0 });
    for (const positionX of [1.5, 100_001, -100_001, "3"]) {
      expect(stepCreateSchema.safeParse({ stepType: "delay", config: { amount: 1, unit: "days" }, positionX }).success).toBe(false);
    }
    expect(stepCreateSchema.parse({ stepType: "delay", config: { amount: 1, unit: "days" }, positionX: -40, positionY: 120 })).toMatchObject({ positionX: -40, positionY: 120 });
  });
  it("hay un tope de nodos por flujo", () => {
    expect(MAX_STEPS_PER_FLOW).toBe(50);
  });
});

describe("stepPatchSchema y parseStepConfig", () => {
  it("exige al menos un campo y rechaza cambiar el tipo", () => {
    expect(stepPatchSchema.safeParse({}).success).toBe(false);
    expect(stepPatchSchema.safeParse({ positionX: 10 }).success).toBe(true);
    expect(stepPatchSchema.safeParse({ stepType: "delay" }).success).toBe(false);
  });
  it("parseStepConfig valida la config contra el tipo que ya tiene el paso", () => {
    expect(parseStepConfig("delay", { amount: 1, unit: "days" }).ok).toBe(true);
    expect(parseStepConfig("delay", { content: "x" }).ok).toBe(false);
    expect(parseStepConfig("send_whatsapp", { content: "Hola" }).ok).toBe(true);
    const bad = parseStepConfig("send_whatsapp", {});
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain("config");
  });
});

describe("automationGate", () => {
  const session = (role: string) => ({ organizationId: "org_1", role }) as unknown as SessionContext;
  const prev = process.env.AUTOMATIONS;
  afterEach(() => {
    if (prev === undefined) delete process.env.AUTOMATIONS;
    else process.env.AUTOMATIONS = prev;
  });

  it("apagado (sin AUTOMATIONS) responde 404 a todos, incluso al dueño", () => {
    delete process.env.AUTOMATIONS;
    expect(automationGate(session("owner"))!.status).toBe(404);
    process.env.AUTOMATIONS = "off";
    expect(automationGate(session("owner"))!.status).toBe(404);
  });
  it("encendido: el dueño y el administrador pasan; un miembro recibe 403", async () => {
    process.env.AUTOMATIONS = "on";
    expect(automationGate(session("owner"))).toBeNull();
    expect(automationGate(session("admin"))).toBeNull();
    const denied = automationGate(session("member"))!;
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("forbidden");
  });
  it("el 404 va primero: apagado, un miembro no se entera de que existe", () => {
    delete process.env.AUTOMATIONS;
    expect(automationGate(session("member"))!.status).toBe(404);
  });
});

describe("automationErrorResponse", () => {
  it("traduce los errores del dominio al contrato { error: { code, message } }", async () => {
    const res = automationErrorResponse(new AutomationError("flow_without_steps", 409, "Agrega un paso"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "flow_without_steps", message: "Agrega un paso" } });
  });
  it("relanza lo inesperado (se vuelve un 500 sin filtrar detalles en withAuth)", () => {
    expect(() => automationErrorResponse(new Error("boom"))).toThrow("boom");
  });
});
