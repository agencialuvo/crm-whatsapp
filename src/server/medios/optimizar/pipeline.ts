import { open, rm, stat } from "node:fs/promises";
import { ejecutar, ffmpegBin, ffprobeBin, hilosOptimizar, maxSegundosOptimizar } from "@/server/medios/optimizar/binarios";
import { moovAlPrincipio } from "@/server/medios/optimizar/faststart";
import {
  argumentosRemux,
  argumentosTranscodificar,
  clasificar,
  clasificarFalloFfmpeg,
  interpretarProbe,
  OptimizarError,
  permanente,
  TECHO_BYTES,
  transitorio,
  verificarSalida,
  type InfoVideo,
  type PerfilSalida,
} from "@/server/medios/optimizar/perfil";

/**
 * Medios — optimizar UN archivo de video (sin base de datos ni almacenamiento): inspeccionar, clasificar (A/B/C/D), copiar o
 * recodificar con ffmpeg, y verificar el resultado con ffprobe. Lanza `OptimizarError` (permanente o transitorio).
 */

export type ResultadoOptimizacion =
  | { plan: "ninguna"; info: InfoVideo }
  | { plan: "remux" | "transcodificar"; info: InfoVideo; salidaInfo: InfoVideo; bytes: number; perfil?: PerfilSalida };

export type OpcionesOptimizar = {
  entrada: string;
  /** Dónde se escribe el MP4 resultante (no existe antes; si algo falla se borra). */
  salida: string;
  bytes: number;
  mime: string;
  signal?: AbortSignal;
  /** Con las medidas del original, apenas se inspecciona (para guardarlas aunque luego falle). */
  onInfo?: (info: InfoVideo) => void | Promise<void>;
  /** Avance de ffmpeg en microsegundos de video procesado. */
  onProgreso?: (microsegundos: number) => void;
  maxSegundos?: number;
  hilos?: number;
  zscale?: boolean;
  /** Solo pruebas: otro presupuesto/techo. */
  objetivoBytes?: number;
  techoBytes?: number;
};

/** `ffprobe` sobre un archivo → `InfoVideo`. */
export async function inspeccionar(ruta: string, signal?: AbortSignal): Promise<InfoVideo> {
  const r = await ejecutar(ffprobeBin(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", ruta], {
    timeoutMs: 30_000,
    maxStdout: 1024 * 1024,
    signal,
  });
  if (r.codigo !== 0) throw clasificarFalloFfmpeg(r);
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw permanente("archivo_danado", "No se pudo leer el video: el archivo está dañado o su formato no es compatible.");
  }
  return interpretarProbe(json);
}

async function tieneFaststart(ruta: string, bytes: number): Promise<boolean> {
  const fh = await open(ruta, "r");
  try {
    return await moovAlPrincipio(async (desde, cuantos) => {
      const buf = Buffer.alloc(cuantos);
      const { bytesRead } = await fh.read(buf, 0, cuantos, desde);
      return buf.subarray(0, bytesRead);
    }, bytes);
  } finally {
    await fh.close();
  }
}

async function correr(args: string[], o: OpcionesOptimizar, timeoutMs: number) {
  const r = await ejecutar(ffmpegBin(), args, { timeoutMs, sinProgresoMs: 90_000, signal: o.signal, onProgreso: o.onProgreso ?? (() => {}) });
  if (r.codigo !== 0) throw clasificarFalloFfmpeg(r);
}

export async function optimizarArchivo(o: OpcionesOptimizar): Promise<ResultadoOptimizacion> {
  const techo = o.techoBytes ?? TECHO_BYTES;
  const limpiar = () => rm(o.salida, { force: true }).catch(() => {});
  try {
    const info = await inspeccionar(o.entrada, o.signal);
    await o.onInfo?.(info);
    const faststart = await tieneFaststart(o.entrada, o.bytes);
    const plan = clasificar(info, { bytes: o.bytes, mime: o.mime, faststart, maxSegundos: o.maxSegundos ?? maxSegundosOptimizar(), objetivoBytes: o.objetivoBytes });
    if (plan instanceof OptimizarError) throw plan;
    if (plan.tipo === "ninguna") return { plan: "ninguna", info };

    const hilos = o.hilos ?? hilosOptimizar();
    const segundos = info.duracionMs / 1000;

    const verificar = async (): Promise<{ salidaInfo: InfoVideo; bytes: number; motivo: string | null }> => {
      const bytes = (await stat(o.salida)).size;
      const salidaInfo = await inspeccionar(o.salida, o.signal);
      const fast = await tieneFaststart(o.salida, bytes);
      return { salidaInfo, bytes, motivo: verificarSalida(salidaInfo, info, bytes, { techoBytes: techo, faststart: fast }) };
    };

    if (plan.tipo === "remux") {
      await correr(argumentosRemux(o.entrada, o.salida), o, 120_000);
      const v = await verificar();
      if (v.motivo) throw transitorio("verificacion", `El video optimizado no cumple lo esperado: ${v.motivo}.`);
      return { plan: "remux", info, salidaInfo: v.salidaInfo, bytes: v.bytes };
    }

    // Recodificar. Si el primer intento se pasa del techo, un segundo con un tope de bitrate 20 % menor; si tampoco, no cabe.
    const timeoutMs = Math.max(180_000, Math.ceil(segundos * 4000));
    for (const factor of [1, 0.8]) {
      await limpiar();
      await correr(argumentosTranscodificar(o.entrada, o.salida, info, plan.perfil, { hilos, zscale: o.zscale, factor }), o, timeoutMs);
      const v = await verificar();
      if (v.bytes > techo && factor === 1) continue;
      if (v.bytes > techo) throw permanente("no_cabe", "No se pudo reducir el video por debajo del límite de WhatsApp con buena calidad. Recórtalo y vuelve a subirlo.");
      if (v.motivo) throw transitorio("verificacion", `El video optimizado no cumple lo esperado: ${v.motivo}.`);
      return { plan: "transcodificar", info, salidaInfo: v.salidaInfo, bytes: v.bytes, perfil: plan.perfil };
    }
    throw permanente("no_cabe", "No se pudo reducir el video por debajo del límite de WhatsApp con buena calidad.");
  } catch (e) {
    await limpiar();
    throw e;
  }
}
