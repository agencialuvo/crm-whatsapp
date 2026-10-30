import { createHmac, timingSafeEqual } from "node:crypto";
import { CAPTCHA_HEADER, CAPTCHA_PROOF_HEADER, type CaptchaAction } from "@/lib/captcha";
import { getEnv } from "@/lib/env";

/**
 * reCAPTCHA en las puertas de autenticación (inicio de sesión, restablecer
 * contraseña, alta de cuentas de equipo).
 *
 * Conector opcional (constitución II): sin las dos claves queda apagado y todo
 * funciona igual. Si Google no responde, NO se bloquea la operación: los topes
 * por IP y por cuenta siguen frenando la fuerza bruta.
 */

const VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
const VERIFY_TIMEOUT_MS = 5000;
/** Cuánto vale la constancia del paso 1 del login para el paso 2. */
const PROOF_TTL_MS = 5 * 60 * 1000;

export function captchaEnabled(): boolean {
  return !!(process.env.RECAPTCHA_SECRET_KEY?.trim() && process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY?.trim());
}

/** Puntuación mínima de reCAPTCHA v3 (0 = bot, 1 = persona). Ajustable con RECAPTCHA_MIN_SCORE. */
function minScore(): number {
  const n = Number(process.env.RECAPTCHA_MIN_SCORE);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.5;
}

/** Valida el token contra Google: que sea de este sitio, de ESTA acción y con buena puntuación. Un solo uso. */
export async function verifyCaptchaToken(
  token: string | null | undefined,
  action: CaptchaAction,
  ip?: string
): Promise<boolean> {
  if (!captchaEnabled()) return true;
  if (!token || token.length > 4096) return false;
  try {
    const form = new URLSearchParams({ secret: process.env.RECAPTCHA_SECRET_KEY!.trim(), response: token });
    if (ip && ip !== "local") form.set("remoteip", ip);
    // RECAPTCHA_VERIFY_URL solo se sobreescribe en el self-test (apunta a un Google falso).
    const res = await fetch(process.env.RECAPTCHA_VERIFY_URL?.trim() || VERIFY_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[captcha] Google respondió ${res.status}; se deja pasar (degradación)`);
      return true;
    }
    const data = (await res.json()) as {
      success?: boolean;
      score?: number;
      action?: string;
      "error-codes"?: string[];
    };
    if (data.success === true) {
      // Un token válido de otra acción, o de baja puntuación (bot), no abre esta puerta.
      return data.action === action && (data.score ?? 0) >= minScore();
    }
    // Claves mal puestas (no es culpa de quien intenta entrar): se avisa en el log y se deja pasar.
    const codes = data["error-codes"] ?? [];
    if (codes.some((c) => c === "invalid-input-secret" || c === "missing-input-secret")) {
      console.error("[captcha] RECAPTCHA_SECRET_KEY no es válida; se deja pasar hasta corregirla");
      return true;
    }
    return false;
  } catch (err) {
    console.warn("[captcha] no se pudo consultar a Google; se deja pasar:", err instanceof Error ? err.message : "error");
    return true;
  }
}

/** Valida el token que viene en la cabecera de la petición. */
export function verifyCaptchaHeader(
  headers: Headers | null | undefined,
  action: CaptchaAction,
  ip?: string
): Promise<boolean> {
  return verifyCaptchaToken(headers?.get(CAPTCHA_HEADER), action, ip);
}

function sign(email: string, exp: number): string {
  return createHmac("sha256", getEnv().BETTER_AUTH_SECRET).update(`captcha-proof:${email.toLowerCase()}:${exp}`).digest("base64url");
}

/**
 * Constancia de que ESTE correo ya pasó el captcha en el paso 1 del login. El token de
 * Google es de un solo uso, y el login hace dos llamadas (paso 1 y la de Better Auth):
 * la segunda presenta esta constancia en lugar de un segundo desafío.
 */
export function issueCaptchaProof(email: string): string {
  const exp = Date.now() + PROOF_TTL_MS;
  return `${exp}.${sign(email, exp)}`;
}

export function verifyCaptchaProof(headers: Headers | null | undefined, email: string): boolean {
  const raw = headers?.get(CAPTCHA_PROOF_HEADER);
  if (!raw) return false;
  const [expRaw = "", mac = ""] = raw.split(".");
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = Buffer.from(sign(email, exp));
  const given = Buffer.from(mac);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
