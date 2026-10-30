import { headers } from "next/headers";
import { z } from "zod";
import { APIError } from "better-auth/api";
import { apiError, parseBody } from "@/lib/api";
import { getAuth } from "@/lib/auth";
import { AUTH_RATE_LIMIT, checkRateLimit, clientIp } from "@/lib/rate-limit";
import { consumeOtp } from "@/server/auth/otp";
import { verifyCurrentPassword } from "@/server/auth/password-change";
import { consumeBackupCode, findUserByEmail, runTwoFactorVerified } from "@/server/auth/two-factor";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
  /** El código de 6 dígitos del correo… */
  code: z.string().trim().regex(/^\d{6}$/, "El código tiene 6 dígitos").optional(),
  /** …o uno de los códigos de respaldo (`ABCD-EFGH`), si el correo no llega. */
  backupCode: z.string().trim().min(8).max(16).optional(),
}).refine((v) => Boolean(v.code) !== Boolean(v.backupCode), {
  message: "Escribe el código del correo o un código de respaldo",
});

const CODE_ERRORS = {
  invalid: "El código no es correcto.",
  expired: "El código venció. Pide uno nuevo.",
  too_many: "Demasiados intentos con ese código. Pide uno nuevo.",
  missing: "Pide un código nuevo para continuar.",
} as const;

/**
 * Inicio de sesión con 2FA, paso 2. Vuelve a comprobar correo y contraseña, gasta
 * el código y, solo entonces, inicia la sesión DESDE EL SERVIDOR (el inicio de
 * sesión público rechaza a las cuentas con 2FA). Las cookies de la sesión viajan
 * en esta misma respuesta.
 */
export async function POST(req: Request) {
  if (!checkRateLimit(`2fa-verify:${clientIp(req.headers)}`, AUTH_RATE_LIMIT).allowed) {
    return apiError(429, "rate_limited", "Demasiados intentos. Espera unos minutos.");
  }
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  const { email, password, code, backupCode } = body.data;

  const user = await findUserByEmail(email);
  if (!user?.twoFactorEnabled || !(await verifyCurrentPassword(user.id, password))) {
    return apiError(401, "invalid_credentials", "Correo o contraseña incorrectos.");
  }
  if (backupCode) {
    // Adivinar un código de respaldo: con tope por cuenta, además del de la IP.
    if (!checkRateLimit(`2fa-backup:${user.id}`, { windowMs: 10 * 60 * 1000, max: 10 }).allowed) {
      return apiError(429, "rate_limited", "Demasiados intentos. Espera unos minutos.");
    }
    if (!(await consumeBackupCode(user.id, backupCode))) {
      return apiError(422, "backup_invalid", "Ese código de respaldo no es válido o ya se usó.");
    }
  } else {
    const result = await consumeOtp("login-2fa", user.id, code ?? "");
    if (result !== "ok") return apiError(422, `code_${result}`, CODE_ERRORS[result]);
  }

  const requestHeaders = await headers();
  try {
    const signedIn = await runTwoFactorVerified(user.id, () =>
      getAuth().api.signInEmail({
        headers: requestHeaders,
        body: { email, password },
        returnHeaders: true,
      })
    );
    return Response.json({ ok: true }, { headers: signedIn.headers });
  } catch (err) {
    if (err instanceof APIError && err.status === "TOO_MANY_REQUESTS") {
      return apiError(429, "rate_limited", "Demasiados intentos. Espera unos minutos.");
    }
    if (err instanceof APIError) {
      return apiError(401, "invalid_credentials", "Correo o contraseña incorrectos.");
    }
    throw err;
  }
}
