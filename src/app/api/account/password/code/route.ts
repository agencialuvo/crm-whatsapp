import { headers } from "next/headers";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getAuth } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  changeCodeAvailable,
  issueChangeCode,
  verifyCurrentPassword,
} from "@/server/auth/password-change";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ currentPassword: z.string().min(1, "Escribe tu contraseña actual").max(128) });

/** Pocos códigos por persona, para no usar el CRM como bomba de correo. */
const CODE_LIMIT = { windowMs: 10 * 60 * 1000, max: 3 };
/** Adivinar la contraseña actual desde una sesión abierta: también con tope. */
const GUESS_LIMIT = { windowMs: 10 * 60 * 1000, max: 8 };

/**
 * Mi perfil → cambiar contraseña, paso 1: con la contraseña actual correcta,
 * manda un código de un solo uso al correo de la cuenta. El segundo paso
 * (`POST /api/account/password`) lo exige para aplicar el cambio.
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  if (!changeCodeAvailable()) {
    return apiError(503, "email_unavailable", "Esta instancia no tiene correo configurado para enviar el código.");
  }
  if (!checkRateLimit(`pwd-guess:${session.userId}`, GUESS_LIMIT).allowed) {
    return apiError(429, "rate_limited", "Demasiados intentos. Espera unos minutos.");
  }
  if (!(await verifyCurrentPassword(session.userId, body.data.currentPassword))) {
    return apiError(422, "invalid_password", "La contraseña actual no es correcta.");
  }
  if (!checkRateLimit(`pwd-code:${session.userId}`, CODE_LIMIT).allowed) {
    return apiError(429, "rate_limited", "Pediste varios códigos. Espera unos minutos para pedir otro.");
  }
  const auth = await getAuth().api.getSession({ headers: await headers() });
  if (!auth) return apiError(401, "unauthorized", "No autenticado");
  try {
    await issueChangeCode(session.userId, auth.user.email);
  } catch (err) {
    console.error("[auth] no se pudo enviar el código de cambio de contraseña:", err instanceof Error ? err.message : "error");
    return apiError(502, "email_failed", "No se pudo enviar el código al correo. Inténtalo de nuevo.");
  }
  return Response.json({ sent: true, email: auth.user.email });
});
