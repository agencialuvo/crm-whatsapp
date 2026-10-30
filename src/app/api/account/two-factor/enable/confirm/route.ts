import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { consumeOtp } from "@/server/auth/otp";
import { activateTwoFactor, isTwoFactorEnabled } from "@/server/auth/two-factor";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, "El código tiene 6 dígitos") });

const CODE_ERRORS = {
  invalid: "El código no es correcto.",
  expired: "El código venció. Pide uno nuevo.",
  too_many: "Demasiados intentos con ese código. Pide uno nuevo.",
  missing: "Pide un código nuevo para continuar.",
} as const;

/**
 * Activar el 2FA, paso 2. Con el código de prueba correcto —prueba de que el correo
 * llega— enciende `two_factor_enabled` y devuelve los códigos de respaldo, UNA sola vez
 * (en la base solo queda su hash).
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  if (await isTwoFactorEnabled(session.userId)) {
    return apiError(409, "already_enabled", "La verificación en dos pasos ya está activada.");
  }
  const result = await consumeOtp("2fa-setup", session.userId, body.data.code);
  if (result !== "ok") return apiError(422, `code_${result}`, CODE_ERRORS[result]);
  const backupCodes = await activateTwoFactor(session.userId);
  return Response.json({ enabled: true, backupCodes });
});
