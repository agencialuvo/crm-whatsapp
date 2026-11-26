import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Paso 3 — «Conectar con Google» con un clic: el `state` firmado, PKCE S256, la URL de permisos, el canje
 * del código y las rutas `/api/settings/google/oauth/{start,callback}` con cada camino infeliz. Google se
 * simula por la frontera de red (`fetch`); la base, la sesión y la prueba de conexión son dobles.
 */

const SECRET = "secreto-de-prueba-suficiente";
const session = { userId: "usr_1", organizationId: "org_1", role: "owner" };
const app = { current: { clientId: "cid.apps.googleusercontent.com", clientSecret: "csec" } as { clientId: string; clientSecret: string } | null };

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    APP_BASE_URL: "https://crm.ejemplo.test",
    BETTER_AUTH_SECRET: SECRET,
    GOOGLE_ACCOUNTS_BASE_URL: "https://accounts.google.test",
    GOOGLE_OAUTH_BASE_URL: "https://oauth.google.test",
    GOOGLE_CAL_BASE_URL: "https://cal.google.test/v3",
  }),
}));
vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...session }),
}));
vi.mock("@/server/saas/enforcement", () => ({ subscriptionInactive: async () => null }));
vi.mock("@/server/agenda/flag", () => ({
  agendaEnabled: () => true,
  agendaDisabledResponse: () => new Response(null, { status: 404 }),
}));
vi.mock("@/server/business/saas-guard", () => ({ moduleGate: async () => null }));

const testConnection = vi.fn(async (_creds?: unknown) => ({ ok: true as boolean, error: "" }));
vi.mock("@/server/agenda/connectors/google", () => ({
  googleConnector: { testConnection: (c: unknown) => testConnection(c) },
  GOOGLE_SCOPE: "https://www.googleapis.com/auth/calendar.events",
  GOOGLE_TIMEOUT_MS: 10_000,
}));
const saveGoogleOAuthConnection = vi.fn(async (_input: unknown) => {});
vi.mock("@/server/agenda/connectors/google-credentials", () => ({
  instanceOAuthApp: () => app.current,
  saveGoogleOAuthConnection: (i: unknown) => saveGoogleOAuthConnection(i),
}));
const resyncUpcomingBookings = vi.fn(async (_org: string) => 0);
vi.mock("@/server/agenda/calendar-sync/sync", () => ({
  resyncUpcomingBookings: (o: string) => resyncUpcomingBookings(o),
}));

import {
  buildAuthorizeUrl,
  createPkce,
  emailFromIdToken,
  exchangeCode,
  hasCalendarScope,
  OAUTH_COOKIE,
  parseCookieValue,
  readCookie,
  revokeToken,
  signState,
  verifyState,
} from "@/server/agenda/google-oauth";

const CAL = "https://www.googleapis.com/auth/calendar.events";
const idToken = (email: string) =>
  `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.x`;

describe("el state firmado", () => {
  const now = 1_000_000;
  const good = { o: "org_1", u: "usr_1", n: "nonce1", e: now + 60_000 };
  const ctx = { secret: SECRET, organizationId: "org_1", userId: "usr_1", cookieNonce: "nonce1", now };

  it("vale si la firma, la vigencia, la sesión y el nonce cuadran", () => {
    expect(verifyState(signState(good, SECRET), ctx)).toEqual({ ok: true, state: good });
  });
  it("rechaza uno alterado o firmado con otro secreto", () => {
    const token = signState(good, SECRET);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...good, o: "org_ajena" })).toString("base64url");
    expect(verifyState(`${forged}.${sig}`, ctx)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyState(signState(good, "otro-secreto-cualquiera"), ctx)).toMatchObject({ reason: "bad_signature" });
    expect(verifyState(`${payload}`, ctx)).toMatchObject({ reason: "malformed" });
    expect(verifyState(null, ctx)).toMatchObject({ reason: "malformed" });
  });
  it("rechaza uno vencido, de otra organización o usuario, o sin la cookie del flujo", () => {
    expect(verifyState(signState({ ...good, e: now - 1 }, SECRET), ctx)).toMatchObject({ reason: "expired" });
    expect(verifyState(signState({ ...good, o: "org_2" }, SECRET), ctx)).toMatchObject({ reason: "wrong_session" });
    expect(verifyState(signState({ ...good, u: "usr_2" }, SECRET), ctx)).toMatchObject({ reason: "wrong_session" });
    expect(verifyState(signState(good, SECRET), { ...ctx, cookieNonce: null })).toMatchObject({ reason: "nonce_mismatch" });
    expect(verifyState(signState(good, SECRET), { ...ctx, cookieNonce: "otro" })).toMatchObject({ reason: "nonce_mismatch" });
  });
});

