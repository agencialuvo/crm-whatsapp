import { getEnv } from "@/lib/env";
import { instanceOAuthApp } from "@/server/agenda/connectors/google-credentials";
import {
  buildAuthorizeUrl,
  cookieValue,
  createPkce,
  newNonce,
  signStaffState,
  STAFF_OAUTH_SCOPES,
  staffOAuthRedirectUri,
  STATE_TTL_MS,
} from "@/server/agenda/google-oauth";
import { redirectTo } from "@/server/agenda/google-oauth-http";
import { staffCalendarsDisabledResponse, staffCalendarsEnabled } from "@/server/agenda/staff-calendar/flag";
import { setStaffOAuthCookie, staffResult } from "@/server/agenda/staff-calendar/http";
import { resolveInvite } from "@/server/agenda/staff-calendar/invite";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

/**
 * Mejora 3 — PÚBLICA (el profesional no tiene sesión en Vocero): el botón «Conectar con Google» de la página
 * del enlace. Solo con un enlace vigente; firma un `state` con la invitación (y un nonce que va también en
 * una cookie httpOnly con el `code_verifier` PKCE) y lleva a Google pidiendo SOLO leer el calendario.
 */
export async function GET(_req: Request, ctx: Ctx) {
  if (!staffCalendarsEnabled()) return staffCalendarsDisabledResponse();
  const { token } = await ctx.params;
  const found = await resolveInvite(token);
  if (!found.ok) return staffResult({ ok: false, reason: found.reason });
  const app = instanceOAuthApp();
  if (!app) return staffCalendarsDisabledResponse();

  const nonce = newNonce();
  const { verifier, challenge } = createPkce();
  const state = signStaffState(
    { i: found.invite.id, n: nonce, e: Date.now() + STATE_TTL_MS },
    getEnv().BETTER_AUTH_SECRET
  );
  const url = buildAuthorizeUrl({
    clientId: app.clientId,
    state,
    challenge,
    redirectUri: staffOAuthRedirectUri(),
    scopes: STAFF_OAUTH_SCOPES,
  });
  return redirectTo(url, [setStaffOAuthCookie(cookieValue(nonce, verifier))]);
}
