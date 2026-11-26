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
 */

export type MockEvent = {
  id: string;
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
};

/** Un evento que el dueño puso en su calendario, tal como lo devuelve Google (forma libre). */
export type MockExternalEvent = {
  id: string;
  status?: string;
  summary?: string;
  transparency?: string;
  eventType?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
};

type MockState = {
  events: Map<string, MockEvent>;
  /** Paso 4: lo que el dueño tiene en su calendario aparte de lo que publica Vocero. */
  external: MockExternalEvent[];
  /** Tamaño de página máximo que el mock respeta (para ejercitar la paginación). */
  pageSize: number;
  deleted: string[];
  nextId: number;
  /** Lecturas que tarda la conferencia en estar lista. */
  conferenceDelayReads: number;
  /** Próximas llamadas al calendario que fallan con este estado (para el camino infeliz). */
  failNext: { status: number; count: number } | null;
  /** Tokens revocados. */
  revoked: string[];
};

const globalForMock = globalThis as unknown as { __googleMock?: MockState };

export function googleMockState(): MockState {
  if (!globalForMock.__googleMock) {
    globalForMock.__googleMock = {
      events: new Map(),
      external: [],
      pageSize: 250,
      deleted: [],
      nextId: 1,
      conferenceDelayReads: 1,
      failNext: null,
      revoked: [],
    };
  }
  return globalForMock.__googleMock;
}

export function resetGoogleMock(): void {
  const s = googleMockState();
  s.events.clear();
  s.external.length = 0;
  s.pageSize = 250;
  s.deleted.length = 0;
  s.nextId = 1;
  s.conferenceDelayReads = 1;
  s.failNext = null;
  s.revoked.length = 0;
}

export function googleMockSnapshot() {
  const s = googleMockState();
  return {
    events: [...s.events.values()],
    external: [...s.external],
    deleted: [...s.deleted],
    revoked: [...s.revoked],
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

/** El correo de la cuenta «autorizada» en el mock. */
export const MOCK_ACCOUNT_EMAIL = "agenda@negocio.mock";
export const MOCK_REFRESH_TOKEN = "mock-refresh-oauth";
