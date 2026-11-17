"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { MessageSquareText, Settings2, Trophy, XCircle } from "lucide-react";
import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import { latestOnly } from "@/lib/inbox-state";
import { formatMoneyCents } from "@/lib/money";
import {
  applyBoardDelta,
  dropIndex,
  emptyColumns,
  findLead,
  mergeColumnPage,
  moveLocal,
  patchLead,
  replaceColumn,
  type Column,
  type Columns,
  type DeltaCard,
} from "@/lib/pipeline-state";
import type {
  BoardFiltersDto,
  BoardLeadDto,
  BoardStageDto,
  LossReason,
  PriorityValue,
  StageDto,
  StageTotalsDto,
} from "@/lib/types";
import { DEFAULT_CURRENCY } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ContactAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/components/inbox/helpers";
import { useEvents } from "@/components/use-events";
import { StageManager } from "./stage-manager";
import { LossReasonDialog } from "./loss-reason-dialog";
import { AmountDialog } from "./amount-dialog";
import { PriorityBadge } from "./priority-picker";
import { LeadDrawer } from "./lead-drawer";
import { PipelineFilters } from "./pipeline-filters";

export type BoardLead = BoardLeadDto;

/** Tarjetas por columna en cada página (la primera carga y cada «cargar más»). */
const PAGE = 25;
/** Espera tras teclear antes de buscar, y tras un evento antes de pedir el delta (una ráfaga = una petición). */
const SEARCH_DEBOUNCE_MS = 250;
const EVENT_DEBOUNCE_MS = 250;
/** Al recargar una columna se piden tantas tarjetas como había cargadas, hasta este tope. */
const RELOAD_CAP = 200;

/** Los filtros como query string (sin vacíos). */
function filtrosQs(f: BoardFiltersDto): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q?.trim()) p.set("q", f.q.trim());
  if (f.priority) p.set("priority", f.priority);
  if (f.tag) p.set("tag", f.tag);
  if (f.channel) p.set("channel", f.channel);
  return p;
}

type MoveTarget = { leadId: string; stageId: string; index: number | undefined };

