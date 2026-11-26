import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";
import { GOOGLE_SCOPE, GOOGLE_TIMEOUT_MS } from "@/server/agenda/connectors/google";
import { CALENDAR_LIST_SCOPE } from "@/lib/google-calendar";

/**
 * Paso 3 — «Conectar con Google» con un clic: el flujo OAuth 2.0 (código de autorización + PKCE S256) con
 * la app de la INSTANCIA (`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`).
 *
 *   /oauth/start    → firma un `state` (organización, usuario, nonce, vence en 10 min) con HMAC y guarda
 *                     el nonce y el `code_verifier` en una cookie httpOnly; redirige a Google.
 *   /oauth/callback → el `state` tiene que estar bien firmado, vigente, ser de ESTA sesión y coincidir con
 *                     la cookie; canjea el código con su verifier; exige refresh token y el permiso de
 *                     eventos (Google deja desmarcarlo); prueba la conexión y recién entonces guarda.
 *
 * Funciones puras salvo `exchangeCode` y `revokeToken`, que hablan con Google (con tiempo máximo).
 */

/** Lo mínimo: escribir eventos, y la identidad (correo) para mostrar «Conectado como …». */
export const GOOGLE_OAUTH_SCOPES = [GOOGLE_SCOPE, "openid", "email"] as const;

/**
 * Mejora 2 — ¿Se pide también la lista de calendarios? Solo con `GOOGLE_CALENDAR_LIST` encendida: es un
 * permiso que Google tiene que aprobar en la pantalla de consentimiento antes de pedirlo en producción.
 */
export function calendarListEnabled(): boolean {
  return ["on", "1", "true", "si", "sí", "yes"].includes((getEnv().GOOGLE_CALENDAR_LIST ?? "").trim().toLowerCase());
}

/** Los permisos que se piden ahora (los mínimos, más la lista de calendarios si la bandera está encendida). */
export function oauthScopes(): string[] {
  return calendarListEnabled() ? [...GOOGLE_OAUTH_SCOPES, CALENDAR_LIST_SCOPE] : [...GOOGLE_OAUTH_SCOPES];
}

export const OAUTH_COOKIE = "vocero_google_oauth";
/** La cookie solo viaja a las rutas del flujo. */
export const OAUTH_COOKIE_PATH = "/api/settings/google/oauth";
export const STATE_TTL_MS = 10 * 60_000;

export function oauthRedirectUri(): string {
  return `${getEnv().APP_BASE_URL.replace(/\/+$/, "")}/api/settings/google/oauth/callback`;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export type OAuthState = { o: string; u: string; n: string; e: number };

/** El contexto va dentro de la firma: un `state` de un flujo no sirve en el otro. */
function sign(payload: string, secret: string, context = "google-oauth"): string {
  return b64url(createHmac("sha256", secret).update(`${context}:${payload}`).digest());
}

/** `payload.firma`, con el payload en base64url. */
export function signState(state: OAuthState, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(state)));
  return `${payload}.${sign(payload, secret)}`;
}

export type StateCheck =
  | { ok: true; state: OAuthState }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_session" | "nonce_mismatch" };

