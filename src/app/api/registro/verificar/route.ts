import { headers } from "next/headers";
import { z } from "zod";
import { APIError } from "better-auth/api";
import { apiError, parseBody } from "@/lib/api";
import { getAuth } from "@/lib/auth";
import { AUTH_RATE_LIMIT, checkRateLimit, clientIp } from "@/lib/rate-limit";
import { consumeOtp } from "@/server/auth/otp";
import { isPublicSignupAllowed } from "@/server/auth/registration";
import { completeSignup, findPendingSignupWithPassword } from "@/server/auth/signup-verification";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
  code: z.string().trim().regex(/^\d{6}$/, "El código tiene 6 dígitos"),
});

const CODE_ERRORS = {
  invalid: "El código no es correcto.",
  expired: "El código venció. Pide uno nuevo.",
  too_many: "Demasiados intentos con ese código. Pide uno nuevo.",
  missing: "Pide un código nuevo para continuar.",
} as const;

/**
 * Cierra el registro: comprueba correo, contraseña y código; con todo correcto verifica el correo, crea el
 * negocio del propietario e inicia la sesión DESDE EL SERVIDOR (las cookies viajan en esta respuesta).
 */
export async function POST(req: Request) {
  if (!(await isPublicSignupAllowed())) return apiError(403, "signup_disabled", "El registro no está disponible.");
  if (!checkRateLimit(`signup-verify:${clientIp(req.headers)}`, AUTH_RATE_LIMIT).allowed) {
    return apiError(429, "rate_limited", "Demasiados intentos. Espera unos minutos.");
  }
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  const { email, password, code } = body.data;

  const user = await findPendingSignupWithPassword(email, password);
  if (!user) return apiError(401, "invalid_credentials", "No hay un registro pendiente con esos datos.");

  const result = await consumeOtp("signup-verify", user.id, code);
  if (result !== "ok") return apiError(422, `code_${result}`, CODE_ERRORS[result]);

  await completeSignup(user);
  try {
    const signedIn = await getAuth().api.signInEmail({
      headers: await headers(),
      body: { email, password },
      returnHeaders: true,
    });
    return Response.json({ ok: true }, { headers: signedIn.headers });
  } catch (err) {
    if (err instanceof APIError && err.status === "TOO_MANY_REQUESTS") {
      return apiError(429, "rate_limited", "Demasiados intentos. Espera unos minutos.");
    }
    if (err instanceof APIError) {
      // La cuenta ya quedó verificada: solo falló abrir la sesión.
      return apiError(401, "signin_failed", "Tu cuenta ya está verificada. Inicia sesión para continuar.");
    }
    throw err;
  }
}