describe("PKCE, URL de permisos y cookie", () => {
  it("el challenge es S256 del verifier", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("pide offline + consent, los permisos mínimos y vuelve al callback de la instancia", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "cid", state: "st", challenge: "ch" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.test/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe("cid");
    expect(p.get("redirect_uri")).toBe("https://crm.ejemplo.test/api/settings/google/oauth/callback");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toBe("ch");
    expect(p.get("state")).toBe("st");
    expect(p.get("scope")!.split(" ").sort()).toEqual([CAL, "email", "openid"].sort());
  });

  it("lee la cookie del flujo y su valor nonce.verifier", () => {
    const header = `otra=1; ${OAUTH_COOKIE}=${encodeURIComponent("n1.v1")}; x=2`;
    expect(readCookie(header, OAUTH_COOKIE)).toBe("n1.v1");
    expect(parseCookieValue("n1.v1")).toEqual({ nonce: "n1", verifier: "v1" });
    expect(parseCookieValue("raro")).toBeNull();
    expect(parseCookieValue("a.b.c")).toBeNull();
    expect(readCookie(null, OAUTH_COOKIE)).toBeNull();
  });

  it("scope y correo de la respuesta de Google", () => {
    expect(hasCalendarScope(`openid ${CAL} email`)).toBe(true);
    expect(hasCalendarScope("openid email")).toBe(false);
    expect(hasCalendarScope(undefined)).toBe(false);
    expect(emailFromIdToken(idToken("dueno@negocio.com"))).toBe("dueno@negocio.com");
    expect(emailFromIdToken("basura")).toBeNull();
  });
});

/** Respuesta del endpoint de tokens de Google, configurable por prueba. */
let tokenReply: () => Response;
let calls: { url: string; body: string }[] = [];

