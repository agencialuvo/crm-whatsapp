/**
 * 048 — La configuración del conector de Cloudflare R2. Es el ÚNICO archivo (con `r2.ts`) que lee las credenciales
 * `R2_*`: una prueba de vigilancia lo comprueba. Apagado por defecto (patrón ADR-001): sin la bandera, o con alguna
 * variable vacía, el sistema usa el disco local y nada cambia.
 */

const ON = new Set(["on", "1", "true", "si", "sí", "yes"]);

export type R2Config = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };

/** Bandera `R2_STORAGE=on` **y** las cuatro variables presentes. Cualquier otra cosa = disco local. */
export function r2Config(): R2Config | null {
  if (!ON.has((process.env.R2_STORAGE ?? "").trim().toLowerCase())) return null;
  const endpoint = process.env.R2_ENDPOINT?.trim().replace(/\/+$/, "") ?? "";
  const bucket = process.env.R2_BUCKET_NAME?.trim() ?? "";
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim() ?? "";
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  if (/REEMPLAZA_/.test(endpoint + bucket + accessKeyId + secretAccessKey)) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

/** ¿Pidieron R2 pero falta algo? (el arranque y `pnpm doctor` avisan; la operación degrada a local). */
export function r2Incompleto(): boolean {
  return ON.has((process.env.R2_STORAGE ?? "").trim().toLowerCase()) && r2Config() === null;
}

export function r2Enabled(): boolean {
  return r2Config() !== null;
}
