"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, PanelRight } from "lucide-react";
import { cn, formatPhone } from "@/lib/utils";
import { ContactAvatar } from "@/components/avatar";
import type {
  ConversationDto,
  ConversationsPageDto,
  InboxCountsDto,
  InboxFilters,
  MessageDto,
  MessagesPageDto,
} from "@/lib/types";
import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import { ChannelBadge } from "@/components/channel-badge";
import { useEvents } from "@/components/use-events";
import {
  applyDelta,
  DEFAULT_FILTERS,
  insertSorted,
  latestOnly,
  mergeById,
  patchRow,
  puedeMarcarLeido,
  removeRow,
  upsertMany,
  type ListRow,
} from "@/lib/inbox-state";
import { clockOffsetMs, windowStateAt } from "@/lib/inbox-window";
import { ConversationList } from "./conversation-list";
import { MessageThread } from "./message-thread";
import { Composer } from "./composer";
import { ContactPanel } from "./contact-panel";
import { useInboxClock } from "./use-inbox-clock";

/**
 * Texto que ya salió del compositor pero cuyo POST todavía viaja. Existe solo
 * en el cliente: se pinta como burbuja "enviando" para que escribir el
 * siguiente renglón no espere a Meta (~1,5 s de ida y vuelta).
 */
type PendingOut = {
  id: string;
  conversationId: string;
  text: string;
  createdAt: string;
};

/**
 * `xl` es el umbral donde caben las tres columnas (lista + hilo + detalles).
 * Debajo, el panel de detalles flota sobre el hilo. Debe coincidir con el
 * breakpoint `xl:` que usan las clases de la sección de detalles.
 */
const PANEL_MEDIA_QUERY = "(min-width: 1280px)";
const isWideEnoughForPanel = () =>
  typeof window !== "undefined" && window.matchMedia(PANEL_MEDIA_QUERY).matches;

/** 042 — Tamaños de página, y las esperas que agrupan ráfagas de eventos. */
const LIST_PAGE = 40;
const THREAD_PAGE = 50;
const DELTA_DEBOUNCE_MS = 250;
const SEARCH_DEBOUNCE_MS = 250;
/** El solape del `since`: lo que llegue justo en el borde entre dos consultas no se pierde (los upserts son idempotentes). */
const SINCE_OVERLAP_MS = 2000;

function listQuery(f: InboxFilters, extra: Record<string, string>): string {
  const p = new URLSearchParams(extra);
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.stage !== "all") p.set("stage", f.stage);
  if (f.channel !== "all") p.set("channel", f.channel);
  if (f.filter !== "all") p.set("filter", f.filter);
  return p.toString();
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<{ status: number; data: T | null }> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return { status: res.status, data: null };
    return { status: res.status, data: (await res.json()) as T };
  } catch {
    return { status: 0, data: null };
  }
}

