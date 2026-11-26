import { createHash, randomUUID } from "node:crypto";
import { getEnv } from "@/lib/env";
import {
  ConnectorError,
  type AgendaConnector,
  type MeetingRequest,
  type MeetingResult,
  type TestConnectionResult,
} from "@/server/agenda/connectors/types";
import {
  getCachedGoogleToken,
  setCachedGoogleToken,
  type GoogleCreds,
} from "@/server/agenda/connectors/google-credentials";
import {
  calendarEventIdFor,
  conferenceRequestIdFor,
} from "@/server/agenda/calendar-sync/event";

/**
 * 015 — Conector Google Calendar + Meet, por REST directo (sin SDK: la
 * constitución no admite dependencias nuevas para esto).
 *
 * Cada cita se convierte en un evento del calendario del dueño con su enlace
 * de Meet. Es el conector con un diferencial claro: la cita aparece donde el
 * dueño ya mira su día.
 *
 * DOS cosas de Google que dan problemas y aquí están resueltas a propósito:
 *
 *  1. **La conferencia se crea de forma ASÍNCRONA.** La respuesta inmediata de
 *     `events.insert` puede traer `conferenceData.createRequest.status =
 *     "pending"` y ningún enlace. Por eso se re-lee el evento unas pocas veces
 *     antes de rendirse; y si aun así no llegó, la cita se entrega con el
 *     evento creado y el enlace pendiente (reintentable), nunca duplicando.
 *  2. **El refresh token caduca a los 7 días si la app OAuth está en modo
 *     prueba.** Eso no se puede arreglar desde aquí: se advierte en la guía de
 *     conexión, y cuando pasa, el 401 marca la credencial como rota para que
 *     el dueño se entere por la UI y no por un cliente sin enlace.
 *
 * Paso 3 — Idempotencia por cita: con `bookingId`, el evento lleva un id PROPIO
 * y determinista (`calendarEventIdFor`) y la conferencia un `requestId` por cita.
 * Si la respuesta del insert se pierde y se reintenta, Google contesta 409 y se
 * reutiliza ese mismo evento (añadiéndole Meet si le falta) en vez de duplicarlo.
 * Antes el `requestId` salía del instante: dos citas a la misma hora (multicupo)
 * pedían la conferencia con el mismo id.
 */

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

/** Cuántas veces se re-lee el evento esperando el enlace de Meet. */
const CONFERENCE_POLLS = 3;
const POLL_DELAY_MS = 400;
/** Ninguna llamada a Google espera más que esto: una cita nunca queda colgada de un proveedor lento. */
export const GOOGLE_TIMEOUT_MS = 10_000;

/**
 * La clave del caché incluye TODO lo que determina el token.
 *
 * Era `clientId:calendarId`. Como el refresh token y el secreto no entraban,
 * cambiar credenciales no tenía efecto observable hasta que el token expiraba
 * —una hora— y el operador concluía que las nuevas también estaban mal. Pasó
 * de verdad: tras corregir el scope y regenerar el refresh token, la prueba
 * seguía devolviendo el MISMO 403, palabra por palabra (#50, punto 3).
 *
 * Va como hash y no en claro porque esta clave vive en memoria del proceso y
 * no hay motivo para tener un refresh token dando vueltas en ella.
 */
function claveDeToken(creds: GoogleCreds): string {
  // `JSON.stringify` del array y no un separador a mano: los valores son
  // opacos y una concatenación cruda podría colisionar entre credenciales
  // distintas. Aquí la ambigüedad la resuelve el propio formato.
  return createHash("sha256")
    .update(
      JSON.stringify([
        creds.clientId,
        creds.clientSecret,
        creds.refreshToken,
        creds.calendarId,
      ])
    )
    .digest("hex");
}

