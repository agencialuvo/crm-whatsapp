import { describe, expect, it } from "vitest";
import {
  BASE_ESPERA_MS,
  decidirReintento,
  escribirFetchError,
  esperaTrasIntentos,
  leerFetchError,
  MAX_ESPERA_MS,
  MAX_INTENTOS,
  PENDIENTE_MIN_EDAD_MS,
  REINTENTO_VENTANA_DIAS,
  type AdjuntoParaReintento,
} from "@/lib/media-retry";

/**
 * Hallazgo J — reglas puras del reintento proactivo de adjuntos entrantes pendientes o fallidos: espera creciente, tope de
 * intentos, vigencia de Meta (< 28 días) y lo que Meta ya dio por borrado.
 */

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const NOW = new Date("2026-11-20T12:00:00Z");
const hace = (ms: number) => new Date(NOW.getTime() - ms);

function adjunto(extra: Partial<AdjuntoParaReintento> = {}): AdjuntoParaReintento {
  return {
    kind: "video",
    fetchStatus: "failed",
    waMediaId: "wa_1",
    libraryItemId: null,
    fetchError: "[intento 1] R2 caído",
    createdAt: hace(2 * DIA),
    updatedAt: hace(2 * HORA),
    ...extra,
  };
}

describe("fetch_error: el intento y lo permanente viajan en el texto", () => {
  it("ida y vuelta", () => {
    expect(escribirFetchError({ intentos: 3, gone: false, mensaje: "R2 caído" })).toBe("[intento 3] R2 caído");
    expect(leerFetchError("[intento 3] R2 caído")).toEqual({ intentos: 3, gone: false, mensaje: "R2 caído" });
    expect(escribirFetchError({ intentos: 5, gone: true, mensaje: "Meta ya no lo tiene" })).toBe("[gone] Meta ya no lo tiene");
    expect(leerFetchError("[gone] Meta ya no lo tiene")).toEqual({ intentos: 0, gone: true, mensaje: "Meta ya no lo tiene" });
  });
  it("un texto antiguo (sin marca) o vacío cuenta como 0 intentos, no permanente", () => {
    expect(leerFetchError("Meta no entregó la metadata del adjunto")).toEqual({ intentos: 0, gone: false, mensaje: "Meta no entregó la metadata del adjunto" });
    expect(leerFetchError(null)).toEqual({ intentos: 0, gone: false, mensaje: "" });
  });
  it("el mensaje guardado se acota", () => {
    expect(escribirFetchError({ intentos: 1, gone: false, mensaje: "x".repeat(5000) }).length).toBeLessThan(330);
  });
});

describe("esperaTrasIntentos: creciente y acotada", () => {
  it("15 min, 30, 1 h, 2 h… con tope de 12 h", () => {
    expect(esperaTrasIntentos(0)).toBe(0);
    expect([1, 2, 3, 4].map(esperaTrasIntentos)).toEqual([15 * MIN, 30 * MIN, HORA, 2 * HORA]);
    expect(esperaTrasIntentos(1)).toBe(BASE_ESPERA_MS);
    expect(esperaTrasIntentos(10)).toBe(MAX_ESPERA_MS);
    expect(esperaTrasIntentos(1000)).toBe(MAX_ESPERA_MS);
  });
});

describe("decidirReintento", () => {
  it("fallido y pasada su espera → reintentar", () => {
    expect(decidirReintento(adjunto({ fetchError: "[intento 1] x", updatedAt: hace(16 * MIN) }), NOW)).toEqual({ reintentar: true });
  });
  it("fallido pero aún en su espera → no (y la espera crece con los intentos)", () => {
    expect(decidirReintento(adjunto({ fetchError: "[intento 1] x", updatedAt: hace(10 * MIN) }), NOW)).toEqual({ reintentar: false, motivo: "en_espera" });
    expect(decidirReintento(adjunto({ fetchError: "[intento 4] x", updatedAt: hace(HORA) }), NOW)).toEqual({ reintentar: false, motivo: "en_espera" });
    expect(decidirReintento(adjunto({ fetchError: "[intento 4] x", updatedAt: hace(2 * HORA + MIN) }), NOW)).toEqual({ reintentar: true });
  });
  it("pendiente: solo si lleva más de 10 min (la descarga normal del webhook aún puede estar en curso)", () => {
    const base = { fetchStatus: "pending" as const, fetchError: null };
    expect(decidirReintento(adjunto({ ...base, updatedAt: hace(PENDIENTE_MIN_EDAD_MS - 1) }), NOW)).toEqual({ reintentar: false, motivo: "reciente" });
    expect(decidirReintento(adjunto({ ...base, updatedAt: hace(PENDIENTE_MIN_EDAD_MS) }), NOW)).toEqual({ reintentar: true });
  });
  it("vigencia de Meta: a los 28 días ya no se intenta", () => {
    expect(REINTENTO_VENTANA_DIAS).toBe(28);
    expect(decidirReintento(adjunto({ createdAt: hace(27 * DIA) }), NOW)).toEqual({ reintentar: true });
    expect(decidirReintento(adjunto({ createdAt: hace(28 * DIA) }), NOW)).toEqual({ reintentar: false, motivo: "vencido" });
    expect(decidirReintento(adjunto({ createdAt: hace(40 * DIA) }), NOW)).toEqual({ reintentar: false, motivo: "vencido" });
  });
  it("lo que Meta ya dio por borrado ([gone]) no se reintenta jamás", () => {
    expect(decidirReintento(adjunto({ fetchError: "[gone] 404", updatedAt: hace(30 * DIA) }), NOW)).toEqual({ reintentar: false, motivo: "permanente" });
  });
  it("tope de intentos: no es un bucle infinito", () => {
    expect(decidirReintento(adjunto({ fetchError: `[intento ${MAX_INTENTOS - 1}] x`, updatedAt: hace(DIA) }), NOW)).toEqual({ reintentar: true });
    expect(decidirReintento(adjunto({ fetchError: `[intento ${MAX_INTENTOS}] x`, updatedAt: hace(DIA) }), NOW)).toEqual({ reintentar: false, motivo: "agotado" });
  });
  it("lo ya disponible, lo que no tiene binario o es de la biblioteca nunca se toca", () => {
    expect(decidirReintento(adjunto({ fetchStatus: "available" }), NOW)).toEqual({ reintentar: false, motivo: "disponible" });
    expect(decidirReintento(adjunto({ waMediaId: null }), NOW)).toEqual({ reintentar: false, motivo: "sin_binario" });
    expect(decidirReintento(adjunto({ libraryItemId: "med_1" }), NOW)).toEqual({ reintentar: false, motivo: "sin_binario" });
    expect(decidirReintento(adjunto({ kind: "location" }), NOW)).toEqual({ reintentar: false, motivo: "sin_binario" });
    expect(decidirReintento(adjunto({ kind: "contacts" }), NOW)).toEqual({ reintentar: false, motivo: "sin_binario" });
  });
  it("el tiempo total de intentos cabe de sobra en la vigencia de Meta (sin quedarse corto en una caída larga)", () => {
    let total = 0;
    for (let n = 1; n < MAX_INTENTOS; n++) total += esperaTrasIntentos(n);
    expect(total).toBeGreaterThan(10 * DIA);
  });
});
