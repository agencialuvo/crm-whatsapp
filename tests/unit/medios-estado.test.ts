import { afterEach, describe, expect, it } from "vitest";
import { estadoDeEnvio, type ItemParaEnvio } from "@/server/medios/envio";
import { medioToDto } from "@/server/medios/store";
import { fijarEstadoFfmpeg } from "@/server/medios/flag";
import {
  avisoDeMedioEnPaso,
  etiquetaDeOpcion,
  fusionarVariantes,
  hayOptimizando,
  insigniaDeEnvio,
  origenDeVista,
  seOfreceEnPaso,
  type MedioDePaso,
} from "@/lib/medios-estado";
import type { MedioDto } from "@/lib/medios";

/**
 * Medios — Paso 3b, lógica pura: el estado de envío del DTO (`envio`, `noEnviable`, `puedeReintentar`, `urlVariante`) y lo
 * que la interfaz hace con él (insignias, sondeo, selector de pasos). Sin base de datos ni navegador.
 */

const MB = 1024 * 1024;
const base: ItemParaEnvio = {
  kind: "video",
  mimeType: "video/mp4",
  sizeBytes: 5 * MB,
  variantStatus: "none",
  variantMimeType: null,
  variantSizeBytes: null,
  variantStorageKey: null,
  variantError: null,
};
const v = (o: Partial<ItemParaEnvio> = {}): ItemParaEnvio => ({ ...base, ...o });
const lista = { variantStatus: "ready" as const, variantMimeType: "video/mp4", variantSizeBytes: 9 * MB, variantStorageKey: "org/o/medios-wa/m" };

describe("estadoDeEnvio", () => {
  it("imagen y PDF enviables: original; AVIF: no_enviable (sin reintento: solo los videos se optimizan)", () => {
    expect(estadoDeEnvio(v({ kind: "image", mimeType: "image/png", sizeBytes: MB }))).toEqual({ envio: "original", noEnviable: false, puedeReintentar: false });
    expect(estadoDeEnvio(v({ kind: "image", mimeType: "image/avif", sizeBytes: MB }))).toEqual({ envio: "no_enviable", noEnviable: true, puedeReintentar: false });
  });

  it("video con variante lista: listo", () => {
    expect(estadoDeEnvio(v({ ...lista, sizeBytes: 200 * MB }))).toEqual({ envio: "listo", noEnviable: false, puedeReintentar: false });
  });

  it("video optimizándose: optimizando y NO es noEnviable aunque su original sea enorme", () => {
    expect(estadoDeEnvio(v({ variantStatus: "processing", sizeBytes: 200 * MB }))).toEqual({ envio: "optimizando", noEnviable: false, puedeReintentar: false });
  });

  it("video fallido: fallo y reintentable; noEnviable solo si el original tampoco sirve", () => {
    expect(estadoDeEnvio(v({ variantStatus: "failed", sizeBytes: 200 * MB }))).toEqual({ envio: "fallo", noEnviable: true, puedeReintentar: true });
    expect(estadoDeEnvio(v({ variantStatus: "failed", sizeBytes: 5 * MB }))).toEqual({ envio: "fallo", noEnviable: false, puedeReintentar: true });
  });

  it("video sin variante: original si cabe; si no (grande o MOV) no_enviable y reintentable", () => {
    expect(estadoDeEnvio(v())).toEqual({ envio: "original", noEnviable: false, puedeReintentar: false });
    expect(estadoDeEnvio(v({ sizeBytes: 40 * MB }))).toEqual({ envio: "no_enviable", noEnviable: true, puedeReintentar: true });
    expect(estadoDeEnvio(v({ mimeType: "video/quicktime", sizeBytes: 2 * MB }))).toEqual({ envio: "no_enviable", noEnviable: true, puedeReintentar: true });
  });

  it("variante lista pero incompleta: fallo (no se envía a ciegas), sin botón (el endpoint solo parte de failed/none)", () => {
    expect(estadoDeEnvio(v({ ...lista, variantStorageKey: null }))).toEqual({ envio: "fallo", noEnviable: true, puedeReintentar: false });
  });
});