export function PipelineClient({ channels = [] }: { channels?: readonly Channel[] }) {
  const [stages, setStages] = useState<StageDto[]>([]);
  const [columns, setColumnsState] = useState<Columns>({});
  const [currency, setCurrency] = useState<string>(DEFAULT_CURRENCY);
  const [filters, setFilters] = useState<BoardFiltersDto>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeLead, setActiveLead] = useState<BoardLead | null>(null);
  const [managing, setManaging] = useState(false);
  /** Arrastre hacia una etapa perdida, esperando el motivo. */
  const [pendingLoss, setPendingLoss] = useState<(MoveTarget & { name: string }) | null>(null);
  /** Tarjeta cuyo monto se está capturando. */
  const [editandoMonto, setEditandoMonto] = useState<BoardLead | null>(null);
  /**
   * Trato abierto en el cajón. Se guarda el ID y no el objeto: así el cajón
   * lee siempre del tablero y refleja al instante lo que se cambie desde
   * dentro, en vez de enseñar una copia que envejece.
   */
  const [abiertoId, setAbiertoId] = useState<string | null>(null);

  /* ---------- Refs: lo que los callbacks y los eventos leen sin re-suscribirse ---------- */
  const columnsRef = useRef<Columns>({});
  const filtersRef = useRef<BoardFiltersDto>({});
  const currencyRef = useRef<string>(DEFAULT_CURRENCY);
  const serverTimeRef = useRef<string | null>(null);
  /** Tarjetas que el operador está moviendo o guardando: un delta no las pisa. */
  const protectRef = useRef<Set<string>>(new Set());
  const loadingMoreRef = useRef<Set<string>>(new Set());
  const pendingStagesRef = useRef<Set<string>>(new Set());
  const dirtyRef = useRef(false);
  const eventTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Una respuesta lenta de una carga vieja nunca pisa a una nueva (misma garantía que la Bandeja). */
  const headGuard = useMemo(() => latestOnly(), []);
  const deltaGuard = useMemo(() => latestOnly(), []);

  const setColumns = useCallback((next: Columns) => {
    columnsRef.current = next;
    setColumnsState(next);
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  /* ---------- Cargas ---------- */

  const loadBoard = useCallback(
    async (f: BoardFiltersDto = filtersRef.current) => {
      deltaGuard.cancel();
      const req = headGuard.begin();
      const qs = filtrosQs(f);
      qs.set("limit", String(PAGE));
      const res = await fetch(`/api/pipeline/board?${qs}`, { signal: req.signal }).catch(() => null);
      if (!req.current()) return;
      if (!res?.ok) {
        setError("No se pudo cargar el tablero. Reintenta en un momento.");
        setLoaded(true);
        return;
      }
      const data = (await res.json()) as { currency?: string; serverTime: string; stages: BoardStageDto[] };
      if (!req.current()) return;
      setError(null);
      if (data.currency) {
        currencyRef.current = data.currency;
        setCurrency(data.currency);
      }
      setStages(
        data.stages.map((s) => ({ id: s.id, name: s.name, position: s.position, kind: s.kind, autoRole: s.autoRole }))
      );
      const next = emptyColumns(data.stages.map((s) => s.id));
      for (const s of data.stages) next[s.id] = { rows: s.leads, nextCursor: s.nextCursor, totals: s.totals };
      setColumns(next);
      serverTimeRef.current = data.serverTime;
      setLoaded(true);
    },
    [headGuard, deltaGuard, setColumns]
  );

  /** La siguiente página de UNA columna. Descarta la respuesta si los filtros cambiaron mientras tanto. */
  const loadMore = useCallback(
    async (stageId: string) => {
      const col = columnsRef.current[stageId];
      if (!col?.nextCursor || loadingMoreRef.current.has(stageId)) return;
      loadingMoreRef.current.add(stageId);
      const f = filtersRef.current;
      try {
        const qs = filtrosQs(f);
        qs.set("limit", String(PAGE));
        qs.set("cursor", col.nextCursor);
        const res = await fetch(`/api/pipeline/stages/${stageId}/leads?${qs}`).catch(() => null);
        if (!res?.ok || filtersRef.current !== f) return;
        const data = (await res.json()) as { leads: BoardLead[]; nextCursor: string | null };
        if (filtersRef.current !== f) return;
        const cur = columnsRef.current[stageId];
        if (!cur) return;
        setColumns({ ...columnsRef.current, [stageId]: mergeColumnPage(cur, data.leads, data.nextCursor) });
      } finally {
        loadingMoreRef.current.delete(stageId);
      }
    },
    [setColumns]
  );

  /** Vuelve a pedir lo cargado de unas columnas (el servidor las renumeró). Páginas de 50, hasta el tope. */
  const reloadColumns = useCallback(
    async (stageIds: string[]) => {
      const f = filtersRef.current;
      await Promise.all(
        stageIds.map(async (stageId) => {
          const col = columnsRef.current[stageId];
          if (!col) return;
          const want = Math.min(Math.max(col.rows.length, PAGE), RELOAD_CAP);
          const rows: BoardLead[] = [];
          let cursor: string | null = null;
          let nextCursor: string | null = null;
          while (rows.length < want) {
            const qs = filtrosQs(f);
            qs.set("limit", String(Math.min(50, want - rows.length)));
            if (cursor) qs.set("cursor", cursor);
            const res = await fetch(`/api/pipeline/stages/${stageId}/leads?${qs}`).catch(() => null);
            if (!res?.ok) return;
            const data = (await res.json()) as { leads: BoardLead[]; nextCursor: string | null };
            rows.push(...data.leads);
            nextCursor = data.nextCursor;
            cursor = data.nextCursor;
            if (!cursor) break;
          }
          if (filtersRef.current !== f) return;
          const cur = columnsRef.current[stageId];
          if (!cur) return;
          setColumns({ ...columnsRef.current, [stageId]: replaceColumn(cur, rows, nextCursor) });
        })
      );
    },
    [setColumns]
  );

  /** Lo que cambió desde la última respuesta, una sola petición para toda una ráfaga de eventos. */
  const loadDelta = useCallback(async () => {
    if (!serverTimeRef.current) {
      await loadBoard();
      return;
    }
    const req = deltaGuard.begin();
    const f = filtersRef.current;
    const qs = filtrosQs(f);
    qs.set("since", serverTimeRef.current);
    const res = await fetch(`/api/pipeline/board?${qs}`, { signal: req.signal }).catch(() => null);
    if (!res?.ok || !req.current() || filtersRef.current !== f) return;
    const data = (await res.json()) as {
      serverTime: string;
      truncated: boolean;
      changed: DeltaCard[];
      totals: Record<string, StageTotalsDto>;
      currency?: string;
    };
    if (!req.current() || filtersRef.current !== f) return;
    if (data.truncated) {
      await loadBoard();
      return;
    }
    setColumns(applyBoardDelta(columnsRef.current, data.changed, data.totals, { protect: protectRef.current }));
    serverTimeRef.current = data.serverTime;
  }, [deltaGuard, loadBoard, setColumns]);

  const flush = useCallback(async () => {
    if (document.visibilityState === "hidden") {
      dirtyRef.current = true; // con la pestaña oculta no se pide nada: al volver, un delta
      return;
    }
    const stageIds = [...pendingStagesRef.current];
    pendingStagesRef.current.clear();
    await loadDelta();
    if (stageIds.length > 0) await reloadColumns(stageIds);
  }, [loadDelta, reloadColumns]);

  const schedule = useCallback(
    (stageIds?: string[]) => {
      for (const id of stageIds ?? []) pendingStagesRef.current.add(id);
      if (eventTimer.current) clearTimeout(eventTimer.current);
      eventTimer.current = setTimeout(() => void flush(), EVENT_DEBOUNCE_MS);
    },
    [flush]
  );

  useEffect(() => {
    void loadBoard();
    const onVisible = () => {
      if (document.visibilityState === "visible" && dirtyRef.current) {
        dirtyRef.current = false;
        void flush();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (eventTimer.current) clearTimeout(eventTimer.current);
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [loadBoard, flush]);

  useEvents({
    onPipelineLead: () => schedule(),
    onPipelineReordered: (d) => schedule(d.stageIds),
    onReconnect: () => schedule(),
  });

  /* ---------- Filtros ---------- */

  const changeFilters = useCallback(
    (patch: Partial<BoardFiltersDto>) => {
      const next: BoardFiltersDto = { ...filtersRef.current, ...patch };
      if (!next.q?.trim()) delete next.q;
      filtersRef.current = next;
      setFilters(next);
      // Nada de lo que viaja con los filtros viejos vale ya.
      headGuard.cancel();
      deltaGuard.cancel();
      if (searchTimer.current) clearTimeout(searchTimer.current);
      const soloBusqueda = Object.keys(patch).length === 1 && "q" in patch;
      if (soloBusqueda) searchTimer.current = setTimeout(() => void loadBoard(next), SEARCH_DEBOUNCE_MS);
      else void loadBoard(next);
    },
    [headGuard, deltaGuard, loadBoard]
  );

  /* ---------- Acciones del operador ---------- */

  const abierto = abiertoId ? (findLead(columns, abiertoId)?.lead ?? null) : null;

  /**
   * Mueve (o reordena) una tarjeta: optimista, y el servidor renumera la columna. `index` undefined =
   * «arriba» (lo que hace el servidor cuando no se pide posición).
   */
  async function moverLead(target: MoveTarget, loss?: { reason: LossReason; note: string }) {
    const antes = columnsRef.current;
    const origen = findLead(antes, target.leadId)?.stageId;
    protectRef.current.add(target.leadId);
    setColumns(moveLocal(antes, target.leadId, target.stageId, target.index ?? 0, currencyRef.current));
    const res = await fetch(`/api/pipeline/leads/${target.leadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stageId: target.stageId,
        ...(target.index !== undefined ? { position: target.index } : {}),
        ...(loss ? { lossReason: loss.reason, ...(loss.note ? { lossNote: loss.note } : {}) } : {}),
      }),
    }).catch(() => null);
    protectRef.current.delete(target.leadId);
    if (!res?.ok) {
      // Se revierte con lo que de verdad hay en el servidor, no con una copia local que pudo envejecer.
      setError("No se pudo mover la tarjeta. Se restauró el tablero.");
      await reloadColumns([target.stageId, ...(origen && origen !== target.stageId ? [origen] : [])]);
    } else {
      setError(null);
    }
    void loadDelta();
  }

  async function guardarCampos(leadId: string, patch: { amountCents?: number | null; priority?: PriorityValue | null }) {
    protectRef.current.add(leadId);
    setColumns(patchLead(columnsRef.current, leadId, patch, currencyRef.current));
    await fetch(`/api/pipeline/leads/${leadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      // Sin `stageId`: esto NO mueve la tarjeta, solo escribe el campo.
      body: JSON.stringify(patch),
    }).catch(() => null);
    protectRef.current.delete(leadId);
    void loadDelta();
  }

  function onDragStart(event: DragStartEvent) {
    setActiveLead(findLead(columnsRef.current, String(event.active.id))?.lead ?? null);
  }

  async function onDragEnd(event: DragEndEvent) {
    setActiveLead(null);
    const leadId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || overId === leadId) return;
    const lead = findLead(columnsRef.current, leadId);
    const drop = dropIndex(columnsRef.current, leadId, overId);
    if (!lead || !drop) return;
    if (lead.stageId === drop.stageId && lead.index === drop.index) return;

    // Perder un trato exige motivo. Se pregunta ANTES de mover: si el dueño
    // cancela, la tarjeta ni siquiera parpadea fuera de su columna.
    const destino = stages.find((s) => s.id === drop.stageId);
    if (destino?.kind === "lost" && lead.stageId !== drop.stageId) {
      setPendingLoss({ leadId, stageId: drop.stageId, index: drop.index, name: lead.lead.contact.name });
      return;
    }
    await moverLead({ leadId, stageId: drop.stageId, index: drop.index });
  }

  /**
   * Cambiar de etapa desde el cajón. Entra por la MISMA puerta que el arrastre: perder un trato exige
   * motivo venga de donde venga, y duplicar esa regla aquí sería tener dos sitios donde olvidarla.
   */
  function moverDesdeCajon(leadId: string, stageId: string) {
    const lead = findLead(columnsRef.current, leadId);
    if (!lead || lead.stageId === stageId) return;
    const destino = stages.find((s) => s.id === stageId);
    if (destino?.kind === "lost") {
      setPendingLoss({ leadId, stageId, index: undefined, name: lead.lead.contact.name });
      return;
    }
    void moverLead({ leadId, stageId, index: undefined });
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-6 sm:py-4">
        <h2 className="text-[17px] font-bold tracking-tight">Pipeline</h2>
        <Button variant="outline" size="sm" onClick={() => setManaging(true)}>
          <Settings2 className="h-4 w-4" /> Gestionar etapas
        </Button>
      </header>

      <PipelineFilters filters={filters} channels={channels} onChange={changeFilters} />

      {error && (
        <p role="alert" className="border-b bg-danger-tint px-4 py-2 text-sm text-destructive sm:px-6">
          {error}
        </p>
      )}

      {/* El tablero se arrastra en horizontal; en el teléfono cada columna
          se detiene en su sitio (snap) para no quedar a medio camino. */}
      <div
        data-testid="pipeline-board"
        data-loaded={loaded ? "true" : "false"}
        className="flex-1 snap-x snap-mandatory overflow-x-auto p-3 sm:snap-none sm:p-4"
      >
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={(e) => void onDragEnd(e)}>
          <div className="flex h-full gap-3">
            {stages.map((stage) => (
              <StageColumn
                key={stage.id}
                stage={stage}
                column={columns[stage.id]}
                currency={currency}
                showChannel={channels.length > 1}
                onLoadMore={loadMore}
                onEditAmount={setEditandoMonto}
                onOpen={(l) => setAbiertoId(l.id)}
              />
            ))}
          </div>
          <DragOverlay>
            {activeLead ? <LeadCard lead={activeLead} currency={currency} overlay /> : null}
          </DragOverlay>
        </DndContext>
      </div>

      {managing && (
        <StageManager
          stages={stages}
          onClose={() => setManaging(false)}
          onChanged={() => void loadBoard()}
        />
      )}

      {/* Va ANTES que los diálogos: con el mismo z-index, el que se pinta
          después queda encima, y el motivo de pérdida debe tapar al cajón. */}
      {abierto && (
        <LeadDrawer
          lead={abierto}
          stages={stages}
          currency={currency}
          onClose={() => setAbiertoId(null)}
          onMoveStage={(stageId) => moverDesdeCajon(abierto.id, stageId)}
          onAmount={(cents) => void guardarCampos(abierto.id, { amountCents: cents })}
          onPriority={(p) => void guardarCampos(abierto.id, { priority: p })}
        />
      )}

      {editandoMonto && (
        <AmountDialog
          leadName={editandoMonto.contact.name}
          currency={editandoMonto.currency ?? currency}
          amountCents={editandoMonto.amountCents}
          priority={editandoMonto.priority}
          onPriorityChange={(p) => {
            setEditandoMonto({ ...editandoMonto, priority: p });
            void guardarCampos(editandoMonto.id, { priority: p });
          }}
          onCancel={() => setEditandoMonto(null)}
          onSave={(cents) => {
            const leadId = editandoMonto.id;
            setEditandoMonto(null);
            void guardarCampos(leadId, { amountCents: cents });
          }}
        />
      )}

      {pendingLoss && (
        <LossReasonDialog
          leadName={pendingLoss.name}
          onCancel={() => setPendingLoss(null)}
          onConfirm={(reason, note) => {
            const { leadId, stageId, index } = pendingLoss;
            setPendingLoss(null);
            void moverLead({ leadId, stageId, index }, { reason, note });
          }}
        />
      )}
    </div>
  );
}

function StageColumn({
  stage,
  column,
  currency,
  showChannel,
  onLoadMore,
  onEditAmount,
  onOpen,
}: {
  stage: StageDto;
  column: Column | undefined;
  currency: string;
  showChannel: boolean;
  onLoadMore: (stageId: string) => void;
  onEditAmount: (lead: BoardLead) => void;
  onOpen: (lead: BoardLead) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const rows = column?.rows ?? [];
  const totals = column?.totals;
  const hasMore = Boolean(column?.nextCursor);

  // El observador del final de la columna lee la función por una referencia estable: si se re-suscribiera
  // en cada render (el padre pasa una nueva), pediría páginas sin parar.
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = scrollRef.current;
    const el = sentinelRef.current;
    if (!hasMore || !root || !el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current(stage.id);
      },
      { root, rootMargin: "200px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
    // `rows.length` re-crea el observador: si tras cargar la página el final sigue a la vista, vuelve a disparar.
  }, [hasMore, rows.length, stage.id]);

  return (
    <div
      ref={setNodeRef}
      data-testid={`stage-${stage.id}`}
      data-stage-name={stage.name}
      className={cn(
        "flex h-full w-64 shrink-0 snap-start flex-col rounded-lg border border-border-strong bg-subtle transition-[box-shadow,border-color]",
        isOver && "border-brand ring-[3px] ring-brand-soft"
      )}
    >
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="flex items-center gap-1.5 text-[13.5px] font-bold tracking-tight">
          {stage.kind === "won" && <Trophy className="h-3.5 w-3.5 text-primary" />}
          {stage.kind === "lost" && <XCircle className="h-3.5 w-3.5 text-muted-foreground" />}
          {stage.name}
        </span>
        <span
          data-testid="stage-count"
          className="rounded-full border border-border-strong bg-background px-2 py-0.5 font-mono text-[11px] text-text-3"
        >
          {totals?.count ?? rows.length}
        </span>
      </div>
      <div ref={scrollRef} data-testid="stage-scroll" className="flex-1 space-y-2 overflow-y-auto p-2">
        {rows.map((lead) => (
          <DraggableLead
            key={lead.id}
            lead={lead}
            currency={currency}
            showChannel={showChannel}
            onEditAmount={onEditAmount}
            onOpen={onOpen}
          />
        ))}
        {hasMore && (
          <>
            <div ref={sentinelRef} aria-hidden className="h-px" />
            <button
              type="button"
              data-testid="stage-load-more"
              onClick={() => onLoadMore(stage.id)}
              className="w-full rounded-md border border-dashed border-border-strong py-1.5 text-xs text-text-3 hover:bg-accent"
            >
              Cargar más{totals ? ` (${Math.max(totals.count - rows.length, 0)})` : ""}
            </button>
          </>
        )}
      </div>
      <StageFooter totals={totals} currency={currency} />
    </div>
  );
}

/**
 * Cuánto dinero hay en esta etapa, y qué quedó fuera de la cuenta. Los números los da el servidor sobre
 * TODA la columna (con los filtros), no sobre las tarjetas que hay cargadas: una columna de 300 leads no
 * puede decir «Total» de las 25 que se ven.
 */
function StageFooter({ totals, currency }: { totals: StageTotalsDto | undefined; currency: string }) {
  const t = totals ?? { count: 0, sumCents: 0, withoutAmount: 0, otherCurrency: 0 };
  const conMonto = t.count - t.withoutAmount - t.otherCurrency;

  return (
    <div className="border-t px-3 py-2 text-[11px]">
      {conMonto === 0 ? (
        // Un "$0.00" aquí se lee como un error del sistema, no como un dato.
        <p className="text-muted-foreground">Sin montos capturados</p>
      ) : (
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-muted-foreground">
            Total{t.withoutAmount > 0 ? ` · ${t.withoutAmount} sin monto` : ""}
          </span>
          <span data-testid="stage-total" className="font-semibold tabular-nums">
            {formatMoneyCents(t.sumCents, currency)}
          </span>
        </div>
      )}
      {t.otherCurrency > 0 && (
        // Descartarlos en silencio haría que el total mintiera sin que nadie
        // pudiera notarlo.
        <p className="mt-0.5 text-warning-text">{t.otherCurrency} en otra moneda, fuera del total</p>
      )}
    </div>
  );
}

function DraggableLead({
  lead,
  currency,
  showChannel,
  onEditAmount,
  onOpen,
}: {
  lead: BoardLead;
  currency: string;
  showChannel: boolean;
  onEditAmount: (lead: BoardLead) => void;
  onOpen: (lead: BoardLead) => void;
}) {
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id: lead.id });
  // La tarjeta también es destino: soltar sobre ella da el índice exacto dentro de la columna.
  const { setNodeRef: setDropRef } = useDroppable({ id: lead.id });
  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      data-testid="lead-card"
      data-lead-id={lead.id}
      {...listeners}
      {...attributes}
      // Abrir y arrastrar conviven porque el sensor solo activa el arrastre a
      // los 6 px de movimiento: un clic quieto nunca llega a ser un arrastre.
      // Los controles de dentro de la tarjeta cortan la propagación, para que
      // tocar "+ monto" no abra además el cajón.
      onClick={() => onOpen(lead)}
      // dnd-kit ya deja el nodo con `role="button"` y `tabIndex`, pero un div
      // no dispara `click` con el teclado: sin esto, el cajón sería alcanzable
      // solo con el ratón.
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(lead);
        }
      }}
      aria-label={`Abrir el trato de ${lead.contact.name}`}
      className={cn(isDragging && "opacity-40")}
    >
      <LeadCard lead={lead} currency={currency} showChannel={showChannel} onEditAmount={onEditAmount} />
    </div>
  );
}

