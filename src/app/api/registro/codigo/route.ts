import { z } from "zod";
import { apiError, parseBody } from "@/lib/api";
import { AUTH_RATE_LIMIT, checkRateLimit, clientIp } from "@/lib/rate-limit";
import { changeCodeAvailable } from "@/server/auth/password-change";
import { isPublicSignupAllowed } from "@/server/auth/registration";
import { findPendingSignupWithPassword, sendSignupCode } from "@/server/auth/signup-verification";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
});

/** Pocos códigos por cuenta, para no usar el CRM como bomba de correo. */
const CODE_LIMIT = { windowMs: 10 * 60 * 1000, max: 5 };

/**
 * Manda (o reenvía) el código con el que se verifica el correo de un registro a medias. Pide la contraseña
 * de la cuenta: sin ella no se envía nada, así que no sirve para escribirle a un correo ajeno.
 */
export async function POST(req: Request) {
  if (!(await isPublicSignupAllowed())) return apiError(403, "signup_disabled", "El registro no está disponible.");
  if (!checkRateLimit(`signup-code-ip:${clientIp(req.headers)}`, AUTH_RATE_LIMIT).allowed) {
    return apiError(429, "rate_limited", "Demasiados intentos. Espera unos minutos.");
  }
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  if (!changeCodeAvailable()) {
    return apiError(503, "email_unavailable", "El servidor no tiene correo configurado para enviar el código.");
  }
  const user = await findPendingSignupWithPassword(body.data.email, body.data.password);
  if (!user) return apiError(401, "invalid_credentials", "No hay un registro pendiente con esos datos.");
  if (!checkRateLimit(`signup-code:${user.id}`, CODE_LIMIT).allowed) {
    return apiError(429, "rate_limited", "Pediste varios códigos. Espera unos minutos para pedir otro.");
  }
  try {
    await sendSignupCode(user);
  } catch (err) {
    console.error("[auth] no se pudo enviar el código de registro:", err instanceof Error ? err.message : "error");
    return apiError(502, "email_failed", "No se pudo enviar el código al correo. Inténtalo de nuevo.");
  }
  return Response.json({ ok: true });
}
