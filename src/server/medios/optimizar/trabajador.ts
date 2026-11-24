import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { estadoFfmpeg } from "@/server/medios/flag";
import { cerrarAgotados, fijarMedidas, fallar, posponer, publicar, reclamar, renovar, sinVariante, type TrabajoDeVariante } from "@/server/medios/optimizar/cola";
import { registrarDespertar } from "@/server/medios/optimizar/despertar";
import { optimizarArchivo, type OpcionesOptimizar, type ResultadoOptimizacion } from "@/server/medios/optimizar/pipeline";
import { esperaTrasIntento, OptimizarError, permanente, transitorio } from "@/server/medios/optimizar/perfil";
import { limpiarTemporales } from "@/server/medios/optimizar/temporales";
import { carpetaTemporal, rutaDeMedio, rutaDeVariante, rutaTemporalDeMedio } from "@/server/medios/store";
import { claveDeVariante, objectStore } from "@/server/storage";

/**
 * Medios — el trabajador que optimiza los videos en cola. UN trabajo a la vez por instancia (un mutex del proceso: 1 GB de
 * RAM y una CPU compartida no dan para más), con latido que renueva el arrendamiento y detecta que el medio se borró.
 *
 * Por trabajo: conseguir el original en disco (el local se lee en su sitio; el de R2 se baja en flujo a `medios-tmp`, nunca
 * entero a memoria), optimizar (`pipeline.ts`), publicar la variante en `medios-wa` (disco o R2) y anotarla con la ficha del
 * intento. Los errores permanentes (video dañado, demasiado largo, no cabe) no se reintentan; los transitorios sí, hasta 3
 * veces con esperas de 1 y 5 minutos.
 */

const SONDEO_MS = 20_000;
const LATIDO_MS = 30_000;
/** Holgura de disco que se pide además del archivo (la salida pesa menos de 15 MiB). */
const HOLGURA_BYTES = 40 * 1024 * 1024;

type Estado = { timer: NodeJS.Timeout | null; corriendo: boolean };
const g = globalThis as unknown as { __voceroOptimizador?: Estado };
const estado = (): Estado => (g.__voceroOptimizador ??= { timer: null, corriendo: false });

export type DepsTrabajador = {
  ahora?: () => Date;
  optimizar?: (o: OpcionesOptimizar) => Promise<ResultadoOptimizacion>;
  latidoMs?: number;
};

async function espacioLibre(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

async function descargar(url: string, destino: string, esperado: number, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    throw transitorio("r2_descarga", `No se pudo bajar el video del almacenamiento (${e instanceof Error ? e.message : "error de red"}).`);
  }
  if (!res.ok || !res.body) throw transitorio("r2_descarga", `No se pudo bajar el video del almacenamiento (${res.status}).`);
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(destino), { signal });
  } catch (e) {
    if (signal.aborted) throw transitorio("cancelado", "La optimización se canceló.");
    throw transitorio("r2_descarga", `Se cortó la descarga del video (${e instanceof Error ? e.message : "error"}).`);
  }
  const { size } = await stat(destino);
  if (size !== esperado) throw transitorio("r2_descarga", "El video bajado del almacenamiento no está completo.");
}

