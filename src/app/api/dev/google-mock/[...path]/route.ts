import { mockGuard } from "@/lib/dev-guard";
import {
  googleMockSnapshot,
  googleMockState,
  MOCK_ACCOUNT_EMAIL,
  MOCK_REFRESH_TOKEN,
  MOCK_REFRESH_TOKEN_LIST,
  MOCK_PRIMARY_CALENDAR,
  mockCalendarId,
  mockStaffRefreshToken,
  mockRefreshTokenIsBad,
  mockResourceId,
  sendMockNotifications,
  type MockChannel,
  type MockCalendar,
  type MockExternalEvent,
  resetGoogleMock,
  takeMockFailure,
  type MockEvent,
} from "@/server/dev/google-mock-state";

export const dynamic = "force-dynamic";

/**
 * 015 — Google de mentira para el self-test, tras `mockGuard()` (404
 * incondicional en producción).
 *
 * Cubre lo que el conector usa: refrescar el token, crear/leer/mover/borrar un
 * evento y listar el calendario. Y reproduce la asincronía de la conferencia:
 * al crear NO hay enlace de Meet, y aparece en una lectura posterior.
 *
 * Paso 3 — Además:
 *  - `GET  o/oauth2/v2/auth`: la pantalla de permisos, que «acepta» sola y vuelve al
 *    `redirect_uri` con un código. `client_id` terminado en `-deny` simula que el
 *    usuario cancela; en `-noscope`, que desmarca el permiso del calendario.
 *  - `POST token` con `authorization_code`, `POST revoke`.
 *  - Ids propios: crear uno que existe (o se borró) da 409; leer uno borrado da
 *    `status: cancelled`; borrar dos veces da 410.
 *  - `POST _fail {status, count}`: las próximas N llamadas al calendario fallan (un 403 con el cuerpo de
 *    «permiso insuficiente», como Google cuando el token no alcanza para leer).
 *
 * Paso 4 — `GET calendars/{id}/events` lista de verdad: lo publicado por Vocero y lo sembrado con
 * `POST _external {events, replace?, pageSize?}`, filtrado por `timeMin`/`timeMax` y en páginas
 * (`maxResults`/`pageToken`). Los eventos borrados no salen (`showDeleted=false`).
 *
 * Mejora 2 — `GET users/me/calendarList` (solo con un token que trae la lista: si no, 403 de permiso),
 * eventos POR calendario (`primary` = el principal), `POST calendars/{id}/events/{ev}/move?destination=`, y
 * `POST _calendars {calendars?, remove?, grantCalendarList?}` para armar la cuenta (quitar uno = «dejaron de
 * compartirlo»: leerlo da 404).
 *
 * Mejora 3 — Si la pantalla de permisos pide `calendar.events.readonly`, «entra» el profesional
 * (`staffAccountEmail`): su código, su refresh token (`mock-refresh-staff|<correo>`), su token
 * (`TOKEN.staff|<correo>`) y su `primary`. Con ese token no se puede escribir (403). `POST _staff
 * {email?, grantRead?}` arma la cuenta del profesional.
 *
 * Mejora 4 — `POST calendars/{id}/events/watch` abre un canal (y manda el `sync` a su dirección),
 * `POST channels/stop` lo cierra (uno desconocido: 404), `POST _external` avisa a los canales del calendario
 * que cambió (`notify: false` para no avisar), `POST _notify {calendarId?, state?}` avisa a mano y
 * `POST _watch {fail?: {status, count}, unsupported?: string[]}` provoca rechazos.
 */

type Ctx = { params: Promise<{ path: string[] }> };

const TOKEN = "google-token-de-mentira";
const CAL_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const STAFF_READ_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

