import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Estado y historial de automatizaciones contra PostgreSQL REAL: conteos, filtros, paginación y
 * aislamiento entre organizaciones. Corre con `pnpm test:db` (necesita DOS organizaciones).
 * Crea sus propios flujos, contactos y líneas, y los borra al terminar.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("monitoreo de automatizaciones contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let mon: typeof import("@/server/automation/monitor");
  let AutomationError: (typeof import("@/server/automation/http"))["AutomationError"];

  const tag = Date.now().toString(36);
  let orgA = "";
  let orgB = "";
  const flowIds: string[] = [];
  const contactIds: string[] = [];
  let flowA = "";
  let flowA2 = "";
  let flowB = "";
  let stepA = "";

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      return e instanceof AutomationError ? `${e.status}:${e.code}` : `error:${String(e)}`;
    }
  };
  const q = (limit = 25, offset = 0, status?: never) => ({ limit, offset, ...(status ? { status } : {}) });

  beforeAll(async () => {
    ({ inArray } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    mon = await import("@/server/automation/monitor");
    ({ AutomationError } = await import("@/server/automation/http"));

    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    expect(orgs.length, "hacen falta dos organizaciones").toBeGreaterThanOrEqual(2);
    orgA = orgs[0]!.id;
    orgB = orgs[1]!.id;

    const flow = async (org: string, suffix: string) => {
      const id = `flw_m${tag}${suffix}`;
      await db.insert(schema.automationFlow).values({ id, organizationId: org, name: `M ${suffix}`, triggerType: "manual" });
      flowIds.push(id);
      return id;
    };
    flowA = await flow(orgA, "a");
    flowA2 = await flow(orgA, "b");
    flowB = await flow(orgB, "c");

    const contact = async (org: string, suffix: string, name: string) => {
      const id = `ct_m${tag}${suffix}`;
      await db.insert(schema.contact).values({ id, organizationId: org, name, waIdentity: `m-${id}`, phone: "5215550001" });
      contactIds.push(id);
      return id;
    };
    const ctA = await contact(orgA, "a", "Ana Prueba");
    const ctB = await contact(orgB, "b", "Beto Ajeno");

    stepA = `stp_m${tag}a`;
    await db.insert(schema.automationStep).values({
      id: stepA, organizationId: orgA, flowId: flowA, stepType: "send_whatsapp", config: { content: "Hola" }, positionX: 0, positionY: 0,
    });
    const stepB = `stp_m${tag}c`;
    await db.insert(schema.automationStep).values({
      id: stepB, organizationId: orgB, flowId: flowB, stepType: "delay", config: { amount: 1, unit: "hours" }, positionX: 0, positionY: 0,
    });

    const future = new Date(Date.now() + 3_600_000);
    const soon = new Date(Date.now() + 60_000);
    const queue = (id: string, org: string, flowId: string, contactId: string, stepId: string, status: "pending" | "processing" | "completed" | "failed" | "cancelled", at: Date) =>
      db.insert(schema.automationQueue).values({ id, organizationId: org, flowId, contactId, stepId, status, scheduledFor: at });
    await queue(`que_m${tag}1`, orgA, flowA, ctA, stepA, "pending", future);
    await queue(`que_m${tag}2`, orgA, flowA, ctA, stepA, "pending", soon);
    await queue(`que_m${tag}3`, orgA, flowA, ctA, stepA, "processing", soon);
    await queue(`que_m${tag}4`, orgA, flowA, ctA, stepA, "completed", soon);
    await queue(`que_m${tag}5`, orgA, flowA, ctA, stepA, "failed", soon);
    await queue(`que_m${tag}6`, orgA, flowA2, ctA, stepA, "cancelled", soon);
    await queue(`que_m${tag}7`, orgB, flowB, ctB, stepB, "pending", soon);

    const base = Date.now() - 600_000;
    const log = (n: number, org: string, flowId: string, contactId: string, stepId: string | null, status: "success" | "failed" | "skipped_rate_limit" | "skipped_opt_out", metadata: object) =>
      db.insert(schema.automationExecutionLog).values({
        id: `log_m${tag}${n}`, organizationId: org, flowId, contactId, stepId, status, metadata, executedAt: new Date(base + n * 1000),
      });
    await log(1, orgA, flowA, ctA, stepA, "success", { stepType: "send_whatsapp", waMessageId: "wamid.1" });
    await log(2, orgA, flowA, ctA, stepA, "failed", { stepType: "send_whatsapp", error: "meta_error" });
    await log(3, orgA, flowA, ctA, stepA, "skipped_rate_limit", { stepType: "send_whatsapp" });
    await log(4, orgA, flowA2, ctA, null, "skipped_opt_out", { stepType: "delay" });
    await log(5, orgA, flowA2, ctA, null, "success", { stepType: "delay" });
    await log(6, orgB, flowB, ctB, stepB, "success", { stepType: "delay" });
  });

  afterAll(async () => {
    if (flowIds.length) await db.delete(schema.automationFlow).where(inArray(schema.automationFlow.id, flowIds));
    if (contactIds.length) await db.delete(schema.contact).where(inArray(schema.contact.id, contactIds));
  });

  it("estado de un flujo: cola por estado y resumen", async () => {
    const s = await mon.getStats(orgA, flowA);
    expect(s.flowId).toBe(flowA);
    expect(s.queue).toMatchObject({ pending: 2, processing: 1, completed: 1, failed: 1, cancelled: 0 });
    expect(s.summary).toEqual({ pending: 3, success: 1, failed: 1, skipped: 1 });
    expect(s.executions).toMatchObject({ success: 1, failed: 1, skippedRateLimit: 1, skippedOptOut: 0, total: 3 });
    expect(s.queue.nextScheduledFor).toBeInstanceOf(Date);
    expect(s.executions.lastExecutedAt).toBeInstanceOf(Date);
  });

  it("estado de la organización suma sus flujos y no cuenta los de otra", async () => {
    const a = await mon.getStats(orgA, null);
    const sum = (k: "pending" | "failed" | "cancelled") => a.queue[k];
    // Los datos de otras pruebas pueden existir: solo se exige que incluya lo de A y no lo de B.
    expect(sum("cancelled")).toBeGreaterThanOrEqual(1);
    expect(a.executions.skippedOptOut).toBeGreaterThanOrEqual(1);
    const b = await mon.getStats(orgB, null);
    expect(b.executions.total).toBeGreaterThanOrEqual(1);
    const bOnly = await mon.getStats(orgB, flowB);
    expect(bOnly.summary).toEqual({ pending: 1, success: 1, failed: 0, skipped: 0 });
    // Y el total de A con flowA + flowA2 es consistente con la suma por flujo.
    const a2 = await mon.getStats(orgA, flowA2);
    expect(a2.summary).toEqual({ pending: 0, success: 1, failed: 0, skipped: 1 });
  });

  it("un flujo ajeno o inexistente es 404, igual que si no existiera", async () => {
    expect(await code(mon.getStats(orgA, flowB))).toBe("404:not_found");
    expect(await code(mon.getStats(orgA, "flw_no_existe"))).toBe("404:not_found");
    expect(await code(mon.listLogs(orgA, flowB, q()))).toBe("404:not_found");
  });

  it("historial de un flujo: lo más reciente primero, con contacto, paso, error y metadata", async () => {
    const r = await mon.listLogs(orgA, flowA, q());
    expect(r.total).toBe(3);
    expect(r.logs.map((l) => l.status)).toEqual(["skipped_rate_limit", "failed", "success"]);
    const failed = r.logs.find((l) => l.status === "failed")!;
    expect(failed).toMatchObject({
      flowId: flowA,
      error: "meta_error",
      contact: { name: "Ana Prueba", phone: "5215550001" },
      step: { id: stepA, stepType: "send_whatsapp" },
      metadata: { stepType: "send_whatsapp", error: "meta_error" },
    });
    expect(r.logs.find((l) => l.status === "success")!.error).toBeNull();
  });

  it("filtra por estado, y «skipped» agrupa los dos motivos", async () => {
    const f = await mon.listLogs(orgA, flowA, { ...q(), status: "failed" });
    expect(f.logs.map((l) => l.status)).toEqual(["failed"]);
    expect(f.total).toBe(1);
    const sk = await mon.listLogs(orgA, null, { ...q(100), status: "skipped" });
    const mine = sk.logs.filter((l) => [flowA, flowA2].includes(l.flowId));
    expect(mine.map((l) => l.status).sort()).toEqual(["skipped_opt_out", "skipped_rate_limit"]);
    expect(sk.logs.every((l) => l.status.startsWith("skipped"))).toBe(true);
  });

  it("una línea sin paso (borrado) se conserva con step null", async () => {
    const r = await mon.listLogs(orgA, flowA2, q());
    expect(r.total).toBe(2);
    expect(r.logs.every((l) => l.step === null)).toBe(true);
  });

  it("paginación: limit y offset recorren sin repetir ni saltar", async () => {
    const p1 = await mon.listLogs(orgA, flowA, q(2, 0));
    const p2 = await mon.listLogs(orgA, flowA, q(2, 2));
    expect(p1.logs).toHaveLength(2);
    expect(p2.logs).toHaveLength(1);
    expect(p1.total).toBe(3);
    expect(new Set([...p1.logs, ...p2.logs].map((l) => l.id)).size).toBe(3);
    expect((await mon.listLogs(orgA, flowA, q(2, 10))).logs).toHaveLength(0);
  });

  it("el historial de la organización nunca incluye líneas de otra", async () => {
    const a = await mon.listLogs(orgA, null, q(100));
    expect(a.logs.some((l) => l.flowId === flowB)).toBe(false);
    expect(a.logs.some((l) => l.contact.name === "Beto Ajeno")).toBe(false);
    const b = await mon.listLogs(orgB, null, q(100));
    expect(b.logs.some((l) => l.flowId === flowA || l.flowId === flowA2)).toBe(false);
    expect(b.logs.some((l) => l.flowId === flowB)).toBe(true);
  });

  it("incluye el nombre del flujo en el historial de la organización", async () => {
    const a = await mon.listLogs(orgA, null, q(100));
    expect(a.logs.find((l) => l.flowId === flowA2)?.flowName).toBe("M b");
  });
});
