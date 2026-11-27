import { describe, expect, it } from "vitest";
import {
  KB_MAX_CHARS,
  KB_MAX_ENTRIES,
  kbChars,
  kbLimitError,
  renderKbForPrompt,
  renderKbText,
} from "@/lib/kb-budget";
import { MAX_PARTES_RESPUESTA, partirParaCanal } from "@/lib/agent/split";
import { textoParaModelo } from "@/lib/agent/history";
import { decidirVigencia } from "@/lib/agent/vigencia";
import {
  LAB_RUNS_PER_DAY_ACTIVE,
  LAB_RUNS_PER_DAY_TRIAL,
  labDailyLimit,
} from "@/lib/lab-limits";
import { textFits } from "@/server/channels/capabilities";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";

const qa = (q: string, a: string) => ({ kind: "qa", question: q, answer: a, content: null });
const bloque = (c: string) => ({ kind: "block", question: null, answer: null, content: c });

describe("Mejora 5 — presupuesto del conocimiento", () => {
  it("renderiza igual que antes (P/R y bloques separados por línea en blanco)", () => {
    expect(renderKbText([qa("¿Envíos?", "Sí"), bloque("Horario 9 a 6")])).toBe("P: ¿Envíos?\nR: Sí\n\nHorario 9 a 6");
    expect(renderKbText([])).toBe("(knowledge base vacío)");
    expect(kbChars([])).toBe(0);
  });

  it("dentro del presupuesto entra entero, sin nota", () => {
    const r = renderKbForPrompt([qa("a", "b")], 1000);
    expect(r.omitted).toBe(0);
    expect(r.text).toBe("P: a\nR: b");
  });

  it("pasado el presupuesto recorta por entradas COMPLETAS y avisa al modelo", () => {
    const entradas = [bloque("x".repeat(60)), bloque("y".repeat(60)), bloque("z".repeat(10))];
    const r = renderKbForPrompt(entradas, 100);
    expect(r.text).toContain("x".repeat(60));
    expect(r.text).not.toContain("y");
    expect(r.text).toContain("z".repeat(10)); // una entrada corta posterior sí cabe
    expect(r.omitted).toBe(1);
    expect(r.text).toContain("no cupieron");
  });

  it("el prompt del agente nunca pasa del presupuesto aunque el conocimiento guardado sea enorme", () => {
    const kb = Array.from({ length: 30 }, (_, i) => bloque(`${i}`.padEnd(3000, "k")));
    const prompt = buildAgentSystemPrompt({
      profile: { name: "Ana", tone: null, instructions: null, escalationRules: null, greeting: null } as never,
      kb: kb as never,
      stages: [],
    });
    expect(prompt.length).toBeLessThan(KB_MAX_CHARS + 6000);
    expect(prompt).toContain("no cupieron");
  });

  it("al guardar: rechaza pasar del tope de caracteres o de entradas, con un mensaje claro", () => {
    expect(kbLimitError([bloque("a")])).toBeNull();
    expect(kbLimitError([bloque("a".repeat(KB_MAX_CHARS + 1))])).toMatch(/máximo/);
    expect(kbLimitError(Array.from({ length: KB_MAX_ENTRIES + 1 }, () => bloque("a")))).toMatch(/entradas/);
  });
});

describe("Mejora 7 — partir la respuesta para el canal", () => {
  const cabeWa = (s: string) => textFits("whatsapp", s);

  it("un texto que cabe sale en un solo mensaje", () => {
    expect(partirParaCanal("Hola, ¿en qué te ayudo?", cabeWa)).toEqual(["Hola, ¿en qué te ayudo?"]);
    expect(partirParaCanal("   ", cabeWa)).toEqual([]);
  });

  it("uno de más de 4096 caracteres se parte por párrafos y cada parte cabe en WhatsApp", () => {
    const parrafo = "Lorem ipsum dolor sit amet. ".repeat(60).trim(); // ~1680
    const texto = [parrafo, parrafo, parrafo].join("\n\n"); // ~5000
    const partes = partirParaCanal(texto, cabeWa);
    expect(partes.length).toBe(2);
    expect(partes.every(cabeWa)).toBe(true);
    expect(partes.join("\n\n")).toBe(texto); // sin perder nada
  });

  it("un párrafo gigante se parte por oraciones; una palabra infinita, por caracteres", () => {
    const oraciones = Array.from({ length: 30 }, (_, i) => `Oración número ${i} con algo de texto.`).join(" ");
    const partes = partirParaCanal(oraciones, (s) => s.length <= 200);
    expect(partes.every((p) => p.length <= 200)).toBe(true);
    expect(partes.length).toBeLessThanOrEqual(MAX_PARTES_RESPUESTA);

    const duro = partirParaCanal("a".repeat(250), (s) => s.length <= 100);
    expect(duro.every((p) => p.length <= 100)).toBe(true);
    expect(duro.join("")).toBe("a".repeat(250));
  });

  it("más de tres partes: se recorta la última con «…» y todas siguen cabiendo", () => {
    const texto = Array.from({ length: 10 }, () => "b".repeat(90)).join("\n\n");
    const partes = partirParaCanal(texto, (s) => s.length <= 100);
    expect(partes).toHaveLength(MAX_PARTES_RESPUESTA);
    expect(partes.at(-1)!.endsWith("…")).toBe(true);
    expect(partes.every((p) => p.length <= 100)).toBe(true);
  });

  it("respeta el límite en BYTES de Instagram (acentos y emojis pesan más)", () => {
    const texto = "Árbol ñandú 🎉 ".repeat(200);
    const partes = partirParaCanal(texto, (s) => textFits("instagram", s));
    expect(partes.every((p) => textFits("instagram", p))).toBe(true);
  });
});

