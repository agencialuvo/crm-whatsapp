import { describe, expect, it } from "vitest";
import {
  BYTES_CABECERA_ADJUNTO,
  CuerpoDemasiadoGrande,
  leerFormularioAcotado,
  MAX_ADJUNTO_MANUAL_BYTES,
  MAX_CUERPO_ADJUNTO_BYTES,
  reconocerPorBytes,
  validarAdjuntoManual,
} from "@/server/inbox/adjunto-manual";

/**
 * Hallazgo A — el adjunto manual de la bandeja: tamaño por tipo, tipo real por los bytes y lectura acotada del cuerpo.
 */

const MB = 1024 * 1024;
const cab = (...b: number[]) => Uint8Array.from([...b, ...new Array(32).fill(0)]);
const texto = (s: string) => new TextEncoder().encode(s);
const ftyp = (marca: string) => Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...texto(marca), 0, 0, 0, 0]);

const JPEG = cab(0xff, 0xd8, 0xff, 0xe0);
const PNG = cab(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PDF = texto("%PDF-1.7\n1 0 obj");
const ZIP = cab(0x50, 0x4b, 0x03, 0x04);
const MP4 = ftyp("isom");
const OGG = texto("OggS\0\x02");
const HTML = texto("<!DOCTYPE html><html><script>alert(1)</script>");

function validar(mime: string | null, size: number, head: Uint8Array) {
  return validarAdjuntoManual({ mimeType: mime, size, head });
}
const rechaza = (fn: () => unknown, code: string) =>
  expect(fn).toThrowError(expect.objectContaining({ name: "MediaValidationError", code }));

describe("reconocerPorBytes", () => {
  it("reconoce las firmas que importan", () => {
    expect(reconocerPorBytes(JPEG)?.mime).toBe("image/jpeg");
    expect(reconocerPorBytes(PNG)?.mime).toBe("image/png");
    expect(reconocerPorBytes(texto("RIFF\0\0\0\0WEBPVP8 "))?.mime).toBe("image/webp");
    expect(reconocerPorBytes(PDF)?.mime).toBe("application/pdf");
    expect(reconocerPorBytes(MP4)?.mime).toBe("video/mp4");
    expect(reconocerPorBytes(ftyp("3gp4"))?.mime).toBe("video/3gpp");
    expect(reconocerPorBytes(ftyp("M4A "))?.mime).toBe("audio/mp4");
    expect(reconocerPorBytes(OGG)?.mime).toBe("audio/ogg");
    expect(reconocerPorBytes(texto("ID3\x03\0"))?.mime).toBe("audio/mpeg");
    expect(reconocerPorBytes(cab(0xff, 0xf1, 0x50))?.mime).toBe("audio/aac");
    expect(reconocerPorBytes(cab(0xff, 0xfb, 0x90))?.mime).toBe("audio/mpeg");
    expect(reconocerPorBytes(texto("#!AMR\n"))?.mime).toBe("audio/amr");
    expect(reconocerPorBytes(ZIP)?.mime).toBe("application/zip");
  });
  it("lo que no se reconoce da null", () => {
    expect(reconocerPorBytes(texto("hola, esto es texto"))).toBeNull();
    expect(reconocerPorBytes(new Uint8Array(0))).toBeNull();
  });
});

describe("validarAdjuntoManual — tamaño", () => {
  it("imagen de más de 5 MB → too_large (aunque los bytes sean válidos)", () => {
    rechaza(() => validar("image/png", 5 * MB + 1, PNG), "too_large");
    expect(validar("image/png", 5 * MB, PNG)).toEqual({ mimeType: "image/png", kind: "image" });
  });
  it("video de más de 16 MB → too_large", () => {
    rechaza(() => validar("video/mp4", 16 * MB + 1, MP4), "too_large");
    expect(validar("video/mp4", 16 * MB, MP4).kind).toBe("video");
  });
  it("un documento de decenas de MB → too_large (el tope de la bandeja es 16 MB, no los 100 de WhatsApp)", () => {
    expect(MAX_ADJUNTO_MANUAL_BYTES.document).toBe(16 * MB);
    for (const mb of [17, 25, 50, 100]) {
      rechaza(() => validar("application/pdf", mb * MB, PDF), "too_large");
    }
    expect(validar("application/pdf", 16 * MB, PDF).kind).toBe("document");
  });
  it("también topa un documento sin firma (txt) y un tipo genérico", () => {
    rechaza(() => validar("text/plain", 30 * MB, texto("hola")), "too_large");
    rechaza(() => validar("application/octet-stream", 30 * MB, ZIP), "too_large");
  });
  it("archivo vacío → empty", () => {
    rechaza(() => validar("image/png", 0, new Uint8Array(0)), "empty");
  });
  it("el tope del cuerpo cubre el mayor de los archivos más el sobre del multipart", () => {
    expect(MAX_CUERPO_ADJUNTO_BYTES).toBeGreaterThan(16 * MB);
    expect(MAX_CUERPO_ADJUNTO_BYTES).toBeLessThan(17 * MB);
  });
});

describe("validarAdjuntoManual — tipo real por los bytes", () => {
  it("imagen declarada pero con bytes de otra cosa → unsupported_type", () => {
    rechaza(() => validar("image/jpeg", 1000, HTML), "unsupported_type");
    rechaza(() => validar("image/png", 1000, texto("no soy una imagen")), "unsupported_type");
    rechaza(() => validar("image/png", 1000, PDF), "unsupported_type");
  });
  it("video / audio declarados con bytes de imagen o de otra familia → unsupported_type", () => {
    rechaza(() => validar("video/mp4", 1000, JPEG), "unsupported_type");
    rechaza(() => validar("audio/ogg", 1000, MP4), "unsupported_type");
    rechaza(() => validar("audio/mpeg", 1000, texto("MZ\x90\0")), "unsupported_type");
  });
  it("la clase la deciden los bytes: image/png con bytes de JPEG se guarda y envía como image/jpeg", () => {
    expect(validar("image/png", 1000, JPEG)).toEqual({ mimeType: "image/jpeg", kind: "image" });
  });
  it("tipo genérico con bytes reconocibles → se usa el reconocido (octet-stream + JPEG = imagen)", () => {
    expect(validar("application/octet-stream", 1000, JPEG)).toEqual({ mimeType: "image/jpeg", kind: "image" });
    expect(validar(null, 1000, PDF)).toEqual({ mimeType: "application/pdf", kind: "document" });
    expect(validar("", 1000, PDF).mimeType).toBe("application/pdf");
  });
  it("un tipo con parámetros (audio/ogg; codecs=opus) se normaliza y se acepta", () => {
    expect(validar("audio/ogg; codecs=opus", 1000, OGG)).toEqual({ mimeType: "audio/ogg", kind: "audio" });
  });
  it("PDF declarado sin firma de PDF → unsupported_type; Office moderno exige zip", () => {
    rechaza(() => validar("application/pdf", 1000, texto("MZ ejecutable")), "unsupported_type");
    rechaza(() => validar("application/pdf", 1000, JPEG), "unsupported_type");
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(validar(docx, 1000, ZIP).kind).toBe("document");
    rechaza(() => validar(docx, 1000, texto("no es zip")), "unsupported_type");
  });
  it("HTML y SVG se rechazan por contenido aunque se declaren como PDF, texto o binario", () => {
    for (const mime of ["application/pdf", "text/plain", "application/octet-stream", "image/svg+xml", "text/html"]) {
      rechaza(() => validar(mime, 1000, HTML), "unsupported_type");
    }
    rechaza(() => validar("application/octet-stream", 100, texto('<?xml version="1.0"?><svg xmlns="x"><script/></svg>')), "unsupported_type");
    rechaza(() => validar("text/plain", 100, texto("  \n<html><body>hola")), "unsupported_type");
  });
  it("un documento sin firma conocida (txt, csv) sigue pasando", () => {
    expect(validar("text/plain", 100, texto("hola mundo"))).toEqual({ mimeType: "text/plain", kind: "document" });
    expect(validar("text/csv", 100, texto("a,b\n1,2"))).toEqual({ mimeType: "text/csv", kind: "document" });
  });
  it("una imagen no nativa (gif) va como documento, pero con bytes de otra familia se rechaza", () => {
    expect(validar("image/gif", 1000, texto("GIF89a....")).kind).toBe("document");
    rechaza(() => validar("image/gif", 1000, PDF), "unsupported_type");
  });
});

describe("leerFormularioAcotado", () => {
  function multipart(bytes: number) {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), "a.pdf");
    form.set("caption", "hola");
    return form;
  }
  function req(form: FormData, headers: Record<string, string> = {}) {
    return new Request("http://localhost/x", { method: "POST", body: form, headers });
  }

  it("un cuerpo dentro del tope se lee completo", async () => {
    const f = await leerFormularioAcotado(req(multipart(10_000)), 100_000);
    expect(f.get("caption")).toBe("hola");
    expect((f.get("file") as File).size).toBe(10_000);
  });

  it("un cuerpo que pasa del tope se corta y lanza CuerpoDemasiadoGrande", async () => {
    await expect(leerFormularioAcotado(req(multipart(300_000)), 100_000)).rejects.toBeInstanceOf(CuerpoDemasiadoGrande);
  });

  it("se corta aunque no haya Content-Length (cuerpo en flujo) y aunque el declarado mienta", async () => {
    const grande = multipart(300_000);
    const base = req(grande);
    const tipo = base.headers.get("content-type")!;
    const crudo = new Uint8Array(await base.arrayBuffer());
    const flujo = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < crudo.length; i += 16_384) c.enqueue(crudo.subarray(i, i + 16_384));
          c.close();
        },
      });
    const sinLength = new Request("http://localhost/x", { method: "POST", body: flujo(), headers: { "content-type": tipo }, duplex: "half" } as RequestInit);
    expect(sinLength.headers.get("content-length")).toBeNull();
    await expect(leerFormularioAcotado(sinLength, 100_000)).rejects.toBeInstanceOf(CuerpoDemasiadoGrande);

    const miente = new Request("http://localhost/x", {
      method: "POST",
      body: flujo(),
      headers: { "content-type": tipo, "content-length": "500" },
      duplex: "half",
    } as RequestInit);
    await expect(leerFormularioAcotado(miente, 100_000)).rejects.toBeInstanceOf(CuerpoDemasiadoGrande);
  });

  it("un cuerpo que no es multipart falla con otro error (no 'demasiado grande')", async () => {
    const r = new Request("http://localhost/x", { method: "POST", body: "hola", headers: { "content-type": "text/plain" } });
    await expect(leerFormularioAcotado(r, 100_000)).rejects.not.toBeInstanceOf(CuerpoDemasiadoGrande);
  });

  it("la cabecera que se inspecciona es acotada", () => {
    expect(BYTES_CABECERA_ADJUNTO).toBeLessThanOrEqual(8192);
  });
});
