import { spawn } from "node:child_process";
import os from "node:os";
import { fijarEstadoFfmpeg, type EstadoFfmpeg } from "@/server/medios/flag";

/**
 * Medios — los programas `ffmpeg` y `ffprobe`: dónde están, si sirven y cómo se ejecutan (con tiempo máximo, detección de
 * «se quedó sin avanzar», cancelación y prioridad baja para no quitarle CPU al proceso web).
 */

export const ffmpegBin = () => process.env.FFMPEG_PATH?.trim() || "ffmpeg";
export const ffprobeBin = () => process.env.FFPROBE_PATH?.trim() || "ffprobe";

const entero = (raw: string | undefined, def: number, min: number, max: number) => {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n >= min && n <= max && raw?.trim() ? Math.floor(n) : def;
};

/** Duración máxima de un video a optimizar, en segundos (por defecto 180). */
export const maxSegundosOptimizar = () => entero(process.env.MEDIA_OPTIMIZE_MAX_SECONDS, 180, 10, 600);
/** Hilos de ffmpeg (por defecto 2): con una CPU compartida, pocos para no dejar sin respuesta al proceso web. */
export const hilosOptimizar = () => entero(process.env.MEDIA_OPTIMIZE_THREADS, 2, 1, 8);

export type ResultadoProceso = {
  codigo: number | null;
  senal: string | null;
  stdout: string;
  stderr: string;
  tiempoAgotado: boolean;
  sinProgreso: boolean;
  cancelado: boolean;
};

export type OpcionesProceso = {
  /** Tiempo máximo total (se mata el proceso al cumplirse). */
  timeoutMs: number;
  /** Si no llega ninguna señal de progreso en tanto tiempo, se mata (solo con `onProgreso`). */
  sinProgresoMs?: number;
  signal?: AbortSignal;
  /** Cada vez que ffmpeg informa avance (`out_time` en microsegundos). */
  onProgreso?: (microsegundos: number) => void;
  /** Tope de lo que se guarda de stdout (ffprobe); lo demás se descarta. */
  maxStdout?: number;
};

const COLA_STDERR = 8 * 1024;

/** Ejecuta un programa SIN shell, con prioridad baja, y devuelve cómo terminó. Nunca lanza por un código de salida distinto de 0. */
export function ejecutar(bin: string, args: string[], o: OpcionesProceso): Promise<ResultadoProceso> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let tiempoAgotado = false;
    let sinProgreso = false;
    let cancelado = false;
    let ultimoProgreso = Date.now();
    let hijo: ReturnType<typeof spawn>;
    try {
      hijo = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ codigo: null, senal: null, stdout: "", stderr: e instanceof Error ? e.message : String(e), tiempoAgotado: false, sinProgreso: false, cancelado: false });
      return;
    }
    try {
      if (hijo.pid) os.setPriority(hijo.pid, 10);
    } catch {
      // Sin permiso para bajar la prioridad (o Windows): sigue igual.
    }
    const matar = () => {
      try {
        hijo.kill("SIGKILL");
      } catch {
        // ya terminó
      }
    };
    const reloj = setTimeout(() => {
      tiempoAgotado = true;
      matar();
    }, o.timeoutMs);
    const vigia = o.onProgreso
      ? setInterval(() => {
          if (Date.now() - ultimoProgreso > (o.sinProgresoMs ?? 90_000)) {
            sinProgreso = true;
            matar();
          }
        }, 5_000)
      : null;
    const alAbortar = () => {
      cancelado = true;
      matar();
    };
    if (o.signal) {
      if (o.signal.aborted) alAbortar();
      else o.signal.addEventListener("abort", alAbortar, { once: true });
    }

    const maxOut = o.maxStdout ?? 64 * 1024;
    let resto = "";
    hijo.stdout?.on("data", (d: Buffer) => {
      if (o.onProgreso) {
        // `-progress pipe:1`: líneas `clave=valor`; `out_time_us` / `out_time_ms` son microsegundos.
        resto += d.toString("utf8");
        const lineas = resto.split("\n");
        resto = lineas.pop() ?? "";
        for (const l of lineas) {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(l.trim());
          if (m) {
            ultimoProgreso = Date.now();
            o.onProgreso(Number(m[1]));
          } else if (l.startsWith("progress=")) ultimoProgreso = Date.now();
        }
      } else if (stdout.length < maxOut) {
        stdout += d.toString("utf8").slice(0, maxOut - stdout.length);
      }
    });
    hijo.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-COLA_STDERR);
    });
    const fin = (codigo: number | null, senal: string | null) => {
      clearTimeout(reloj);
      if (vigia) clearInterval(vigia);
      o.signal?.removeEventListener("abort", alAbortar);
      resolve({ codigo, senal, stdout, stderr, tiempoAgotado, sinProgreso, cancelado });
    };
    hijo.on("error", (e) => {
      stderr += e.message;
      fin(null, null);
    });
    hijo.on("close", (codigo, senal) => fin(codigo, senal));
  });
}

/**
 * Lo que el arranque comprueba: `ffmpeg` y `ffprobe` se ejecutan, `ffmpeg` trae `libx264` y el codificador `aac`, y si tiene
 * el filtro `zscale` (para el tone-mapping de HDR). Fija el estado que lee `flag.ts` y lo devuelve.
 */
export async function comprobarFfmpeg(): Promise<EstadoFfmpeg> {
  const estado = await (async (): Promise<EstadoFfmpeg> => {
    const v = await ejecutar(ffmpegBin(), ["-hide_banner", "-version"], { timeoutMs: 10_000 });
    if (v.codigo !== 0) return { ok: false, motivo: `no se pudo ejecutar «${ffmpegBin()}» (${v.stderr.trim().slice(0, 120) || "no está instalado"})` };
    const p = await ejecutar(ffprobeBin(), ["-hide_banner", "-version"], { timeoutMs: 10_000 });
    if (p.codigo !== 0) return { ok: false, motivo: `no se pudo ejecutar «${ffprobeBin()}» (${p.stderr.trim().slice(0, 120) || "no está instalado"})` };
    const enc = await ejecutar(ffmpegBin(), ["-hide_banner", "-encoders"], { timeoutMs: 15_000, maxStdout: 512 * 1024 });
    if (!/\blibx264\b/.test(enc.stdout)) return { ok: false, motivo: "este ffmpeg no trae el codificador libx264 (H.264)" };
    if (!/\baac\b/.test(enc.stdout)) return { ok: false, motivo: "este ffmpeg no trae el codificador de audio aac" };
    const fil = await ejecutar(ffmpegBin(), ["-hide_banner", "-filters"], { timeoutMs: 15_000, maxStdout: 512 * 1024 });
    return { ok: true, zscale: /\bzscale\b/.test(fil.stdout) && /\btonemap\b/.test(fil.stdout) };
  })();
  fijarEstadoFfmpeg(estado);
  return estado;
}
