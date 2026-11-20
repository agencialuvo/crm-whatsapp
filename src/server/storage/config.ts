/**
 * 048 — La configuración del conector de Cloudflare R2. Es el ÚNICO archivo (con `r2.ts`) que lee las credenciales
 * `R2_*`: una prueba de vigilancia lo comprueba. Apagado por defecto (patrón ADR-001): sin la bandera, el sistema usa el
 * disco local y nada cambia.
 *
 * Con la bandera encendida pero la configuración incompleta o mal puesta, la operación degrada a disco local (el
 * sistema no se cae); lo que NO debe pasar es que eso ocurra en silencio. `diagnosticarR2` es el diagnóstico único que
 * usan el arranque, `/api/health` y `pnpm doctor`: dice qué variables faltan o están mal, siempre por NOMBRE y nunca
 * con su valor.
 */

const ON = new Set(["on", "1", "true", "si", "sí", "yes"]);

/** Las cuatro variables que R2 necesita además de la bandera. */
export const R2_VARIABLES = ["R2_ENDPOINT", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
export type R2Variable = (typeof R2_VARIABLES)[number];

export type R2Config = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };

type Env = Record<string, string | undefined>;

/** El valor de ejemplo que trae `.env.example` (`REEMPLAZA_…`): es no haber configurado nada. */
const esEjemplo = (v: string) => v.includes("REEMPLAZA_");

function bandera(env: Env): boolean {
  return ON.has((env.R2_STORAGE ?? "").trim().toLowerCase());
}

function endpointValido(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * El estado de R2 a partir del entorno, sin tocar la red.
 * - `off`: sin la bandera. Todo vive en `MEDIA_DIR`.
 * - `ok`: bandera y las cuatro variables presentes y con forma válida.
 * - `incompleto`: bandera encendida pero falta alguna variable (`faltan`: vacías o con el valor de ejemplo) o alguna no
 *   tiene forma válida (`invalidas`: hoy, un `R2_ENDPOINT` que no es una URL http(s)). `mensaje` es el texto para logs y
 *   respuestas: solo nombres de variable, jamás valores.
 */
export type R2Diagnostico =
  | { estado: "off" }
  | { estado: "ok" }
  | { estado: "incompleto"; faltan: R2Variable[]; invalidas: R2Variable[]; mensaje: string };

export function diagnosticarR2(env: Env = process.env): R2Diagnostico {
  if (!bandera(env)) return { estado: "off" };
  const faltan: R2Variable[] = [];
  const invalidas: R2Variable[] = [];
  for (const k of R2_VARIABLES) {
    const v = env[k]?.trim() ?? "";
    if (!v || esEjemplo(v)) faltan.push(k);
    else if (k === "R2_ENDPOINT" && !endpointValido(v)) invalidas.push(k);
  }
  if (faltan.length === 0 && invalidas.length === 0) return { estado: "ok" };
  const partes: string[] = [];
  if (faltan.length > 0) partes.push(`faltan o están vacías: ${faltan.join(", ")}`);
  if (invalidas.length > 0) partes.push(`no es una URL http(s) válida: ${invalidas.join(", ")}`);
  return {
    estado: "incompleto",
    faltan,
    invalidas,
    mensaje: `R2_STORAGE=on pero la configuración de R2 está incompleta (${partes.join("; ")}). Mientras tanto los archivos nuevos se guardan en MEDIA_DIR (disco local)`,
  };
}

/** Bandera `R2_STORAGE=on` **y** las cuatro variables presentes y válidas. Cualquier otra cosa = disco local. */
export function r2Config(): R2Config | null {
  if (diagnosticarR2().estado !== "ok") return null;
  return {
    endpoint: process.env.R2_ENDPOINT!.trim().replace(/\/+$/, ""),
    bucket: process.env.R2_BUCKET_NAME!.trim(),
    accessKeyId: process.env.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!.trim(),
  };
}

/** ¿Pidieron R2 pero falta o está mal algo? (el arranque, `/api/health` y `pnpm doctor` avisan; la operación degrada a local). */
export function r2Incompleto(): boolean {
  return diagnosticarR2().estado === "incompleto";
}

export function r2Enabled(): boolean {
  return r2Config() !== null;
}
