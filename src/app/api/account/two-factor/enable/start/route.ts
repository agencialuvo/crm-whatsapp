import { headers } from "next/headers";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getAuth } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { changeCodeAvailable, verifyCurrentPassword } from "@/server/auth/password-change";
import { isTwoFactorEnabled, sendSetupCode } from "@/server/auth/two-factor";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ currentPassword: z.string().min(1, "Escribe tu contraseña actual").max(128) });

const CODE_LIMIT = { windowMs: 10 * 60 * 1000, max: 3 };
const GUESS_LIMIT = { windowMs: 10 * 60 * 1000, max: 8 };

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * Activar el 2FA, paso 1. Con la contraseña actual correcta manda un código de PRUEBA
 * al correo de la cuenta. El 2FA todavía NO se activa: solo lo hace el paso 2, al
 * escribir ese código. Así quien tenga el correo mal o un SMTP caído se entera ahora
 * y no cuando ya no pueda entrar.
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  if (!changeCodeAvailable()) {
    return apiError(
      503,
      "email_unavailable",
      "Esta instancia no tiene correo configurado: sin él no se podría enviar el código y no podrías entrar."
    );
  }
  if (!checkRateLimit(`pwd-guess:${session.userId}`, GUESS_LIMIT).allowed) {
    return apiError(429, "rate_limited", "Demasiados intentos. Espera unos minutos.");
  }
  if (!(await verifyCurrentPassword(session.userId, body.data.currentPassword))) {
    return apiError(422, "invalid_password", "La contraseña actual no es correcta.");
  }
  if (await isTwoFactorEnabled(session.userId)) {
    return apiError(409, "already_enabled", "La verificación en dos pasos ya está activada.");
  }
  if (!checkRateLimit(`2fa-setup:${session.userId}`, CODE_LIMIT).allowed) {
    return apiError(429, "rate_limited", "Pediste varios códigos. Espera unos minutos para pedir otro.");
  }
  const auth = await getAuth().api.getSession({ headers: await headers() });
  if (!auth) return apiError(401, "unauthorized", "No autenticado");
  try {
    await sendSetupCode({ id: session.userId, email: auth.user.email });
  } catch (err) {
    console.error("[auth] no se pudo enviar el código de prueba del 2FA:", err instanceof Error ? err.message : "error");
    return apiError(
      502,
      "email_failed",
      "No se pudo enviar el código a tu correo. No se activó la verificación en dos pasos."
    );
  }
  return Response.json({ sent: true, email: maskEmail(auth.user.email) });
});
