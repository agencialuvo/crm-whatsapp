/**
 * 015 — Estado del mock de Google Calendar (solo entorno de pruebas).
 *
 * Imita la parte que más cuesta creer hasta que se ve: la conferencia de Meet
 * NO viene en la respuesta de crear el evento. Aquí el primer `GET` del evento
 * todavía la da como pendiente y el siguiente ya trae el enlace — así el
 * self-test ejercita el camino real, no uno cómodo.
 *
 * Paso 3 — También imita: ids propios (crear uno que ya existe o se borró da 409),
 * eventos SIN Meet (la sincronización del calendario), la pantalla de permisos de
 * OAuth, el canje del código, la revocación y fallos provocados a voluntad.
 *
 * Paso 4 — Y el listado del calendario de verdad (ventana `timeMin`/`timeMax` y páginas), con eventos
 * «del dueño» sembrados a mano (`_external`): con hora o de día completo, «Disponible», rechazados,
 * cancelados… Un 403 provocado trae el cuerpo real de «permiso insuficiente».
 *
 * Mejora 2 — Varios calendarios con roles distintos (`calendarList`), cada evento vive en UNO (leerlo o
 * tocarlo desde otro da 404, como en Google), `events.move`, y la pantalla de permisos que concede o no la
 * lista de calendarios (`grantCalendarList`). Un token con la lista lleva `.list` al final.
 *
 * Mejora 3 — Otra cuenta: la del PROFESIONAL (`staffAccountEmail`), que concede solo leer
 * (`calendar.events.readonly`; `staffGrantRead: false` = la desmarca). Su token es `TOKEN.staff|<correo>`,
 * su `primary` es SU calendario (eventos `_external` con `calendarId` = su correo) y no puede escribir.
 *
 * Mejora 4 — Los canales de avisos (`events.watch`, `channels.stop`) y el AVISO en sí: al crear un canal manda
 * `sync` a su dirección, y al cambiar los eventos de un calendario (`_external`) manda `exists` a los canales
 * que lo vigilan, con los encabezados reales de Google (`X-Goog-*`). `_watch` provoca rechazos.
 */

/** Mejora 3: la cuenta personal de un profesional en el mock. */
export const MOCK_STAFF_EMAIL = "carla@personal.mock";

/** Mejora 3: el refresh token que devuelve el mock a un profesional (lleva su correo). */
export function mockStaffRefreshToken(email: string): string {
  return `mock-refresh-staff|${email}`;
}

/** El calendario principal de la cuenta del mock (`primary` es su alias). */
export const MOCK_PRIMARY_CALENDAR = "agenda@negocio.mock";

export type MockCalendar = {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: "owner" | "writer" | "reader" | "freeBusyReader";
};

/** La cuenta del mock: el principal, uno del equipo (editor), uno personal (lector) y uno de libre/ocupado. */
export function defaultMockCalendars(): MockCalendar[] {
  return [
    { id: MOCK_PRIMARY_CALENDAR, summary: "Agenda del negocio", primary: true, accessRole: "owner" },
    { id: "equipo@group.calendar.mock", summary: "Equipo", accessRole: "writer" },
    { id: "personal@group.calendar.mock", summary: "Personal", accessRole: "reader" },
    { id: "socio@group.calendar.mock", summary: "Socio", accessRole: "freeBusyReader" },
  ];
}

/** `primary` → el id real del principal. */
export function mockCalendarId(id: string): string {
  return id === "primary" ? MOCK_PRIMARY_CALENDAR : id;
}

export type MockEvent = {
  id: string;
  /** Mejora 2: en qué calendario vive. */
  calendarId: string;
  summary: string;
  description: string;
  location: string | null;
  start: string;
  end: string;
  status: "confirmed" | "cancelled";
  /** `extendedProperties.private`. */
  privateProps: Record<string, string>;
  /** Se pidió conferencia de Meet. */
  wantsMeet: boolean;
  /** Cuántas veces se ha leído: la conferencia "termina" tras la primera. */
  reads: number;
  meetLink: string | null;
  updates: number;
  /** Mejora 2: cuántas veces se movió de calendario. */
  moves?: number;
};

/** Un evento que el dueño puso en su calendario, tal como lo devuelve Google (forma libre). */
export type MockExternalEvent = {
  id: string;
  /** Mejora 2: calendario donde está (por defecto, el principal). */
  calendarId?: string;
  status?: string;
  summary?: string;
  transparency?: string;
  eventType?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
};

/** Mejora 4: un canal de avisos que «Google» tiene abierto. */
export type MockChannel = {
  id: string;
  resourceId: string;
  /** El calendario real (ya resuelto `primary`). */
  calendarId: string;
  address: string;
  token: string | null;
  expiration: number;
  stopped: boolean;
  /** Avisos enviados (el `X-Goog-Message-Number` sigue de aquí). */
  messages: number;
};