describe("Mejora 10 — adjuntos en el historial del modelo", () => {
  it("el texto normal pasa tal cual", () => {
    expect(textoParaModelo({ direction: "in", type: "text", text: "hola" })).toBe("hola");
  });

  it("una nota de voz sin texto llega como marcador (antes se descartaba)", () => {
    expect(textoParaModelo({ direction: "in", type: "audio", text: null })).toBe(
      "[El cliente envió una nota de voz o audio sin texto]"
    );
  });

  it("una imagen con pie de foto lleva el pie, sin comillas que rompan la cita", () => {
    expect(
      textoParaModelo({ direction: "in", type: "image", text: null, caption: 'mi "boleta" de pago' })
    ).toBe("[El cliente envió una imagen con este texto: \"mi 'boleta' de pago\"]");
  });

  it("los salientes con adjunto y los tipos desconocidos también se describen", () => {
    expect(textoParaModelo({ direction: "out", type: "document", text: null, caption: "Catálogo" })).toBe(
      '[Se le envió al cliente un documento: "Catálogo"]'
    );
    expect(textoParaModelo({ direction: "in", type: "unsupported", text: null })).toContain("no es texto");
  });

  it("un saliente de texto vacío no aporta nada", () => {
    expect(textoParaModelo({ direction: "out", type: "text", text: "  " })).toBeNull();
  });

  it("el prompt enseña al agente qué hacer con los marcadores", () => {
    const prompt = buildAgentSystemPrompt({
      profile: { name: "Ana", tone: null, instructions: null, escalationRules: null, greeting: null } as never,
      kb: [],
      stages: [],
    });
    expect(prompt).toContain("NO puedes ver ni escuchar");
    expect(prompt).toContain("me lo escribes");
  });
});

describe("Mejora 11 — vigencia del turno antes de enviar", () => {
  const conv = { aiEnabled: true, handoffAt: null, isTest: false };
  it("todo en orden → sigue", () => {
    expect(decidirVigencia({ conversation: conv, agentEnabled: true, personaRespondio: false })).toEqual({ ok: true });
  });
  it.each([
    [{ conversation: null, agentEnabled: true, personaRespondio: false }, "conversacion_borrada"],
    [{ conversation: { ...conv, handoffAt: new Date() }, agentEnabled: true, personaRespondio: false }, "traspasada"],
    [{ conversation: { ...conv, aiEnabled: false }, agentEnabled: true, personaRespondio: false }, "ia_apagada"],
    [{ conversation: conv, agentEnabled: false, personaRespondio: false }, "agente_apagado"],
    [{ conversation: conv, agentEnabled: null, personaRespondio: false }, "agente_apagado"],
    [{ conversation: conv, agentEnabled: true, personaRespondio: true }, "persona_respondio"],
  ] as const)("cancela: %j → %s", (estado, motivo) => {
    expect(decidirVigencia(estado)).toEqual({ ok: false, motivo });
  });
  it("el Laboratorio sigue aunque el agente esté apagado", () => {
    expect(
      decidirVigencia({ conversation: { ...conv, isTest: true }, agentEnabled: false, personaRespondio: false })
    ).toEqual({ ok: true });
  });
});

describe("Mejora 8 — cupo diario del Laboratorio", () => {
  it.each([
    [{ subscriptionStatus: "active", sinSaldo: false }, LAB_RUNS_PER_DAY_ACTIVE],
    [{ subscriptionStatus: null, sinSaldo: false }, LAB_RUNS_PER_DAY_ACTIVE],
    [{ subscriptionStatus: "trialing", sinSaldo: false }, LAB_RUNS_PER_DAY_TRIAL],
    [{ subscriptionStatus: "past_due", sinSaldo: false }, LAB_RUNS_PER_DAY_TRIAL],
    [{ subscriptionStatus: "active", sinSaldo: true }, LAB_RUNS_PER_DAY_TRIAL],
  ] as const)("%j → %i", (input, esperado) => {
    expect(labDailyLimit(input)).toBe(esperado);
  });
  it("Demo/sin saldo = 5 y activa = 25", () => {
    expect(LAB_RUNS_PER_DAY_TRIAL).toBe(5);
    expect(LAB_RUNS_PER_DAY_ACTIVE).toBe(25);
  });
});
