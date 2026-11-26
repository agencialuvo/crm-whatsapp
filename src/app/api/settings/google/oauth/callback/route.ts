import { apiError, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { getEnv } from "@/lib/env";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { googleConnector } from "@/server/agenda/connectors/google";
import {
  instanceOAuthApp,
  saveGoogleOAuthConnection,
} from "@/server/agenda/connectors/google-credentials";
import {
  exchangeCode,
  OAUTH_COOKIE,
  parseCookieValue,
  readCookie,
  verifyState,
} from "@/server/agenda/google-oauth";
import { backToSettings } from "@/server/agenda/google-oauth-http";
import { resyncUpcomingBookings } from "@/server/agenda/calendar-sync/sync";
import { requestBusySync } from "@/server/agenda/calendar-busy/sync";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

/**
 * Paso 3 — La vuelta de Google. Nada se guarda hasta que TODO cuadra:
 *   1. el `state` está bien firmado, vigente, es de esta organización y usuario, y su nonce es el de la
 *      cookie (sin cookie del flujo no hay conexión: protege contra que alguien te haga conectar SU cuenta);
 *   2. Google canjea el código (con el `code_verifier` PKCE) y entrega refresh token y el permiso de eventos;
 *   3. se puede escribir de verdad en el calendario (la misma prueba que «Probar»).
 * Después vuelve a Ajustes → Agenda con `?google=conectado` o `?google=error&motivo=…`, y borra la cookie.
 *
 * Mejora 2: guarda los permisos concedidos. Si es la MISMA cuenta que ya estaba, se conservan los calendarios
 * elegidos (publicar y leer); si es otra, vuelven al principal (los ids no sirven entre cuentas).
 */
export const GET = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const planBlocked = await moduleGate(session.organizationId, "agenda");
  if (planBlocked) return planBlocked;
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }

  const url = new URL(req.url);
  // El usuario canceló (o Google rechazó) en la pantalla de permisos.
  if (url.searchParams.get("error")) return backToSettings({ ok: false, reason: "denied" });

  const cookie = parseCookieValue(readCookie(req.headers.get("cookie"), OAUTH_COOKIE));
  const check = verifyState(url.searchParams.get("state"), {
    secret: getEnv().BETTER_AUTH_SECRET,
    organizationId: session.organizationId,
    userId: session.userId,
    cookieNonce: cookie?.nonce ?? null,
  });
  const code = url.searchParams.get("code");
  if (!check.ok || !cookie || !code) return backToSettings({ ok: false, reason: "state" });

  const app = instanceOAuthApp();
  if (!app) return backToSettings({ ok: false, reason: "no_app" });

  const exchanged = await exchangeCode({ code, verifier: cookie.verifier, ...app });
  if (!exchanged.ok) {
    if (exchanged.detail) console.warn(`[google] el canje del código falló: ${exchanged.detail}`);
    return backToSettings({ ok: false, reason: exchanged.reason });
  }

  const creds = {
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    refreshToken: exchanged.refreshToken,
    calendarId: "primary",
    status: "connected" as const,
  };
  const test = await googleConnector.testConnection(creds);
  if (!test.ok) {
    console.warn(`[google] la cuenta se autorizó pero la prueba falló: ${test.error}`);
    return backToSettings({ ok: false, reason: "test_failed" });
  }

  await saveGoogleOAuthConnection({
    organizationId: session.organizationId,
    clientId: app.clientId,
    refreshToken: exchanged.refreshToken,
    accountEmail: exchanged.email,
    // Mejora 2: lo concedido decide si se ofrece elegir calendarios (Google deja desmarcar la lista).
    grantedScopes: exchanged.scope,
  });
  // Reconectar retoma lo que quedó sin publicar (si la sincronización está encendida).
  await resyncUpcomingBookings(session.organizationId);
  // Paso 4: si se lee lo ocupado, se lee ya con la conexión nueva (en segundo plano).
  await requestBusySync(session.organizationId);
  return backToSettings({ ok: true });
});
