import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { googleConnector } from "@/server/agenda/connectors/google";
import {
  deleteGoogleCredentials,
  getGoogleConnectionInfo,
  getGoogleCredentials,
  instanceOAuthApp,
  saveGoogleCredentials,
  secretLast4,
} from "@/server/agenda/connectors/google-credentials";
import { revokeToken } from "@/server/agenda/google-oauth";
import { resyncUpcomingBookings } from "@/server/agenda/calendar-sync/sync";
import { clearGoogleBusyBlocks, getBusyState, requestBusySync } from "@/server/agenda/calendar-busy/sync";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

/**
 * 015 / Paso 3 — La conexión de Google Calendar del negocio (una cuenta, un calendario).
 *
 *  - GET: el estado para Ajustes (origen, cuenta, último error, si la instancia ofrece «Conectar con
 *    Google»). Los secretos entran y no vuelven a salir: del manual, solo sus últimos 4.
 *  - PUT: modo Avanzado (pegar las credenciales de la app propia). Se prueban contra Google antes de guardar.
 *  - DELETE: desconectar. Revoca el permiso en Google (si falla, se desconecta igual) y borra la fila. Las
 *    citas no se tocan: sus eventos se quedan en el calendario y la agenda sigue igual. Los bloqueos que se
 *    habían traído de Google (Paso 4) sí se quitan.
 */

export const GET = withAuth(async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const planBlocked = await moduleGate(session.organizationId, "agenda");
  if (planBlocked) return planBlocked;
  const info = await getGoogleConnectionInfo(session.organizationId);
  const oauthAvailable = instanceOAuthApp() !== null;
  if (!info) return Response.json({ connection: null, oauthAvailable });
  return Response.json({
    oauthAvailable,
    // Paso 4: la lectura de lo ocupado (última lectura, error, cuántos bloqueos).
    busy: await getBusyState(session.organizationId),
    connection: {
      status: info.status,
      source: info.source,
      accountEmail: info.accountEmail,
      connectedAt: info.connectedAt?.toISOString() ?? null,
      lastError: info.lastError,
      lastOkAt: info.lastOkAt?.toISOString() ?? null,
      appMissing: info.appMissing,
      secretLast4: info.secretLast4,
      // Lo que rellena el formulario de Avanzado (solo del origen manual).
      fields: info.source === "manual" ? { clientId: info.clientId, calendarId: info.calendarId } : { calendarId: info.calendarId },
    },
  });
});

const credsSchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  refreshToken: z.string().trim().min(1),
  calendarId: z.string().trim().optional(),
});

export const PUT = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const planBlocked = await moduleGate(session.organizationId, "agenda");
  if (planBlocked) return planBlocked;
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const body = await parseBody(req, credsSchema);
  if (!body.ok) return body.response;

  const calendarId = body.data.calendarId?.trim() || "primary";
  const check = await googleConnector.testConnection({
    ...body.data,
    calendarId,
    status: "connected",
  });
  if (!check.ok) return apiError(422, "google_invalid", check.error);

  await saveGoogleCredentials({
    organizationId: session.organizationId,
    ...body.data,
    calendarId,
  });
  await resyncUpcomingBookings(session.organizationId);
  await requestBusySync(session.organizationId);

  return Response.json({
    oauthAvailable: instanceOAuthApp() !== null,
    connection: {
      status: "connected",
      source: "manual",
      accountEmail: null,
      connectedAt: new Date().toISOString(),
      lastError: null,
      lastOkAt: new Date().toISOString(),
      appMissing: false,
      secretLast4: secretLast4(body.data.clientSecret),
      fields: { clientId: body.data.clientId, calendarId },
    },
  });
});

export const DELETE = withAuth(async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const planBlocked = await moduleGate(session.organizationId, "agenda");
  if (planBlocked) return planBlocked;
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const creds = await getGoogleCredentials(session.organizationId).catch(() => null);
  // Revocar es cortesía con la cuenta del negocio: si Google no responde, se desconecta igual.
  const revoked = creds ? await revokeToken(creds.refreshToken) : false;
  // Paso 4: sin conexión, lo que se había traído de Google deja de corresponder a nada: se quita.
  await clearGoogleBusyBlocks(session.organizationId);
  await deleteGoogleCredentials(session.organizationId);
  return Response.json({ ok: true, revoked });
});
