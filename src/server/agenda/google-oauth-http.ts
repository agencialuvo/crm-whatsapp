import { getEnv } from "@/lib/env";
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH, STATE_TTL_MS } from "@/server/agenda/google-oauth";

/**
 * Paso 3 — Respuestas HTTP del flujo OAuth de Google: la vuelta a Ajustes → Agenda y la cookie del flujo.
 * Aparte de las rutas para que las pruebas las usen sin cargar Next.
 */

/** Donde vive la tarjeta de Google (Ajustes → Agenda). */
export const GOOGLE_SETTINGS_PATH = "/ajustes/calendario";

function absolute(path: string): string {
  return `${getEnv().APP_BASE_URL.replace(/\/+$/, "")}${path}`;
}

function cookieAttrs(maxAgeSeconds: number): string {
  const secure = getEnv().APP_BASE_URL.startsWith("https://") ? "; Secure" : "";
  return `Path=${OAUTH_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function setOAuthCookie(value: string): string {
  return `${OAUTH_COOKIE}=${encodeURIComponent(value)}; ${cookieAttrs(Math.floor(STATE_TTL_MS / 1000))}`;
}

export function clearOAuthCookie(): string {
  return `${OAUTH_COOKIE}=; ${cookieAttrs(0)}`;
}

/** 302 a una URL (absoluta) con cookies opcionales. `Response.redirect` no deja añadir cabeceras. */
export function redirectTo(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

/** Vuelve a Ajustes → Agenda con el resultado: `?google=conectado` o `?google=error&motivo=…`. */
export function backToSettings(result: { ok: true } | { ok: false; reason: string }): Response {
  const query = result.ok ? "google=conectado" : `google=error&motivo=${encodeURIComponent(result.reason)}`;
  return redirectTo(absolute(`${GOOGLE_SETTINGS_PATH}?${query}`), [clearOAuthCookie()]);
}
