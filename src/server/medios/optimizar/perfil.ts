import { MAX_VIDEO_BYTES } from "@/lib/medios";

/**
 * Medios — optimización de video para WhatsApp: las REGLAS, sin tocar disco ni procesos (módulo puro y probable).
 *
 * Perfil de salida: MP4 H.264 (`main`, nivel 3.1, `yuv420p`) + AAC, `faststart`, dentro de una caja 1280x720 (720x1280 en
 * vertical) sin ampliar nunca, a 30 fps como máximo, de menos de 15 MiB (se apunta a 14). Si el video es tan largo que no cabe
 * en 720p con calidad aceptable baja a 480p; más allá de 3 minutos se rechaza.
 */

export const MIB = 1024 * 1024;
/** A cuánto se apunta (deja margen para el desvío del control de bitrate y cabe tanto en 16 MB decimales como en 16 MiB). */
export const OBJETIVO_BYTES = 14 * MIB;
/** El techo que NO se pasa: 15 MiB ≈ 15,7 MB. */
export const TECHO_BYTES = 15 * MIB;
export const MAX_SEGUNDOS_DEFECTO = 180;
export const MAX_LADO_ENTRADA = 8192;
/** Reserva para el sobrecoste del contenedor MP4. */
const FACTOR_CONTENEDOR = 0.985;
const AUDIO_KBPS_720 = 128;
const AUDIO_KBPS_480 = 96;
/** Por debajo de este video (kbps) la caja de 720p se ve mal: se baja a 480p. */
const PISO_720_KBPS = 900;
/** Por debajo de este video (kbps) ni 480p se salva: el video es demasiado largo. */
const PISO_480_KBPS = 500;
/** Con CRF 23 un 720p30 casi nunca pide más de esto: el tope de bitrate solo manda en los videos largos. */
const TOPE_720_KBPS = 3500;
const TOPE_480_KBPS = 1800;
const FPS_MAX = 30;

/** Un error de la optimización. `permanente`: reintentarlo daría lo mismo (no se reintenta); si no, es transitorio. */
export class OptimizarError extends Error {
  constructor(
    message: string,
    readonly permanente: boolean,
    readonly codigo: string
  ) {
    super(message);
    this.name = "OptimizarError";
  }
}

export const permanente = (codigo: string, message: string) => new OptimizarError(message, true, codigo);
export const transitorio = (codigo: string, message: string) => new OptimizarError(message, false, codigo);

/* ---------- Lo que se lee del video (ffprobe) ---------- */

export type InfoVideo = {
  /** Duración total en milisegundos. */
  duracionMs: number;
  /** Dimensiones TAL COMO SE VEN (ya con la rotación aplicada). */
  ancho: number;
  alto: number;
  /** Grados de rotación declarados (0, 90, 180 o 270). */
  rotacion: number;
  /** Cuadros por segundo (promedio); 0 si no se pudo leer. */
  fps: number;
  fpsVariable: boolean;
  codecVideo: string;
  pixFmt: string;
  bitsPorMuestra: number;
  /** Transferencia de color de HDR (PQ o HLG). */
  hdr: boolean;
  tieneAudio: boolean;
  codecAudio: string | null;
  /** Cuántos flujos de video (sin contar carátulas), de audio y de otro tipo trae el archivo. */
  flujos: { video: number; audio: number; otros: number };
  formato: string;
};

type FlujoProbe = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  bits_per_raw_sample?: string;
  color_transfer?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
};

function fraccion(s: string | undefined): number {
  if (!s) return 0;
  const [a, b] = s.split("/").map(Number);
  if (!Number.isFinite(a) || !a) return 0;
  return b ? a / b : Number.isFinite(a) ? a : 0;
}

const HDR_TRANSFER = new Set(["smpte2084", "arib-std-b67"]);

/**
 * Convierte la salida JSON de `ffprobe -show_format -show_streams` en `InfoVideo`. Un archivo que no es un video utilizable
 * (sin flujo de video, sin duración, dimensiones absurdas) es un error PERMANENTE con un mensaje para mostrar tal cual.
 */
