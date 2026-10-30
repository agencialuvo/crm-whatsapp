import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyCurrentPassword } from "@/server/auth/password-change";
import { regenerateBackupCodes } from "@/server/auth/two-factor";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ currentPassword: z.string().min(1, "Escribe tu contraseña actual").max(128) });
const GUESS_LIMIT = { windowMs: 10 * 60 * 1000, max: 8 };

/**
 * Mi perfil → códigos de respaldo nuevos (los anteriores dejan de valer). Pide la
 * contraseña actual y solo existe con el 2FA activo. Los devuelve UNA sola vez.
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  if (!checkRateLimit(`pwd-guess:${session.userId}`, GUESS_LIMIT).allowed) {
    return apiError(429, "rate_limited", "Demasiados intentos. Espera unos minutos.");
  }
  if (!(await verifyCurrentPassword(session.userId, body.data.currentPassword))) {
    return apiError(422, "invalid_password", "La contraseña actual no es correcta.");
  }
  const backupCodes = await regenerateBackupCodes(session.userId);
  if (!backupCodes) {
    return apiError(409, "not_enabled", "Activa la verificación en dos pasos para tener códigos de respaldo.");
  }
  return Response.json({ backupCodes });
});
