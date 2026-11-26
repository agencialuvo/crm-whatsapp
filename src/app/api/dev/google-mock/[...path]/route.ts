import { mockGuard } from "@/lib/dev-guard";
import {
  googleMockSnapshot,
  googleMockState,
  MOCK_ACCOUNT_EMAIL,
  MOCK_REFRESH_TOKEN,
  mockRefreshTokenIsBad,
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
 */

type Ctx = { params: Promise<{ path: string[] }> };

const TOKEN = "google-token-de-mentira";
const CAL_SCOPE = "https://www.googleapis.com/auth/calendar.events";

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
      return Response.json({
        access_token: TOKEN,
        expires_in: 3600,
        refresh_token: MOCK_REFRESH_TOKEN,
        scope: code.endsWith("-noscope") ? "openid email" : `${CAL_SCOPE} openid email`,
        id_token: fakeIdToken(MOCK_ACCOUNT_EMAIL),
      });
    }
    if (mockRefreshTokenIsBad(body) && form.get("refresh_token") !== MOCK_REFRESH_TOKEN) {
      return Response.json(
        { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        { status: 400 }
      );
    }
    return Response.json({ access_token: TOKEN, expires_in: 3600 });
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

  if (route === "_external") {
    const body = (await req.json().catch(() => ({}))) as {
      events?: MockExternalEvent[];
      replace?: boolean;
      pageSize?: number;
    };
    const state = googleMockState();
    if (body.replace) state.external.length = 0;
    state.external.push(...(body.events ?? []));
    if (body.pageSize) state.pageSize = body.pageSize;
    return Response.json({ ok: true, external: state.external.length });
  }

  if (route === "_fail") {
    const body = (await req.json().catch(() => ({}))) as { status?: number; count?: number };
    googleMockState().failNext = { status: body.status ?? 500, count: body.count ?? 1 };
    return Response.json({ ok: true });
  }

  // POST /calendars/{id}/events
  if (path[0] === "calendars" && path[2] === "events" && path.length === 3) {
    const unauthorized = requireToken(req);
    if (unauthorized) return unauthorized;
    const failure = takeMockFailure();
    if (failure) return Response.json({ error: { code: failure } }, { status: failure });

    const body = (await req.json().catch(() => ({}))) as EventBody & { id?: string };
    const state = googleMockState();
    if (body.id && (state.events.has(body.id) || state.deleted.includes(body.id))) {
      return Response.json({ error: { code: 409, message: "The requested identifier already exists." } }, { status: 409 });
    }
    const id = body.id ?? `evt_${state.nextId++}`;
    const event: MockEvent = {
      id,
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
    else back.searchParams.set("code", clientId.endsWith("-noscope") ? "mock-code-noscope" : "mock-code");
    return new Response(null, { status: 302, headers: { Location: back.toString() } });
  }

  const unauthorized = requireToken(req);
  if (unauthorized) return unauthorized;
  const failure = takeMockFailure();
  if (failure) return failureResponse(failure);

  // GET /calendars/{id} — el calendario.
  if (path[0] === "calendars" && path.length === 2) {
    return Response.json({ id: path[1], summary: "Calendario de prueba" });
  }
  // GET /calendars/{id}/events — el listado (la prueba de conexión y, Paso 4, la lectura de lo ocupado).
  if (path[0] === "calendars" && path.length === 3 && path[2] === "events") {
    return Response.json({ summary: "Calendario de prueba", ...listEvents(new URL(req.url)) });
  }

  // GET /calendars/{id}/events/{eventId}
  const id = eventIdFrom(path);
  if (!id) return new Response(null, { status: 404 });
  const state = googleMockState();
  if (state.deleted.includes(id)) return Response.json({ id, status: "cancelled" });
  const event = state.events.get(id);
  if (!event) return new Response(null, { status: 404 });

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
    event = { id, summary: "", description: "", location: null, start: "", end: "", status: "confirmed", privateProps: {}, wantsMeet: false, reads: 0, meetLink: null, updates: 0 };
    state.events.set(id, event);
  }
  if (!event) return new Response(null, { status: 404 });
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
  const failure = takeMockFailure();
  if (failure) return Response.json({ error: { code: failure } }, { status: failure });

  const { path } = await ctx.params;
  const id = eventIdFrom(path);
  if (!id) return new Response(null, { status: 404 });
  const state = googleMockState();
  if (state.deleted.includes(id)) return new Response(null, { status: 410 });
  if (!state.events.has(id)) return new Response(null, { status: 404 });
  state.events.delete(id);
  state.deleted.push(id);
  return new Response(null, { status: 204 });
}

/** El listado: lo de Vocero y lo del dueño, en la ventana pedida, por páginas. */
function listEvents(url: URL): { items: unknown[]; nextPageToken?: string } {
  const state = googleMockState();
  const timeMin = Date.parse(url.searchParams.get("timeMin") ?? "") || -Infinity;
  const timeMax = Date.parse(url.searchParams.get("timeMax") ?? "") || Infinity;
  const size = Math.min(Number(url.searchParams.get("maxResults")) || 250, state.pageSize);
  const offset = Number(url.searchParams.get("pageToken") ?? "0") || 0;
  const edge = (e: { dateTime?: string; date?: string } | undefined) =>
    e?.dateTime ? Date.parse(e.dateTime) : e?.date ? Date.parse(`${e.date}T00:00:00Z`) : NaN;
  const all = [
    ...[...state.events.values()].map(view),
    ...state.external.map((e) => ({ status: "confirmed", ...e })),
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
  if (req.headers.get("authorization") === `Bearer ${TOKEN}`) return null;
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
