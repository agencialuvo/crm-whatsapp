import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mejora 11 — `revalidarTurno` lee la conversación, el perfil del agente y si hubo un saliente de una persona
 * después del entrante, y decide. Si la lectura falla, cancela (no habla encima de nadie).
 */

const selectQueue: unknown[][] = [];
let falla = false;

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (falla) throw new Error("base caída");
    const chain = (rows: unknown[]) => {
      const c: Record<string, unknown> = {};
      for (const m of ["from", "where", "limit"]) c[m] = () => c;
      (c as { then: unknown }).then = (r: (v: unknown) => void) => Promise.resolve(rows).then(r);
      return c;
    };
    return { select: () => chain(selectQueue.shift() ?? []) };
  },
  schema: new Proxy({}, { get: (_t, t) => new Proxy({}, { get: (_t2, c) => `${String(t)}.${String(c)}` }) }),
}));

let revalidarTurno: typeof import("@/server/ai/turn-guard").revalidarTurno;
beforeAll(async () => {
  ({ revalidarTurno } = await import("@/server/ai/turn-guard"));
}, 60_000);

const input = { organizationId: "org_1", conversationId: "cv_1", desde: new Date() };
const conv = { aiEnabled: true, handoffAt: null, isTest: false };

beforeEach(() => {
  selectQueue.length = 0;
  falla = false;
});

describe("revalidarTurno", () => {
  it("vigente: IA encendida, sin traspaso, agente encendido y nadie contestó", async () => {
    selectQueue.push([conv], [{ enabled: true }], []);
    expect(await revalidarTurno(input)).toEqual({ ok: true });
  });

  it("una persona contestó después del entrante → cancela", async () => {
    selectQueue.push([conv], [{ enabled: true }], [{ id: "msg_humano" }]);
    expect(await revalidarTurno(input)).toEqual({ ok: false, motivo: "persona_respondio" });
  });

  it("la tomaron (traspaso) mientras el modelo pensaba → cancela", async () => {
    selectQueue.push([{ ...conv, handoffAt: new Date() }], [{ enabled: true }], []);
    expect(await revalidarTurno(input)).toEqual({ ok: false, motivo: "traspasada" });
  });

  it("apagaron el agente → cancela", async () => {
    selectQueue.push([conv], [{ enabled: false }], []);
    expect(await revalidarTurno(input)).toEqual({ ok: false, motivo: "agente_apagado" });
  });

  it("la conversación ya no existe → cancela", async () => {
    selectQueue.push([], [{ enabled: true }], []);
    expect(await revalidarTurno(input)).toEqual({ ok: false, motivo: "conversacion_borrada" });
  });

  it("si la base falla, cancela con el motivo (y lo registra)", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    falla = true;
    expect(await revalidarTurno(input)).toEqual({ ok: false, motivo: "error_consulta" });
    expect(consola).toHaveBeenCalled();
    consola.mockRestore();
  });
});
