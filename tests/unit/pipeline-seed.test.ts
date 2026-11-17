import { describe, expect, it } from "vitest";
import { SEED_STAGES } from "@/server/auth/on-signup";
import { aiMockCompletion } from "@/server/dev/ai-mock";

/**
 * El pipeline con el que nace un negocio NUEVO. Los existentes conservan sus etapas: el motor y el agente
 * trabajan con `id` y `kind`, nunca con nombres.
 */
describe("etapas sembradas para los negocios nuevos", () => {
  it("son Nuevo, En conversación, Interesado, Cliente (ganada) y No interesado (perdida), con su papel automático", () => {
    expect(SEED_STAGES).toEqual([
      { name: "Nuevo", kind: "open", autoRole: "new" },
      { name: "En conversación", kind: "open", autoRole: "conversation" },
      { name: "Interesado", kind: "open", autoRole: "interested" },
      { name: "Cliente", kind: "won", autoRole: "client" },
      { name: "No interesado", kind: "lost", autoRole: null },
    ]);
  });

  it("cada papel automático aparece una sola vez (lo exige el índice único)", () => {
    const roles = SEED_STAGES.map((s) => s.autoRole).filter(Boolean);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("hay exactamente una ganada y una perdida (las anclas que el sistema exige)", () => {
    expect(SEED_STAGES.filter((s) => s.kind === "won")).toHaveLength(1);
    expect(SEED_STAGES.filter((s) => s.kind === "lost")).toHaveLength(1);
  });
});

describe("el ai-mock mueve al lead a la etapa de interés que tenga el negocio", () => {
  const ask = (stages: string) =>
    JSON.parse(
      aiMockCompletion([
        { role: "system", content: `Eres un asistente.\n\nEtapas del pipeline disponibles: ${stages}` },
        { role: "user", content: "Perfecto, lo compro" },
      ])
    ) as { action: string; stage?: string };

  it("negocio nuevo → Contactado", () => {
    expect(ask("Nuevo | Contactado | Citado | Convertido | No interesado")).toMatchObject({ action: "move_stage", stage: "Contactado" });
  });
  it("negocio anterior → Interesado", () => {
    expect(ask("Nuevo | En conversación | Interesado | Cliente | Perdido")).toMatchObject({ action: "move_stage", stage: "Interesado" });
  });
});