function LeadCard({
  lead,
  currency,
  overlay = false,
  showChannel = false,
  onEditAmount,
}: {
  lead: BoardLead;
  currency: string;
  overlay?: boolean;
  showChannel?: boolean;
  onEditAmount?: (lead: BoardLead) => void;
}) {
  return (
    <div
      className={cn(
        "cursor-grab rounded-md border border-border-strong bg-card p-3 shadow-sm transition-shadow hover:shadow-md",
        overlay && "rotate-2 shadow-pop"
      )}
    >
      <div className="flex items-center gap-2.5">
        <ContactAvatar name={lead.contact.name} seed={lead.contact.id} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p data-testid="lead-name" className="truncate text-sm font-semibold">
              {lead.contact.name}
            </p>
            {lead.priority && <PriorityBadge value={lead.priority} />}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {showChannel ? `${CHANNEL_LABEL[lead.channel]} · ` : ""}
            {lead.lastActivityAt ? `Actividad: ${formatTime(lead.lastActivityAt)}` : "Sin actividad"}
          </p>
        </div>
        {lead.conversationId && (
          <Link
            href={`/bandeja?contact=${lead.contact.id}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            aria-label="Abrir conversación"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <MessageSquareText className="h-4 w-4" />
          </Link>
        )}
      </div>
      {!overlay && onEditAmount && (
        <button
          // `stopPropagation` en pointerdown: sin esto, tocar el monto empieza
          // un arrastre y el diálogo nunca abre.
          onPointerDown={(e) => e.stopPropagation()}
          // También en `click`: sin esto, tocar el monto abriría además el
          // cajón, porque el evento sigue subiendo hasta la tarjeta.
          onClick={(e) => {
            e.stopPropagation();
            onEditAmount(lead);
          }}
          className={cn(
            "mt-1.5 w-full rounded px-1 py-0.5 text-right text-xs tabular-nums hover:bg-accent",
            lead.amountCents === null ? "text-text-3" : "font-semibold text-foreground"
          )}
        >
          {lead.amountCents === null
            ? "+ monto"
            : formatMoneyCents(lead.amountCents, lead.currency ?? currency)}
        </button>
      )}
      {overlay && lead.amountCents !== null && (
        <p className="mt-1.5 text-right text-xs font-semibold tabular-nums">
          {formatMoneyCents(lead.amountCents, lead.currency ?? currency)}
        </p>
      )}
    </div>
  );
}