export function InboxClient({
  channels,
  canDelete = false,
}: {
  channels: readonly Channel[];
  /** 026 — Eliminar es irreversible: solo quien administra ve la opción. */
  canDelete?: boolean;
}) {
  const multiChannel = channels.length > 1;

  /* ---------- La lista (042: un almacén por id, no «lo que devolvió el último fetch») ---------- */
  const [rows, setRows] = useState<ListRow[] | null>(null);
  const [counts, setCounts] = useState<InboxCountsDto | null>(null);
  const [stages, setStages] = useState<string[]>([]);
  const [filters, setFilters] = useState<InboxFilters>(DEFAULT_FILTERS);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offsetMs, setOffsetMs] = useState(0);
  const rowsRef = useRef<ListRow[] | null>(null);
  rowsRef.current = rows;
  const filtersRef = useRef<InboxFilters>(DEFAULT_FILTERS);
  const cursorRef = useRef<string | null>(null);
  const syncedAtRef = useRef(0);
  const offsetRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const serverNow = () => Date.now() + offsetRef.current;

  // Cada tipo de petición tiene su guardia: una respuesta vieja nunca pisa a una más nueva (P5).
  const headGuard = useMemo(() => latestOnly(), []);
  const moreGuard = useMemo(() => latestOnly(), []);
  const deltaGuard = useMemo(() => latestOnly({ abortPrevious: false }), []);
  const threadGuard = useMemo(() => latestOnly(), []);
  const latestGuard = useMemo(() => latestOnly({ abortPrevious: false }), []);
  const olderGuard = useMemo(() => latestOnly(), []);

  /* ---------- La conversación abierta ---------- */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFallback, setSelectedFallback] = useState<ConversationDto | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pending, setPending] = useState<PendingOut[]>([]);
  const [scrollToken, setScrollToken] = useState(0);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const olderCursorRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);
  const atBottomRef = useRef(true);
  /** Entró algo mientras el operador leía historial: se marca leído cuando baje. */
  const pendingUnreadRef = useRef(false);

  // Arranca cerrado: en pantallas angostas el panel de detalles es un cajón
  // ENCIMA del hilo, así que abrirlo por defecto taparía la conversación. El
  // efecto de abajo lo abre solo si de veras hay tres columnas de ancho.
  const [panelOpen, setPanelOpen] = useState(false);
  // Se incrementa con cada evento SSE que puede cambiar la etapa/lead o el
  // estado del agente: el panel de detalles lo observa y refetch en vivo.
  const [detailRev, setDetailRev] = useState(0);

  useEffect(() => {
    if (!isWideEnoughForPanel()) return;
    setPanelOpen(localStorage.getItem("vocero.panelOpen") !== "false");
  }, []);
  const togglePanel = useCallback((open: boolean) => {
    setPanelOpen(open);
    // La preferencia es de escritorio: abrir el cajón en el teléfono no debe
    // reescribir cómo queda la Bandeja en la computadora.
    if (isWideEnoughForPanel()) {
      localStorage.setItem("vocero.panelOpen", String(open));
    }
  }, []);
  const tmpSeq = useRef(0);
  // Los envíos salen en fila: el compositor ya no espera, pero WhatsApp debe
  // recibir "hola" antes que el renglón siguiente. Sin esta cadena, dos POST
  // simultáneos pueden llegar a Meta en desorden.
  const sendQueue = useRef<Promise<unknown>>(Promise.resolve());

  const selected =
    rows?.find((r) => r.dto.id === selectedId)?.dto ??
    (selectedFallback && selectedFallback.id === selectedId ? selectedFallback : null);

  // 042: la ventana corre en el cliente, en hora del servidor.
  const nowMs = useInboxClock(selected, offsetMs);

  /* ---------- Cargar la lista ---------- */

  const applyClock = useCallback((serverTime: string) => {
    const offset = clockOffsetMs(serverTime);
    offsetRef.current = offset;
    setOffsetMs(offset);
  }, []);

  /** La cabeza de la lista con unos filtros: reemplaza lo que había (cambió el filtro, o se reconectó). */
  const loadHead = useCallback(
    async (f: InboxFilters = filtersRef.current) => {
      moreGuard.cancel();
      deltaGuard.cancel();
      loadingMoreRef.current = false;
      setLoadingMore(false);
      const req = headGuard.begin();
      const { data } = await getJson<ConversationsPageDto>(
        `/api/conversations?${listQuery(f, { limit: String(LIST_PAGE) })}`,
        req.signal
      );
      if (!data || !req.current()) return;
      const t = Date.parse(data.serverTime);
      applyClock(data.serverTime);
      syncedAtRef.current = t - SINCE_OVERLAP_MS;
      cursorRef.current = data.nextCursor;
      setHasMore(data.nextCursor !== null);
      setRows(upsertMany([], data.conversations, t));
      if (data.counts) setCounts(data.counts);
      if (data.stages) setStages(data.stages);
    },
    [headGuard, moreGuard, deltaGuard, applyClock]
  );

  /** La página siguiente, al llegar al final de la lista. */
  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const req = moreGuard.begin();
    const f = filtersRef.current;
    const { data } = await getJson<ConversationsPageDto>(
      `/api/conversations?${listQuery(f, { limit: String(LIST_PAGE), cursor })}`,
      req.signal
    );
    if (!req.current()) return; // cambió el filtro: esta página es de otra lista
    loadingMoreRef.current = false;
    setLoadingMore(false);
    if (!data) return;
    cursorRef.current = data.nextCursor;
    setHasMore(data.nextCursor !== null);
    setRows((prev) => upsertMany(prev ?? [], data.conversations, Date.parse(data.serverTime)));
  }, [moreGuard]);

  /**
   * Un DELTA: lo que cambió desde la última vez, en un solo viaje que junta ráfagas. Reemplaza al refetch de la
   * lista entera que cada evento disparaba (P1).
   */
  const deltaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deltaInFlight = useRef(false);
  const deltaAgain = useRef(false);
  const runDeltaRef = useRef<() => Promise<void>>(async () => {});

  const scheduleDelta = useCallback(() => {
    if (deltaTimer.current) clearTimeout(deltaTimer.current);
    deltaTimer.current = setTimeout(() => void runDeltaRef.current(), DELTA_DEBOUNCE_MS);
  }, []);

  runDeltaRef.current = async () => {
    if (!rowsRef.current) return; // todavía no hay cabeza: ella traerá lo último
    if (deltaInFlight.current) {
      deltaAgain.current = true;
      return;
    }
    deltaInFlight.current = true;
    const req = deltaGuard.begin();
    const f = filtersRef.current;
    try {
      const { data } = await getJson<ConversationsPageDto>(
        `/api/conversations?${listQuery(f, { since: new Date(syncedAtRef.current).toISOString() })}`
      );
      if (!data || !req.current()) return;
      const t = Date.parse(data.serverTime);
      applyClock(data.serverTime);
      if (data.truncated) {
        void loadHead(f); // cambió demasiado para un delta
        return;
      }
      syncedAtRef.current = t - SINCE_OVERLAP_MS;
      setRows((prev) => (prev ? applyDelta(prev, data.conversations, f, t, cursorRef.current !== null) : prev));
      // La abierta sigue a la vista aunque ya no cumpla el filtro (la leíste y estabas en «No leídas»).
      const open = data.conversations.find((c) => c.id === selectedIdRef.current);
      if (open) setSelectedFallback(open);
      if (data.counts) setCounts(data.counts);
      if (data.stages) setStages(data.stages);
    } finally {
      deltaInFlight.current = false;
      if (deltaAgain.current) {
        deltaAgain.current = false;
        scheduleDelta();
      }
    }
  };

  useEffect(() => {
    void loadHead(DEFAULT_FILTERS);
    return () => {
      if (deltaTimer.current) clearTimeout(deltaTimer.current);
      if (headTimer.current) clearTimeout(headTimer.current);
      for (const g of [headGuard, moreGuard, deltaGuard, threadGuard, latestGuard, olderGuard]) g.cancel();
    };
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Cambia un filtro: se pide la cabeza con los nuevos. La búsqueda espera a que termines de teclear. */
  const headTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onFiltersChange = useCallback(
    (patch: Partial<InboxFilters>) => {
      const current = filtersRef.current;
      const next = { ...current, ...patch };
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      filtersRef.current = next;
      setFilters(next);
      // Nada de lo que viaja con los filtros viejos vale ya.
      headGuard.cancel();
      moreGuard.cancel();
      deltaGuard.cancel();
      if (headTimer.current) clearTimeout(headTimer.current);
      const soloBusqueda = Object.keys(patch).length === 1 && "q" in patch;
      if (soloBusqueda) {
        headTimer.current = setTimeout(() => void loadHead(next), SEARCH_DEBOUNCE_MS);
      } else {
        void loadHead(next);
      }
    },
    [headGuard, moreGuard, deltaGuard, loadHead]
  );

  /* ---------- El hilo ---------- */

  /** Lo más reciente del hilo, FUSIONADO con lo ya cargado (reconexión, tras enviar): un acuse no cambia `created_at`. */
  const refreshLatest = useCallback(
    async (conversationId: string) => {
      const req = latestGuard.begin();
      const { data } = await getJson<MessagesPageDto>(
        `/api/conversations/${conversationId}/messages?limit=${THREAD_PAGE}`
      );
      if (!data || !req.current() || selectedIdRef.current !== conversationId) return;
      setMessages((prev) => mergeById(prev, data.messages));
    },
    [latestGuard]
  );

  const loadThread = useCallback(
    async (conversationId: string) => {
      olderGuard.cancel();
      latestGuard.cancel();
      olderCursorRef.current = null;
      loadingOlderRef.current = false;
      setLoadingOlder(false);
      setHasOlder(false);
      setMessages([]);
      const req = threadGuard.begin();
      const { status, data } = await getJson<MessagesPageDto>(
        `/api/conversations/${conversationId}/messages?limit=${THREAD_PAGE}`,
        req.signal
      );
      if (!req.current() || selectedIdRef.current !== conversationId) return;
      if (status === 404) {
        quitarConversacion(conversationId);
        return;
      }
      if (!data) return;
      // Se fusiona (no se reemplaza): puede haber entrado un mensaje por SSE mientras cargaba.
      setMessages((prev) => mergeById(prev, data.messages));
      olderCursorRef.current = data.nextBefore;
      setHasOlder(data.hasMore);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [olderGuard, latestGuard, threadGuard]
  );

  /** Mensajes anteriores, al subir el hilo. */
  const loadOlder = useCallback(async () => {
    const conversationId = selectedIdRef.current;
    const before = olderCursorRef.current;
    if (!conversationId || !before || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const req = olderGuard.begin();
    const { data } = await getJson<MessagesPageDto>(
      `/api/conversations/${conversationId}/messages?limit=${THREAD_PAGE}&before=${encodeURIComponent(before)}`,
      req.signal
    );
    if (!req.current() || selectedIdRef.current !== conversationId) return;
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    if (!data) return;
    setMessages((prev) => mergeById(prev, data.messages));
    olderCursorRef.current = data.nextBefore;
    setHasOlder(data.hasMore);
  }, [olderGuard]);

  /* ---------- Marcar leído: solo si de verdad se está viendo ---------- */

  const marcarLeida = useCallback((conversationId: string, opts: { force?: boolean } = {}) => {
    if (!puedeMarcarLeido(document.visibilityState)) return; // pestaña en segundo plano: no se «lee» nada
    const row =
      rowsRef.current?.find((r) => r.dto.id === conversationId)?.dto ?? null;
    // Sin contador no hay nada que marcar: no se manda ni se publica nada (P4).
    if (!opts.force && (!row || row.unreadCount <= 0)) return;
    const habiaSinLeer = (row?.unreadCount ?? 0) > 0;
    pendingUnreadRef.current = false;
    setRows((prev) => (prev ? patchRow(prev, conversationId, { unreadCount: 0 }, serverNow()) : prev));
    setSelectedFallback((prev) => (prev && prev.id === conversationId ? { ...prev, unreadCount: 0 } : prev));
    if (habiaSinLeer) setCounts((c) => (c ? { ...c, unread: Math.max(0, c.unread - 1) } : c));
    void fetch(`/api/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markRead: true }),
    }).catch(() => null);
  }, []);

  // Al volver a ver la pestaña, se marca lo que entró mientras no se veía (si el operador está en el fondo).
  useEffect(() => {
    const onVisible = () => {
      const id = selectedIdRef.current;
      if (document.visibilityState === "visible" && id && atBottomRef.current) {
        marcarLeida(id, { force: pendingUnreadRef.current });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [marcarLeida]);

  /** El hilo avisa si el operador está en el fondo: al llegar, lo que entró mientras leía arriba cuenta como leído. */
  const onBottomChange = useCallback(
    (atBottom: boolean) => {
      atBottomRef.current = atBottom;
      const id = selectedIdRef.current;
      if (atBottom && id) marcarLeida(id, { force: pendingUnreadRef.current });
    },
    [marcarLeida]
  );

  const select = useCallback(
    (id: string, known?: ConversationDto) => {
      const dto = known ?? rowsRef.current?.find((r) => r.dto.id === id)?.dto ?? null;
      setSelectedId(id);
      selectedIdRef.current = id;
      setSelectedFallback(dto);
      atBottomRef.current = true;
      pendingUnreadRef.current = false;
      void loadThread(id);
      if (dto) marcarLeida(id); // solo si trae contador (y se ve la pestaña)
    },
    [loadThread, marcarLeida]
  );

  /** 026 — Saca una conversación eliminada de todo lo que esta pestaña recuerda. */
  const quitarConversacion = useCallback((id: string) => {
    setRows((prev) => (prev ? removeRow(prev, id) : prev));
    setPending((prev) => prev.filter((p) => p.conversationId !== id));
    setCounts((c) => (c ? { ...c, total: Math.max(0, c.total - 1) } : c));
    if (selectedIdRef.current === id) {
      setSelectedId(null);
      setSelectedFallback(null);
      setMessages([]);
    }
  }, []);

  // Enlace directo desde Contactos/Pipeline: /bandeja?contact=<id>. La conversación puede no estar en la página cargada.
  const searchParams = useSearchParams();
  const contactParam = searchParams.get("contact");
  const deepLinkDone = useRef<string | null>(null);
  useEffect(() => {
    if (!contactParam || selectedIdRef.current || rows === null) return;
    const match = rows.find((r) => r.dto.contact.id === contactParam);
    if (match) {
      deepLinkDone.current = contactParam;
      select(match.dto.id);
      return;
    }
    if (deepLinkDone.current === contactParam) return;
    deepLinkDone.current = contactParam;
    void getJson<ConversationsPageDto>(`/api/conversations?contactId=${encodeURIComponent(contactParam)}`).then(
      ({ data }) => {
        const dto = data?.conversations[0];
        if (dto && !selectedIdRef.current) select(dto.id, dto);
      }
    );
  }, [contactParam, rows, select]);

  useEvents({
    onMessageNew: ({ conversationId, message }) => {
      const m = message as MessageDto;
      if (selectedIdRef.current === conversationId) {
        // La hora del evento decide el lugar: un entrante que Meta retrasó cae donde le toca (D4).
        setMessages((prev) => insertSorted(prev, m));
        if (m.direction === "in") {
          if (atBottomRef.current && puedeMarcarLeido(document.visibilityState)) {
            marcarLeida(conversationId, { force: true });
          } else {
            pendingUnreadRef.current = true;
          }
        }
      }
      scheduleDelta();
      // Un entrante nuevo puede crear/mover el lead: refresca el panel.
      setDetailRev((v) => v + 1);
    },
    onMessageStatus: ({ conversationId, messageId, status, error }) => {
      if (selectedIdRef.current !== conversationId) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                status: status as MessageDto["status"],
                error: error ?? null,
              }
            : m
        )
      );
    },
    onConversationUpdated: () => {
      scheduleDelta();
      // El agente movió de etapa o cambió el handoff: refresca el panel en vivo.
      setDetailRev((v) => v + 1);
    },
    // 042: alguien (tú en otra pestaña, o un compañero) leyó una conversación. Se parcha el contador sin pedir nada.
    onConversationRead: ({ conversationId }) => {
      const row = rowsRef.current?.find((r) => r.dto.id === conversationId)?.dto;
      setRows((prev) => (prev ? patchRow(prev, conversationId, { unreadCount: 0 }, serverNow()) : prev));
      setSelectedFallback((prev) => (prev && prev.id === conversationId ? { ...prev, unreadCount: 0 } : prev));
      if (row && row.unreadCount > 0) setCounts((c) => (c ? { ...c, unread: Math.max(0, c.unread - 1) } : c));
    },
    onConversationDeleted: ({ conversationId }) => {
      // 026: la eliminó alguien del equipo (o esta misma pestaña). Se quita
      // ya, sin esperar a nada, para que nadie le escriba a un hilo que
      // no existe.
      quitarConversacion(conversationId);
      scheduleDelta();
    },
    onReconnect: () => {
      // Catch-up tras reconexión (contrato sse.md): la cabeza de la lista y lo último del hilo abierto. Lo demás
      // ya cargado no se toca.
      void loadHead();
      if (selectedIdRef.current) void refreshLatest(selectedIdRef.current);
      setDetailRev((v) => v + 1);
    },
  });

  /**
   * Hilo visible = lo confirmado + lo que aún viaja. El mensaje real puede
   * llegar por refetch o por SSE antes de que retiremos el provisional, así
   * que cada pendiente se empareja con UN mensaje real (no por texto suelto:
   * mandar "hola" dos veces seguidas no debe borrar la segunda burbuja).
   */
  const thread = useMemo(() => {
    const propios = pending.filter((p) => p.conversationId === selectedId);
    if (propios.length === 0) return messages;
    const emparejados = new Set<string>();
    const visibles = propios.filter((p) => {
      const real = messages.find(
        (m) =>
          !emparejados.has(m.id) &&
          m.direction === "out" &&
          m.text === p.text &&
          Date.parse(m.createdAt) >= Date.parse(p.createdAt) - 60_000
      );
      if (real) emparejados.add(real.id);
      return !real;
    });
    if (visibles.length === 0) return messages;
    return [
      ...messages,
      ...visibles.map<MessageDto>((p) => ({
        id: p.id,
        conversationId: p.conversationId,
        direction: "out",
        type: "text",
        text: p.text,
        status: "pending",
        error: null,
        aiGenerated: false,
        origin: "operator",
        media: null,
        createdAt: p.createdAt,
      })),
    ];
  }, [messages, pending, selectedId]);

  /**
   * El compositor NO espera a que esto termine: limpia su campo al instante y
   * aquí se pinta la burbuja "enviando". Si el envío falla, la burbuja se
   * retira y el error vuelve al compositor, que devuelve el texto — un mensaje
   * jamás se pierde en silencio.
   */
  const sendText = useCallback(
    async (text: string): Promise<string | null> => {
      const conversationId = selectedIdRef.current;
      if (!conversationId) return "Sin conversación seleccionada";

      const tmpId = `tmp_${++tmpSeq.current}`;
      setPending((prev) => [
        ...prev,
        {
          id: tmpId,
          conversationId,
          text,
          createdAt: new Date().toISOString(),
        },
      ]);
      setScrollToken((n) => n + 1); // enviar siempre baja
      const drop = () => setPending((prev) => prev.filter((p) => p.id !== tmpId));

      const run = async (): Promise<string | null> => {
        const res = await fetch(`/api/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }).catch(() => null);
        if (!res) {
          drop();
          return "Sin conexión con el servidor";
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          drop();
          // 041: un envío que falló dejó su burbuja `failed`; llega por SSE, pero se trae ya.
          void refreshLatest(conversationId);
          return data?.error?.message ?? "No se pudo enviar el mensaje";
        }
        // Primero traer el mensaje real, después quitar el provisional: al
        // revés, la burbuja parpadearía.
        await refreshLatest(conversationId);
        drop();
        scheduleDelta();
        return null;
      };

      const queued = sendQueue.current.then(run, run);
      sendQueue.current = queued.catch(() => null);
      return queued;
    },
    [refreshLatest, scheduleDelta]
  );

  const patchConversation = useCallback(
    async (patch: { aiEnabled?: boolean; reactivate?: boolean }) => {
      if (!selectedIdRef.current) return;
      await fetch(`/api/conversations/${selectedIdRef.current}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => null);
      scheduleDelta();
    },
    [scheduleDelta]
  );

  /** 026 — Devuelve el mensaje de error, o null si la conversación ya no existe. */
  const deleteConversation = useCallback(
    async (alsoContact: boolean): Promise<string | null> => {
      const id = selectedIdRef.current;
      if (!id) return "Sin conversación seleccionada";
      const res = await fetch(
        `/api/conversations/${id}${alsoContact ? "?contacto=1" : ""}`,
        { method: "DELETE" }
      ).catch(() => null);
      if (!res) return "Sin conexión con el servidor";
      // 404 = otra persona la eliminó primero: para quien lo pidió, ya está.
      if (!res.ok && res.status !== 404) {
        const data = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        return data?.error?.message ?? "No se pudo eliminar la conversación";
      }
      quitarConversacion(id);
      scheduleDelta();
      return null;
    },
    [quitarConversacion, scheduleDelta]
  );

  const list = useMemo(() => rows?.map((r) => r.dto) ?? [], [rows]);
  const ventana = selected ? windowStateAt(selected, nowMs) : null;

  return (
    <div className="flex h-full">
      {/* Móvil: una columna a la vez. La lista cede la pantalla completa al
          hilo en cuanto hay conversación elegida (patrón maestro-detalle). */}
      <section
        className={cn(
          "w-full shrink-0 overflow-hidden border-r md:w-[300px] lg:w-[360px]",
          selected && "max-md:hidden"
        )}
      >
        <ConversationList
          conversations={list}
          loading={rows === null}
          counts={counts}
          stages={stages}
          filters={filters}
          onFiltersChange={onFiltersChange}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={() => void loadMore()}
          channels={channels}
          selectedId={selectedId}
          onSelect={(id) => select(id)}
          onSeeded={() => void loadHead()}
          nowMs={nowMs}
        />
      </section>

      <section
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          !selected && "max-md:hidden"
        )}
      >
        {selected ? (
          <>
            <header className="flex items-center justify-between gap-1 border-b bg-background px-2 py-2.5 md:px-4">
              {/* Volver a la lista: en móvil el hilo ocupa toda la pantalla. */}
              <button
                onClick={() => setSelectedId(null)}
                aria-label="Volver a las conversaciones"
                className="shrink-0 rounded-md p-1.5 text-text-2 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
              >
                <ChevronLeft className="h-5 w-5" strokeWidth={1.8} />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-3 p-1">
                <ContactAvatar
                  name={selected.contact.name}
                  seed={selected.contact.id}
                  size="md"
                />
                <div className="min-w-0">
                  <p className="flex min-w-0 items-center gap-1.5 text-[15px] font-bold leading-tight tracking-tight">
                    {multiChannel && <ChannelBadge channel={selected.channel} />}
                    <span className="truncate">{selected.contact.name}</span>
                  </p>
                  <p
                    className={cn(
                      "mt-0.5 font-mono text-[10.5px] tracking-[0.04em]",
                      ventana?.standardOpen
                        ? "font-medium text-success-text"
                        : ventana?.humanOpen
                          ? "font-medium text-info-text"
                          : "text-text-3"
                    )}
                  >
                    {ventana?.standardOpen
                      ? "ventana abierta"
                      : ventana?.humanOpen
                        ? // 024: pasadas 24 h en Instagram o Messenger solo
                          // contesta una persona. No se llama «atención
                          // humana»: eso ya es el traspaso, con la IA en pausa.
                          "ventana humana"
                        : selected.contact.phone
                        ? formatPhone(selected.contact.phone)
                        : // Instagram no tiene teléfono: decir "Sin teléfono"
                          // sería contestar una pregunta que nadie hizo.
                          CHANNEL_LABEL[selected.channel]}
                  </p>
                </div>
              </div>
              {!panelOpen && (
                <button
                  onClick={() => togglePanel(true)}
                  aria-label="Mostrar detalles"
                  className="shrink-0 rounded-full border border-border-strong p-1.5 text-text-3 transition-colors hover:border-text-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <PanelRight className="h-4 w-4" strokeWidth={1.7} />
                </button>
              )}
            </header>
            <MessageThread
              conversationId={selected.id}
              messages={thread}
              hasOlder={hasOlder}
              loadingOlder={loadingOlder}
              onLoadOlder={() => void loadOlder()}
              scrollToBottomToken={scrollToken}
              onBottomChange={onBottomChange}
            />
            <Composer
              // 028: uno por conversación. Sin la llave, el borrador, el adjunto
              // elegido y el panel abierto pasaban a la siguiente conversación.
              key={selected.id}
              conversation={selected}
              nowMs={nowMs}
              onSend={sendText}
              onSent={() => {
                const id = selectedIdRef.current;
                if (id) void refreshLatest(id);
                setScrollToken((n) => n + 1);
                scheduleDelta();
              }}
            />
          </>
        ) : (
          <div className="thread-bg flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="font-serif text-[24px] italic leading-tight text-text-2">
              Elige una conversación para ver el hilo
            </p>
            <p className="kicker">Bandeja · tiempo real</p>
          </div>
        )}
      </section>

      {/* Velo del cajón de detalles (solo donde no caben tres columnas). */}
      {panelOpen && selected && (
        <button
          aria-label="Cerrar los detalles"
          tabIndex={-1}
          onClick={() => togglePanel(false)}
          className="fixed inset-0 z-30 bg-overlay xl:hidden"
        />
      )}

      <section
        className={cn(
          "shrink-0 overflow-hidden border-l transition-[width] duration-200",
          // Debajo de xl no hay ancho para una tercera columna: el panel se
          // vuelve un cajón que entra desde la derecha, encima del hilo.
          "max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:z-40 max-xl:w-auto max-xl:bg-popover max-xl:transition-transform",
          panelOpen && selected
            ? "w-[320px] max-xl:translate-x-0 max-xl:shadow-pop"
            : "w-0 border-l-0 max-xl:translate-x-full"
        )}
      >
        {selected && (
          <div className="h-full w-[320px] max-xl:w-[min(320px,88vw)]">
            <ContactPanel
              conversation={selected}
              refreshKey={detailRev}
              onPatchConversation={patchConversation}
              onDeleteConversation={canDelete ? deleteConversation : undefined}
              onClose={() => togglePanel(false)}
            />
          </div>
        )}
      </section>
    </div>
  );
}
