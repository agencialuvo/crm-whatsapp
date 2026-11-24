import { describe, expect, it } from "vitest";
import {
  acceptMedios,
  ACCEPT_MEDIOS,
  esEnviablePorWhatsapp,
  formatBytes,
  formatoDe,
  limiteDe,
  MAX_SUBIDA_BYTES,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_ENTRADA_BYTES,
  maxSubidaBytes,
  nombreLegible,
  resumenDeLimites,
  validarMedio,
  FORMATOS_MEDIO,
} from "@/lib/medios";
import { parseVideoOptimizeFlag } from "@/server/medios/flag";
import { medioToDto } from "@/server/medios/store";
import { claveDeMedio, claveDeVariante } from "@/server/storage/keys";
import { detectarFormato, revisarSvg } from "@/server/medios/sniff";

const MB = 1024 * 1024;

/** Cabeceras mínimas de cada formato, para probar el reconocimiento por bytes. */
const bytes = (...partes: (number[] | string)[]) =>
  Uint8Array.from(
    partes.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p))
  );
const JPG = bytes([0xff, 0xd8, 0xff, 0xe0], "x".repeat(20));
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "x".repeat(20));
const WEBP = bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ", "x".repeat(12));
const AVIF = bytes([0, 0, 0, 0x1c], "ftypavif", "x".repeat(16));
const MP4 = bytes([0, 0, 0, 0x20], "ftypisom", "x".repeat(16));

describe("límites de peso por formato", () => {
  it("JPG y PNG llegan hasta 3 MB", () => {
    expect(validarMedio("a.jpg", "image/jpeg", 3 * MB).ok).toBe(true);
    expect(validarMedio("a.png", "image/png", 3 * MB).ok).toBe(true);
    expect(validarMedio("a.jpg", "image/jpeg", 3 * MB + 1)).toMatchObject({ ok: false, code: "too_large" });
    expect(validarMedio("a.png", "image/png", 4 * MB)).toMatchObject({ ok: false, code: "too_large" });
  });

  it("WEBP y AVIF llegan hasta 1,5 MB", () => {
    expect(validarMedio("a.webp", "image/webp", 1.5 * MB).ok).toBe(true);
    expect(validarMedio("a.avif", "image/avif", 1.5 * MB).ok).toBe(true);
    expect(validarMedio("a.webp", "image/webp", 2 * MB)).toMatchObject({ ok: false, code: "too_large" });
    expect(validarMedio("a.avif", "image/avif", 1.5 * MB + 1)).toMatchObject({ ok: false, code: "too_large" });
  });

  it("MP4 llega hasta 16 MB (el tope duro de WhatsApp, 048)", () => {
    expect(validarMedio("v.mp4", "video/mp4", 16 * MB).ok).toBe(true);
    expect(validarMedio("v.mp4", "video/mp4", 16 * MB + 1)).toMatchObject({ ok: false, code: "too_large" });
    expect(validarMedio("v.mp4", "video/mp4", 16 * MB + 1)).toMatchObject({ message: expect.stringContaining("16 MB") });
  });

  it("PDF llega hasta 16 MB y es un documento (048)", () => {
    const ok = validarMedio("ficha.pdf", "application/pdf", 16 * MB);
    expect(ok).toMatchObject({ ok: true, formato: { tipo: "document", ext: "pdf" } });
    expect(validarMedio("ficha.pdf", "application/pdf", 16 * MB + 1)).toMatchObject({ ok: false, code: "too_large" });
  });

  it("el aviso dice el archivo, su peso y el máximo de ESE formato", () => {
    const r = validarMedio("foto.webp", "image/webp", 2 * MB);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) {
      expect(r.message).toContain("foto.webp");
      expect(r.message).toContain("2,0 MB");
      expect(r.message).toContain("1,5 MB");
      expect(r.message).toContain("WEBP");
    }
  });

  it("un archivo vacío se rechaza", () => {
    expect(validarMedio("a.jpg", "image/jpeg", 0)).toMatchObject({ ok: false, code: "empty" });
  });
});