/** Procesa UN trabajo ya reclamado. Nunca lanza: el resultado queda en la fila. */
export async function procesar(t: TrabajoDeVariante, deps: DepsTrabajador = {}): Promise<void> {
  const ahora = deps.ahora ?? (() => new Date());
  const optimizar = deps.optimizar ?? optimizarArchivo;
  const abort = new AbortController();
  let perdido = false;
  const latido = setInterval(() => {
    void renovar(t.id, t.intento, ahora())
      .then((ok) => {
        if (!ok && !perdido) {
          perdido = true;
          abort.abort(); // el medio se borró o el trabajo ya no es de este intento
        }
      })
      .catch(() => {});
  }, deps.latidoMs ?? LATIDO_MS);
  latido.unref?.();

  const origenTmp = rutaTemporalDeMedio(t.organizationId, t.id, ".src");
  const salidaTmp = rutaTemporalDeMedio(t.organizationId, t.id, ".wa.mp4");
  let publicada: { r2: boolean; ruta: string } | null = null;

  try {
    await mkdir(carpetaTemporal(t.organizationId), { recursive: true });
    const libre = await espacioLibre(carpetaTemporal(t.organizationId));
    const r2 = objectStore();

    let entrada: string;
    if (t.storage === "r2") {
      if (!r2 || !t.storageKey) throw transitorio("sin_r2", "El almacenamiento en la nube no está disponible.");
      if (libre < t.sizeBytes + HOLGURA_BYTES) throw transitorio("sin_espacio", "No hay espacio en disco para optimizar el video.");
      const url = await r2.signRead(t.storageKey, { ttlSeconds: 3600 }).catch(() => {
        throw transitorio("r2_descarga", "No se pudo preparar la descarga del video.");
      });
      await descargar(url, origenTmp, t.sizeBytes, abort.signal);
      entrada = origenTmp;
    } else {
      entrada = rutaDeMedio(t.organizationId, t.id);
      try {
        await stat(entrada);
      } catch {
        throw permanente("archivo_ausente", "El archivo del video ya no está en el almacenamiento.");
      }
      if (libre < HOLGURA_BYTES) throw transitorio("sin_espacio", "No hay espacio en disco para optimizar el video.");
    }

    const res = await optimizar({
      entrada,
      salida: salidaTmp,
      bytes: t.sizeBytes,
      mime: t.mimeType,
      signal: abort.signal,
      zscale: estadoFfmpeg()?.zscale,
      onInfo: async (info) => {
        await fijarMedidas(t.id, t.intento, info);
      },
    });

    if (res.plan === "ninguna") {
      await sinVariante(t.id, t.intento, ahora());
      return;
    }

    // Publicar: la variante vive en `medios-wa`, en el mismo almacenamiento que el original.
    const clave = claveDeVariante(t.organizationId, t.id);
    if (t.storage === "r2") {
      if (!r2) throw transitorio("sin_r2", "El almacenamiento en la nube no está disponible.");
      await r2.put(clave, await readFile(salidaTmp), "video/mp4").catch(() => {
        throw transitorio("r2_subida", "No se pudo guardar el video optimizado en el almacenamiento.");
      });
      publicada = { r2: true, ruta: clave };
    } else {
      const destino = rutaDeVariante(t.organizationId, t.id);
      await mkdir(path.dirname(destino), { recursive: true });
      await rename(salidaTmp, destino);
      publicada = { r2: false, ruta: destino };
    }
    const ok = await publicar(t.id, t.intento, { clave, bytes: res.bytes, mime: "video/mp4", ancho: res.salidaInfo.ancho, alto: res.salidaInfo.alto }, ahora());
    if (!ok) {
      // El medio se borró (o el arrendamiento pasó a otro intento) mientras se publicaba: lo publicado no tiene dueño.
      await quitarPublicada(publicada);
      publicada = null;
    }
  } catch (e) {
    if (publicada && perdido) await quitarPublicada(publicada);
    if (perdido) return; // la fila ya no es de este intento: no se toca
    const err = e instanceof OptimizarError ? e : transitorio("inesperado", e instanceof Error ? e.message : "Error inesperado al optimizar el video.");
    if (err.permanente) {
      await fallar(t.id, t.intento, err.message, ahora());
    } else {
      const espera = esperaTrasIntento(t.intento);
      if (espera === null) await fallar(t.id, t.intento, `No se pudo optimizar el video tras varios intentos: ${err.message}`, ahora());
      else await posponer(t.id, t.intento, err.message, new Date(ahora().getTime() + espera));
    }
    console.warn(`[medios] optimización de ${t.id} (intento ${t.intento}): ${err.codigo} — ${err.message}`);
  } finally {
    clearInterval(latido);
    await rm(origenTmp, { force: true }).catch(() => {});
    await rm(salidaTmp, { force: true }).catch(() => {});
  }
}

async function quitarPublicada(p: { r2: boolean; ruta: string }): Promise<void> {
  if (p.r2) await objectStore()?.delete(p.ruta).catch(() => {});
  else await rm(p.ruta, { force: true }).catch(() => {});
}

/** Una ronda: cierra lo agotado y procesa, de a uno, todo lo que toca. Si ya hay una en curso, no hace nada (concurrencia 1). */
export async function tickOptimizador(deps: DepsTrabajador = {}): Promise<number> {
  const s = estado();
  if (s.corriendo) return 0;
  s.corriendo = true;
  const ahora = deps.ahora ?? (() => new Date());
  let n = 0;
  try {
    await cerrarAgotados(ahora());
    for (;;) {
      const t = await reclamar(ahora());
      if (!t) break;
      await procesar(t, deps);
      n++;
    }
  } catch (err) {
    console.error("[medios] el optimizador de video falló:", err instanceof Error ? err.message : err);
  } finally {
    s.corriendo = false;
  }
  return n;
}

/** Arranca el trabajador: ronda inmediata, cada 20 s, y cuando una subida avisa que hay un video nuevo. */
export function startMediaOptimizer(): void {
  const s = estado();
  registrarDespertar(() => {
    setImmediate(() => void tickOptimizador());
  });
  if (!s.timer) {
    s.timer = setInterval(() => void tickOptimizador(), SONDEO_MS);
    s.timer.unref?.();
  }
  void limpiarTemporales().catch(() => {});
  void tickOptimizador();
}

export function stopMediaOptimizer(): void {
  const s = estado();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  registrarDespertar(null);
}
