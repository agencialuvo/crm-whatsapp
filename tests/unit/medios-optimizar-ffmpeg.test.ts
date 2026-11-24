import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { ejecutar, ffmpegBin } from "@/server/medios/optimizar/binarios";
import { inspeccionar, optimizarArchivo } from "@/server/medios/optimizar/pipeline";
import { MIB, OptimizarError, TECHO_BYTES } from "@/server/medios/optimizar/perfil";

/**
 * Medios — la optimización de video con ffmpeg REAL (`describe.skipIf`: solo corre si hay ffmpeg/ffprobe con libx264 y aac;
 * en una máquina sin ellos se salta entera). Las entradas se fabrican con ffmpeg (`lavfi`), cortas, en una carpeta temporal.
 */

const sondear = (bin: string, args: string[]) => {
  try {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
};
const ffmpegListo = (() => {
  const enc = sondear(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-encoders"]);
  return !!enc && /\blibx264\b/.test(enc) && /\baac\b/.test(enc) && sondear(process.env.FFPROBE_PATH || "ffprobe", ["-version"]) !== null;
})();

let dir = "";
const ruta = (n: string) => path.join(dir, n);

/** Fabrica un video: `video` = args de entrada de video, `salida` = nombre; el resto, argumentos de codificación. */
function fabricar(salida: string, o: { size?: string; rate?: number; seg?: number; audio?: boolean; codec?: string[]; extra?: string[] } = {}): string {
  const { size = "1280x720", rate = 30, seg = 3, audio = true, codec = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"], extra = [] } = o;
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}:duration=${seg}`];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seg}`, "-c:a", "aac", "-shortest");
  else args.push("-an");
  args.push(...codec, ...extra, ruta(salida));
  const r = spawnSync(ffmpegBin(), args, { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`no se pudo fabricar ${salida}: ${r.stderr}`);
  return ruta(salida);
}

const optimizar = (entrada: string, salida: string, over: Partial<Parameters<typeof optimizarArchivo>[0]> = {}) =>
  optimizarArchivo({ entrada, salida: ruta(salida), bytes: statSync(entrada).size, mime: "video/mp4", hilos: 2, ...over });

describe.skipIf(!ffmpegListo)("optimización de video con ffmpeg real", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "medios-ffmpeg-"));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("C: un 1080p se recodifica a H.264 yuv420p + AAC, dentro de 720p, con faststart y bajo el techo", async () => {
    const entrada = fabricar("c-1080.mp4", { size: "1920x1080", seg: 3 });
    const r = await optimizar(entrada, "c-1080.out.mp4");
    expect(r.plan).toBe("transcodificar");
    if (r.plan === "ninguna") throw new Error("inesperado");
    expect(r.salidaInfo).toMatchObject({ codecVideo: "h264", pixFmt: "yuv420p", codecAudio: "aac", ancho: 1280, alto: 720 });
    expect(r.salidaInfo.fps).toBeLessThanOrEqual(30.5);
    expect(r.bytes).toBeLessThan(TECHO_BYTES);
    expect(Math.abs(r.salidaInfo.duracionMs - r.info.duracionMs)).toBeLessThan(1500);
    expect(statSync(ruta("c-1080.out.mp4")).size).toBe(r.bytes);
  }, 90_000);

  it("un video vertical sigue siendo vertical (720x1280)", async () => {
    const entrada = fabricar("c-vertical.mp4", { size: "1080x1920", seg: 2 });
    const r = await optimizar(entrada, "c-vertical.out.mp4");
    if (r.plan === "ninguna") throw new Error("inesperado");
    expect(r.salidaInfo).toMatchObject({ ancho: 720, alto: 1280 });
  }, 90_000);

  it("sin pista de audio: la salida no la inventa, y un video chico NO se amplía", async () => {
    const entrada = fabricar("c-sinaudio.mp4", { size: "640x360", seg: 2, audio: false });
    const r = await optimizar(entrada, "c-sinaudio.out.mp4", { mime: "video/quicktime" }); // un MOV siempre se recodifica
    expect(r.plan).toBe("transcodificar");
    if (r.plan === "ninguna") throw new Error("inesperado");
    expect(r.info.tieneAudio).toBe(false);
    expect(r.salidaInfo.tieneAudio).toBe(false);
    expect(r.salidaInfo).toMatchObject({ ancho: 640, alto: 360 });
  }, 90_000);

  it("a 60 fps sale a 30 como máximo", async () => {
    const entrada = fabricar("c-60fps.mp4", { rate: 60, seg: 2 });
    const r = await optimizar(entrada, "c-60fps.out.mp4");
    if (r.plan === "ninguna") throw new Error("inesperado");
    expect(r.salidaInfo.fps).toBeLessThanOrEqual(30.5);
  }, 90_000);

  it("A: un MP4 que ya cumple y tiene faststart → no se hace nada y no se escribe salida", async () => {
    const entrada = fabricar("a-cumple.mp4", { extra: ["-profile:v", "main", "-movflags", "+faststart"] });
    const r = await optimizar(entrada, "a-cumple.out.mp4");
    expect(r.plan).toBe("ninguna");
    expect(existsSync(ruta("a-cumple.out.mp4"))).toBe(false);
  }, 60_000);

  it("B: lo mismo con el moov al final → remux (copia, sin recodificar) y la salida SÍ tiene faststart", async () => {
    const entrada = fabricar("b-remux.mp4", { extra: ["-profile:v", "main"] }); // ffmpeg deja el moov al final
    const r = await optimizar(entrada, "b-remux.out.mp4");
    expect(r.plan).toBe("remux");
    if (r.plan !== "remux") throw new Error("inesperado");
    expect(r.salidaInfo).toMatchObject({ codecVideo: "h264", ancho: 1280, alto: 720 });
    expect(r.bytes).toBeLessThan(TECHO_BYTES);
    // La segunda pasada sobre la salida ya es el caso A.
    const otra = await optimizar(ruta("b-remux.out.mp4"), "b-remux.out2.mp4");
    expect(otra.plan).toBe("ninguna");
  }, 60_000);

  it("una rotación declarada en los metadatos se respeta (las dimensiones mostradas son las rotadas)", async () => {
    const base = fabricar("r-base.mp4", { size: "1280x720", seg: 2 });
    const girado = ruta("r-giro.mp4");
    const g = spawnSync(ffmpegBin(), ["-y", "-hide_banner", "-loglevel", "error", "-display_rotation", "90", "-i", base, "-c", "copy", girado], { encoding: "utf8" });
    if (g.status !== 0) return; // este ffmpeg no sabe girar por metadatos: no hay nada que probar
    const info = await inspeccionar(girado);
    expect(info).toMatchObject({ ancho: 720, alto: 1280 });
    expect([90, 270]).toContain(info.rotacion);
    const r = await optimizar(girado, "r-giro.out.mp4", { mime: "video/quicktime" });
    if (r.plan === "ninguna") throw new Error("inesperado");
    // Recodificado: ffmpeg aplica la rotación y la salida queda vertical sin metadatos de giro.
    expect(r.salidaInfo).toMatchObject({ ancho: 720, alto: 1280 });
  }, 90_000);

  it("las medidas del original se entregan en cuanto se inspecciona (onInfo)", async () => {
    const entrada = fabricar("i-info.mp4", { size: "1920x1080", seg: 2 });
    let visto: { duracionMs: number; ancho: number; alto: number } | null = null;
    await optimizar(entrada, "i-info.out.mp4", { onInfo: (i) => void (visto = { duracionMs: i.duracionMs, ancho: i.ancho, alto: i.alto }) });
    expect(visto).toMatchObject({ ancho: 1920, alto: 1080 });
    expect(visto!.duracionMs).toBeGreaterThan(1500);
    expect(visto!.duracionMs).toBeLessThan(2600);
  }, 90_000);

  it("el avance de ffmpeg se informa", async () => {
    const entrada = fabricar("p-progreso.mp4", { size: "1920x1080", seg: 3 });
    const avances: number[] = [];
    await optimizar(entrada, "p-progreso.out.mp4", { onProgreso: (us) => avances.push(us) });
    expect(avances.length).toBeGreaterThan(0);
    expect(Math.max(...avances)).toBeGreaterThan(1_000_000);
  }, 90_000);

  it("un presupuesto ajustado baja a 480p y se mantiene bajo su techo", async () => {
    const entrada = fabricar("l-480.mp4", { size: "1280x720", seg: 30 });
    const r = await optimizar(entrada, "l-480.out.mp4", { objetivoBytes: 3 * MIB, techoBytes: 3.5 * MIB, mime: "video/quicktime" });
    if (r.plan !== "transcodificar") throw new Error("inesperado");
    expect(r.perfil).toMatchObject({ altura: 480 });
    expect(r.salidaInfo).toMatchObject({ ancho: 854, alto: 480 });
    expect(r.bytes).toBeLessThanOrEqual(3.5 * MIB);
  }, 120_000);

  it("más largo que el máximo → rechazo permanente sin gastar CPU y sin dejar salida", async () => {
    const entrada = fabricar("x-largo.mp4", { size: "1920x1080", seg: 3 });
    const e = await optimizar(entrada, "x-largo.out.mp4", { maxSegundos: 2 }).catch((x) => x);
    expect(e).toBeInstanceOf(OptimizarError);
    expect(e).toMatchObject({ permanente: true, codigo: "demasiado_largo" });
    expect(existsSync(ruta("x-largo.out.mp4"))).toBe(false);
  }, 60_000);

  it("si ni con el segundo intento (tope −20 %) baja del techo → error permanente y sin salida", async () => {
    const entrada = fabricar("n-nocabe.mp4", { size: "1280x720", seg: 3, extra: ["-profile:v", "high"] });
    const e = await optimizar(entrada, "n-nocabe.out.mp4", { techoBytes: 20 * 1024, mime: "video/quicktime" }).catch((x) => x);
    expect(e).toMatchObject({ permanente: true, codigo: "no_cabe" });
    expect(existsSync(ruta("n-nocabe.out.mp4"))).toBe(false);
  }, 120_000);

  it("un archivo que no es video (bytes al azar) falla como permanente y no deja salida", async () => {
    const basura = ruta("z-basura.mp4");
    writeFileSync(basura, randomBytes(50_000));
    const e = await optimizar(basura, "z-basura.out.mp4").catch((x) => x);
    expect(e).toBeInstanceOf(OptimizarError);
    expect(e.permanente).toBe(true);
    expect(existsSync(ruta("z-basura.out.mp4"))).toBe(false);
  }, 60_000);

  it("el tiempo máximo mata el proceso", async () => {
    const t0 = Date.now();
    const r = await ejecutar(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=600", "-f", "null", "-"], { timeoutMs: 700 });
    expect(r.tiempoAgotado).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);

  it("cancelar (AbortSignal) detiene la optimización a mitad y no deja salida", async () => {
    const entrada = fabricar("k-cancelar.mp4", { size: "1920x1080", seg: 8 });
    const ac = new AbortController();
    const p = optimizar(entrada, "k-cancelar.out.mp4", { signal: ac.signal, onProgreso: () => ac.abort() });
    const e = await p.catch((x) => x);
    expect(e).toBeInstanceOf(OptimizarError);
    expect(e).toMatchObject({ permanente: false, codigo: "cancelado" });
    expect(existsSync(ruta("k-cancelar.out.mp4"))).toBe(false);
  }, 90_000);
});
