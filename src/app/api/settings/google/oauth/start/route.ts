import { apiError, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { getEnv } from "@/lib/env";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { instanceOAuthApp } from "@/server/agenda/connectors/google-credentials";
import {
  buildAuthorizeUrl,
  cookieValue,
  createPkce,
  newNonce,
  signState,
  STATE_TTL_MS,
} from "@/server/agenda/google-oauth";
import { backToSettings, redirectTo, setOAuthCookie } from "@/server/agenda/google-oauth-http";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

/**
 * Paso 3 — «Conectar con Google»: firma el `state` (organización + usuario + nonce, 10 min), guarda el nonce
 * y el `code_verifier` PKCE en una cookie httpOnly y manda a la pantalla de permisos de Google. Solo dueño o
 * administrador, y solo con la agenda encendida.
 */
export const GET = withAuth(async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const planBlocked = await moduleGate(session.organizationId, "agenda");
  if (planBlocked) return planBlocked;
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const app = instanceOAuthApp();
  if (!app) return backToSettings({ ok: false, reason: "no_app" });

  const nonce = newNonce();
  const { verifier, challenge } = createPkce();
  const state = signState(
    { o: session.organizationId, u: session.userId, n: nonce, e: Date.now() + STATE_TTL_MS },
    getEnv().BETTER_AUTH_SECRET
  );
  return redirectTo(buildAuthorizeUrl({ clientId: app.clientId, state, challenge }), [
    setOAuthCookie(cookieValue(nonce, verifier)),
  ]);
});