/** Comprueba firma, vigencia, sesión (organización y usuario) y que el nonce sea el de la cookie. */
export function verifyState(
  token: string | null | undefined,
  input: { secret: string; organizationId: string; userId: string; cookieNonce: string | null; now?: number }
): StateCheck {
  const [payload, signature, extra] = (token ?? "").split(".");
  if (!payload || !signature || extra !== undefined) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(sign(payload, input.secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_signature" };
  }
  let state: OAuthState;
  try {
    state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof state?.e !== "number" || typeof state.n !== "string") return { ok: false, reason: "malformed" };
  if (state.e < (input.now ?? Date.now())) return { ok: false, reason: "expired" };
  if (state.o !== input.organizationId || state.u !== input.userId) return { ok: false, reason: "wrong_session" };
  if (!input.cookieNonce || input.cookieNonce !== state.n) return { ok: false, reason: "nonce_mismatch" };
  return { ok: true, state };
}

/** PKCE S256: el verifier se queda en la cookie; a Google solo va el challenge. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function newNonce(): string {
  return b64url(randomBytes(18));
}

/** Valor de la cookie: `nonce.verifier` (los dos en base64url, sin puntos). */
export function cookieValue(nonce: string, verifier: string): string {
  return `${nonce}.${verifier}`;
}

export function parseCookieValue(raw: string | null | undefined): { nonce: string; verifier: string } | null {
  const [nonce, verifier, extra] = (raw ?? "").split(".");
  return nonce && verifier && extra === undefined ? { nonce, verifier } : null;
}

/** Lee una cookie de la cabecera `Cookie`. */
export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function buildAuthorizeUrl(input: {
  clientId: string;
  state: string;
  challenge: string;
  redirectUri?: string;
  /** Mejora 3: los permisos de otro flujo (el del profesional); por defecto, los del negocio. */
  scopes?: readonly string[];
}): string {
  // Concatenado y no `new URL("/o/…", base)`: eso descartaría el camino de una base con subruta (el mock).
  const url = new URL(`${getEnv().GOOGLE_ACCOUNTS_BASE_URL.replace(/\/+$/, "")}/o/oauth2/v2/auth`);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri ?? oauthRedirectUri(),
    response_type: "code",
    scope: (input.scopes ?? oauthScopes()).join(" "),
    // `offline` + `consent`: Google entrega SIEMPRE un refresh token (sin `consent` solo lo da la primera vez).
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** ¿Concedió el permiso de eventos? (la pantalla de Google permite desmarcarlo). */
export function hasCalendarScope(scope: string | null | undefined): boolean {
  return (scope ?? "").split(/\s+/).includes(GOOGLE_SCOPE);
}

/**
 * El correo del `id_token`. Sin verificar la firma A PROPÓSITO: viene directo del endpoint de tokens de
 * Google por TLS en esta misma llamada (OIDC Core 3.1.3.7 lo permite), y solo se usa para mostrarlo.
 */
export function emailFromIdToken(idToken: string | null | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof data.email === "string" ? data.email : null;
  } catch {
    return null;
  }
}

export type CodeExchange =
  | { ok: true; refreshToken: string; scope: string; email: string | null }
  | { ok: false; reason: "exchange_failed" | "no_refresh_token" | "missing_scope"; detail?: string };

/** Canjea el código de autorización. Nunca lanza: los fallos vuelven con su motivo (sin secretos). */
export async function exchangeCode(input: {
  code: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  /** Mejora 3: qué permiso hace falta (el del profesional es de solo lectura); por defecto, `calendar.events`. */
  hasRequiredScope?: (scope: string | null | undefined) => boolean;
}): Promise<CodeExchange> {
  let res: Response;
  try {
    res = await fetch(`${getEnv().GOOGLE_OAUTH_BASE_URL}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: input.verifier,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri ?? oauthRedirectUri(),
      }).toString(),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: "exchange_failed", detail: `No se pudo contactar a Google: ${err}` };
  }
  const data = (await res.json().catch(() => null)) as {
    refresh_token?: string;
    scope?: string;
    id_token?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (!res.ok || !data) {
    return { ok: false, reason: "exchange_failed", detail: data?.error_description ?? data?.error ?? `HTTP ${res.status}` };
  }
  if (!(input.hasRequiredScope ?? hasCalendarScope)(data.scope)) return { ok: false, reason: "missing_scope" };
  if (!data.refresh_token) return { ok: false, reason: "no_refresh_token" };
  return { ok: true, refreshToken: data.refresh_token, scope: data.scope ?? "", email: emailFromIdToken(data.id_token) };
}

/** Revoca el permiso en Google al desconectar. Best-effort: si falla, se desconecta igual. */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${getEnv().GOOGLE_OAUTH_BASE_URL}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ---------- Mejora 3: el profesional conecta SU calendario (solo lectura) ---------- */

/** Solo leer eventos (y la identidad para mostrar la cuenta). Nunca escribe en el calendario del profesional. */
export const STAFF_READ_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const STAFF_OAUTH_SCOPES = [STAFF_READ_SCOPE, "openid", "email"] as const;

/** La cookie del flujo del profesional: otro nombre y solo viaja a sus rutas públicas. */
export const STAFF_OAUTH_COOKIE = "vocero_staff_google_oauth";
export const STAFF_OAUTH_COOKIE_PATH = "/api/calendar-invite";

/** La URI de vuelta del profesional (hay que registrarla en Google Cloud). Pública: el profesional no tiene sesión. */
export function staffOAuthRedirectUri(): string {
  return `${getEnv().APP_BASE_URL.replace(/\/+$/, "")}/api/calendar-invite/oauth/callback`;
}

/** ¿Concedió leer el calendario? (vale también un permiso mayor: `calendar.events` o `calendar`). */
export function hasStaffReadScope(scope: string | null | undefined): boolean {
  const granted = (scope ?? "").split(/\s+/);
  return [STAFF_READ_SCOPE, GOOGLE_SCOPE, "https://www.googleapis.com/auth/calendar"].some((s) => granted.includes(s));
}

/** El `state` del profesional: la invitación (no hay sesión que comprobar), un nonce y el vencimiento. */
export type StaffOAuthState = { i: string; n: string; e: number };

export function signStaffState(state: StaffOAuthState, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(state)));
  return `${payload}.${sign(payload, secret, "google-staff-oauth")}`;
}

export type StaffStateCheck =
  | { ok: true; state: StaffOAuthState }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "nonce_mismatch" };

/** Firma (del flujo del profesional), vigencia y que el nonce sea el de la cookie. */
export function verifyStaffState(
  token: string | null | undefined,
  input: { secret: string; cookieNonce: string | null; now?: number }
): StaffStateCheck {
  const [payload, signature, extra] = (token ?? "").split(".");
  if (!payload || !signature || extra !== undefined) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(sign(payload, input.secret, "google-staff-oauth"));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_signature" };
  }
  let state: StaffOAuthState;
  try {
    state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as StaffOAuthState;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof state?.e !== "number" || typeof state.n !== "string" || typeof state.i !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (state.e < (input.now ?? Date.now())) return { ok: false, reason: "expired" };
  if (!input.cookieNonce || input.cookieNonce !== state.n) return { ok: false, reason: "nonce_mismatch" };
  return { ok: true, state };
}