beforeEach(() => {
  calls = [];
  app.current = { clientId: "cid.apps.googleusercontent.com", clientSecret: "csec" };
  session.role = "owner";
  testConnection.mockClear();
  testConnection.mockImplementation(async () => ({ ok: true, error: "" }));
  saveGoogleOAuthConnection.mockClear();
  resyncUpcomingBookings.mockClear();
  tokenReply = () =>
    Response.json({ refresh_token: "rt_1", scope: `openid ${CAL} email`, id_token: idToken("dueno@negocio.com"), access_token: "at" });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    if (String(url).endsWith("/token")) return tokenReply();
    if (String(url).endsWith("/revoke")) return new Response(null, { status: 503 });
    return new Response(null, { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("canje del código", () => {
  it("con verifier, secreto y el mismo redirect_uri; devuelve token, scope y correo", async () => {
    const out = await exchangeCode({ code: "c1", verifier: "v1", clientId: "cid", clientSecret: "csec" });
    expect(out).toEqual({ ok: true, refreshToken: "rt_1", scope: `openid ${CAL} email`, email: "dueno@negocio.com" });
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toBe("v1");
    expect(form.get("redirect_uri")).toBe("https://crm.ejemplo.test/api/settings/google/oauth/callback");
  });
  it("sin el permiso del calendario o sin refresh token, no sirve", async () => {
    tokenReply = () => Response.json({ refresh_token: "rt", scope: "openid email" });
    expect(await exchangeCode({ code: "c", verifier: "v", clientId: "a", clientSecret: "b" })).toMatchObject({ ok: false, reason: "missing_scope" });
    tokenReply = () => Response.json({ scope: CAL });
    expect(await exchangeCode({ code: "c", verifier: "v", clientId: "a", clientSecret: "b" })).toMatchObject({ ok: false, reason: "no_refresh_token" });
    tokenReply = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    expect(await exchangeCode({ code: "c", verifier: "v", clientId: "a", clientSecret: "b" })).toMatchObject({ ok: false, reason: "exchange_failed", detail: "invalid_grant" });
  });
  it("revocar nunca lanza: si Google falla devuelve false", async () => {
    expect(await revokeToken("rt")).toBe(false);
  });
});

describe("GET /api/settings/google/oauth/start", () => {
  it("redirige a Google con un state que el callback acepta y deja la cookie httpOnly, Lax y Secure", async () => {
    const { GET } = await import("@/app/api/settings/google/oauth/start/route");
    const res = await GET();
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://accounts.google.test");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${OAUTH_COOKIE}=`));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/api/settings/google/oauth");
    // El nonce de la cookie es el del state firmado.
    const value = parseCookieValue(decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!))!;
    const check = verifyState(location.searchParams.get("state"), {
      secret: SECRET,
      organizationId: "org_1",
      userId: "usr_1",
      cookieNonce: value.nonce,
    });
    expect(check.ok).toBe(true);
    expect(location.searchParams.get("code_challenge")).toBe(createHash("sha256").update(value.verifier).digest("base64url"));
  });

  it("sin la app de la instancia vuelve a Ajustes con el motivo", async () => {
    app.current = null;
    const { GET } = await import("@/app/api/settings/google/oauth/start/route");
    const res = await GET();
    expect(res.headers.get("location")).toBe("https://crm.ejemplo.test/ajustes/calendario?google=error&motivo=no_app");
  });

  it("un miembro sin permiso de configurar recibe 403", async () => {
    session.role = "member";
    const { GET } = await import("@/app/api/settings/google/oauth/start/route");
    expect((await GET()).status).toBe(403);
  });
});

describe("GET /api/settings/google/oauth/callback", () => {
  async function callback(query: Record<string, string>, opts: { cookie?: string | null } = {}) {
    const { GET } = await import("@/app/api/settings/google/oauth/callback/route");
    const url = new URL("https://crm.ejemplo.test/api/settings/google/oauth/callback");
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers = new Headers();
    if (opts.cookie) headers.set("cookie", `${OAUTH_COOKIE}=${encodeURIComponent(opts.cookie)}`);
    return GET(new Request(url, { headers }));
  }
  const validState = (n = "nonce1") => signState({ o: "org_1", u: "usr_1", n, e: Date.now() + 60_000 }, SECRET);
  const motivo = (res: Response) => new URL(res.headers.get("location")!).searchParams.get("motivo");

  it("todo en orden: guarda el token con la cuenta, resincroniza, vuelve conectado y borra la cookie", async () => {
    const res = await callback({ code: "c1", state: validState() }, { cookie: "nonce1.verif1" });
    expect(res.headers.get("location")).toBe("https://crm.ejemplo.test/ajustes/calendario?google=conectado");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(saveGoogleOAuthConnection).toHaveBeenCalledWith({
      organizationId: "org_1",
      clientId: "cid.apps.googleusercontent.com",
      refreshToken: "rt_1",
      accountEmail: "dueno@negocio.com",
      // Mejora 2: lo concedido decide si se ofrece elegir calendarios.
      grantedScopes: `openid ${CAL} email`,
    });
    expect(resyncUpcomingBookings).toHaveBeenCalledWith("org_1");
    // El canje usó el verifier de la cookie; la prueba de conexión, el token recién emitido.
    expect(new URLSearchParams(calls[0]!.body).get("code_verifier")).toBe("verif1");
    expect(testConnection).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "rt_1", calendarId: "primary" }));
  });

  it("el usuario canceló en Google: no se toca nada", async () => {
    const res = await callback({ error: "access_denied", state: validState() }, { cookie: "nonce1.v" });
    expect(motivo(res)).toBe("denied");
    expect(calls).toHaveLength(0);
    expect(saveGoogleOAuthConnection).not.toHaveBeenCalled();
  });

  it("state inválido, sin cookie o de otra sesión: no se canjea nada", async () => {
    for (const [q, cookie] of [
      [{ code: "c", state: "basura" }, "nonce1.v"],
      [{ code: "c", state: validState() }, null],
      [{ code: "c", state: validState("otro") }, "nonce1.v"],
      [{ state: validState() }, "nonce1.v"],
    ] as const) {
      const res = await callback(q as Record<string, string>, { cookie });
      expect(motivo(res)).toBe("state");
    }
    expect(calls).toHaveLength(0);
    expect(saveGoogleOAuthConnection).not.toHaveBeenCalled();
  });

  it("sin el permiso del calendario, sin refresh token o sin poder escribir: no guarda", async () => {
    tokenReply = () => Response.json({ refresh_token: "rt", scope: "openid email" });
    expect(motivo(await callback({ code: "c", state: validState() }, { cookie: "nonce1.v" }))).toBe("missing_scope");
    tokenReply = () => Response.json({ scope: CAL });
    expect(motivo(await callback({ code: "c", state: validState() }, { cookie: "nonce1.v" }))).toBe("no_refresh_token");
    tokenReply = () => Response.json({ refresh_token: "rt", scope: CAL });
    testConnection.mockImplementation(async () => ({ ok: false, error: "403" }));
    expect(motivo(await callback({ code: "c", state: validState() }, { cookie: "nonce1.v" }))).toBe("test_failed");
    expect(saveGoogleOAuthConnection).not.toHaveBeenCalled();
  });
});
