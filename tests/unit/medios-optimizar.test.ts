import { describe, expect, it } from "vitest";
import { moovAlPrincipio } from "@/server/medios/optimizar/faststart";
import {
  argumentosRemux,
  argumentosTranscodificar,
  cajaPara,
  calcularPerfil,
  clasificar,
  clasificarFalloFfmpeg,
  esperaTrasIntento,
  filtroDeVideo,
  interpretarProbe,
  MIB,
  OBJETIVO_BYTES,
  OptimizarError,
  TECHO_BYTES,
  verificarSalida,
  yaCumple,
  type InfoVideo,
  type PerfilSalida,
} from "@/server/medios/optimizar/perfil";
import { idDeTemporal } from "@/server/medios/optimizar/temporales";
import { colaDeOptimizacionActiva, fijarEstadoFfmpeg, videoOptimizeEnabled } from "@/server/medios/flag";
import { idDeClave } from "@/server/medios/reconciliar";

/* ---------- helpers ---------- */

const info = (o: Partial<InfoVideo> = {}): InfoVideo => ({
  duracionMs: 50_000,
  ancho: 1920,
  alto: 1080,
  rotacion: 0,
  fps: 30,
  fpsVariable: false,
  codecVideo: "h264",
  pixFmt: "yuv420p",
  bitsPorMuestra: 8,
  hdr: false,
  tieneAudio: true,
  codecAudio: "aac",
  flujos: { video: 1, audio: 1, otros: 0 },
  formato: "mov,mp4,m4a,3gp,3g2,mj2",
  ...o,
});

const probe = (video: object = {}, extra: object[] = [], format: object = { duration: "12.5", format_name: "mov,mp4" }) => ({
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1280, height: 720, pix_fmt: "yuv420p", avg_frame_rate: "30/1", r_frame_rate: "30/1", ...video },
    { codec_type: "audio", codec_name: "aac", channels: 2 },
    ...extra,
  ],
  format,
});

/* ---------- ffprobe → InfoVideo ---------- */

describe("interpretarProbe", () => {
  it("lee duración, dimensiones, códecs y audio", () => {
    expect(interpretarProbe(probe())).toMatchObject({
      duracionMs: 12_500,
      ancho: 1280,
      alto: 720,
      rotacion: 0,
      fps: 30,
      fpsVariable: false,
      codecVideo: "h264",
      pixFmt: "yuv420p",
      hdr: false,
      tieneAudio: true,
      codecAudio: "aac",
      flujos: { video: 1, audio: 1, otros: 0 },
    });
  });

  it("intercambia ancho y alto con una rotación de 90° (side data) o 270° (tag `rotate`)", () => {
    const a = interpretarProbe(probe({ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }));
    expect(a).toMatchObject({ ancho: 1080, alto: 1920, rotacion: 270 });
    const b = interpretarProbe(probe({ width: 1920, height: 1080, tags: { rotate: "90" } }));
    expect(b).toMatchObject({ ancho: 1080, alto: 1920, rotacion: 90 });
    const c = interpretarProbe(probe({ width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] }));
    expect(c).toMatchObject({ ancho: 1920, alto: 1080, rotacion: 180 });
  });

  it("sin pista de audio: `tieneAudio` es false", () => {
    const r = interpretarProbe({ streams: [{ codec_type: "video", codec_name: "h264", width: 640, height: 360, pix_fmt: "yuv420p", avg_frame_rate: "24/1", r_frame_rate: "24/1" }], format: { duration: "5" } });
    expect(r).toMatchObject({ tieneAudio: false, codecAudio: null });
  });

  it("detecta fps variable, HDR (PQ y HLG) y 10 bits", () => {
    expect(interpretarProbe(probe({ avg_frame_rate: "24/1", r_frame_rate: "60/1" })).fpsVariable).toBe(true);
    expect(interpretarProbe(probe({ avg_frame_rate: "30000/1001", r_frame_rate: "30000/1001" })).fpsVariable).toBe(false);
    expect(interpretarProbe(probe({ color_transfer: "smpte2084" })).hdr).toBe(true);
    expect(interpretarProbe(probe({ color_transfer: "arib-std-b67" })).hdr).toBe(true);
    expect(interpretarProbe(probe({ color_transfer: "bt709" })).hdr).toBe(false);
    expect(interpretarProbe(probe({ pix_fmt: "yuv420p10le", bits_per_raw_sample: "10" })).bitsPorMuestra).toBe(10);
  });

  it("varias pistas de audio y flujos de otro tipo se cuentan; una carátula no es un video", () => {
    const r = interpretarProbe(
      probe({}, [{ codec_type: "audio", codec_name: "aac" }, { codec_type: "subtitle" }, { codec_type: "video", codec_name: "mjpeg", width: 100, height: 100, disposition: { attached_pic: 1 } }])
    );
    expect(r.flujos).toEqual({ video: 1, audio: 2, otros: 2 });
  });

  it("sin video, sin duración o con dimensiones absurdas: error permanente con mensaje", () => {
    const falla = (j: unknown) => {
      try {
        interpretarProbe(j);
        return null;
      } catch (e) {
        return e as OptimizarError;
      }
    };
    expect(falla({ streams: [{ codec_type: "audio" }], format: { duration: "5" } })).toMatchObject({ permanente: true, codigo: "sin_video" });
    expect(falla({ streams: [], format: {} })).toMatchObject({ permanente: true, codigo: "sin_video" });
    expect(falla(probe({}, [], { duration: "N/A" }))).toMatchObject({ permanente: true, codigo: "sin_duracion" });
    expect(falla(probe({ width: 9000, height: 5000 }))).toMatchObject({ permanente: true, codigo: "dimensiones" });
    expect(falla(null)).toMatchObject({ permanente: true });
  });
});

