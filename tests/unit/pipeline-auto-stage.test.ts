import { describe, expect, it } from "vitest";
import { decodeColumnCursor, encodeColumnCursor } from "@/lib/pipeline-cursor";
import { decideAutoStage, RULE_TARGET, type StageKind } from "@/lib/lead-auto-stage";
import type { AutoStageRole, AutoStageRule } from "@/lib/types";

/** 044 — Las reglas de avance automático del lead y el cursor de columna, sin base de datos. */

const ROLES: (AutoStageRole | null)[] = ["new", "conversation", "interested", "client", null];
const KINDS: StageKind[] = ["open", "won", "lost"];

describe("decideAutoStage", () => {
  const decide = (rule: AutoStageRule, kind: StageKind, role: AutoStageRole | null) =>
    decideAutoStage({ rule, current: { kind, role } });

  it("primera respuesta: solo de «Nuevo» a «En conversación»", () => {
    expect(decide("first_reply", "open", "new")).toBe("conversation");
    for (const role of ROLES.filter((r) => r !== "new")) expect(decide("first_reply", "open", role)).toBeNull();
  });

  it("cita agendada: de «Nuevo» o «En conversación» a «Interesado»", () => {
    expect(decide("booking", "open", "new")).toBe("interested");
    expect(decide("booking", "open", "conversation")).toBe("interested");
    expect(decide("booking", "open", "interested")).toBeNull();
    expect(decide("booking", "open", "client")).toBeNull();
    expect(decide("booking", "open", null)).toBeNull();
  });

  it("venta: salta a «Cliente» desde cualquier etapa abierta, con o sin papel (incluido el salto directo desde «Nuevo»)", () => {
    for (const role of ["new", "conversation", "interested", null] as const) {
      expect(decide("sale", "open", role)).toBe("client");
    }
    expect(decide("sale", "open", "client")).toBeNull(); // ya está ahí
  });

  it("jamás toca una etapa ganada o perdida (requiere trato manual), sea cual sea la regla", () => {
    for (const rule of Object.keys(RULE_TARGET) as AutoStageRule[]) {
      for (const role of ROLES) {
        expect(decide(rule, "won", role)).toBeNull();
        expect(decide(rule, "lost", role)).toBeNull();
      }
    }
  });

  it("una etapa abierta SIN papel la puso el dueño a propósito: solo la venta la mueve", () => {
    expect(decide("first_reply", "open", null)).toBeNull();
    expect(decide("booking", "open", null)).toBeNull();
    expect(decide("sale", "open", null)).toBe("client");
  });

  it("solo avanza: el destino nunca es anterior al papel actual en el orden new < conversation < interested < client", () => {
    const orden: Record<AutoStageRole, number> = { new: 0, conversation: 1, interested: 2, client: 3 };
    for (const rule of Object.keys(RULE_TARGET) as AutoStageRule[]) {
      for (const kind of KINDS) {
        for (const role of ROLES) {
          const d = decide(rule, kind, role);
          if (d && role) expect(orden[d]).toBeGreaterThan(orden[role]);
        }
      }
    }
  });

  it("cada regla persigue su papel", () => {
    expect(RULE_TARGET).toEqual({ first_reply: "conversation", booking: "interested", sale: "client" });
  });
});

describe("cursor de columna", () => {
  it("ida y vuelta, también con una posición negativa (un lead nuevo entra arriba con min − 1)", () => {
    for (const p of [0, 7, -1, -250, 1_000_000]) {
      const c = { p, id: "lead_abc-123" };
      expect(decodeColumnCursor(encodeColumnCursor(c))).toEqual(c);
    }
  });

  it("rechaza un cursor manipulado", () => {
    expect(decodeColumnCursor("basura")).toBeNull();
    expect(decodeColumnCursor(Buffer.from("{}").toString("base64url"))).toBeNull();
    expect(decodeColumnCursor(Buffer.from(JSON.stringify({ p: "1", id: "x" })).toString("base64url"))).toBeNull();
    expect(decodeColumnCursor(Buffer.from(JSON.stringify({ p: 1.5, id: "x" })).toString("base64url"))).toBeNull();
    expect(decodeColumnCursor(Buffer.from(JSON.stringify({ p: 1, id: "x' or 1=1 --" })).toString("base64url"))).toBeNull();
    expect(decodeColumnCursor("a".repeat(500))).toBeNull();
  });
});
