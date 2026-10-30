import { headers } from "next/headers";
import { z } from "zod";
import { APIError } from "better-auth/api";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getAuth, runInternalPasswordChange } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  changeCodeAvailable,
  consumeChangeCode,
  notifyPasswordChanged,
  verifyCurrentPassword,
} from "@/server/auth/password-change";

export const dynamic = "force-dynamic";

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

const bodySchema = z.object({
  currentPassword: z.string().min(1, "Escribe tu contraseña actual").max(MAX_PASSWORD),
  newPassword: z
    .string()
    .min(MIN_PASSWORD, `La contraseña nueva lleva al menos ${MIN_PASSWORD} caracteres`)
    .max(MAX_PASSWORD, `La contraseña nueva admite hasta ${MAX_PASSWORD} caracteres`),
  /** El código del correo. Obligatorio cuando la instancia puede enviar correo. */
  code: z.string().trim().regex(/^\d{6}$/, "El código tiene 6 dígitos").optional(),
});

const GUESS_LIMIT = { windowMs: 10 * 60 * 1000, max: 8 };

const CODE_ERRORS = {
  invalid: "El código no es correcto.",
  expired: "El código venció. Pide uno nuevo.",
  too_many: "Demasiados intentos con ese código. Pide uno nuevo.",
  missing: "Pide un código nuevo para continuar.",
} as const;

/**
 * Mi perfil → cambiar contraseña, paso 2. Exige la contraseña actual y, si la
 * instancia puede enviar correo, el código de un solo uso. Al terminar cierra
 * las demás sesiones y avisa por correo a la persona y a los propietarios.
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  const { currentPassword, newPassword, code } = body.data;

  if (!checkRateLimit(`pwd-guess:${session.userId}`, GUESS_LIMIT).allowed) {
    return apiError(429, "rate_limited", "Demasiados intentos. Espera unos minutos.");
  }
  if (newPassword === currentPassword) {
    return apiError(422, "same_password", "La contraseña nueva debe ser distinta a la actual.");
  }
  // La actual se comprueba ANTES de gastar el código: equivocarse en ella no lo quema.
  if (!(await verifyCurrentPassword(session.userId, currentPassword))) {
    return apiError(422, "invalid_password", "La contraseña actual no es correcta.");
  }
  if (changeCodeAvailable()) {
    if (!code) return apiError(422, "code_required", "Escribe el código que enviamos a tu correo.");
    const result = await consumeChangeCode(session.userId, code);
    if (result !== "ok") return apiError(422, `code_${result}`, CODE_ERRORS[result]);
  }

  const requestHeaders = await headers();
  // Quién es se lee ANTES: cambiar la contraseña cierra las sesiones y rota la actual.
  const before = await getAuth().api.getSession({ headers: requestHeaders });
  let result: Awaited<ReturnType<typeof changePasswordWithHeaders>>;
  try {
    result = await changePasswordWithHeaders(requestHeaders, currentPassword, newPassword);
  } catch (err) {
    if (err instanceof APIError) {
      return apiError(422, "change_failed", "No se pudo cambiar la contraseña. Revisa los datos.");
    }
    throw err;
  }

  if (before) {
    await notifyPasswordChanged({
      organizationId: session.organizationId,
      user: { name: before.user.name, email: before.user.email },
    });
  }
  // La sesión actual se renueva: su cookie nueva tiene que llegar al navegador.
  return Response.json(
    { changed: true, notified: changeCodeAvailable() },
    { headers: result.headers }
  );
});

function changePasswordWithHeaders(requestHeaders: Headers, currentPassword: string, newPassword: string) {
  return runInternalPasswordChange(() =>
    getAuth().api.changePassword({
      headers: requestHeaders,
      body: { currentPassword, newPassword, revokeOtherSessions: true },
      returnHeaders: true,
    })
  );
}
