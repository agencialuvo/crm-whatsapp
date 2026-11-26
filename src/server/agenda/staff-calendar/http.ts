import { getEnv } from "@/lib/env";
import { STAFF_OAUTH_COOKIE, STAFF_OAUTH_COOKIE_PATH, STATE_TTL_MS } from "@/server/agenda/google-oauth";
import { redirectTo } from "@/server/agenda/google-oauth-http";

/**
 * Mejora 3 — Respuestas HTTP del flujo del profesional: la cookie del flujo (otra que la del negocio, solo en
 * `/api/calendar-invite`) y la vuelta a la página de resultado (pública).
 */

export const STAFF_RESULT_PATH = "/conectar-calendario/resultado";

function cookieAttrs(maxAgeSeconds: number): string {
  const secure = getEnv().APP_BASE_URL.startsWith("https://") ? "; Secure" : "";
  return `Path=${STAFF_OAUTH_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function setStaffOAuthCookie(value: string): string {
  return `${STAFF_OAUTH_COOKIE}=${encodeURIComponent(value)}; ${cookieAttrs(Math.floor(STATE_TTL_MS / 1000))}`;
}

export function clearStaffOAuthCookie(): string {
  return `${STAFF_OAUTH_COOKIE}=; ${cookieAttrs(0)}`;
}

/** A la página de resultado: `?estado=ok&negocio=…&nombre=…` o `?estado=error&motivo=…`. Borra la cookie. */
export function staffResult(
  result: { ok: true; organizationName: string; staffName: string } | { ok: false; reason: string }
): Response {
  const params = new URLSearchParams(
    result.ok
      ? { estado: "ok", negocio: result.organizationName, nombre: result.staffName }
      : { estado: "error", motivo: result.reason }
  );
  const base = getEnv().APP_BASE_URL.replace(/\/+$/, "");
  return redirectTo(`${base}${STAFF_RESULT_PATH}?${params.toString()}`, [clearStaffOAuthCookie()]);
}