/* ---------- presupuesto de bytes y resolución ---------- */

describe("calcularPerfil — presupuesto", () => {
  it("50 s: 720p con ≈ 2,2 Mbps de video (el CRF manda; el tope de bitrate es 3,5 Mbps)", () => {
    const p = calcularPerfil({ duracionMs: 50_000, ancho: 1920, alto: 1080, tieneAudio: true }) as PerfilSalida;
    expect(p.altura).toBe(720);
    expect(p.caja).toEqual({ ancho: 1280, alto: 720 });
    expect(p.videoKbps).toBeGreaterThan(2100);
    expect(p.videoKbps).toBeLessThan(2300);
    expect(p.maxrateKbps).toBe(p.videoKbps);
    expect(p.audioKbps).toBe(128);
  });

  it("un clip corto tiene presupuesto de sobra: el tope de bitrate lo limita a 3,5 Mbps", () => {
    const p = calcularPerfil({ duracionMs: 10_000, ancho: 1280, alto: 720, tieneAudio: true }) as PerfilSalida;
    expect(p.videoKbps).toBeGreaterThan(3500);
    expect(p.maxrateKbps).toBe(3500);
  });

  it("112 s es el límite de 720p (≈ 0,9 Mbps); 113 s ya baja a 480p", () => {
    const en720 = calcularPerfil({ duracionMs: 111_000, ancho: 1920, alto: 1080, tieneAudio: true }) as PerfilSalida;
    expect(en720.altura).toBe(720);
    const en480 = calcularPerfil({ duracionMs: 114_000, ancho: 1920, alto: 1080, tieneAudio: true }) as PerfilSalida;
    expect(en480.altura).toBe(480);
    expect(en480.caja).toEqual({ ancho: 854, alto: 480 });
    expect(en480.audioKbps).toBe(96);
  });

  it("180 s cabe en 480p (≈ 0,55 Mbps de video)", () => {
    const p = calcularPerfil({ duracionMs: 180_000, ancho: 1920, alto: 1080, tieneAudio: true }) as PerfilSalida;
    expect(p.altura).toBe(480);
    expect(p.videoKbps).toBeGreaterThanOrEqual(500);
    expect(p.videoKbps).toBeLessThan(600);
  });

  it("más largo de lo que cabe en 480p con calidad: error permanente que lo explica", () => {
    const e = calcularPerfil({ duracionMs: 260_000, ancho: 1920, alto: 1080, tieneAudio: true });
    expect(e).toBeInstanceOf(OptimizarError);
    expect(e).toMatchObject({ permanente: true, codigo: "no_cabe" });
    expect((e as OptimizarError).message).toContain("4:20");
  });

  it("sin audio el presupuesto de video es mayor", () => {
    const con = calcularPerfil({ duracionMs: 50_000, ancho: 1280, alto: 720, tieneAudio: true }) as PerfilSalida;
    const sin = calcularPerfil({ duracionMs: 50_000, ancho: 1280, alto: 720, tieneAudio: false }) as PerfilSalida;
    expect(sin.audioKbps).toBe(0);
    expect(sin.videoKbps).toBeGreaterThan(con.videoKbps);
  });

  it("el objetivo es 14 MiB y el techo 15 MiB (cabe en 16 MB decimales y en 16 MiB)", () => {
    expect(OBJETIVO_BYTES).toBe(14 * MIB);
    expect(TECHO_BYTES).toBe(15 * MIB);
    expect(TECHO_BYTES).toBeLessThan(16_000_000);
  });

  it("la caja respeta la orientación (cuadrado = horizontal)", () => {
    expect(cajaPara(720, { ancho: 1920, alto: 1080 })).toEqual({ ancho: 1280, alto: 720 });
    expect(cajaPara(720, { ancho: 1080, alto: 1920 })).toEqual({ ancho: 720, alto: 1280 });
    expect(cajaPara(720, { ancho: 1000, alto: 1000 })).toEqual({ ancho: 1280, alto: 720 });
    expect(cajaPara(480, { ancho: 1080, alto: 1920 })).toEqual({ ancho: 480, alto: 854 });
  });
});