export async function POST(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const { path } = await ctx.params;
  const route = path.join("/");

  if (route === "token") {
    const body = await req.text();
    const form = new URLSearchParams(body);
    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code") ?? "";
      if (!code.startsWith("mock-code")) {
        return Response.json({ error: "invalid_grant", error_description: "Bad code" }, { status: 400 });
      }
      if (code.startsWith("mock-code-staff")) {
        const email = googleMockState().staffAccountEmail;
        return Response.json({
          access_token: `${TOKEN}.staff|${email}`,
          expires_in: 3600,
          refresh_token: mockStaffRefreshToken(email),
          scope: code.endsWith("-noscope") ? "openid email" : `${STAFF_READ_SCOPE} openid email`,
          id_token: fakeIdToken(email),
        });
      }
      const list = code.endsWith("-list");
      return Response.json({
        access_token: list ? `${TOKEN}.list` : TOKEN,
        expires_in: 3600,
        refresh_token: list ? MOCK_REFRESH_TOKEN_LIST : MOCK_REFRESH_TOKEN,
        scope: code.endsWith("-noscope")
          ? "openid email"
          : `${CAL_SCOPE} openid email${list ? ` ${LIST_SCOPE}` : ""}`,
        id_token: fakeIdToken(MOCK_ACCOUNT_EMAIL),
      });
    }
    if (mockRefreshTokenIsBad(body) && form.get("refresh_token") !== MOCK_REFRESH_TOKEN) {
      return Response.json(
        { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        { status: 400 }
      );
    }
    // Mejora 2: el permiso de la lista viaja con el refresh token (`…-list`).
    const refreshToken = form.get("refresh_token") ?? "";
    if (refreshToken.startsWith("mock-refresh-staff|")) {
      return Response.json({ access_token: `${TOKEN}.staff|${refreshToken.slice("mock-refresh-staff|".length)}`, expires_in: 3600 });
    }
    const listGranted = refreshToken.includes("-list");
    return Response.json({ access_token: listGranted ? `${TOKEN}.list` : TOKEN, expires_in: 3600 });
  }

  if (route === "revoke") {
    const token = new URLSearchParams(await req.text()).get("token");
    if (token) googleMockState().revoked.push(token);
    return new Response(null, { status: 200 });
  }

  if (route === "_reset") {
    resetGoogleMock();
    return Response.json({ ok: true });
  }

  if (route === "_staff") {
    const body = (await req.json().catch(() => ({}))) as { email?: string; grantRead?: boolean };
    const state = googleMockState();
    if (body.email) state.staffAccountEmail = body.email;
    if (body.grantRead !== undefined) state.staffGrantRead = body.grantRead;
    return Response.json({ ok: true, email: state.staffAccountEmail });
  }

  if (route === "_calendars") {
    const body = (await req.json().catch(() => ({}))) as {
      calendars?: MockCalendar[];
      remove?: string[];
      grantCalendarList?: boolean;
    };
    const state = googleMockState();
    if (body.calendars) state.calendars = body.calendars;
    if (body.remove) state.calendars = state.calendars.filter((c) => !body.remove!.includes(c.id));
    if (body.grantCalendarList !== undefined) state.grantCalendarList = body.grantCalendarList;
    return Response.json({ ok: true, calendars: state.calendars });
  }

  if (route === "_external") {
    const body = (await req.json().catch(() => ({}))) as {
      events?: MockExternalEvent[];
      replace?: boolean;
      pageSize?: number;
      notify?: boolean;
    };
    const state = googleMockState();
    const touched = new Set<string>([
      ...(body.replace ? state.external.map((e) => mockCalendarId(e.calendarId ?? "primary")) : []),
      ...(body.events ?? []).map((e) => mockCalendarId(e.calendarId ?? "primary")),
    ]);
    if (body.replace) state.external.length = 0;
    state.external.push(...(body.events ?? []));
    if (body.pageSize) state.pageSize = body.pageSize;
    // Mejora 4: como Google, avisa a los canales que vigilan los calendarios que cambiaron.
    let notified = 0;
    if (body.notify !== false) for (const cal of touched) notified += await sendMockNotifications(cal);
    return Response.json({ ok: true, external: state.external.length, notified });
  }

  if (route === "_notify") {
    const body = (await req.json().catch(() => ({}))) as { calendarId?: string; state?: "exists" | "not_exists" | "sync" };
    const notified = await sendMockNotifications(body.calendarId ? mockCalendarId(body.calendarId) : null, body.state ?? "exists");
    return Response.json({ ok: true, notified });
  }

  if (route === "_watch") {
    const body = (await req.json().catch(() => ({}))) as { fail?: { status: number; count: number } | null; unsupported?: string[] };
    const state = googleMockState();
    if (body.fail !== undefined) state.failWatch = body.fail;
    if (body.unsupported) state.watchUnsupported = body.unsupported.map(mockCalendarId);
    return Response.json({ ok: true });
  }

  // Mejora 4: POST /channels/stop {id, resourceId}
  if (route === "channels/stop") {
    const unauthorized = requireToken(req);
    if (unauthorized) return unauthorized;
    const body = (await req.json().catch(() => ({}))) as { id?: string; resourceId?: string };
    const channel = googleMockState().channels.find((c) => c.id === body.id && c.resourceId === body.resourceId && !c.stopped);
    if (!channel) return Response.json({ error: { code: 404, message: "Channel not found" } }, { status: 404 });
    channel.stopped = true;
    return new Response(null, { status: 204 });
  }

  // Mejora 4: POST /calendars/{id}/events/watch
  if (path[0] === "calendars" && path[2] === "events" && path.length === 4 && path[3] === "watch") {
    const unauthorized = requireToken(req);
    if (unauthorized) return unauthorized;
    const state = googleMockState();
    if (state.failWatch && state.failWatch.count > 0) {
      const status = state.failWatch.status;
      state.failWatch.count -= 1;
      if (state.failWatch.count <= 0) state.failWatch = null;
      return failureResponse(status);
    }
    const missing = calendarMissing(path[1]!, req);
    if (missing) return missing;
    const cal = calId(path[1]!, req);
    if (state.watchUnsupported.includes(cal)) {
      return Response.json(
        {
          error: {
            code: 400,
            message: "Push notifications are not supported by this resource.",
            errors: [{ reason: "pushNotSupportedForRequestedResource" }],
          },
        },
        { status: 400 }
      );
    }
    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      type?: string;
      address?: string;
      token?: string;
      params?: { ttl?: string };
    };
    if (!body.id || body.type !== "web_hook" || !body.address) {
      return Response.json({ error: { code: 400, message: "Invalid channel" } }, { status: 400 });
    }
    if (state.channels.some((c) => c.id === body.id)) {
      return Response.json({ error: { code: 400, message: "Channel id not unique" } }, { status: 400 });
    }
    const ttl = Math.min(Number(body.params?.ttl) || 604800, 604800);
    const channel: MockChannel = {
      id: body.id,
      resourceId: mockResourceId(cal),
      calendarId: cal,
      address: body.address,
      token: body.token ?? null,
      expiration: Date.now() + ttl * 1000,
      stopped: false,
      messages: 0,
    };
    state.channels.push(channel);
    // Como Google: el primer aviso (`sync`) sale apenas se abre el canal, sin esperar a esta respuesta.
    void sendMockNotifications(null, "sync", channel);
    return Response.json({
      kind: "api#channel",
      id: channel.id,
      resourceId: channel.resourceId,
      resourceUri: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events?alt=json`,
      token: channel.token,
      expiration: String(channel.expiration),
    });
  }

  if (route === "_fail") {
    const body = (await req.json().catch(() => ({}))) as { status?: number; count?: number };
    googleMockState().failNext = { status: body.status ?? 500, count: body.count ?? 1 };
    return Response.json({ ok: true });
  }

  // Mejora 2: POST /calendars/{id}/events/{eventId}/move?destination=…
  if (path[0] === "calendars" && path[2] === "events" && path.length === 5 && path[4] === "move") {
    const unauthorized = requireToken(req);
    if (unauthorized) return unauthorized;
    const failure = takeMockFailure();
    if (failure) return failureResponse(failure);
    const state = googleMockState();
    const event = state.events.get(path[3]!);
    if (!event || event.calendarId !== calId(path[1]!, req)) return new Response(null, { status: 404 });
    const dest = calId(new URL(req.url).searchParams.get("destination") ?? "", req);
    const target = state.calendars.find((c) => c.id === dest);
    if (!target || (target.accessRole !== "owner" && target.accessRole !== "writer")) {
      return Response.json({ error: { code: 403, message: "Forbidden" } }, { status: 403 });
    }
    event.calendarId = dest;
    event.moves = (event.moves ?? 0) + 1;
    return Response.json(view(event));
  }

  // POST /calendars/{id}/events
  if (path[0] === "calendars" && path[2] === "events" && path.length === 3) {
    const unauthorized = requireToken(req);
    if (unauthorized) return unauthorized;
    const failure = takeMockFailure();
    if (failure) return Response.json({ error: { code: failure } }, { status: failure });
    const missing = calendarMissing(path[1]!, req);
    if (missing) return missing;
    if (staffOf(req)) return failureResponse(403);

    const body = (await req.json().catch(() => ({}))) as EventBody & { id?: string };
    const state = googleMockState();
    if (body.id && (state.events.has(body.id) || state.deleted.includes(body.id))) {
      return Response.json({ error: { code: 409, message: "The requested identifier already exists." } }, { status: 409 });
    }
    const id = body.id ?? `evt_${state.nextId++}`;
    const event: MockEvent = {
      id,
      calendarId: calId(path[1]!, req),
      summary: "",
      description: "",
      location: null,
      start: "",
      end: "",
      status: "confirmed",
      privateProps: {},
      wantsMeet: false,
      reads: 0,
      meetLink: null,
      updates: 0,
    };
    apply(event, body);
    state.events.set(id, event);
    // Sin enlace todavía: la conferencia se está creando. Es el
    // comportamiento real de Google y por eso el conector re-lee.
    return Response.json(view(event));
  }

  return new Response(null, { status: 404 });
}

export async function GET(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const { path } = await ctx.params;
  const route = path.join("/");

  if (route === "_state") return Response.json(googleMockSnapshot());

  // La pantalla de permisos: «acepta» sola y vuelve con el código (o con el error, si se simula cancelar).
  if (route === "o/oauth2/v2/auth") {
    const url = new URL(req.url);
    const back = new URL(url.searchParams.get("redirect_uri") ?? "/");
    const clientId = url.searchParams.get("client_id") ?? "";
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    if (clientId.endsWith("-deny")) back.searchParams.set("error", "access_denied");
    else {
      // Mejora 2: si se pidió la lista de calendarios y la «persona» la deja marcada, el código la concede.
      const scopes = (url.searchParams.get("scope") ?? "").split(" ");
      const list = scopes.includes(LIST_SCOPE) && googleMockState().grantCalendarList;
      // Mejora 3: el flujo del profesional (solo lectura) «entra» con su cuenta personal.
      const staff = scopes.includes(STAFF_READ_SCOPE);
      back.searchParams.set(
        "code",
        staff
          ? googleMockState().staffGrantRead
            ? "mock-code-staff"
            : "mock-code-staff-noscope"
          : clientId.endsWith("-noscope")
            ? "mock-code-noscope"
            : list
              ? "mock-code-list"
              : "mock-code"
      );
    }
    return new Response(null, { status: 302, headers: { Location: back.toString() } });
  }

  const unauthorized = requireToken(req);
  if (unauthorized) return unauthorized;
  const failure = takeMockFailure();
  if (failure) return failureResponse(failure);

  // Mejora 2: GET /users/me/calendarList — solo con el permiso de la lista.
  if (route === "users/me/calendarList") {
    if (!(req.headers.get("authorization") ?? "").endsWith(".list")) return failureResponse(403);
    return Response.json({
      items: googleMockState().calendars.map((c) => ({
        id: c.id,
        summary: c.summary,
        accessRole: c.accessRole,
        ...(c.primary ? { primary: true } : {}),
      })),
    });
  }

  // GET /calendars/{id} — el calendario.
  if (path[0] === "calendars" && path.length === 2) {
    return Response.json({ id: path[1], summary: "Calendario de prueba" });
  }
  // GET /calendars/{id}/events — el listado (la prueba de conexión y, Paso 4, la lectura de lo ocupado).
  if (path[0] === "calendars" && path.length === 3 && path[2] === "events") {
    const missing = calendarMissing(path[1]!, req);
    if (missing) return missing;
    const cal = googleMockState().calendars.find((c) => c.id === calId(path[1]!, req));
    if (cal?.accessRole === "freeBusyReader") return Response.json({ error: { code: 403, message: "Forbidden" } }, { status: 403 });
    return Response.json({ summary: cal?.summary ?? "Calendario de prueba", ...listEvents(new URL(req.url), calId(path[1]!, req)) });
  }

  // GET /calendars/{id}/events/{eventId}
  const id = eventIdFrom(path);
  if (!id) return new Response(null, { status: 404 });
  const state = googleMockState();
  if (state.deleted.includes(id)) return Response.json({ id, status: "cancelled" });
  const event = state.events.get(id);
  // Mejora 2: un evento se lee desde SU calendario.
  if (!event || event.calendarId !== calId(path[1]!, req)) return new Response(null, { status: 404 });

  event.reads += 1;
  if (event.wantsMeet && !event.meetLink && event.reads > state.conferenceDelayReads) {
    event.meetLink = `https://meet.google.mock/${event.id}`;
  }
  return Response.json(view(event));
}

export async function PATCH(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const unauthorized = requireToken(req);
  if (unauthorized) return unauthorized;
  if (staffOf(req)) return failureResponse(403);
  const failure = takeMockFailure();
  if (failure) return Response.json({ error: { code: failure } }, { status: failure });

  const { path } = await ctx.params;
  const id = eventIdFrom(path);
  if (!id) return new Response(null, { status: 404 });
  const state = googleMockState();
  const body = (await req.json().catch(() => ({}))) as EventBody;

  let event = state.events.get(id);
  if (!event && state.deleted.includes(id)) {
    // Como Google: un evento borrado se puede revivir con `status: confirmed`.
    if (body.status !== "confirmed") return new Response(null, { status: 404 });
    state.deleted.splice(state.deleted.indexOf(id), 1);
    event = { id, calendarId: calId(path[1]!, req), summary: "", description: "", location: null, start: "", end: "", status: "confirmed", privateProps: {}, wantsMeet: false, reads: 0, meetLink: null, updates: 0 };
    state.events.set(id, event);
  }
  if (!event || event.calendarId !== calId(path[1]!, req)) return new Response(null, { status: 404 });
  apply(event, body);
  event.updates += 1;
  // El evento se movió: su enlace de Meet es el mismo.
  return Response.json(view(event));
}

export async function DELETE(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const unauthorized = requireToken(req);
  if (unauthorized) return unauthorized;
  if (staffOf(req)) return failureResponse(403);
  const failure = takeMockFailure();
  if (failure) return Response.json({ error: { code: failure } }, { status: failure });

  const { path } = await ctx.params;
  const id = eventIdFrom(path);
  if (!id) return new Response(null, { status: 404 });
  const state = googleMockState();
  if (state.deleted.includes(id)) return new Response(null, { status: 410 });
  if (state.events.get(id)?.calendarId !== calId(path[1]!, req)) return new Response(null, { status: 404 });
  state.events.delete(id);
  state.deleted.push(id);
  return new Response(null, { status: 204 });
}

/** Mejora 2: un calendario que la cuenta ya no tiene (lo dejaron de compartir) da 404. */
/** Mejora 3: de quién es el token (el profesional) o null (la cuenta del negocio). */
function staffOf(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const i = auth.indexOf(".staff|");
  return i >= 0 ? auth.slice(i + ".staff|".length) : null;
}

/** `primary` → el principal de QUIEN pregunta (el negocio o el profesional). */
function calId(id: string, req: Request): string {
  return id === "primary" ? (staffOf(req) ?? MOCK_PRIMARY_CALENDAR) : mockCalendarId(id);
}

function calendarMissing(calendarId: string, req: Request): Response | null {
  const id = calId(calendarId, req);
  if (id === staffOf(req)) return null;
  return googleMockState().calendars.some((c) => c.id === id)
    ? null
    : Response.json({ error: { code: 404, message: "Not Found" } }, { status: 404 });
}

/** El listado de UN calendario: lo de Vocero y lo del dueño, en la ventana pedida, por páginas. */
function listEvents(url: URL, calendarId: string): { items: unknown[]; nextPageToken?: string } {
  const state = googleMockState();
  const timeMin = Date.parse(url.searchParams.get("timeMin") ?? "") || -Infinity;
  const timeMax = Date.parse(url.searchParams.get("timeMax") ?? "") || Infinity;
  const size = Math.min(Number(url.searchParams.get("maxResults")) || 250, state.pageSize);
  const offset = Number(url.searchParams.get("pageToken") ?? "0") || 0;
  const edge = (e: { dateTime?: string; date?: string } | undefined) =>
    e?.dateTime ? Date.parse(e.dateTime) : e?.date ? Date.parse(`${e.date}T00:00:00Z`) : NaN;
  const all = [
    ...[...state.events.values()].filter((e) => e.calendarId === calendarId).map(view),
    ...state.external
      .filter((e) => mockCalendarId(e.calendarId ?? "primary") === calendarId)
      .map((e) => ({ status: "confirmed", ...e })),
  ]
    .filter((e) => {
      const start = edge(e.start as { dateTime?: string; date?: string });
      const end = edge(e.end as { dateTime?: string; date?: string });
      // Como Google: los que terminan después de `timeMin` y empiezan antes de `timeMax`.
      return !(end <= timeMin) && !(start >= timeMax) && e.status !== "cancelled";
    })
    .sort((a, b) => edge(a.start as { dateTime?: string }) - edge(b.start as { dateTime?: string }));
  const items = all.slice(offset, offset + size);
  return offset + size < all.length ? { items, nextPageToken: String(offset + size) } : { items };
}

/** Un fallo provocado, con el cuerpo que manda Google (el 403 es el de «permiso insuficiente»). */
function failureResponse(status: number): Response {
  if (status === 403) {
    return Response.json(
      {
        error: {
          code: 403,
          message: "Request had insufficient authentication scopes.",
          errors: [{ reason: "insufficientPermissions" }],
          status: "PERMISSION_DENIED",
          details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
        },
      },
      { status }
    );
  }
  return Response.json({ error: { code: status } }, { status });
}

type EventBody = {
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  conferenceData?: unknown;
  extendedProperties?: { private?: Record<string, string> };
};

function apply(event: MockEvent, body: EventBody): void {
  if (body.summary !== undefined) event.summary = body.summary;
  if (body.description !== undefined) event.description = body.description;
  if (body.location !== undefined) event.location = body.location;
  if (body.start?.dateTime) event.start = body.start.dateTime;
  if (body.end?.dateTime) event.end = body.end.dateTime;
  if (body.status === "confirmed") event.status = "confirmed";
  if (body.conferenceData) event.wantsMeet = true;
  if (body.extendedProperties?.private) event.privateProps = { ...event.privateProps, ...body.extendedProperties.private };
}

function view(event: MockEvent) {
  return {
    id: event.id,
    status: event.status,
    summary: event.summary,
    description: event.description,
    ...(event.location ? { location: event.location } : {}),
    start: { dateTime: event.start },
    end: { dateTime: event.end },
    extendedProperties: { private: event.privateProps },
    ...(event.wantsMeet
      ? {
          conferenceData: event.meetLink
            ? {
                createRequest: { status: { statusCode: "success" } },
                entryPoints: [{ entryPointType: "video", uri: event.meetLink }],
              }
            : { createRequest: { status: { statusCode: "pending" } } },
        }
      : {}),
  };
}

function eventIdFrom(path: string[]): string | null {
  if (path[0] !== "calendars" || path[2] !== "events" || !path[3]) return null;
  return path[3];
}

function requireToken(req: Request): Response | null {
  // Mejora 2: el token con la lista de calendarios es `TOKEN.list`; vale igual para lo demás.
  const auth = req.headers.get("authorization") ?? "";
  if (auth === `Bearer ${TOKEN}` || auth === `Bearer ${TOKEN}.list` || auth.startsWith(`Bearer ${TOKEN}.staff|`)) return null;
  return Response.json(
    { error: { code: 401, message: "Invalid Credentials" } },
    { status: 401 }
  );
}

/** Un `id_token` sin firma real (el CRM no la verifica: lo recibe directo del endpoint de tokens). */
function fakeIdToken(email: string): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({ email, email_verified: true })}.firma`;
}
