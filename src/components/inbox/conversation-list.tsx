"use client";

import { useEffect, useRef, useState } from "react";
import { Inbox, Megaphone, Search, Sparkles, UserRound, X } from "lucide-react";
import type { ConversationDto, InboxCountsDto, InboxFilters } from "@/lib/types";
import { windowStateAt } from "@/lib/inbox-window";
import { etiquetaDeOrigen, titularDeOrigen } from "@/lib/anuncios";
import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import { ChannelBadge } from "@/components/channel-badge";
import { cn } from "@/lib/utils";
import { ContactAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { emptyInboxDescription, formatTime, previewText } from "./helpers";
import { SearchSelect } from "@/components/ui/search-select";

/* Puntos de etapa: los tokens del tema, no hex copiados del tema claro —
   así siguen al acento white-label y se recalculan en oscuro. */
const STAGE_DOT: Record<string, string> = {
  Nuevo: "var(--text-3)",
  "En conversación": "var(--accent)",
  Interesado: "var(--warning)",
  Cliente: "var(--success)",
  Perdido: "var(--danger)",
  // Seed de los negocios nuevos (los anteriores conservan los nombres de arriba).
  Contactado: "var(--accent)",
  Citado: "var(--warning)",
  Convertido: "var(--success)",
  "No interesado": "var(--danger)",
};
const STAGE_DOT_FALLBACK = "var(--text-3)";

/**
 * Foco por teclado de chips y selector: el anillo de `ui/button`, acento
 * sólido separado del control (el elegido ya ES del color del acento y un
 * anillo pegado se fundiría con él). El suave de los campos
 * (`ring-brand-soft`) queda a ~1.3:1 del fondo: aquí no hay borde que cambie
 * de color para compensarlo, y se veía menos que el del navegador.
 */
const FOCO_SEPARADO =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function InboxEmptyState({
  onSeeded,
  channels,
}: {
  onSeeded: () => void;
  channels: readonly Channel[];
}) {
  const [seeding, setSeeding] = useState(false);
  const [failed, setFailed] = useState(false);

  async function seed() {
    setSeeding(true);
    const res = await fetch("/api/seed/demo", { method: "POST" }).catch(
      () => null
    );
    setSeeding(false);
    if (res?.ok) onSeeded();
    else setFailed(true);
  }

  return (
    <EmptyState
      icon={Inbox}
      className="h-full"
      title="Sin conversaciones todavía"
      description={emptyInboxDescription(channels.map((ch) => CHANNEL_LABEL[ch]))}
      action={
        !failed && (
          <Button
            size="sm"
            variant="outline"
            disabled={seeding}
            onClick={() => void seed()}
          >
            <Sparkles className="h-4 w-4" strokeWidth={1.7} />
            {seeding ? "Cargando demo…" : "Cargar datos de demostración"}
          </Button>
        )
      }
    />
  );
}

/**
 * 042 — La lista ya no filtra ni cuenta: eso lo hace el servidor (`GET /api/conversations`) con los filtros que
 * esta pantalla le manda, y los contadores llegan hechos. Aquí solo se pinta lo que `InboxClient` entrega, se
 * avisa cuando cambia un filtro y se pide la siguiente página al llegar al final.
 */
export function ConversationList({
  conversations,
  loading,
  counts,
  stages,
  filters,
  onFiltersChange,
  hasMore,
  loadingMore,
  onLoadMore,
  channels,
  selectedId,
  onSelect,
  onSeeded,
  nowMs,
}: {
  /** Ya filtradas y en orden. */
  conversations: ConversationDto[];
  loading: boolean;
  counts: InboxCountsDto | null;
  stages: string[];
  filters: InboxFilters;
  onFiltersChange: (patch: Partial<InboxFilters>) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Canales encendidos en esta instancia (ADR-001). */
  channels: readonly Channel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSeeded: () => void;
  /** «Ahora» en hora del servidor: el punto verde de la ventana se apaga solo. */
  nowMs: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Estable: el padre pasa una función nueva en cada render y el observador no debe volver a suscribirse por eso.
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  const [typed, setTyped] = useState("");

  /**
   * Rescate de lo tecleado ANTES de que hidratara el JS. La caja se pinta en
   * el HTML del servidor, así que se puede escribir en ella mientras carga la
   * página; al montar, React la dejaba vacía y esas pulsaciones se perdían en
   * silencio (el usuario veía la lista entera "sin filtrar"). Por eso el input
   * es NO controlado: el DOM manda y aquí solo adoptamos su valor.
   */
  useEffect(() => {
    const value = inputRef.current?.value ?? "";
    if (value) {
      setTyped(value);
      onFiltersChange({ q: value });
    }
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { filter, stage, channel: inbox } = filters;
  const query = typed;
  const total = counts?.total ?? conversations.length;
  const filtros: { id: InboxFilters["filter"]; label: string; count: number }[] = [
    { id: "all", label: "Todas", count: counts?.all ?? conversations.length },
    { id: "unread", label: "No leídas", count: counts?.unread ?? 0 },
  ];
  // Sin ninguna conversación de anuncio el filtro no aparece: a quien no
  // anuncia no se le pinta un botón que siempre dice 0. Si está elegido, se
  // queda, para poder salir de él aunque el contador baje a cero.
  if ((counts?.anuncios ?? 0) > 0 || filter === "anuncios") {
    filtros.push({ id: "anuncios", label: "Anuncios", count: counts?.anuncios ?? 0 });
  }
  // Con un solo canal encendido no hay bandejas que distinguir: ni marca en
  // los renglones ni filtro. La pantalla queda exactamente como antes de 014.
  const multiChannel = channels.length > 1;

  // La etapa elegida siempre es una opción, aunque ya no haya conversaciones en ella.
  const etapas = stage !== "all" && !stages.includes(stage) ? [...stages, stage] : stages;

  // El centinela del final: al verse, pide la página siguiente.
  useEffect(() => {
    const bottom = bottomRef.current;
    const root = listRef.current;
    if (!bottom || !root || !hasMore || loadingMore || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMoreRef.current();
      },
      { root, rootMargin: "0px 0px 200px 0px" }
    );
    observer.observe(bottom);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, loading, conversations.length]);

  function clearQuery() {
    if (inputRef.current) inputRef.current.value = "";
    setTyped("");
    onFiltersChange({ q: "" });
    inputRef.current?.focus();
  }

  const sinFiltros = !query && filter === "all" && stage === "all" && inbox === "all";

  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-4 pb-3 pt-4">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-[17px] font-bold tracking-tight">Bandeja</h2>
          <span className="font-mono text-[12px] text-text-3">{total}</span>
          {multiChannel && (
            <div className="ml-auto flex items-center gap-1">
              {channels.map((ch) => {
                const on = inbox === ch;
                return (
                  <button
                    key={ch}
                    onClick={() => onFiltersChange({ channel: on ? "all" : ch })}
                    aria-pressed={on}
                    title={
                      on
                        ? "Ver todas las bandejas"
                        : `Ver solo ${CHANNEL_LABEL[ch]}`
                    }
                    className={cn(
                      "flex items-center gap-1 rounded-full border py-[3px] pl-[5px] pr-2 text-[11.5px] font-medium transition-colors",
                      FOCO_SEPARADO,
                      on
                        ? "border-brand bg-brand-veil text-foreground"
                        : "text-text-3 hover:bg-accent",
                      inbox !== "all" && !on && "opacity-45"
                    )}
                  >
                    <ChannelBadge
                      channel={ch}
                      className="h-[13px] w-[13px] rounded-[4px]"
                    />
                    {counts?.byChannel[ch] ?? 0}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border-strong bg-chip px-3.5 py-[7px] shadow-sm transition-[border-color,box-shadow] focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand-soft">
          <Search className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.7} />
          <input
            ref={inputRef}
            placeholder="Buscar por nombre o teléfono…"
            aria-label="Buscar conversación"
            defaultValue=""
            onChange={(e) => {
              setTyped(e.target.value);
              onFiltersChange({ q: e.target.value });
            }}
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-text-3"
          />
          {query && (
            <button
              onClick={clearQuery}
              aria-label="Limpiar búsqueda"
              className="shrink-0 rounded-full p-0.5 text-text-3 hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          )}
        </div>
      </header>

      {/* Envuelve: con el filtro de anuncios, los tres botones y el selector de
          etapa no caben en una columna de 300-360 px, y el selector se
          aplastaba hasta dejar solo la flecha. */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 border-b px-4 py-2.5">
        {filtros.map((f) => (
          <button
            key={f.id}
            onClick={() => onFiltersChange({ filter: f.id })}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-[5px] text-[12.5px] font-semibold transition-colors",
              FOCO_SEPARADO,
              filter === f.id
                ? "border-brand bg-brand text-brand-fg"
                : "border-border-strong bg-chip text-text-2 hover:border-text-3"
            )}
          >
            {f.label}
            <span
              className={cn(
                "rounded-full px-1.5 text-[11px]",
                filter === f.id ? "bg-brand-veil" : "bg-secondary text-text-3"
              )}
            >
              {f.count}
            </span>
          </button>
        ))}

        {etapas.length > 0 && (
          <SearchSelect
            value={stage}
            onChange={(value) => onFiltersChange({ stage: value })}
            ariaLabel="Filtrar por etapa del embudo"
            options={[
              { value: "all", label: "Toda etapa" },
              ...etapas.map((s) => ({ value: s, label: s })),
            ]}
            searchPlaceholder="Buscar etapa…"
            minListWidth={220}
            className="ml-auto min-w-0 max-w-[42%]"
            triggerClassName={cn(
              "h-auto w-full rounded-full px-2 py-[5px] text-[12.5px] font-semibold shadow-none transition-colors",
              FOCO_SEPARADO,
              stage === "all"
                ? "border-border-strong bg-chip text-text-2 hover:border-text-3"
                : "border-brand bg-brand text-brand-fg"
            )}
          />
        )}
      </div>

      <div ref={listRef} data-testid="conversation-list" className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="p-6 text-center text-xs text-text-3">Cargando…</p>
        ) : sinFiltros && total === 0 && conversations.length === 0 ? (
          <InboxEmptyState onSeeded={onSeeded} channels={channels} />
        ) : conversations.length === 0 ? (
          <p className="p-6 text-center text-xs text-text-3">
            {/* 028: un canal en el que nadie ha escrito no es una búsqueda fallida. */}
            {inbox !== "all" &&
            !query &&
            filter === "all" &&
            stage === "all" &&
            (counts?.byChannel[inbox] ?? 0) === 0
              ? `Nadie ha escrito por ${CHANNEL_LABEL[inbox]} todavía.`
              : "Sin resultados para este filtro."}
          </p>
        ) : (
          <>
            <ul>
              {conversations.map((c) => {
                const unread = c.unreadCount > 0;
                const active = selectedId === c.id;
                const ventanaAbierta = windowStateAt(c, nowMs).standardOpen;
                return (
                  <li key={c.id} className="relative border-b border-border">
                    {active && (
                      <span className="absolute inset-y-0 left-0 w-[3px] bg-brand" />
                    )}
                    <button
                      onClick={() => onSelect(c.id)}
                      className={cn(
                        "flex w-full items-start gap-[11px] px-4 py-[var(--row-py)] text-left transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        active ? "bg-[var(--bg-active)]" : "hover:bg-row-hover"
                      )}
                    >
                      <span className="relative shrink-0">
                        <ContactAvatar name={c.contact.name} seed={c.contact.id} size="lg" />
                        {ventanaAbierta && (
                          <span className="absolute bottom-0 right-0 h-[11px] w-[11px] rounded-full border-[2.5px] border-background bg-success" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5">
                            {multiChannel && <ChannelBadge channel={c.channel} />}
                            <span
                              data-testid="conv-name"
                              className={cn(
                                "truncate text-sm",
                                unread ? "font-[680]" : "font-semibold"
                              )}
                            >
                              {c.contact.name}
                            </span>
                          </span>
                          <span
                            className={cn(
                              "shrink-0 font-mono text-[10.5px] tracking-[0.02em]",
                              unread ? "font-semibold text-brand-ink" : "text-text-3"
                            )}
                          >
                            {formatTime(c.lastMessageAt)}
                          </span>
                        </span>
                        <span className="mt-0.5 flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              "truncate text-[13px]",
                              unread ? "font-medium text-text-2" : "text-text-3"
                            )}
                          >
                            {previewText(c.preview)}
                          </span>
                          {unread && (
                            <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[10.5px] font-semibold text-brand-fg">
                              {c.unreadCount}
                            </span>
                          )}
                        </span>
                        <span className="mt-1.5 flex items-center gap-1.5">
                          {c.stageName && (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-chip px-2 py-0.5 text-[11px] font-medium text-text-2">
                              <span
                                className="h-[7px] w-[7px] rounded-full"
                                style={{
                                  background: STAGE_DOT[c.stageName] ?? STAGE_DOT_FALLBACK,
                                }}
                              />
                              {c.stageName}
                            </span>
                          )}
                          {c.handoffAt && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-warning-soft bg-warning-tint px-2 py-0.5 text-[11px] text-warning-text">
                              <UserRound className="h-3 w-3" strokeWidth={1.7} />
                              Atención humana
                            </span>
                          )}
                          {c.anuncio && (
                            <span
                              className="inline-flex min-w-0 items-center gap-1 rounded-full border border-info-soft bg-info-tint px-2 py-0.5 text-[11px] text-info-text"
                              title={titularDeOrigen(c.anuncio.headline, c.anuncio.sourceType)}
                            >
                              <Megaphone className="h-3 w-3 shrink-0" strokeWidth={1.7} />
                              <span className="truncate">
                                {etiquetaDeOrigen(c.anuncio.sourceType)}
                                {c.anuncio.headline ? ` · ${c.anuncio.headline}` : ""}
                              </span>
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div ref={bottomRef} className="h-1" />
            {hasMore && (
              <div className="flex justify-center p-3">
                <button
                  type="button"
                  onClick={onLoadMore}
                  disabled={loadingMore}
                  data-testid="load-more"
                  className="kicker rounded-full border border-border-strong bg-background px-3 py-1 text-text-2 hover:bg-accent disabled:opacity-60"
                >
                  {loadingMore ? "Cargando…" : "Cargar más conversaciones"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