/* ---------- clasificación A / B / C / D ---------- */

describe("clasificar", () => {
  const cumple = info({ ancho: 1280, alto: 720 });
  const e = (o: Partial<Parameters<typeof clasificar>[1]> = {}) => ({ bytes: 5 * MIB, mime: "video/mp4", faststart: true, ...o });

  it("A: un MP4 que ya cumple y tiene faststart → no se crea variante", () => {
    expect(clasificar(cumple, e())).toEqual({ tipo: "ninguna" });
  });
  it("B: lo mismo sin faststart → remux", () => {
    expect(clasificar(cumple, e({ faststart: false }))).toEqual({ tipo: "remux" });
  });
  it("un original que cumple sin faststart pero pesa entre 15 y 16 MiB no se copia (la copia pasaría el techo): queda como está", () => {
    expect(clasificar(cumple, e({ faststart: false, bytes: 15 * MIB + 1 }))).toEqual({ tipo: "ninguna" });
    expect(clasificar(cumple, e({ faststart: false, bytes: 15 * MIB }))).toEqual({ tipo: "remux" });
  });
  it("A también sin audio, y con un video de 16 MiB justos", () => {
    expect(clasificar(info({ ancho: 1280, alto: 720, tieneAudio: false, codecAudio: null, flujos: { video: 1, audio: 0, otros: 0 } }), e())).toEqual({ tipo: "ninguna" });
    expect(clasificar(cumple, e({ bytes: 16 * MIB }))).toEqual({ tipo: "ninguna" });
  });
  it("C: no cumple por códec, píxel, audio, fps, caja, HDR o flujos de más → recodificar", () => {
    for (const mal of [
      info({ ancho: 1280, alto: 720, codecVideo: "hevc" }),
      info({ ancho: 1280, alto: 720, pixFmt: "yuv420p10le" }),
      info({ ancho: 1280, alto: 720, codecAudio: "mp3" }),
      info({ ancho: 1280, alto: 720, fps: 60 }),
      info({ ancho: 1280, alto: 720, fpsVariable: true }),
      info({ ancho: 1920, alto: 1080 }),
      info({ ancho: 1280, alto: 720, hdr: true }),
      info({ ancho: 1280, alto: 720, flujos: { video: 1, audio: 2, otros: 0 } }),
      info({ ancho: 1280, alto: 720, flujos: { video: 1, audio: 1, otros: 1 } }),
      info({ ancho: 1281, alto: 720 }),
    ]) {
      expect(clasificar(mal, e()), JSON.stringify(mal)).toMatchObject({ tipo: "transcodificar" });
    }
  });
  it("D: más de 16 MiB o un MOV → recodificar aunque los códecs cumplan", () => {
    expect(clasificar(cumple, e({ bytes: 16 * MIB + 1 }))).toMatchObject({ tipo: "transcodificar" });
    expect(clasificar(cumple, e({ mime: "video/quicktime" }))).toMatchObject({ tipo: "transcodificar" });
  });
  it("más de 180 s (o del máximo configurado) → rechazo permanente ANTES de gastar CPU", () => {
    const r = clasificar(info({ duracionMs: 181_000 }), e({ bytes: 100 * MIB }));
    expect(r).toBeInstanceOf(OptimizarError);
    expect(r).toMatchObject({ permanente: true, codigo: "demasiado_largo" });
    expect(clasificar(info({ duracionMs: 100_000 }), e({ bytes: 100 * MIB, maxSegundos: 60 }))).toMatchObject({ codigo: "demasiado_largo" });
  });
  it("un original que ya cumple NO se rechaza por largo (ya sirve tal cual)", () => {
    expect(clasificar(info({ ancho: 1280, alto: 720, duracionMs: 400_000 }), e())).toEqual({ tipo: "ninguna" });
  });
  it("yaCumple exige MP4 y ≤ 16 MiB", () => {
    expect(yaCumple(cumple, { bytes: MIB, mime: "video/quicktime" })).toBe(false);
    expect(yaCumple(cumple, { bytes: 17 * MIB, mime: "video/mp4" })).toBe(false);
    expect(yaCumple(cumple, { bytes: MIB, mime: "video/mp4" })).toBe(true);
  });
});