type Fila = Parameters<typeof medioToDto>[0];
const fila = (o: Partial<ItemParaEnvio> & Record<string, unknown> = {}): Fila =>
  ({
    id: "med_abcdefghij0123456789",
    organizationId: "org_1",
    name: "promo",
    source: "upload",
    sourceUrl: null,
    status: "ready",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    ...base,
    ...o,
  }) as unknown as Fila;

describe("medioToDto (Paso 3b)", () => {
  afterEach(() => fijarEstadoFfmpeg(null));

  it("lleva envio, noEnviable y urlVariante según el estado", () => {
    const d = medioToDto(fila({ ...lista, sizeBytes: 200 * MB }));
    expect(d).toMatchObject({ envio: "listo", noEnviable: false, varianteBytes: 9 * MB, urlVariante: "/api/medios/med_abcdefghij0123456789/archivo?version=whatsapp" });
    expect(medioToDto(fila({ ...lista }), null, "https://r2.test/var?sig=1").urlVariante).toBe("https://r2.test/var?sig=1");
    expect(medioToDto(fila({ variantStatus: "processing", sizeBytes: 200 * MB }))).toMatchObject({ envio: "optimizando", noEnviable: false, urlVariante: null });
    expect(medioToDto(fila({ variantStatus: "failed", variantError: "dura demasiado", sizeBytes: 200 * MB }))).toMatchObject({ envio: "fallo", noEnviable: true, varianteError: "dura demasiado" });
  });

  it("puedeReintentar exige además la cola de optimización activa (bandera encendida y ffmpeg comprobado)", () => {
    const f = fila({ variantStatus: "failed", sizeBytes: 200 * MB });
    expect(medioToDto(f).puedeReintentar).toBe(false); // sin bandera
    const antes = process.env.MEDIA_VIDEO_OPTIMIZE;
    try {
      process.env.MEDIA_VIDEO_OPTIMIZE = "on";
      fijarEstadoFfmpeg({ ok: true });
      expect(medioToDto(f).puedeReintentar).toBe(true);
      fijarEstadoFfmpeg({ ok: false, motivo: "no hay ffmpeg" });
      expect(medioToDto(f).puedeReintentar).toBe(false);
      fijarEstadoFfmpeg({ ok: true });
      expect(medioToDto(fila({ ...lista })).puedeReintentar).toBe(false); // listo: nada que reintentar
    } finally {
      if (antes === undefined) delete process.env.MEDIA_VIDEO_OPTIMIZE;
      else process.env.MEDIA_VIDEO_OPTIMIZE = antes;
    }
  });
});

const dto = (o: Partial<MedioDto> = {}): MedioDto => ({
  id: "med_1",
  nombre: "promo",
  tipo: "video",
  mime: "video/mp4",
  bytes: 5 * MB,
  origen: "archivo",
  noEnviable: false,
  varianteEstado: "none",
  varianteBytes: null,
  varianteError: null,
  envio: "original",
  puedeReintentar: false,
  urlVariante: null,
  urlOrigen: null,
  ruta: "/api/medios/med_1/archivo",
  urlFirmada: "https://r2.test/a?sig=1",
  creadoEn: "2026-06-01T00:00:00Z",
  ...o,
});

