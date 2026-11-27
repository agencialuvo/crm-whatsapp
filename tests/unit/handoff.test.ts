import { describe, expect, it } from "vitest";
import { matchesHandoffIntent } from "@/server/ai/handoff";

describe("patrón de respaldo de handoff (FR-022 / SC-006)", () => {
  it.each([
    "quiero hablar con un humano",
    "¿puedo hablar con un asesor?",
    "necesito comunicarme con alguien",
    "quiero contactar a una persona real",
    "quiero hablar con alguien por favor",
    "me pasas a un asesor",
    "prefiero atención humana",
    "atencion humana por favor",
  ])("dispara: %s", (text) => {
    expect(matchesHandoffIntent(text)).toBe(true);
  });

  it.each([
    "somos 4 personas", // el caso canónico que NO debe disparar
    "somos cuatro personas y queremos reservar",
    "¿tienen taladros?",
    "la persona que me atendió ayer fue amable",
    "mi humano favorito es mi hijo",
    "el asesor fiscal ya me cobró", // sin verbo de contacto ni "un asesor"
  ])("NO dispara: %s", (text) => {
    expect(matchesHandoffIntent(text)).toBe(false);
  });
});

describe("Mejora 6 — sin falsos positivos por servicios, roles o planes", () => {
  it.each([
    "quiero hablar del plan personalizado",
    "¿tienen un asesor de imagen?",
    "quiero un asesor de imagen para mi boda",
    "¿el plan incluye asesor personal?",
    "¿puedo hablar de precios para 2 personas?",
    "voy a pasar a recoger a la persona que vino ayer",
    "ofrecen atención personalizada?",
    "¿hablan con agentes inmobiliarios?",
    "quiero hablar con un asesor financiero sobre el crédito", // es el servicio, no un traspaso
    "no quiero hablar con un humano, sigue tú",
    "no hace falta que me pases a un asesor",
    "¿cuántas personas caben?",
    "mi agente de viajes me recomendó este lugar",
  ])("NO dispara: %s", (text) => {
    expect(matchesHandoffIntent(text)).toBe(false);
  });

  it.each([
    "Quiero HABLAR con una PERSONA",
    "¿me puedes pasar con un asesor?",
    "pásame con alguien del equipo",
    "quiero hablar directamente con el encargado",
    "que me atienda una persona por favor",
    "quiero un asesor",
    "necesito una persona real",
    "asesor",
    "Un humano por favor!!",
    "¿puedo comunicarme con un agente?",
    "transfiéreme con un operador",
  ])("dispara: %s", (text) => {
    expect(matchesHandoffIntent(text)).toBe(true);
  });
});