/* ---------- argumentos de ffmpeg ---------- */

describe("argumentos de ffmpeg", () => {
  const perfil = (calcularPerfil({ duracionMs: 50_000, ancho: 1920, alto: 1080, tieneAudio: true }) as PerfilSalida);

  it("transcodificar: H.264 main 3.1 yuv420p, CRF con tope, AAC 128k, faststart y sin metadatos", () => {
    const a = argumentosTranscodificar("in.mov", "out.mp4", info(), perfil, { hilos: 2 });
    const tiene = (...xs: string[]) => xs.forEach((x) => expect(a).toContain(x));
    tiene("-c:v", "libx264", "main", "3.1", "yuv420p", "-crf", "23", "-c:a", "aac", "128k", "+faststart", "-movflags");
    expect(a[a.indexOf("-i") + 1]).toBe("in.mov");
    expect(a.at(-1)).toBe("out.mp4");
    expect(a[a.indexOf("-map_metadata") + 1]).toBe("-1");
    expect(a).toContain("0:a:0");
    expect(a).not.toContain("-an");
    expect(a[a.indexOf("-maxrate") + 1]).toBe(`${perfil.maxrateKbps}k`);
    expect(a[a.indexOf("-bufsize") + 1]).toBe(`${perfil.maxrateKbps * 2}k`);
  });
  it("sin audio: `-an`, sin mapa ni códec de audio", () => {
    const a = argumentosTranscodificar("in", "out", info({ tieneAudio: false, codecAudio: null }), perfil, { hilos: 1 });
    expect(a).toContain("-an");
    expect(a).not.toContain("0:a:0");
    expect(a).not.toContain("aac");
  });
  it("el segundo intento baja el tope de bitrate un 20 %", () => {
    const a = argumentosTranscodificar("in", "out", info(), perfil, { hilos: 2, factor: 0.8 });
    expect(a[a.indexOf("-maxrate") + 1]).toBe(`${Math.floor(perfil.maxrateKbps * 0.8)}k`);
  });
  it("la escala nunca amplía y encaja con dimensiones pares; en vertical usa la caja vertical", () => {
    expect(filtroDeVideo(info(), perfil)).toContain("scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2");
    const vertical = info({ ancho: 1080, alto: 1920 });
    const pv = calcularPerfil({ duracionMs: 30_000, ancho: 1080, alto: 1920, tieneAudio: true }) as PerfilSalida;
    expect(filtroDeVideo(vertical, pv)).toContain("scale='min(720,iw)':'min(1280,ih)'");
    expect(filtroDeVideo(info(), perfil).endsWith("format=yuv420p")).toBe(true);
  });
  it("fps: se limita a 30 solo si hace falta (no se suben los menores)", () => {
    expect(filtroDeVideo(info({ fps: 24 }), perfil)).not.toContain("fps=");
    expect(filtroDeVideo(info({ fps: 30 }), perfil)).not.toContain("fps=");
    expect(filtroDeVideo(info({ fps: 60 }), perfil)).toContain("fps=30");
    expect(filtroDeVideo(info({ fps: 24, fpsVariable: true }), perfil)).toContain("fps=24");
  });
  it("HDR: tone-mapping con zscale si hay; si no, conversión de espacio de color", () => {
    expect(filtroDeVideo(info({ hdr: true }), perfil, { zscale: true })).toContain("tonemap=tonemap=hable");
    expect(filtroDeVideo(info({ hdr: true }), perfil, { zscale: false })).toContain("colorspace=all=bt709");
    expect(filtroDeVideo(info({ hdr: false }), perfil, { zscale: true })).not.toContain("tonemap");
  });
  it("remux: copia sin recodificar, con faststart, solo el primer video y el primer audio, sin metadatos", () => {
    const a = argumentosRemux("in.mp4", "out.mp4");
    expect(a).toContain("copy");
    expect(a).toContain("+faststart");
    expect(a).toContain("0:a:0?");
    expect(a).not.toContain("libx264");
    expect(a[a.indexOf("-map_metadata") + 1]).toBe("-1");
  });
});

