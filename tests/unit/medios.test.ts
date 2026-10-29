import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatoDe,
  nombreLegible,
  validarMedio,
} from "@/lib/medios";
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

  it("MP4 llega hasta 50 MB", () => {
    expect(validarMedio("v.mp4", "video/mp4", 50 * MB).ok).toBe(true);
    expect(validarMedio("v.mp4", "video/mp4", 50 * MB + 1)).toMatchObject({ ok: false, code: "too_large" });
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
  it("rechaza SVG, GIF, HTML, PDF y video que no sea mp4", () => {
    for (const [n, m] of [
      ["a.svg", "image/svg+xml"],
      ["a.gif", "image/gif"],
      ["a.html", "text/html"],
      ["a.pdf", "application/pdf"],
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