describe("insignias y sondeo de la galería", () => {
  it("cada estado tiene su texto y su tono; imagen/PDF/video ligero no llevan insignia", () => {
    expect(insigniaDeEnvio(dto())).toBeNull();
    expect(insigniaDeEnvio(dto({ envio: "optimizando" }))).toEqual({ texto: "Optimizando para WhatsApp…", tono: "info" });
    expect(insigniaDeEnvio(dto({ envio: "listo", varianteBytes: 9 * MB }))).toMatchObject({ tono: "ok", texto: expect.stringMatching(/^Listo para WhatsApp · 9[,.]0 MB$/) });
    expect(insigniaDeEnvio(dto({ envio: "fallo" }))).toEqual({ texto: "No se pudo optimizar", tono: "error" });
    expect(insigniaDeEnvio(dto({ envio: "no_enviable" }))).toEqual({ texto: "No se envía por WhatsApp", tono: "neutro" });
  });

  it("hayOptimizando: solo mientras haya un video en processing", () => {
    expect(hayOptimizando(null)).toBe(false);
    expect(hayOptimizando([dto(), dto({ varianteEstado: "failed" })])).toBe(false);
    expect(hayOptimizando([dto(), dto({ id: "med_2", varianteEstado: "processing" })])).toBe(true);
  });

  it("fusionarVariantes toca SOLO los campos de la variante y conserva la URL firmada (sin parpadeo)", () => {
    const antes = [dto({ varianteEstado: "processing", envio: "optimizando" }), dto({ id: "med_2", nombre: "otro" })];
    const nuevos = [
      dto({ varianteEstado: "ready", envio: "listo", varianteBytes: 9 * MB, urlVariante: "/v", urlFirmada: "https://r2.test/a?sig=NUEVA", nombre: "RENOMBRADO" }),
      dto({ id: "med_3" }),
    ];
    const r = fusionarVariantes(antes, nuevos);
    expect(r).toHaveLength(2); // no agrega med_3 ni quita nada
    expect(r[0]).toMatchObject({ varianteEstado: "ready", envio: "listo", varianteBytes: 9 * MB, urlVariante: "/v", urlFirmada: "https://r2.test/a?sig=1", nombre: "promo" });
    expect(r[1]).toBe(antes[1]);
  });

  it("fusionarVariantes devuelve la MISMA lista si nada cambió (React no repinta)", () => {
    const antes = [dto({ varianteEstado: "processing", envio: "optimizando" })];
    expect(fusionarVariantes(antes, [dto({ varianteEstado: "processing", envio: "optimizando", urlFirmada: "https://r2.test/a?sig=OTRA" })])).toBe(antes);
  });

  it("origenDeVista: la variante lista en videos; el original en lo demás", () => {
    expect(origenDeVista(dto({ urlVariante: "/v" }))).toBe("/v");
    expect(origenDeVista(dto())).toBe("https://r2.test/a?sig=1");
    expect(origenDeVista(dto({ tipo: "image", urlVariante: "/v" }))).toBe("https://r2.test/a?sig=1");
    expect(origenDeVista(dto({ urlFirmada: null }))).toBe("/api/medios/med_1/archivo");
  });
});

describe("selector de pasos", () => {
  const m = (o: Partial<MedioDePaso> = {}): MedioDePaso => ({ id: "med_1", nombre: "promo", tipo: "video", ...o });

  it("lo no enviable no se ofrece, salvo el ya elegido; un video optimizándose SÍ", () => {
    expect(seOfreceEnPaso(m({ noEnviable: true }), null)).toBe(false);
    expect(seOfreceEnPaso(m({ noEnviable: true }), "med_1")).toBe(true);
    expect(seOfreceEnPaso(m({ varianteEstado: "processing" }), null)).toBe(true);
    expect(seOfreceEnPaso(m(), null)).toBe(true);
  });

  it("la etiqueta marca «(optimizando…)» y «(no se puede enviar)»", () => {
    expect(etiquetaDeOpcion(m())).toBe("promo · Video");
    expect(etiquetaDeOpcion(m({ varianteEstado: "processing" }))).toBe("promo · Video (optimizando…)");
    expect(etiquetaDeOpcion(m({ noEnviable: true }))).toBe("promo · Video (no se puede enviar)");
    expect(etiquetaDeOpcion(m({ tipo: "image" }))).toBe("promo · Imagen");
    expect(etiquetaDeOpcion(m({ tipo: "document" }))).toBe("promo · PDF");
  });

  it("avisos: espera mientras optimiza; error con el motivo si falló o no es enviable; nada si está bien", () => {
    expect(avisoDeMedioEnPaso(undefined)).toBeNull();
    expect(avisoDeMedioEnPaso(m())).toBeNull();
    expect(avisoDeMedioEnPaso(m({ varianteEstado: "processing" }))).toMatchObject({ tono: "info", texto: expect.stringContaining("el paso espera") });
    const fallo = avisoDeMedioEnPaso(m({ noEnviable: true, varianteEstado: "failed", varianteError: "El video dura más de 3 minutos" }));
    expect(fallo).toMatchObject({ tono: "error", texto: expect.stringContaining("El video dura más de 3 minutos") });
    expect(avisoDeMedioEnPaso(m({ noEnviable: true }))).toMatchObject({ tono: "error", texto: expect.stringContaining("no se puede enviar") });
  });
});
