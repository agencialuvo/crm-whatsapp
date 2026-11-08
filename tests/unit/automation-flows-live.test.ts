import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Gestión de flujos y pasos contra PostgreSQL REAL: las reglas de dominio y, sobre todo, el
 * aislamiento entre organizaciones.
 *
 * Necesita una base con las migraciones aplicadas y DOS organizaciones, así que NO corre con `pnpm test`:
 *   pnpm test:db   (secuencial: estas suites comparten la base y la cola)
 * Crea sus propios flujos y los borra al terminar.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("flujos y pasos contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let svc: typeof import("@/server/automation/flows");
  let AutomationError: (typeof import("@/server/automation/http"))["AutomationError"];

  let orgA = "";
  let orgB = "";
  let stageA = "";
  let stageB = "";
  let templateA = "";
  const tag = Date.now().toString(36);
  const flowIds: string[] = [];
  let contactId = "";

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      return e instanceof AutomationError ? `${e.status}:${e.code}` : `error:${String(e)}`;
    }
  };

  beforeAll(async () => {
    ({ eq, inArray } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    svc = await import("@/server/automation/flows");
    ({ AutomationError } = await import("@/server/automation/http"));

    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    expect(orgs.length, "hacen falta dos organizaciones para probar el aislamiento").toBeGreaterThanOrEqual(2);
    orgA = orgs[0]!.id;
    orgB = orgs[1]!.id;

    const stage = async (org: string) =>
      (await db.select({ id: schema.pipelineStage.id }).from(schema.pipelineStage).where(eq(schema.pipelineStage.organizationId, org)).limit(1))[0]!.id;
    stageA = await stage(orgA);
    stageB = await stage(orgB);

    templateA = `tpl_t${tag}`;
    await db.insert(schema.template).values({
      id: templateA,
      organizationId: orgA,
      name: `t_${tag}`,
      language: "es",
      category: "UTILITY",
      body: "Hola {{1}}",
      status: "approved",
    });
  });

  afterAll(async () => {
    if (flowIds.length) await db.delete(schema.automationFlow).where(inArray(schema.automationFlow.id, flowIds));
    if (templateA) await db.delete(schema.template).where(eq(schema.template.id, templateA));
    if (contactId) await db.delete(schema.contact).where(eq(schema.contact.id, contactId));
  });

  async function newFlow(org: string, triggerType: "manual" | "birthday" | "stage_changed" | "lead_created" = "manual", extra: object = {}) {
    const flow = await svc.createFlow(org, { name: `F ${tag}`, triggerType, ...extra });
    flowIds.push(flow.id);
    return flow;
  }
  const step = (flowId: string, org = orgA, over: object = {}) =>
    svc.createStep(org, flowId, { stepType: "delay", config: { amount: 1, unit: "hours" }, positionX: 0, positionY: 0, ...over } as never);

  it("un flujo nace apagado, con el disparador y sus ajustes normalizados", async () => {
    const f = await newFlow(orgA, "birthday", { triggerConfig: { hour: 9 } });
    expect(f).toMatchObject({ active: false, triggerType: "birthday", triggerConfig: { hour: 9 }, name: `F ${tag}` });
    const g = await newFlow(orgA, "lead_created");
    expect(g.triggerConfig).toBeNull();
  });

  it("valida los ajustes contra el tipo y contra las etapas de la organización", async () => {
    expect(await code(svc.createFlow(orgA, { name: "x", triggerType: "birthday", triggerConfig: { hour: 30 } }))).toBe("422:invalid_trigger_config");
    expect(await code(svc.createFlow(orgA, { name: "x", triggerType: "manual", triggerConfig: { toStageId: stageA } }))).toBe("422:invalid_trigger_config");
    // Una etapa de OTRA organización no se guarda.
    expect(await code(svc.createFlow(orgA, { name: "x", triggerType: "stage_changed", triggerConfig: { toStageId: stageB } }))).toBe("422:stage_not_found");
    const ok = await newFlow(orgA, "stage_changed", { triggerConfig: { toStageId: stageA } });
    expect(ok.triggerConfig).toEqual({ toStageId: stageA });
  });

  it("aislamiento: cada organización ve y toca solo lo suyo (lo ajeno es 404, no 403)", async () => {
    const a = await newFlow(orgA);
    const sa = await step(a.id);

    const listB = await svc.listFlows(orgB);
    expect(listB.map((f) => f.id)).not.toContain(a.id);
    expect((await svc.listFlows(orgA)).map((f) => f.id)).toContain(a.id);

    expect(await code(svc.getFlow(orgB, a.id))).toBe("404:not_found");
    expect(await code(svc.updateFlow(orgB, a.id, { name: "robado" }))).toBe("404:not_found");
    expect(await code(svc.deleteFlow(orgB, a.id))).toBe("404:not_found");
    expect(await code(step(a.id, orgB))).toBe("404:not_found");
    expect(await code(svc.updateStep(orgB, a.id, sa.id, { positionX: 5 }))).toBe("404:not_found");
    expect(await code(svc.deleteStep(orgB, a.id, sa.id))).toBe("404:not_found");

    // Nada cambió.
    const still = await svc.getFlow(orgA, a.id);
    expect(still.flow.name).toBe(`F ${tag}`);
    expect(still.steps).toHaveLength(1);
  });

  it("un paso solo se alcanza por SU flujo (no basta con conocer el id del paso)", async () => {
    const f1 = await newFlow(orgA);
    const f2 = await newFlow(orgA);
    const s1 = await step(f1.id);
    expect(await code(svc.updateStep(orgA, f2.id, s1.id, { positionX: 9 }))).toBe("404:not_found");
    expect(await code(svc.deleteStep(orgA, f2.id, s1.id))).toBe("404:not_found");
    expect((await svc.getFlow(orgA, f1.id)).steps).toHaveLength(1);
  });

  it("el detalle trae los pasos en orden de ejecución (de arriba abajo, de izquierda a derecha)", async () => {
    const f = await newFlow(orgA);
    const c = await step(f.id, orgA, { positionY: 200, positionX: 0 });
    const a = await step(f.id, orgA, { positionY: 0, positionX: 50 });
    const b = await step(f.id, orgA, { positionY: 0, positionX: 10 });
    const { steps } = await svc.getFlow(orgA, f.id);
    expect(steps.map((s) => s.id)).toEqual([b.id, a.id, c.id]);
    expect(steps.map((s) => s.order)).toEqual([1, 2, 3]);

    // Mover un nodo cambia el orden.
    await svc.updateStep(orgA, f.id, c.id, { positionY: -10 });
    expect((await svc.getFlow(orgA, f.id)).steps.map((s) => s.id)).toEqual([c.id, b.id, a.id]);
  });

  it("encender exige al menos un paso; apagar siempre se puede", async () => {
    const f = await newFlow(orgA);
    expect(await code(svc.updateFlow(orgA, f.id, { active: true }))).toBe("409:flow_without_steps");
    await step(f.id);
    expect((await svc.updateFlow(orgA, f.id, { active: true })).active).toBe(true);
    expect((await svc.updateFlow(orgA, f.id, { active: false })).active).toBe(false);
  });

  it("borrar el último paso de un flujo encendido lo apaga", async () => {
    const f = await newFlow(orgA);
    const s = await step(f.id);
    await svc.updateFlow(orgA, f.id, { active: true });
    await svc.deleteStep(orgA, f.id, s.id);
    expect((await svc.getFlow(orgA, f.id)).flow.active).toBe(false);
  });

  it("edita la config contra el tipo que ya tiene el paso", async () => {
    const f = await newFlow(orgA);
    const s = await step(f.id);
    expect(await code(svc.updateStep(orgA, f.id, s.id, { config: { content: "no es un delay" } }))).toBe("422:invalid_step_config");
    const upd = await svc.updateStep(orgA, f.id, s.id, { config: { amount: 3, unit: "days" }, positionX: 7 });
    expect(upd).toMatchObject({ config: { amount: 3, unit: "days" }, positionX: 7 });
  });

  it("una plantilla debe existir en ESTA organización", async () => {
    const fa = await newFlow(orgA);
    const fb = await newFlow(orgB);
    const send = (org: string, flowId: string, templateId: string) =>
      svc.createStep(org, flowId, { stepType: "send_whatsapp", config: { templateId }, positionX: 0, positionY: 0 } as never);
    await expect(send(orgA, fa.id, templateA)).resolves.toMatchObject({ stepType: "send_whatsapp" });
    expect(await code(send(orgB, fb.id, templateA))).toBe("422:template_not_found"); // de otra organización
    expect(await code(send(orgA, fa.id, "tpl_no_existe"))).toBe("422:template_not_found");
  });

  it("hay un tope de pasos por flujo", async () => {
    const f = await newFlow(orgA);
    for (let i = 0; i < 50; i++) await step(f.id, orgA, { positionY: i });
    expect(await code(step(f.id))).toBe("409:too_many_steps");
    expect((await svc.getFlow(orgA, f.id)).steps).toHaveLength(50);
  });

  it("el listado lleva los campos principales y la cantidad de pasos", async () => {
    const f = await newFlow(orgA);
    await step(f.id);
    await step(f.id);
    const row = (await svc.listFlows(orgA)).find((x) => x.id === f.id)!;
    expect(row).toMatchObject({ id: f.id, name: `F ${tag}`, triggerType: "manual", active: false, stepCount: 2 });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("borrar el flujo se lleva sus pasos, su cola y su historial por cascada", async () => {
    const f = await newFlow(orgA);
    const s = await step(f.id);
    const ctId = `ct_t${tag}`;
    contactId = ctId;
    await db.insert(schema.contact).values({ id: ctId, organizationId: orgA, name: "Prueba flujos", waIdentity: `t-${ctId}` });
    const qid = `que_t${tag}`;
    await db.insert(schema.automationQueue).values({ id: qid, organizationId: orgA, flowId: f.id, contactId: ctId, stepId: s.id, scheduledFor: new Date() });
    await svc.deleteFlow(orgA, f.id);
    expect(await code(svc.getFlow(orgA, f.id))).toBe("404:not_found");
    expect(await db.select().from(schema.automationStep).where(eq(schema.automationStep.flowId, f.id))).toHaveLength(0);
    expect(await db.select().from(schema.automationQueue).where(eq(schema.automationQueue.id, qid))).toHaveLength(0);
    expect(await code(svc.deleteFlow(orgA, f.id))).toBe("404:not_found"); // y no se puede borrar dos veces
  });

  it("renombrar y cambiar los ajustes no toca el estado", async () => {
    const f = await newFlow(orgA, "birthday");
    const upd = await svc.updateFlow(orgA, f.id, { name: "Cumple VIP", triggerConfig: { hour: 8 } });
    expect(upd).toMatchObject({ name: "Cumple VIP", triggerConfig: { hour: 8 }, active: false });
    expect(await code(svc.updateFlow(orgA, f.id, { triggerConfig: { toStageId: stageA } }))).toBe("422:invalid_trigger_config");
    expect((await svc.updateFlow(orgA, f.id, { triggerConfig: null })).triggerConfig).toBeNull();
  });
});
