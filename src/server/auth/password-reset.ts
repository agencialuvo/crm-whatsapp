import { getBrandingForEmail } from "@/server/branding";
import { sendMail } from "@/server/email/mailer";
import { resetCodeEmail } from "@/server/email/templates";

/**
 * Restablecer la contraseña con un código que llega por correo.
 *
 * Lo conduce el plugin `emailOTP` de Better Auth (genera el código, lo guarda
 * HASHEADO en `verification`, lo vence y limita los intentos). Aquí viven las
 * decisiones propias: qué rutas del plugin se exponen y cómo se manda el correo.
 */

/** Cuánto vale el código, en segundos. */
export const RESET_CODE_TTL_SECONDS = 10 * 60;
export const RESET_CODE_LENGTH = 6;
/** Intentos de código equivocado antes de invalidarlo. */
export const RESET_CODE_MAX_ATTEMPTS = 5;

export const REQUEST_RESET_PATH = "/email-otp/request-password-reset";
export const RESET_PASSWORD_PATH = "/email-otp/reset-password";

/**
 * El plugin trae más rutas (iniciar sesión solo con un código, verificar el
 * correo, cambiar el correo…). Sería una forma nueva de entrar que nadie pidió:
 * aquí solo se exponen las dos del restablecimiento y el resto responde 404.
 */
export function isBlockedEmailOtpPath(path: string): boolean {
  if (path === REQUEST_RESET_PATH || path === RESET_PASSWORD_PATH) return false;
  return (
    path.startsWith("/email-otp/") ||
    path === "/sign-in/email-otp" ||
    path === "/forget-password/email-otp"
  );
}

/** Llamado por el plugin: manda el código solo para el restablecimiento. */
export async function sendResetCode(input: {
  email: string;
  otp: string;
  type: string;
}): Promise<void> {
  if (input.type !== "forget-password") return;
  const branding = await getBrandingForEmail(input.email).catch(() => null);
  const mail = resetCodeEmail({
    code: input.otp,
    minutes: Math.round(RESET_CODE_TTL_SECONDS / 60),
    productName: branding?.name ?? "",
  });
  try {
    await sendMail({ to: input.email, ...mail, fromName: branding?.name });
  } catch (err) {
    // Sin el código en el log: solo qué falló. El cliente ve el mismo «te
    // enviamos un código» de siempre (no se revela si la cuenta existe).
    console.error(
      "[auth] no se pudo enviar el código de restablecimiento:",
      err instanceof Error ? err.message : "error desconocido"
    );
  }
}
