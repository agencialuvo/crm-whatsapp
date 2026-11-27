import { describe, expect, it } from "vitest";
import { correccionExclusiva, detectarFugaExclusiva, respuestaSeguraExclusiva } from "@/lib/ad-flow-guard";
import { personasDeAnuncio, AD_PERSONA_KEYS, PERSONA_LABELS } from "@/server/lab/personas";
import { buildJudgePrompt, describirAnuncioParaJuez } from "@/server/ai/prompts";
import { textosDeAccion } from "@/server/ai/exclusive-guard";

const base = { objetivo: "Corte clásico", rivales: ["Tinte completo", "Manicure", "Corte"], ultimoDelCliente: null };

describe("Bloque 2 — validación determinista del anuncio exclusivo", () => {
  it("hablar solo del objetivo no es fuga", () => {
    expect(detectarFugaExclusiva({ ...base, texto: "El Corte clásico cuesta S/ 25. ¿Te agendo mañana?" })).toEqual({
      violacion: false,
    });
  });

  it("ofrecer otro servicio que el cliente no pidió → ofrece_otro", () => {
    const f = detectarFugaExclusiva({ ...base, texto: "¡Claro! Y si quieres también hacemos manicure." });
    expect(f).toEqual({ violacion: true, motivo: "ofrece_otro", nombres: ["manicure"] });
  });

  it("cotizar el otro servicio, aunque el cliente lo haya pedido → cotiza_otro", () => {
    const f = detectarFugaExclusiva({
      ...base,
      ultimoDelCliente: "¿y el tinte completo cuánto?",
      texto: "El tinte completo está en S/ 120.",
    });
    expect(f).toMatchObject({ violacion: true, motivo: "cotiza_otro", nombres: ["tinte completo"] });
  });

  it("redirigir en una frase lo que el cliente preguntó, sin precio, está permitido", () => {
    expect(
      detectarFugaExclusiva({
        ...base,
        ultimoDelCliente: "¿hacen tinte completo?",
        texto: "En esta conversación te ayudo con el Corte clásico; el tinte completo lo vemos aparte. ¿Te agendo?",
      })
    ).toEqual({ violacion: false });
  });

  it("el precio del objetivo en otra oración no se le atribuye al otro servicio", () => {
    expect(
      detectarFugaExclusiva({
        ...base,
        ultimoDelCliente: "¿y el tinte completo?",
        texto: "El tinte completo no lo vemos por aquí. El Corte clásico cuesta S/ 25, ¿lo agendamos?",
      })
    ).toEqual({ violacion: false });
  });

  it("ignora rivales contenidos en el objetivo («Corte» dentro de «Corte clásico») y las tildes/mayúsculas cuentan igual", () => {
    expect(detectarFugaExclusiva({ ...base, texto: "Tu corte queda listo en 30 minutos." })).toEqual({ violacion: false });
    expect(detectarFugaExclusiva({ ...base, texto: "También tenemos MANÍCURE." })).toMatchObject({ violacion: true });
  });

  it("palabra completa: «manicures» no es «manicure»; un nombre de menos de 4 letras se ignora", () => {
    expect(detectarFugaExclusiva({ ...base, rivales: ["Spa"], texto: "Ven al spa del centro" })).toEqual({ violacion: false });
    expect(
      detectarFugaExclusiva({ ...base, rivales: ["Tinte"], texto: "Los tintes los vemos luego" })
    ).toEqual({ violacion: false });
  });

  it("la corrección y la respuesta segura nombran el objetivo", () => {
    const f = { violacion: true as const, motivo: "cotiza_otro" as const, nombres: ["tinte completo"] };
    expect(correccionExclusiva("Corte clásico", f)).toContain("«Corte clásico»");
    expect(correccionExclusiva("Corte clásico", f)).toContain("«tinte completo»");
    expect(respuestaSeguraExclusiva("Corte clásico", "S/ 25.00")).toBe(
      "Por aquí te ayudo con «Corte clásico» (S/ 25.00). ¿Quieres que lo agendemos?"
    );
  });

  it("textosDeAccion: revisa lo que de verdad sale al cliente", () => {
    expect(textosDeAccion({ action: "reply", text: "hola" })).toEqual([{ campo: "text", texto: "hola" }]);
    expect(textosDeAccion({ action: "handoff", farewell: "adiós" })).toEqual([{ campo: "farewell", texto: "adiós" }]);
    expect(textosDeAccion({ action: "offer_slots", reply: "Mira" })).toEqual([{ campo: "reply", texto: "Mira" }]);
    expect(textosDeAccion({ action: "none" })).toEqual([]);
    expect(textosDeAccion({ action: "update_lead", note: "x" })).toEqual([]);
  });
});

describe("Bloque 2 — Laboratorio de anuncio", () => {
  it("las personas de anuncio usan el objetivo y otro servicio real", () => {
    const [interesado, pideOtro] = personasDeAnuncio({ objetivo: "Corte clásico", otro: "Tinte completo" });
    expect([interesado!.key, pideOtro!.key]).toEqual([...AD_PERSONA_KEYS]);
    expect(interesado!.script[0]).toContain("Corte clásico");
    expect(pideOtro!.script.join(" ")).toContain("Tinte completo");
    expect(new Set([interesado!.phone, pideOtro!.phone]).size).toBe(2);
    expect(PERSONA_LABELS.anuncio_pide_otro).toBeTruthy();
  });

  it("sin otro servicio en el catálogo, la persona pregunta por «otros servicios»", () => {
    const [, pideOtro] = personasDeAnuncio({ objetivo: "Corte", otro: null });
    expect(pideOtro!.script[1]).toContain("otros servicios");
  });

  it("el juez recibe el contexto del anuncio y la regla de exclusividad", () => {
    const anuncioText = describirAnuncioParaJuez({
      headline: "2x1 en cortes",
      sourceId: "ad_123",
      adFlow: {
        flowId: "adf_1",
        sourceId: "ad_123",
        exclusive: true,
        promptRules: "Menciona que es solo esta semana",
        target: { kind: "service", id: "svc_1", name: "Corte clásico", description: null, priceLabel: "S/ 25.00", durationMinutes: 30, providers: null },
      },
    });
    expect(anuncioText).toContain("EXCLUSIVO");
    expect(anuncioText).toContain("«Corte clásico»");
    const { system, user } = buildJudgePrompt({ persona: "anuncio_pide_otro", transcript: [], kbText: "", behaviorText: "", anuncioText });
    expect(system).toContain("fuera_del_anuncio");
    expect(user).toContain("CONTEXTO DE ANUNCIO");
  });

  it("una corrida normal no menciona anuncios al juez", () => {
    const { system, user } = buildJudgePrompt({ persona: "x", transcript: [], kbText: "", behaviorText: "" });
    expect(system).not.toContain("ANUNCIO (ver");
    expect(user).not.toContain("CONTEXTO DE ANUNCIO");
  });
});