describe("formatos admitidos", () => {
  it("rechaza SVG, GIF, HTML, otros documentos y video que no sea mp4", () => {
    for (const [n, m] of [
      ["a.svg", "image/svg+xml"],
      ["a.gif", "image/gif"],
      ["a.html", "text/html"],
      ["a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["a.mov", "video/quicktime"],
      ["a.webm", "video/webm"],
    ] as const) {
      expect(validarMedio(n, m, 1000)).toMatchObject({ ok: false, code: "unsupported_type" });
    }
  });

  it("un MIME que no es de la lista no se salva por la extensión", () => {
    // Un `.mp4` que dice ser HTML es justo lo que no se quiere dejar pasar.
    expect(formatoDe("peli.mp4", "text/html")).toBeNull();
  });

  it("sin MIME declarado se cree la extensión (.jpeg incluido)", () => {
    expect(formatoDe("a.JPEG", "")?.ext).toBe("jpg");
    expect(formatoDe("a.png", "application/octet-stream")?.ext).toBe("png");
    expect(formatoDe("a.xyz", "")).toBeNull();
  });
});

describe("reconocimiento por los bytes", () => {
  it("reconoce cada formato por su firma", () => {
    expect(detectarFormato(JPG)?.ext).toBe("jpg");
    expect(detectarFormato(PNG)?.ext).toBe("png");
    expect(detectarFormato(WEBP)?.ext).toBe("webp");
    expect(detectarFormato(AVIF)?.ext).toBe("avif");
    expect(detectarFormato(MP4)?.ext).toBe("mp4");
  });

  it("AVIF y MP4 comparten contenedor y no se confunden", () => {
    expect(detectarFormato(AVIF)?.tipo).toBe("image");
    expect(detectarFormato(MP4)?.tipo).toBe("video");
  });

  it("rechaza HTML, SVG, GIF y basura aunque se llamen .jpg", () => {
    expect(detectarFormato(bytes("<!DOCTYPE html><html><script>alert(1)</script>"))).toBeNull();
    expect(detectarFormato(bytes("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(detectarFormato(bytes("GIF89a", "x".repeat(20)))).toBeNull();
    expect(detectarFormato(bytes([1, 2, 3]))).toBeNull();
    expect(detectarFormato(new Uint8Array())).toBeNull();
  });

  it("un contenedor ftyp de otro tipo (heic) no pasa por mp4", () => {
    expect(detectarFormato(bytes([0, 0, 0, 0x18], "ftypheic", "x".repeat(16)))).toBeNull();
  });
});

describe("nombres y pesos legibles", () => {
  it("nombreLegible quita ruta, query y extensión", () => {
    expect(nombreLegible("/fotos/mi%20corte.final.jpg?v=3")).toBe("mi corte.final");
    expect(nombreLegible("C:\\Users\\x\\foto.png")).toBe("foto");
    expect(nombreLegible("")).toBe("medio");
    expect(nombreLegible("x".repeat(300) + ".jpg").length).toBe(120);
  });

  it("formatBytes", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * MB)).toBe("1,5 MB");
    expect(formatBytes(25 * MB)).toBe("25 MB");
  });
});

describe("SVG (solo iconos)", () => {
  const SVG = bytes('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg>');

  it("solo se reconoce y acepta cuando el selector de iconos lo pide", () => {
    expect(detectarFormato(SVG)).toBeNull();
    expect(detectarFormato(SVG, { svg: true })?.ext).toBe("svg");
    expect(validarMedio("tijera.svg", "image/svg+xml", 500).ok).toBe(false);
    expect(validarMedio("tijera.svg", "image/svg+xml", 500, { svg: true }).ok).toBe(true);
    expect(validarMedio("tijera.svg", "image/svg+xml", 300 * 1024, { svg: true }).ok).toBe(false);
  });

  it("un HTML no pasa por SVG", () => {
    expect(detectarFormato(bytes("<html><svg></svg></html>"), { svg: true })).toBeNull();
  });

  it("revisa el contenido: acepta el limpio y rechaza guiones y recursos externos", () => {
    expect(revisarSvg(SVG)).toBeNull();
    expect(revisarSvg(bytes('<svg><use href="#a"/><path fill="url(#g)"/></svg>'))).toBeNull();
    expect(revisarSvg(bytes("<svg><script>alert(1)</script></svg>"))).not.toBeNull();
    expect(revisarSvg(bytes('<svg onload="x()"></svg>'))).not.toBeNull();
    expect(revisarSvg(bytes('<svg><a href="javascript:x()"/></svg>'))).not.toBeNull();
    expect(revisarSvg(bytes('<svg><image href="https://e.com/a.png"/></svg>'))).not.toBeNull();
    expect(revisarSvg(bytes('<svg><foreignObject/></svg>'))).not.toBeNull();
    expect(revisarSvg(bytes('<svg><style>@import "https://e.com/x.css";</style></svg>'))).not.toBeNull();
  });
});

const MOV = bytes([0, 0, 0, 0x14], "ftypqt  ", "x".repeat(16));

describe("MEDIA_VIDEO_OPTIMIZE — la bandera", () => {
  it("apagada por defecto; solo los valores afirmativos la encienden", () => {
    expect(parseVideoOptimizeFlag(undefined)).toBe(false);
    expect(parseVideoOptimizeFlag("")).toBe(false);
    expect(parseVideoOptimizeFlag("off")).toBe(false);
    expect(parseVideoOptimizeFlag("0")).toBe(false);
    for (const v of ["on", "1", "true", "si", "sí", "yes", " ON "]) expect(parseVideoOptimizeFlag(v)).toBe(true);
  });
});

describe("video con la bandera APAGADA (como siempre)", () => {
  it("16 MB y solo MP4: un MOV no es un formato válido y un MP4 de 17 MB es demasiado grande", () => {
    expect(validarMedio("v.mp4", "video/mp4", 16 * MB)).toMatchObject({ ok: true });
    expect(validarMedio("v.mp4", "video/mp4", 16 * MB + 1)).toMatchObject({ ok: false, code: "too_large" });
    expect(validarMedio("v.mov", "video/quicktime", 5 * MB)).toMatchObject({ ok: false, code: "unsupported_type" });
    expect(formatoDe("v.mov", "")).toBeNull();
  });
  it("los topes y los textos no cambian", () => {
    expect(maxSubidaBytes(false)).toBe(MAX_SUBIDA_BYTES);
    expect(acceptMedios(false)).toBe(ACCEPT_MEDIOS);
    expect(resumenDeLimites()).toContain("MP4 y PDF hasta 16 MB");
    expect(resumenDeLimites()).not.toContain("MOV");
  });
});

describe("video con la bandera ENCENDIDA", () => {
  const on = { optimizarVideo: true };
  it("MP4 y MOV hasta 250 MB; uno más se rechaza con el límite en el mensaje", () => {
    expect(MAX_VIDEO_ENTRADA_BYTES).toBe(250 * MB);
    expect(validarMedio("v.mp4", "video/mp4", 250 * MB, on)).toMatchObject({ ok: true });
    expect(validarMedio("v.mov", "video/quicktime", 250 * MB, on)).toMatchObject({ ok: true });
    const r = validarMedio("v.mov", "video/quicktime", 250 * MB + 1, on);
    expect(r).toMatchObject({ ok: false, code: "too_large" });
    if (!r.ok) expect(r.message).toContain("250 MB");
  });
  it("un MOV sin MIME declarado se reconoce por la extensión; uno con un MIME ajeno no", () => {
    expect(formatoDe("v.MOV", "", on)?.ext).toBe("mov");
    expect(formatoDe("v.mov", "text/html", on)).toBeNull();
  });
  it("el tope de entrada solo toca al video: imágenes y PDF siguen con el suyo", () => {
    expect(validarMedio("a.png", "image/png", 4 * MB, on)).toMatchObject({ ok: false, code: "too_large" });
    expect(validarMedio("a.pdf", "application/pdf", 17 * MB, on)).toMatchObject({ ok: false, code: "too_large" });
    expect(limiteDe(FORMATOS_MEDIO.find((f) => f.ext === "png")!, on)).toBe(3 * MB);
  });
  it("sube el tope del cuerpo directo (pero el multipart no: se carga entero en memoria)", () => {
    expect(maxSubidaBytes(true)).toBeGreaterThan(250 * MB);
    expect(maxSubidaBytes(true)).toBeGreaterThan(MAX_SUBIDA_BYTES);
    expect(acceptMedios(true)).toContain(".mov");
    expect(resumenDeLimites(true)).toContain("MP4 y MOV hasta 250 MB");
  });
});

describe("QuickTime (MOV) por los bytes", () => {
  it("`ftyp` + `qt  ` es un MOV de video; no se confunde con MP4 ni con AVIF", () => {
    expect(detectarFormato(MOV)).toMatchObject({ ext: "mov", mime: "video/quicktime", tipo: "video" });
    expect(detectarFormato(MP4)?.ext).toBe("mp4");
    expect(detectarFormato(AVIF)?.ext).toBe("avif");
  });
  it("el formato lo deciden los bytes: un .mov con HTML no es nada; un MP4 llamado .mov sigue siendo MP4", () => {
    expect(detectarFormato(bytes("<!DOCTYPE html><html></html>"))).toBeNull();
    expect(detectarFormato(MP4)?.mime).toBe("video/mp4");
    expect(detectarFormato(MOV)?.mime).toBe("video/quicktime");
  });
  it("un MOV nunca es enviable por WhatsApp hasta que exista su variante; un MP4 de más de 16 MB tampoco", () => {
    expect(esEnviablePorWhatsapp("video/quicktime", 1 * MB)).toBe(false);
    expect(esEnviablePorWhatsapp("video/mp4", MAX_VIDEO_BYTES)).toBe(true);
    expect(esEnviablePorWhatsapp("video/mp4", MAX_VIDEO_BYTES + 1)).toBe(false);
  });
});

describe("la variante en el DTO y en las claves", () => {
  const fila = {
    id: "med_abcdefghij0123456789",
    organizationId: "org_x",
    name: "Promo",
    kind: "video",
    mimeType: "video/mp4",
    sizeBytes: 100 * MB,
    source: "upload",
    sourceUrl: null,
    createdBy: "u",
    storage: "local",
    storageKey: null,
    status: "ready",
    durationMs: null,
    width: null,
    height: null,
    variantStatus: "none",
    variantError: null,
    variantStorageKey: null,
    variantSizeBytes: null,
    variantMimeType: null,
    variantWidth: null,
    variantHeight: null,
    variantProcessedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  } as const;

  it("un medio sin variante la dice `none`, y un original de más de 16 MB sigue sin ser enviable", () => {
    const dto = medioToDto({ ...fila } as never);
    expect(dto).toMatchObject({ varianteEstado: "none", varianteBytes: null, varianteError: null, noEnviable: true });
  });
  it("solo expone el peso de la variante lista y el error de la que falló", () => {
    expect(medioToDto({ ...fila, variantStatus: "processing", variantSizeBytes: 5 } as never)).toMatchObject({ varianteEstado: "processing", varianteBytes: null });
    expect(medioToDto({ ...fila, variantStatus: "ready", variantSizeBytes: 9 * MB } as never)).toMatchObject({ varianteEstado: "ready", varianteBytes: 9 * MB, varianteError: null });
    expect(medioToDto({ ...fila, variantStatus: "failed", variantError: "ffmpeg falló" } as never)).toMatchObject({ varianteEstado: "failed", varianteBytes: null, varianteError: "ffmpeg falló" });
  });
  it("la variante vive en `medios-wa`, aparte del original (`medios`)", () => {
    expect(claveDeVariante("org_x", "med_1")).toBe("org/org_x/medios-wa/med_1");
    expect(claveDeMedio("org_x", "med_1")).toBe("org/org_x/medios/med_1");
    expect(() => claveDeVariante("org/../x", "med_1")).toThrow();
  });
});
