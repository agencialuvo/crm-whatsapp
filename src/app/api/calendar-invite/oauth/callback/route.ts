import { getEnv } from "@/lib/env";
import { eventsPath, googleRequest } from "@/server/agenda/connectors/google";
import {
  getGoogleConnectionInfo,
  instanceOAuthApp,
} from "@/server/agenda/connectors/google-credentials";
import {
  exchangeCode,
  hasStaffReadScope,
  parseCookieValue,
  readCookie,
  revokeToken,
  STAFF_OAUTH_COOKIE,
  staffOAuthRedirectUri,
  verifyStaffState,
} from "@/server/agenda/google-oauth";
import { saveStaffConnection } from "@/server/agenda/staff-calendar/connection";
import { requestStaffBusySync } from "@/server/agenda/staff-calendar/busy";
import { staffCalendarsDisabledResponse, staffCalendarsEnabled } from "@/server/agenda/staff-calendar/flag";
import { staffResult } from "@/server/agenda/staff-calendar/http";
import { markInviteUsed, resolveInviteById } from "@/server/agenda/staff-calendar/invite";
import { notify } from "@/server/notifications/service";

export const dynamic = "force-dynamic";

/**
 * Mejora 3 — PÚBLICA: la vuelta de Google del profesional (URI a registrar en Google Cloud:
 * `${APP_BASE_URL}/api/calendar-invite/oauth/callback`). Nada se guarda hasta que TODO cuadra:
 *   1. `state` firmado (del flujo del profesional), vigente y con el nonce de la cookie;
 *   2. la invitación sigue vigente (no vencida, usada, anulada; el profesional sigue activo);
 *   3. Google canjea el código con PKCE, entrega refresh token y el permiso de LEER el calendario;
 *   4. NO es la cuenta de Google del negocio (sus eventos de Vocero bloquearían al profesional: bucle);
 *   5. se puede leer su calendario de verdad;
 *   6. la invitación se marca usada (condicional: dos vueltas a la vez conectan UNA vez).
 * Después: conexión cifrada, aviso al dueño y una lectura inmediata en segundo plano.
 */
export async function GET(req: Request) {
  if (!staffCalendarsEnabled()) return staffCalendarsDisabledResponse();
  const url = new URL(req.url);
  if (url.searchParams.get("error")) return staffResult({ ok: false, reason: "denied" });

  const cookie = parseCookieValue(readCookie(req.headers.get("cookie"), STAFF_OAUTH_COOKIE));
  const check = verifyStaffState(url.searchParams.get("state"), {
    secret: getEnv().BETTER_AUTH_SECRET,
    cookieNonce: cookie?.nonce ?? null,
  });
  const code = url.searchParams.get("code");
  if (!check.ok || !cookie || !code) return staffResult({ ok: false, reason: "state" });

  const found = await resolveInviteById(check.state.i);
  if (!found.ok) return staffResult({ ok: false, reason: found.reason });
  const invite = found.invite;

  const app = instanceOAuthApp();
  if (!app) return staffCalendarsDisabledResponse();
  const exchanged = await exchangeCode({
    code,
    verifier: cookie.verifier,
    ...app,
    redirectUri: staffOAuthRedirectUri(),
    hasRequiredScope: hasStaffReadScope,
  });
  if (!exchanged.ok) {
    if (exchanged.detail) console.warn(`[google] el canje del código del profesional falló: ${exchanged.detail}`);
    return staffResult({ ok: false, reason: exchanged.reason });
  }

  // Anti-bucle: la cuenta del negocio no sirve como calendario de un profesional.
  const business = await getGoogleConnectionInfo(invite.organizationId).catch(() => null);
  if (
    business?.accountEmail &&
    exchanged.email &&
    business.accountEmail.toLowerCase() === exchanged.email.toLowerCase()
  ) {
    await revokeToken(exchanged.refreshToken);
    return staffResult({ ok: false, reason: "business_account" });
  }

  const creds = { ...app, refreshToken: exchanged.refreshToken, calendarId: "primary", status: "connected" as const };
  try {
    await googleRequest(creds, eventsPath(creds, "?maxResults=1"));
  } catch (err) {
    console.warn(`[google] el profesional autorizó pero no se pudo leer su calendario: ${err}`);
    return staffResult({ ok: false, reason: "test_failed" });
  }

  if (!(await markInviteUsed(invite))) return staffResult({ ok: false, reason: "used" });
  await saveStaffConnection({
    organizationId: invite.organizationId,
    staffId: invite.staffId,
    refreshToken: exchanged.refreshToken,
    accountEmail: exchanged.email,
    grantedScopes: exchanged.scope,
  });
  await notify(invite.organizationId, {
    title: `${invite.staffName} conectó su Google Calendar`,
    message: `Lo ocupado en el calendario de ${invite.staffName} ya no se le ofrece a nadie (solo a ${invite.staffName}; el resto del equipo sigue libre).`,
    category: "sistema",
    link: "/equipo",
  });
  requestStaffBusySync(invite.organizationId, invite.staffId);
  return staffResult({ ok: true, organizationName: invite.organizationName, staffName: invite.staffName });
}