/* ---------- verificación del resultado ---------- */

describe("verificarSalida", () => {
  const ok = info({ ancho: 1280, alto: 720, duracionMs: 50_000 });
  const entrada = { duracionMs: 50_000, tieneAudio: true };
  const v = (s: InfoVideo, bytes = 10 * MIB, faststart = true) => verificarSalida(s, entrada, bytes, { faststart });

  it("acepta un resultado que cumple todo", () => {
    expect(v(ok)).toBeNull();
  });
  it("rechaza lo que se pasa del techo, lo vacío y lo que no es H.264/yuv420p/AAC", () => {
    expect(v(ok, TECHO_BYTES + 1)).toContain("techo");
    expect(v(ok, 0)).toContain("vacío");
    expect(v(info({ ...ok, codecVideo: "hevc" }))).toContain("H.264");
    expect(v(info({ ...ok, pixFmt: "yuv444p" }))).toContain("yuv420p");
    expect(v(info({ ...ok, codecAudio: "mp3" }))).toContain("AAC");
  });
  it("rechaza dimensiones fuera de 720p, más de 30 fps, flujos de más y falta de faststart", () => {
    expect(v(info({ ...ok, ancho: 1920, alto: 1080 }))).toContain("720p");
    expect(v(info({ ...ok, fps: 60 }))).toContain("fps");
    expect(v(info({ ...ok, flujos: { video: 1, audio: 1, otros: 1 } }))).toContain("flujos");
    expect(v(ok, 10 * MIB, false)).toContain("moov");
  });
  it("la duración debe coincidir con la del original (±1,5 s)", () => {
    expect(v(info({ ...ok, duracionMs: 51_400 }))).toBeNull();
    expect(v(info({ ...ok, duracionMs: 53_000 }))).toContain("duración");
  });
  it("una salida con audio cuando el original no lo tenía es un error", () => {
    expect(verificarSalida(ok, { duracionMs: 50_000, tieneAudio: false }, 10 * MIB, { faststart: true })).toContain("audio");
  });
});

/* ---------- reintentos y clasificación de fallos ---------- */

describe("reintentos", () => {
  it("1 min tras el primer intento, 5 min tras el segundo y ninguno tras el tercero", () => {
    expect(esperaTrasIntento(1)).toBe(60_000);
    expect(esperaTrasIntento(2)).toBe(300_000);
    expect(esperaTrasIntento(3)).toBeNull();
    expect(esperaTrasIntento(4)).toBeNull();
  });
});

describe("clasificarFalloFfmpeg", () => {
  const base = { codigo: 1, senal: null, stderr: "", tiempoAgotado: false, sinProgreso: false, cancelado: false };
  it("tiempo agotado, sin progreso, señal y memoria son transitorios", () => {
    expect(clasificarFalloFfmpeg({ ...base, tiempoAgotado: true })).toMatchObject({ permanente: false, codigo: "tiempo_agotado" });
    expect(clasificarFalloFfmpeg({ ...base, sinProgreso: true })).toMatchObject({ permanente: false, codigo: "sin_progreso" });
    expect(clasificarFalloFfmpeg({ ...base, senal: "SIGKILL", codigo: null })).toMatchObject({ permanente: false, codigo: "matado" });
    expect(clasificarFalloFfmpeg({ ...base, codigo: 137 })).toMatchObject({ permanente: false, codigo: "sin_memoria" });
    expect(clasificarFalloFfmpeg({ ...base, cancelado: true })).toMatchObject({ permanente: false, codigo: "cancelado" });
  });
  it("un archivo ilegible es permanente; el resto, transitorio", () => {
    for (const stderr of ["Invalid data found when processing input", "moov atom not found", "Could not find codec parameters"]) {
      expect(clasificarFalloFfmpeg({ ...base, stderr })).toMatchObject({ permanente: true, codigo: "archivo_danado" });
    }
    expect(clasificarFalloFfmpeg({ ...base, stderr: "algo raro" })).toMatchObject({ permanente: false, codigo: "ffmpeg" });
    expect(clasificarFalloFfmpeg({ ...base, stderr: "No space left on device" })).toMatchObject({ permanente: false, codigo: "sin_espacio" });
  });
});

/* ---------- faststart ---------- */

