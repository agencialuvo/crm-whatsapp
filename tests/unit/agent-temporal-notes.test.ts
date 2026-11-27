import { describe, expect, it } from "vitest";
import { abiertoAhora, contextoTemporal, describirHorario, relojLocal } from "@/lib/agent/temporal";
import { AI_NOTE_MAX_CHARS, AI_NOTES_MAX, appendAiNote } from "@/lib/agent/notes";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";

// Jueves 26 de noviembre de 2026, 15:30 UTC = 10:30 en Lima (UTC-5).
const NOW = new Date(Date.UTC(2026, 10, 26, 15, 30));
const HORARIO = {
  mon: [{ start: "09:00", end: "18:00" }],
  thu: [{ start: "09:00", end: "13:00" }, { start: "16:00", end: "20:00" }],
};

describe("Mejora 1 — contexto temporal del agente", () => {
  it("lee el día y la hora de pared en la zona del negocio", () => {
    expect(relojLocal(NOW, "America/Lima")).toEqual({ dia: "thu", hora: "10:30" });
    expect(relojLocal(NOW, "Asia/Tokyo")).toEqual({ dia: "fri", hora: "00:30" });
  });

  it("incluye la fecha completa, la hora y la zona", () => {
    const txt = contextoTemporal({ now: NOW, timeZone: "America/Lima" });
    expect(txt).toContain("jueves, 26 de noviembre de 2026");
    expect(txt).toContain("10:30");
    expect(txt).toContain("America/Lima");
    expect(txt).not.toContain("HORARIO");
  });

  it("con horario: lo describe día por día y dice si está abierto ahora", () => {
    expect(describirHorario(HORARIO)).toContain("jueves 09:00–13:00 y 16:00–20:00");
    expect(describirHorario(HORARIO)).toContain("domingo cerrado");
    expect(abiertoAhora(NOW, "America/Lima", HORARIO)).toBe(true);
    // 14:00 en Lima: entre los dos tramos del jueves.
    expect(abiertoAhora(new Date(Date.UTC(2026, 10, 26, 19, 0)), "America/Lima", HORARIO)).toBe(false);
    const txt = contextoTemporal({ now: NOW, timeZone: "America/Lima", horario: HORARIO });
    expect(txt).toContain("DENTRO");
  });

  it("un horario vacío o con tramos rotos no inventa nada", () => {
    expect(abiertoAhora(NOW, "America/Lima", {})).toBeNull();
    expect(abiertoAhora(NOW, "America/Lima", { thu: [{ start: "25:00", end: "x" }] })).toBeNull();
    expect(contextoTemporal({ now: NOW, timeZone: "America/Lima", horario: {} })).not.toContain("HORARIO");
  });

  it("llega al system prompt", () => {
    const prompt = buildAgentSystemPrompt({
      profile: { name: "Ana", tone: null, instructions: null, escalationRules: null, greeting: null } as never,
      kb: [],
      stages: [],
      contextoTemporal: contextoTemporal({ now: NOW, timeZone: "America/Lima" }),
    });
    expect(prompt).toContain("FECHA Y HORA ACTUAL DEL NEGOCIO");
  });
});

describe("Mejora 2 — notas [IA] consolidadas", () => {
  it("agrega la primera nota", () => {
    expect(appendAiNote(null, "Quiere un corte")).toBe("[IA] Quiere un corte");
  });

  it("no repite una nota igual (sin distinguir mayúsculas ni espacios)", () => {
    expect(appendAiNote("[IA] Quiere un corte", "  quiere   UN corte ")).toBeNull();
  });

  it("ignora notas vacías", () => {
    expect(appendAiNote("algo", "   ")).toBeNull();
  });

  it("conserva solo las últimas notas de la IA y no toca las de las personas", () => {
    let notas: string | null = "Cliente frecuente (lo escribió Ana)";
    for (let i = 0; i < AI_NOTES_MAX + 5; i++) notas = appendAiNote(notas, `nota ${i}`) ?? notas;
    const lineas = notas!.split("\n");
    expect(lineas[0]).toBe("Cliente frecuente (lo escribió Ana)");
    expect(lineas.filter((l) => l.startsWith("[IA] "))).toHaveLength(AI_NOTES_MAX);
    expect(lineas.at(-1)).toBe(`[IA] nota ${AI_NOTES_MAX + 4}`);
    expect(notas).not.toContain("[IA] nota 0\n");
  });

  it("acota el largo de cada nota", () => {
    const nota = appendAiNote(null, "x".repeat(AI_NOTE_MAX_CHARS * 2))!;
    expect(nota.length).toBe("[IA] ".length + AI_NOTE_MAX_CHARS);
    expect(nota.endsWith("…")).toBe(true);
  });
});
