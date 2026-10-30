import { z } from "zod";
import { apiError, parseBody } from "@/lib/api";
import { CAPTCHA_ACTIONS, CAPTCHA_REQUIRED_MESSAGE } from "@/lib/captcha";
import { AUTH_RATE_LIMIT, checkRateLimit, clientIp } from "@/lib/rate-limit";
import { captchaEnabled, issueCaptchaProof, verifyCaptchaHeader, verifyCaptchaProof } from "@/server/auth/captcha";
import { changeCodeAvailable, verifyCurrentPassword } from "@/server/auth/password-change";
import { backupCodesRemaining, findUserByEmail, sendLoginCode } from "@/server/auth/two-factor";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
});

/** Pocos códigos por cuenta, para no usar el CRM como bomba de correo. */
const CODE_LIMIT = { windowMs: 10 * 60 * 1000, max: 3 };

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * Inicio de sesión con 2FA, paso 1. Con correo y contraseña CORRECTOS de una cuenta
 * con verificación en dos pasos, manda el código al correo y responde
 * `{ twoFactor: true }`. En cualquier otro caso responde `{ twoFactor: false }`
 * (cuenta sin 2FA, o datos que no coinciden): la pantalla sigue con el inicio de
 * sesión normal, que es quien dice «incorrectos». Así esta ruta no sirve para
 * averiguar qué correos existen ni cuáles usan 2FA.
 */
export async function POST(req: Request) {
  if (!checkRateLimit(`2fa-start:${clientIp(req.headers)}`, AUTH_RATE_LIMIT).allowed) {
    return apiError(429, "rate_limited", "Demasiados intentos. Espera unos minutos.");
  }
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return Response.json({ twoFactor: false });
  // Primero el desafío: sin él no se toca la base de datos ni el correo. Vale el token del
  // widget o la constancia de este mismo correo (así «Reenviar código» no pide otro desafío).
  if (
    !verifyCaptchaProof(req.headers, body.data.email) &&
    !(await verifyCaptchaHeader(req.headers, CAPTCHA_ACTIONS.login, clientIp(req.headers)))
  ) {
    return apiError(400, "captcha_required", CAPTCHA_REQUIRED_MESSAGE);
  }
  // La constancia viaja a la llamada de inicio de sesión (el token de Google es de un solo uso).
  const captchaProof = captchaEnabled() ? issueCaptchaProof(body.data.email) : undefined;

  const user = await findUserByEmail(body.data.email);
  if (!user?.twoFactorEnabled || !(await verifyCurrentPassword(user.id, body.data.password))) {
    return Response.json({ twoFactor: false, captchaProof });
  }
  // Con los datos ya comprobados, si el correo no sale pero hay códigos de respaldo se
  // sigue igual: esa es justo la red de seguridad para cuando el correo falla.
  const hasBackup = (await backupCodesRemaining(user.id)) > 0;
  const emailDown = (message: string, status: number, code: string) =>
    hasBackup
      ? Response.json({ twoFactor: true, emailSent: false, backupAvailable: true, email: maskEmail(user.email), captchaProof })
      : apiError(status, code, message);

  if (!changeCodeAvailable()) {
    return emailDown(
      "Esta cuenta usa verificación en dos pasos, pero el servidor no tiene correo configurado para enviar el código.",
      503,
      "email_unavailable"
    );
  }
  if (!checkRateLimit(`2fa-code:${user.id}`, CODE_LIMIT).allowed) {
    return apiError(429, "rate_limited", "Pediste varios códigos. Espera unos minutos para pedir otro.");
  }
  try {
    await sendLoginCode(user);
  } catch (err) {
    console.error("[auth] no se pudo enviar el código de acceso:", err instanceof Error ? err.message : "error");
    return emailDown("No se pudo enviar el código al correo. Inténtalo de nuevo.", 502, "email_failed");
  }
  return Response.json({ twoFactor: true, emailSent: true, backupAvailable: hasBackup, email: maskEmail(user.email), captchaProof });
}