describe("moovAlPrincipio", () => {
  const atomo = (tipo: string, tam: number) => {
    const b = Buffer.alloc(tam);
    b.writeUInt32BE(tam, 0);
    b.write(tipo, 4, "latin1");
    return b;
  };
  const lector = (buf: Buffer) => async (desde: number, cuantos: number) => buf.subarray(desde, desde + cuantos);

  it("true si el `moov` va antes que el `mdat`", async () => {
    const f = Buffer.concat([atomo("ftyp", 24), atomo("moov", 100), atomo("mdat", 5000)]);
    expect(await moovAlPrincipio(lector(f), f.length)).toBe(true);
  });
  it("false si el `mdat` va primero (moov al final)", async () => {
    const f = Buffer.concat([atomo("ftyp", 24), atomo("mdat", 5000), atomo("moov", 100)]);
    expect(await moovAlPrincipio(lector(f), f.length)).toBe(false);
  });
  it("salta átomos intermedios (`free`) y entiende el tamaño de 64 bits", async () => {
    const grande = Buffer.alloc(16);
    grande.writeUInt32BE(1, 0);
    grande.write("free", 4, "latin1");
    grande.writeBigUInt64BE(BigInt(16 + 30), 8);
    const f = Buffer.concat([atomo("ftyp", 24), grande, Buffer.alloc(30), atomo("moov", 100), atomo("mdat", 50)]);
    expect(await moovAlPrincipio(lector(f), f.length)).toBe(true);
  });
  it("un archivo roto o vacío no es faststart y no se cuelga", async () => {
    expect(await moovAlPrincipio(lector(Buffer.alloc(0)), 0)).toBe(false);
    const roto = Buffer.alloc(32); // tamaño 0 = «hasta el final» sin moov
    roto.write("junk", 4, "latin1");
    expect(await moovAlPrincipio(lector(roto), roto.length)).toBe(false);
    const diminuto = Buffer.alloc(16);
    diminuto.writeUInt32BE(4, 0); // tamaño menor que la cabecera
    expect(await moovAlPrincipio(lector(diminuto), diminuto.length)).toBe(false);
  });
});

/* ---------- claves, temporales y la bandera efectiva ---------- */

describe("claves y temporales", () => {
  it("idDeClave reconoce la variante en `medios-wa` (y solo con la forma exacta)", () => {
    expect(idDeClave("org/org_1/medios-wa/med_x")).toEqual({ org: "org_1", id: "med_x", variante: true });
    expect(idDeClave("org/org_1/medios/med_x")).toEqual({ org: "org_1", id: "med_x" });
    expect(idDeClave("org/org_1/medios-wa/med_x/extra")).toBeNull();
    expect(idDeClave("org/org_1/otra/med_x")).toBeNull();
  });
  it("el id de un temporal es lo que va antes del primer punto", () => {
    expect(idDeTemporal("med_abc")).toBe("med_abc");
    expect(idDeTemporal("med_abc.src")).toBe("med_abc");
    expect(idDeTemporal("med_abc.wa.mp4")).toBe("med_abc");
  });
});

describe("la bandera efectiva depende de ffmpeg", () => {
  it("encendida y sin comprobar: acepta video, pero NO encola (hay que comprobar ffmpeg antes)", () => {
    process.env.MEDIA_VIDEO_OPTIMIZE = "on";
    fijarEstadoFfmpeg(null);
    expect(videoOptimizeEnabled()).toBe(true);
    expect(colaDeOptimizacionActiva()).toBe(false);
  });
  it("con ffmpeg comprobado y utilizable: acepta y encola", () => {
    process.env.MEDIA_VIDEO_OPTIMIZE = "on";
    fijarEstadoFfmpeg({ ok: true });
    expect(videoOptimizeEnabled()).toBe(true);
    expect(colaDeOptimizacionActiva()).toBe(true);
  });
  it("con ffmpeg comprobado y NO utilizable: queda efectivamente apagada", () => {
    process.env.MEDIA_VIDEO_OPTIMIZE = "on";
    fijarEstadoFfmpeg({ ok: false, motivo: "no está instalado" });
    expect(videoOptimizeEnabled()).toBe(false);
    expect(colaDeOptimizacionActiva()).toBe(false);
  });
  it("apagada por la variable, ffmpeg no importa", () => {
    delete process.env.MEDIA_VIDEO_OPTIMIZE;
    fijarEstadoFfmpeg({ ok: true });
    expect(videoOptimizeEnabled()).toBe(false);
    expect(colaDeOptimizacionActiva()).toBe(false);
    fijarEstadoFfmpeg(null);
  });
});