type MockState = {
  events: Map<string, MockEvent>;
  /** Paso 4: lo que el dueño tiene en su calendario aparte de lo que publica Vocero. */
  external: MockExternalEvent[];
  /** Tamaño de página máximo que el mock respeta (para ejercitar la paginación). */
  pageSize: number;
  /** Mejora 2: los calendarios de la cuenta. */
  calendars: MockCalendar[];
  /** Mejora 2: si la próxima pantalla de permisos concede la lista de calendarios (cuando se pide). */
  grantCalendarList: boolean;
  /** Mejora 3: la cuenta con la que «entra» el profesional en la pantalla de permisos. */
  staffAccountEmail: string;
  /** Mejora 3: si el profesional deja marcado el permiso de leer su calendario. */
  staffGrantRead: boolean;
  deleted: string[];
  nextId: number;
  /** Lecturas que tarda la conferencia en estar lista. */
  conferenceDelayReads: number;
  /** Próximas llamadas al calendario que fallan con este estado (para el camino infeliz). */
  failNext: { status: number; count: number } | null;
  /** Tokens revocados. */
  revoked: string[];
  /** Mejora 4: los canales de avisos. */
  channels: MockChannel[];
  /** Mejora 4: las próximas N altas de canal fallan con este estado. */
  failWatch: { status: number; count: number } | null;
  /** Mejora 4: calendarios que no admiten avisos (400 `pushNotSupportedForRequestedResource`). */
  watchUnsupported: string[];
};

const globalForMock = globalThis as unknown as { __googleMock?: MockState };

export function googleMockState(): MockState {
  if (!globalForMock.__googleMock) {
    globalForMock.__googleMock = {
      events: new Map(),
      external: [],
      pageSize: 250,
      calendars: defaultMockCalendars(),
      grantCalendarList: true,
      staffAccountEmail: MOCK_STAFF_EMAIL,
      staffGrantRead: true,
      deleted: [],
      nextId: 1,
      conferenceDelayReads: 1,
      failNext: null,
      revoked: [],
      channels: [],
      failWatch: null,
      watchUnsupported: [],
    };
  }
  return globalForMock.__googleMock;
}

export function resetGoogleMock(): void {
  const s = googleMockState();
  s.events.clear();
  s.external.length = 0;
  s.pageSize = 250;
  s.calendars = defaultMockCalendars();
  s.grantCalendarList = true;
  s.staffAccountEmail = MOCK_STAFF_EMAIL;
  s.staffGrantRead = true;
  s.deleted.length = 0;
  s.nextId = 1;
  s.conferenceDelayReads = 1;
  s.failNext = null;
  s.revoked.length = 0;
  s.channels.length = 0;
  s.failWatch = null;
  s.watchUnsupported = [];
}

export function googleMockSnapshot() {
  const s = googleMockState();
  return {
    events: [...s.events.values()],
    external: [...s.external],
    calendars: [...s.calendars],
    deleted: [...s.deleted],
    revoked: [...s.revoked],
    channels: s.channels.map((c) => ({ ...c })),
  };
}

/**
 * Camino infeliz determinista: un refresh token terminado en `-invalid` hace
 * que Google responda `invalid_grant` — exactamente lo que pasa cuando la app
 * OAuth sigue en modo prueba y caducó a los 7 días.
 */
export function mockRefreshTokenIsBad(body: string): boolean {
  return new URLSearchParams(body).get("refresh_token")?.endsWith("-invalid") ?? true;
}

/** Si toca fallar, consume un fallo y devuelve su estado. */
export function takeMockFailure(): number | null {
  const s = googleMockState();
  if (!s.failNext || s.failNext.count <= 0) return null;
  s.failNext.count -= 1;
  const status = s.failNext.status;
  if (s.failNext.count <= 0) s.failNext = null;
  return status;
}

/** Mejora 4: el `resourceId` (opaco y estable) de un calendario. */
export function mockResourceId(calendarId: string): string {
  return `res-${Buffer.from(calendarId).toString("base64url")}`;
}

/**
 * Mejora 4: manda el aviso de Google a los canales abiertos sobre ese calendario (o sobre todos con `null`). Con
 * los encabezados reales; sin cuerpo. Espera las respuestas (para que el self-test sea determinista).
 */
export async function sendMockNotifications(
  calendarId: string | null,
  state: "exists" | "not_exists" | "sync" = "exists",
  onlyChannel?: MockChannel
): Promise<number> {
  const s = googleMockState();
  const targets = onlyChannel
    ? [onlyChannel]
    : s.channels.filter((c) => !c.stopped && c.expiration > Date.now() && (calendarId === null || c.calendarId === calendarId));
  const out = await Promise.allSettled(
    targets.map((c) => {
      c.messages += 1;
      return fetch(c.address, {
        method: "POST",
        headers: {
          "X-Goog-Channel-ID": c.id,
          ...(c.token ? { "X-Goog-Channel-Token": c.token } : {}),
          "X-Goog-Channel-Expiration": new Date(c.expiration).toUTCString(),
          "X-Goog-Resource-ID": c.resourceId,
          "X-Goog-Resource-URI": `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.calendarId)}/events?alt=json`,
          "X-Goog-Resource-State": state,
          "X-Goog-Message-Number": String(c.messages),
        },
        signal: AbortSignal.timeout(10_000),
      });
    })
  );
  return out.filter((r) => r.status === "fulfilled" && r.value.ok).length;
}

/** El correo de la cuenta «autorizada» en el mock. */
export const MOCK_ACCOUNT_EMAIL = "agenda@negocio.mock";
export const MOCK_REFRESH_TOKEN = "mock-refresh-oauth";
/** Mejora 2: el refresh token de una conexión que SÍ concedió la lista de calendarios. */
export const MOCK_REFRESH_TOKEN_LIST = "mock-refresh-oauth-list";