export function interpretarProbe(json: unknown): InfoVideo {
  const raiz = (json ?? {}) as { streams?: FlujoProbe[]; format?: { duration?: string; format_name?: string } };
  const flujos = Array.isArray(raiz.streams) ? raiz.streams : [];
  const videos = flujos.filter((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audios = flujos.filter((s) => s.codec_type === "audio");
  const otros = flujos.length - videos.length - audios.length;
  const v = videos[0];
  if (!v || !v.width || !v.height) throw permanente("sin_video", "El archivo no tiene video que se pueda leer.");

  const rotRaw = v.side_data_list?.find((x) => typeof x.rotation === "number")?.rotation ?? Number(v.tags?.rotate ?? 0);
  const rotacion = ((Math.round(Number.isFinite(rotRaw) ? rotRaw : 0) % 360) + 360) % 360;
  const girado = rotacion === 90 || rotacion === 270;
  const ancho = girado ? v.height : v.width;
  const alto = girado ? v.width : v.height;
  if (Math.max(ancho, alto) > MAX_LADO_ENTRADA) {
    throw permanente("dimensiones", `El video es demasiado grande (${ancho}x${alto}). El máximo es ${MAX_LADO_ENTRADA} px por lado.`);
  }

  const segundos = Number(raiz.format?.duration ?? v.duration ?? 0);
  if (!Number.isFinite(segundos) || segundos <= 0) throw permanente("sin_duracion", "No se pudo leer la duración del video.");

  const fps = fraccion(v.avg_frame_rate);
  const fpsR = fraccion(v.r_frame_rate);
  const fpsVariable = fps > 0 && fpsR > 0 && Math.abs(fps - fpsR) / fpsR > 0.05;
  const bits = Number(v.bits_per_raw_sample ?? 8) || 8;

  return {
    duracionMs: Math.round(segundos * 1000),
    ancho,
    alto,
    rotacion,
    fps,
    fpsVariable,
    codecVideo: v.codec_name ?? "",
    pixFmt: v.pix_fmt ?? "",
    bitsPorMuestra: bits,
    hdr: HDR_TRANSFER.has(v.color_transfer ?? ""),
    tieneAudio: audios.length > 0,
    codecAudio: audios[0]?.codec_name ?? null,
    flujos: { video: videos.length, audio: audios.length, otros },
    formato: raiz.format?.format_name ?? "",
  };
}

/* ---------- Presupuesto de bytes y resolución ---------- */

export type PerfilSalida = {
  /** 720 → caja 1280x720; 480 → caja 854x480 (en vertical se intercambian). */
  altura: 720 | 480;
  caja: { ancho: number; alto: number };
  videoKbps: number;
  /** Tope de bitrate para `-maxrate` (el CRF manda mientras no se llegue a él). */
  maxrateKbps: number;
  audioKbps: number;
};

export type PresupuestoOpts = { objetivoBytes?: number };

/** La caja en que cabe un video, según su orientación (cuadrado = horizontal). */
export function cajaPara(altura: 720 | 480, info: Pick<InfoVideo, "ancho" | "alto">): { ancho: number; alto: number } {
  const largo = altura === 720 ? 1280 : 854;
  return info.ancho >= info.alto ? { ancho: largo, alto: altura } : { ancho: altura, alto: largo };
}

/**
 * El perfil de salida que cabe en el presupuesto de bytes para esta duración, o un error PERMANENTE si no cabe con calidad
 * aceptable. `video ≥ 900 kbps` → 720p; `≥ 500 kbps` → 480p con audio a 96 kbps; menos → demasiado largo.
 */
export function calcularPerfil(info: Pick<InfoVideo, "duracionMs" | "ancho" | "alto" | "tieneAudio">, opts: PresupuestoOpts = {}): PerfilSalida | OptimizarError {
  const segundos = info.duracionMs / 1000;
  const totalKbps = ((opts.objetivoBytes ?? OBJETIVO_BYTES) * 8 * FACTOR_CONTENEDOR) / segundos / 1000;

  const a720 = info.tieneAudio ? AUDIO_KBPS_720 : 0;
  const v720 = totalKbps - a720;
  if (v720 >= PISO_720_KBPS) {
    const videoKbps = Math.floor(v720);
    return { altura: 720, caja: cajaPara(720, info), videoKbps, maxrateKbps: Math.min(videoKbps, TOPE_720_KBPS), audioKbps: a720 };
  }
  const a480 = info.tieneAudio ? AUDIO_KBPS_480 : 0;
  const v480 = totalKbps - a480;
  if (v480 >= PISO_480_KBPS) {
    const videoKbps = Math.floor(v480);
    return { altura: 480, caja: cajaPara(480, info), videoKbps, maxrateKbps: Math.min(videoKbps, TOPE_480_KBPS), audioKbps: a480 };
  }
  return permanente("no_cabe", `El video dura ${duracionLegible(info.duracionMs)} y no cabe en el límite de WhatsApp con buena calidad. Recórtalo y vuelve a subirlo.`);
}

export function duracionLegible(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ---------- Clasificación A / B / C / D ---------- */

export type Plan =
  /** A — el original ya sirve: no se crea variante. */
  | { tipo: "ninguna" }
  /** B — sirve pero con el `moov` al final: se copia con `faststart` (sin recodificar). */
  | { tipo: "remux" }
  /** C / D — hay que recodificar. */
  | { tipo: "transcodificar"; perfil: PerfilSalida };

export type EntradaClasificacion = {
  bytes: number;
  mime: string;
  /** ¿El `moov` está antes que el `mdat`? */
  faststart: boolean;
  maxSegundos?: number;
  objetivoBytes?: number;
};

/** ¿Cabe `info` en la caja de 720p (en su orientación)? */
export function cabeEn720(info: Pick<InfoVideo, "ancho" | "alto">): boolean {
  const c = cajaPara(720, info);
  return info.ancho <= c.ancho && info.alto <= c.alto;
}

/** ¿El video, tal cual, ya cumple el perfil de WhatsApp (códecs, caja, fps y peso)? */
export function yaCumple(info: InfoVideo, e: Pick<EntradaClasificacion, "bytes" | "mime">): boolean {
  return (
    e.mime === "video/mp4" &&
    e.bytes <= MAX_VIDEO_BYTES &&
    info.codecVideo === "h264" &&
    info.pixFmt === "yuv420p" &&
    !info.hdr &&
    (!info.tieneAudio || info.codecAudio === "aac") &&
    cabeEn720(info) &&
    info.ancho % 2 === 0 &&
    info.alto % 2 === 0 &&
    info.fps > 0 &&
    info.fps <= FPS_MAX + 0.5 &&
    !info.fpsVariable &&
    info.flujos.video === 1 &&
    info.flujos.audio <= 1 &&
    info.flujos.otros === 0
  );
}

/**
 * A: cumple todo y tiene `faststart` → nada que hacer. B: cumple pero sin `faststart` → remux. C/D: recodificar (si el video
 * dura más de `maxSegundos` o no cabe en el presupuesto, se rechaza ANTES de gastar CPU).
 */
export function clasificar(info: InfoVideo, e: EntradaClasificacion): Plan | OptimizarError {
  if (yaCumple(info, e)) {
    // Sin faststart se copia con el índice al principio, salvo que la copia no pueda pasar del techo (15 MiB): un original de
    // 15–16 MiB que cumple es enviable tal cual, así que no hace falta variante.
    if (e.faststart || e.bytes > TECHO_BYTES) return { tipo: "ninguna" };
    return { tipo: "remux" };
  }
  const max = e.maxSegundos ?? MAX_SEGUNDOS_DEFECTO;
  if (info.duracionMs / 1000 > max) {
    return permanente("demasiado_largo", `El video dura ${duracionLegible(info.duracionMs)}. El máximo para WhatsApp es ${duracionLegible(max * 1000)} con buena calidad: recórtalo y vuelve a subirlo.`);
  }
  const perfil = calcularPerfil(info, { objetivoBytes: e.objetivoBytes });
  if (perfil instanceof OptimizarError) return perfil;
  return { tipo: "transcodificar", perfil };
}

/* ---------- Argumentos de ffmpeg ---------- */

const BASE = ["-nostdin", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y"];

/** Cadena de filtros: (HDR→SDR), escala sin ampliar, fps y formato. */
export function filtroDeVideo(info: InfoVideo, perfil: PerfilSalida, opts: { zscale?: boolean } = {}): string {
  const partes: string[] = [];
  if (info.hdr) {
    partes.push(
      opts.zscale
        ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv"
        : "colorspace=all=bt709:iall=bt2020:fast=1"
    );
  }
  const { ancho, alto } = perfil.caja;
  // `min(caja, original)`: nunca se amplía; `decrease` + par: encaja en la caja con dimensiones pares.
  partes.push(`scale='min(${ancho},iw)':'min(${alto},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`);
  if (info.fps > FPS_MAX + 0.5 || info.fpsVariable) partes.push(`fps=${Math.min(FPS_MAX, Math.max(1, Math.round(info.fps || FPS_MAX)))}`);
  partes.push("format=yuv420p");
  return partes.join(",");
}

/** ffmpeg para recodificar. `factor` (≤ 1) baja el tope de bitrate en el segundo intento. */
export function argumentosTranscodificar(
  entrada: string,
  salida: string,
  info: InfoVideo,
  perfil: PerfilSalida,
  opts: { hilos: number; zscale?: boolean; factor?: number }
): string[] {
  const maxrate = Math.max(100, Math.floor(perfil.maxrateKbps * (opts.factor ?? 1)));
  const audio = info.tieneAudio ? ["-map", "0:a:0"] : ["-an"];
  return [
    ...BASE,
    "-threads",
    String(opts.hilos),
    "-i",
    entrada,
    "-map",
    "0:v:0",
    ...audio,
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-vf",
    filtroDeVideo(info, perfil, { zscale: opts.zscale }),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-profile:v",
    "main",
    "-level",
    "3.1",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "23",
    "-maxrate",
    `${maxrate}k`,
    "-bufsize",
    `${maxrate * 2}k`,
    "-g",
    "60",
    "-threads",
    String(opts.hilos),
    ...(info.tieneAudio ? ["-c:a", "aac", "-b:a", `${perfil.audioKbps}k`, "-ac", "2", "-ar", "44100"] : []),
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    salida,
  ];
}

/** ffmpeg para copiar sin recodificar, con el `moov` al principio y solo el primer video y el primer audio. */
export function argumentosRemux(entrada: string, salida: string): string[] {
  return [
    ...BASE,
    "-i",
    entrada,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    salida,
  ];
}

/* ---------- Verificación del resultado ---------- */

/**
 * ¿Lo que salió de ffmpeg cumple el perfil? Devuelve el motivo del incumplimiento o `null` si todo está en orden. Se mira con
 * `ffprobe` sobre el ARCHIVO FINAL, no se confía en lo que se pidió.
 */
export function verificarSalida(
  salida: InfoVideo,
  entrada: Pick<InfoVideo, "duracionMs" | "tieneAudio">,
  bytes: number,
  opts: { techoBytes?: number; faststart: boolean }
): string | null {
  if (bytes <= 0) return "el archivo resultante está vacío";
  if (bytes > (opts.techoBytes ?? TECHO_BYTES)) return `el archivo resultante pesa ${(bytes / MIB).toFixed(1)} MiB y el techo es ${((opts.techoBytes ?? TECHO_BYTES) / MIB).toFixed(1)} MiB`;
  if (salida.codecVideo !== "h264") return `el video salió en ${salida.codecVideo || "un códec desconocido"}, no en H.264`;
  if (salida.pixFmt !== "yuv420p") return `el video salió en ${salida.pixFmt || "un formato de píxel desconocido"}, no en yuv420p`;
  if (entrada.tieneAudio && salida.codecAudio !== "aac") return "el audio no salió en AAC";
  if (!entrada.tieneAudio && salida.tieneAudio) return "salió una pista de audio que el original no tenía";
  if (!cabeEn720(salida)) return `las dimensiones ${salida.ancho}x${salida.alto} no caben en 720p`;
  if (salida.fps > FPS_MAX + 0.5) return `el video salió a ${salida.fps.toFixed(1)} fps (máximo ${FPS_MAX})`;
  if (salida.flujos.video !== 1 || salida.flujos.audio > 1 || salida.flujos.otros > 0) return "el archivo resultante trae flujos de más";
  if (Math.abs(salida.duracionMs - entrada.duracionMs) > 1500) return "la duración del resultado no coincide con la del original";
  if (!opts.faststart) return "el resultado no tiene el índice (moov) al principio";
  return null;
}

/* ---------- Reintentos ---------- */

export const MAX_INTENTOS = 3;

/** Cuánto esperar antes del siguiente intento tras el intento `n` (1-based) fallido; `null` = ya no hay más intentos. */
export function esperaTrasIntento(n: number): number | null {
  if (n <= 1) return 60_000;
  if (n === 2) return 5 * 60_000;
  return null;
}

/** Cómo se clasifica la salida de un ffmpeg/ffprobe que falló. */
export function clasificarFalloFfmpeg(r: { codigo: number | null; senal: string | null; stderr: string; tiempoAgotado: boolean; sinProgreso: boolean; cancelado: boolean }): OptimizarError {
  if (r.cancelado) return transitorio("cancelado", "La optimización se canceló.");
  if (r.tiempoAgotado) return transitorio("tiempo_agotado", "La optimización tardó demasiado y se detuvo.");
  if (r.sinProgreso) return transitorio("sin_progreso", "La optimización se quedó sin avanzar y se detuvo.");
  if (r.senal) return transitorio("matado", `El proceso de video se interrumpió (${r.senal}). Suele ser falta de memoria.`);
  if (r.codigo === 137) return transitorio("sin_memoria", "El proceso de video se quedó sin memoria.");
  const t = r.stderr.toLowerCase();
  if (/invalid data found|moov atom not found|could not find codec parameters|unsupported codec|no decoder|error while decoding|corrupt|truncated/.test(t)) {
    return permanente("archivo_danado", "No se pudo leer el video: el archivo está dañado o su formato no es compatible.");
  }
  if (/no space left/.test(t)) return transitorio("sin_espacio", "No hay espacio en disco para optimizar el video.");
  return transitorio("ffmpeg", `ffmpeg terminó con error${r.codigo !== null ? ` (${r.codigo})` : ""}.`);
}
