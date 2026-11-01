/**
 * El registro público de propietarios (`POST /api/auth/sign-up/email` y la pantalla `/registro`) está
 * CERRADO por defecto: las cuentas se crean por backend, con `pnpm crear-usuario` (ver
 * scripts/crear-usuario.ts) o, las del equipo, el propietario desde Ajustes → Equipo (bypass interno
 * del gate).
 *
 * Se abre con la variable de despliegue ALLOW_SIGNUP=true. Entonces la pantalla de inicio de sesión
 * muestra «Regístrate» y cada registro crea SU PROPIO negocio como propietario (ver
 * `onOwnerRegistered`), protegido por el captcha de la acción `signup` y el límite de intentos por IP.
 * Cualquier otro valor ("1", "yes"…) no la abre.
 */
export async function isPublicSignupAllowed(): Promise<boolean> {
  return process.env.ALLOW_SIGNUP === "true";
}
