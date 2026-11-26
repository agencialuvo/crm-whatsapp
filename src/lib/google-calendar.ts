/**
 * Paso 3 — Textos de la conexión con Google Calendar que comparten el servidor y la pantalla (sin
 * dependencias de servidor). El callback de OAuth vuelve a Ajustes con `?google=error&motivo=<código>`.
 */

export const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  denied: "Cancelaste el permiso en Google. No se conectó nada.",
  state: "El enlace de conexión caducó o no es de esta sesión. Vuelve a intentarlo.",
  exchange_failed: "Google no aceptó la autorización. Vuelve a intentarlo.",
  no_refresh_token:
    "Google no entregó el permiso permanente. Quita el acceso de esta app en tu cuenta de Google y vuelve a conectar.",
  missing_scope: "Falta el permiso para gestionar los eventos del calendario: márcalo en la pantalla de Google.",
  test_failed: "La cuenta se autorizó, pero no se pudo escribir en su calendario.",
  no_app: "Esta instancia no tiene configurada la app de Google: usa el modo Avanzado.",
};

export function oauthErrorMessage(code: string | null | undefined): string {
  return (code && OAUTH_ERROR_MESSAGES[code]) || "No se pudo conectar con Google. Vuelve a intentarlo.";
}

/** «primary» es el calendario principal de la cuenta; cualquier otro se muestra tal cual. */
export function calendarLabel(calendarId: string | null | undefined): string {
  return !calendarId || calendarId === "primary" ? "calendario principal" : `calendario «${calendarId}»`;
}