export async function getAccessToken(creds: GoogleCreds): Promise<string> {
  const key = claveDeToken(creds);
  const cached = getCachedGoogleToken(key);
  if (cached) return cached;

  let res: Response;
  try {
    res = await fetch(`${getEnv().GOOGLE_OAUTH_BASE_URL}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ConnectorError("google", `No se pudo contactar a Google: ${err}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ConnectorError(
      "google",
      `Google rechazó el refresh token: ${detail}. Si tu app OAuth sigue en modo prueba, Google lo revoca a los 7 días: publícala en producción y vuelve a conectar.`,
      // `invalid_grant` llega como 400 y significa exactamente eso: hay que
      // reconectar.
      { status: res.status, isAuthError: res.status === 401 || res.status === 400 }
    );
  }

  const data = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  if (!data?.access_token) {
    throw new ConnectorError("google", "Google no devolvió un token de acceso");
  }
  setCachedGoogleToken(key, data.access_token, data.expires_in ?? 3600);
  return data.access_token;
}

/**
 * Una llamada a la API de Calendar. Lanza `ConnectorError` salvo en los estados de `accept`, que se
 * devuelven tal cual (`body` null si no hay cuerpo): así quien llama decide qué es éxito (un 404 al
 * borrar, un 409 al crear con id propio).
 */
export async function googleRequest(
  creds: GoogleCreds,
  path: string,
  init: RequestInit & { accept?: readonly number[] } = {}
): Promise<{ status: number; body: unknown }> {
  const token = await getAccessToken(creds);
  const { accept = [], ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${getEnv().GOOGLE_CAL_BASE_URL}${path}`, {
      ...rest,
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(rest.headers ?? {}),
      },
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ConnectorError("google", `No se pudo contactar a Google: ${err}`);
  }

  if (res.ok || accept.includes(res.status)) {
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, body };
  }
  const detail = await res.text().catch(() => "");
  throw new ConnectorError(
    "google",
    `Google respondió ${res.status}: ${detail.slice(0, 500)}`,
    { status: res.status }
  );
}

async function googleFetch(
  creds: GoogleCreds,
  path: string,
  init: RequestInit & { allow404?: boolean } = {}
): Promise<unknown> {
  const { allow404, ...rest } = init;
  const res = await googleRequest(creds, path, { ...rest, accept: allow404 ? [404, 410] : [] });
  return res.status === 404 || res.status === 410 ? null : res.body;
}

type GoogleEvent = {
  id?: string;
  status?: string;
  hangoutLink?: string;
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } };
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
};

/** El enlace de la videollamada, mire donde mire Google. */
function meetLinkOf(event: GoogleEvent | null): string | null {
  if (!event) return null;
  const video = event.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === "video"
  );
  return video?.uri ?? event.hangoutLink ?? null;
}

export function eventsPath(creds: GoogleCreds, suffix = ""): string {
  return `/calendars/${encodeURIComponent(creds.calendarId)}/events${suffix}`;
}

/** El camino de UN evento. */
export function eventPath(creds: GoogleCreds, eventId: string, query = ""): string {
  return eventsPath(creds, `/${encodeURIComponent(eventId)}${query}`);
}

/** ¿La conferencia ya existe o se está creando? (para no pedir otra encima). */
function hasConference(event: GoogleEvent | null): boolean {
  return !!meetLinkOf(event) || !!event?.conferenceData?.createRequest;
}

export const googleConnector: AgendaConnector<GoogleCreds> = {
  id: "google",
  requiresCredentials: true,

  async createMeeting(creds, req: MeetingRequest): Promise<MeetingResult> {
    const endUtc = new Date(
      Date.parse(req.startUtc) + req.durationMinutes * 60_000
    ).toISOString();
    // Con la cita: id de evento y de conferencia propios y estables (idempotencia).
    const eventId = req.bookingId ? calendarEventIdFor(req.bookingId) : undefined;
    const requestId = req.bookingId
      ? conferenceRequestIdFor(req.bookingId)
      : `vocero-${randomUUID()}`;
    const conferenceData = {
      createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } },
    };

    const res = await googleRequest(
      creds,
      `${eventsPath(creds)}?conferenceDataVersion=1&sendUpdates=none`,
      {
        method: "POST",
        accept: eventId ? [409] : [],
        body: JSON.stringify({
          ...(eventId ? { id: eventId } : {}),
          summary: req.topic,
          description: req.notes ?? undefined,
          start: { dateTime: req.startUtc, timeZone: req.timezone || "UTC" },
          end: { dateTime: endUtc, timeZone: req.timezone || "UTC" },
          conferenceData,
          ...(req.bookingId
            ? {
                extendedProperties: {
                  private: {
                    voceroBookingId: req.bookingId,
                    ...(req.organizationId ? { voceroOrg: req.organizationId } : {}),
                  },
                },
              }
            : {}),
        }),
      }
    );

    let created = res.body as GoogleEvent | null;
    if (res.status === 409 && eventId) {
      // Ya existe: un reintento cuya primera respuesta se perdió, o el evento que publicó la
      // sincronización del calendario. Se reutiliza; si le falta Meet (o se había borrado), se pide aquí.
      const existing = (await googleFetch(creds, eventPath(creds, eventId))) as GoogleEvent | null;
      created =
        existing && hasConference(existing) && existing.status !== "cancelled"
          ? existing
          : ((await googleFetch(
              creds,
              eventPath(creds, eventId, "?conferenceDataVersion=1&sendUpdates=none"),
              {
                method: "PATCH",
                body: JSON.stringify({
                  status: "confirmed",
                  start: { dateTime: req.startUtc, timeZone: req.timezone || "UTC" },
                  end: { dateTime: endUtc, timeZone: req.timezone || "UTC" },
                  ...(hasConference(existing) ? {} : { conferenceData }),
                }),
              }
            )) as GoogleEvent | null) ?? { id: eventId };
    }

    const id = created?.id ?? eventId ?? null;
    if (!id) {
      throw new ConnectorError("google", "Google no devolvió el evento creado");
    }

    let link = meetLinkOf(created);
    // La conferencia se genera en segundo plano: la respuesta del insert suele
    // venir `pending`. Se re-lee un par de veces antes de rendirse.
    for (let i = 0; i < CONFERENCE_POLLS && !link; i++) {
      await sleep(POLL_DELAY_MS);
      const refreshed = (await googleFetch(creds, eventPath(creds, id)).catch(
        () => null
      )) as GoogleEvent | null;
      link = meetLinkOf(refreshed);
    }

    // Con el evento creado y sin enlace, el motor deja la cita "sin enlace" y
    // el operador reintenta: eso re-lee este mismo evento, no crea otro.
    return { externalId: id, joinUrl: link };
  },

  async refreshMeeting(creds, externalId): Promise<MeetingResult> {
    const event = (await googleFetch(creds, eventPath(creds, externalId))) as GoogleEvent | null;
    return { externalId, joinUrl: meetLinkOf(event) };
  },

  async updateMeeting(creds, externalId, req): Promise<void> {
    const endUtc = new Date(
      Date.parse(req.startUtc) + req.durationMinutes * 60_000
    ).toISOString();
    await googleFetch(creds, eventPath(creds, externalId, "?sendUpdates=none"), {
      method: "PATCH",
      body: JSON.stringify({
        start: { dateTime: req.startUtc, timeZone: req.timezone || "UTC" },
        end: { dateTime: endUtc, timeZone: req.timezone || "UTC" },
      }),
    });
  },

  async deleteMeeting(creds, externalId): Promise<void> {
    // 404 (nunca existió) y 410 (ya estaba borrado) son éxito: borrar es idempotente.
    await googleFetch(creds, eventPath(creds, externalId, "?sendUpdates=none"), {
      method: "DELETE",
      allow404: true,
    });
  },

  async testConnection(creds): Promise<TestConnectionResult> {
    try {
      /**
       * Se listan eventos, no se lee el calendario.
       *
       * `GET /calendars/{id}` es `Calendars.Get`, y Google solo lo concede con
       * `calendar.readonly` o superior. Con el scope que este conector pide de
       * verdad —`calendar.events`, suficiente para insert/get/patch/delete— la
       * llamada devuelve 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT: la conexión
       * funcionaba y su PROPIA prueba fallaba (#50, punto 2).
       *
       * Listar un evento sí entra en `calendar.events`, así que el scope
       * documentado sigue siendo el mínimo — que es la razón de pedirlo.
       */
      const lista = (await googleFetch(
        creds,
        eventsPath(creds, "?maxResults=1")
      )) as { summary?: string } | null;
      // `summary` del listado es el nombre del calendario: el mismo dato que
      // se enseñaba antes, por una vía que el scope permite.
      return { ok: true, detail: lista?.summary };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : "No se pudo conectar con Google",
      };
    }
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
