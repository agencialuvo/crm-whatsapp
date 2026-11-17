import { matchesQuery } from "@/lib/search";
import type { ConversationDto, InboxFilters, MessageDto } from "@/lib/types";

/**
 * 042 — El estado de la bandeja en el cliente, como funciones puras.
 *
 * Nada aquí toca la red, el DOM ni React: `inbox-client.tsx` solo decide CUÁNDO llamar a cada una.
 * Existe aparte para poder probar lo delicado —que una respuesta vieja no pise a una nueva, que un
 * mensaje retrasado caiga en su lugar— sin montar una pantalla.
 */

export const DEFAULT_FILTERS: InboxFilters = { q: "", stage: "all", channel: "all", filter: "all" };

/* ---------- La lista de conversaciones ---------- */

/** Una fila con el instante (en reloj del servidor) de la última vez que se supo de ella. */
export type ListRow = { dto: ConversationDto; at: number };

const byOrder = (a: ListRow, b: ListRow): number =>
  a.dto.sortKey < b.dto.sortKey ? 1 : a.dto.sortKey > b.dto.sortKey ? -1 : a.dto.id < b.dto.id ? 1 : -1;

/**
 * Mete o reemplaza filas por `id`. Una fila que ya está se reemplaza SOLO si lo que llega es igual de
 * reciente o más (`at`): así un parche local —marcar leído— sobrevive a un delta que salió antes que él.
 */
export function upsertMany(rows: ListRow[], incoming: ConversationDto[], at: number): ListRow[] {
  const byId = new Map(rows.map((r) => [r.dto.id, r]));
  for (const dto of incoming) {
    const current = byId.get(dto.id);
    if (!current || at >= current.at) byId.set(dto.id, { dto, at });
  }
  return [...byId.values()].sort(byOrder);
}

export function patchRow(
  rows: ListRow[],
  id: string,
  patch: Partial<ConversationDto>,
  at: number
): ListRow[] {
  return rows.map((r) => (r.dto.id === id ? { dto: { ...r.dto, ...patch }, at: Math.max(r.at, at) } : r));
}

export const removeRow = (rows: ListRow[], id: string): ListRow[] => rows.filter((r) => r.dto.id !== id);

/** ¿Cumple esta conversación los filtros de la pantalla? Espejo en JavaScript de la consulta del servidor. */
export function matchesFilters(c: ConversationDto, f: InboxFilters): boolean {
  if (!matchesQuery(f.q, { text: [c.contact.name], phone: c.contact.phone })) return false;
  if (f.stage !== "all" && c.stageName !== f.stage) return false;
  if (f.channel !== "all" && c.channel !== f.channel) return false;
  if (f.filter === "unread" && c.unreadCount <= 0) return false;
  if (f.filter === "anuncios" && c.anuncio === null) return false;
  return true;
}

/**
 * Lo que un delta aporta a la lista que se ve: cada fila cambiada que cumple los filtros Y cae dentro de lo
 * ya cargado (o no hay más páginas). Una que cae más abajo del último renglón cargado llegará con «cargar
 * más»; mostrarla ahora dejaría un hueco en la lista. Una que dejó de cumplir los filtros se retira.
 */
export function applyDelta(
  rows: ListRow[],
  changed: ConversationDto[],
  filters: InboxFilters,
  at: number,
  hasMore: boolean
): ListRow[] {
  const loadedFloor = rows.length > 0 ? rows[rows.length - 1]!.dto : null;
  const next = new Map(rows.map((r) => [r.dto.id, r]));
  for (const dto of changed) {
    const current = next.get(dto.id);
    if (current && at < current.at) continue; // el parche local es más nuevo
    if (!matchesFilters(dto, filters)) {
      next.delete(dto.id);
      continue;
    }
    const belowFloor =
      hasMore &&
      loadedFloor !== null &&
      !current &&
      (dto.sortKey < loadedFloor.sortKey || (dto.sortKey === loadedFloor.sortKey && dto.id < loadedFloor.id));
    if (belowFloor) continue;
    next.set(dto.id, { dto, at });
  }
  return [...next.values()].sort(byOrder);
}

/* ---------- El hilo ---------- */

/** La hora del evento de un mensaje (la que se ve y por la que se ordena), en ms. */
const eventTime = (m: MessageDto): number => Date.parse(m.createdAt);

/**
 * Inserta un mensaje en su lugar por hora del evento, sin duplicar por `id` (si ya está, se reemplaza: así
 * un acuse de entrega que llega por SSE actualiza la burbuja). Con empate cae DESPUÉS de los iguales.
 */
export function insertSorted(messages: MessageDto[], m: MessageDto): MessageDto[] {
  const without = messages.filter((x) => x.id !== m.id);
  let i = without.length;
  while (i > 0 && eventTime(without[i - 1]!) > eventTime(m)) i--;
  return [...without.slice(0, i), m, ...without.slice(i)];
}

/** Une dos listas por `id` (gana la que llega) y las deja ordenadas por hora del evento, estable. */
export function mergeById(existing: MessageDto[], incoming: MessageDto[]): MessageDto[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  const order = new Map([...byId.keys()].map((id, i) => [id, i]));
  return [...byId.values()].sort(
    (a, b) => eventTime(a) - eventTime(b) || order.get(a.id)! - order.get(b.id)!
  );
}

/** ¿Este mensaje cayó por encima de lo que el operador ya vio? (Entonces no es «nuevo».) */
export function isOlderThanSeen(m: MessageDto, newestSeen: MessageDto | undefined): boolean {
  return newestSeen !== undefined && eventTime(m) < eventTime(newestSeen);
}

/* ---------- Scroll y lectura ---------- */

export const NEAR_BOTTOM_PX = 120;

export function isNearBottom(
  m: { scrollTop: number; clientHeight: number; scrollHeight: number },
  threshold: number = NEAR_BOTTOM_PX
): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}

/** ¿Se puede marcar leído? Solo si la pestaña se está viendo de verdad. */
export const puedeMarcarLeido = (visibility: string): boolean => visibility === "visible";

/* ---------- Respuestas fuera de orden ---------- */

/**
 * Numera las peticiones de UN tipo y deja pasar solo a la más reciente. `begin()` devuelve una señal para
 * cancelarla y `current()`, que al volver dice si todavía vale. `cancel()` invalida todo lo que viaja (se
 * usa al cambiar de filtro o de conversación). Con `abortPrevious: false` la anterior sigue su camino pero
 * su resultado se descarta igual.
 */
export function latestOnly(opts: { abortPrevious?: boolean } = {}) {
  const abortPrevious = opts.abortPrevious ?? true;
  let seq = 0;
  let controller: AbortController | null = null;
  return {
    begin() {
      if (abortPrevious) controller?.abort();
      controller = new AbortController();
      const mine = ++seq;
      return { signal: controller.signal, current: () => mine === seq };
    },
    cancel() {
      controller?.abort();
      controller = null;
      seq++;
    },
  };
}
