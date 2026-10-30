/** Contrato compartido (cliente y servidor) de la verificación «no soy un robot» (reCAPTCHA v3). */

/** Cabecera con el token que entrega reCAPTCHA. */
export const CAPTCHA_HEADER = "x-captcha-token";
/** Cabecera con la constancia que el servidor emite al validar el token en el paso 1 del login. */
export const CAPTCHA_PROOF_HEADER = "x-captcha-proof";

export const CAPTCHA_REQUIRED_MESSAGE = "Por favor, verifica que no eres un robot";
export const CAPTCHA_UNAVAILABLE_MESSAGE =
  "No se pudo cargar la verificación de seguridad. Revisa tu conexión e inténtalo de nuevo.";

/** Cada puerta pide su propia acción: un token del login no sirve para pedir un código de correo. */
export const CAPTCHA_ACTIONS = {
  login: "login",
  passwordReset: "password_reset",
  teamSignup: "team_signup",
  signup: "signup",
} as const;
export type CaptchaAction = (typeof CAPTCHA_ACTIONS)[keyof typeof CAPTCHA_ACTIONS];

/** La clave pública va al navegador: Next la incrusta al construir. */
export function captchaSiteKey(): string | null {
  return process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY?.trim() || null;
}
