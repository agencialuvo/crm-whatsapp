"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight, Folder, Image as ImageIcon, Layers, Loader2, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  appendUnique,
  chooseLabel,
  configFor,
  coverageLabel,
  freshnessLabel,
  hasChildren,
  isLocalThumb,
  nextFocus,
  nodeKey,
  nodeMatchesConfig,
  nodeTitle,
  pathLabel,
  statusLabel,
  summarizeSelection,
  type AdOptionsRoot,
  type ChildrenState,
  type LooseAd,
  type PickerNode,
  type VisibleRow,
} from "@/lib/ad-picker";
import { adScopeOf, type AdReferralConfig } from "@/lib/automation";
import { describeError } from "@/components/negocio/api";
import { cn } from "@/lib/utils";
import { clearResolvedCache, fetchChildren, fetchMoreRoot, fetchResolved, fetchRoot, fetchSearch, syncCatalogNow } from "./ad-options-client";

/**
 * 047 — El selector del disparador «Llegó de un anuncio»: un árbol Campaña ▸ Conjunto ▸ Anuncio con buscador,
 * miniaturas del creativo (la copia local, nunca una URL de Meta), estado y el ID de Meta de cada anuncio.
 *
 *  - Elegir una CAMPAÑA o un CONJUNTO activa el flujo con cualquier anuncio de ahí; elegir un anuncio, solo con ese.
 *  - Se guarda siempre un ID (`sourceId` / `adsetId` / `campaignId`), nunca un nombre: los nombres que se ven salen
 *    del catálogo en cada lectura, así un renombre en Meta se refleja sin tocar el flujo.
 *  - Sin la Marketing API conectada se degrada a «un anuncio» (los que ya trajeron gente, o un ID escrito).
 *  - Teclado WAI-ARIA de árbol; buscador siempre visible (regla del sistema para los desplegables).
 */

type Row =
  | { kind: "any" }
  | { kind: "node"; row: VisibleRow }
  | { kind: "more"; parentKey: string | null; depth: number }
  | { kind: "loose"; ad: LooseAd }
  | { kind: "typed"; id: string };

const LOOSE_ID = /^\d{6,}$/;

function Thumb({ node, className }: { node: PickerNode; className?: string }) {
  const box = cn("flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-subtle text-text-3", className);
  if (node.level === "ad") {
    return node.thumbUrl && isLocalThumb(node.thumbUrl) ? (
      <span className={box}>
        {/* eslint-disable-next-line @next/next/no-img-element -- copia local del creativo, servida con sesión; no hay host que optimizar */}
        <img src={node.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
      </span>
    ) : (
      <span className={box} aria-hidden>
        <ImageIcon className="h-4 w-4" />
      </span>
    );
  }
  return (
    <span className={box} aria-hidden>
      {node.level === "campaign" ? <Folder className="h-4 w-4" /> : <Layers className="h-4 w-4" />}
    </span>
  );
}

export function AdTriggerPicker({
  value,
  onChange,
  id,
  disabled,
  invalid,
  ariaLabel = "Anuncio, conjunto o campaña que activa el flujo",
}: {
  value: AdReferralConfig;
  onChange: (cfg: AdReferralConfig) => void;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
}) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const [root, setRoot] = useState<AdOptionsRoot | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [rootMore, setRootMore] = useState<{ items: PickerNode[]; nextCursor: string | null }>({ items: [], nextCursor: null });
  const [children, setChildren] = useState<Record<string, ChildrenState | undefined>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [results, setResults] = useState<PickerNode[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [resolved, setResolved] = useState<PickerNode | null>(null);

  const cfgKey = JSON.stringify(value);
  const scope = adScopeOf(value);

  // El nombre VIVO de lo elegido (nunca se guarda: se lee del catálogo).
  useEffect(() => {
    let alive = true;
    if (scope.level === "any") {
      setResolved(null);
      return;
    }
    fetchResolved(value)
      .then((n) => alive && setResolved(n))
      .catch(() => alive && setResolved(null));
    return () => {
      alive = false;
    };
    // `cfgKey` resume `value`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgKey]);

  const loadRoot = useCallback(async () => {
    setRootError(null);
    try {
      const r = await fetchRoot();
      setRoot(r);
      setRootMore({ items: [], nextCursor: r.nextCursor });
      setChildren({});
      setExpanded(new Set());
    } catch (err) {
      setRootError(describeError(err));
    }
  }, []);

  // Abrir: se pide la raíz la primera vez; el buscador toma el foco.
  useEffect(() => {
    if (open && !root && !rootError) void loadRoot();
  }, [open, root, rootError, loadRoot]);

  // Posición de la lista junto al botón (se recalcula al desplazarse o redimensionar).
  useLayoutEffect(() => {
    if (!open) return;
    function measure() {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(Math.max(r.width, 380), window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const below = window.innerHeight - r.bottom;
      if (below < 380 && r.top > below) setPlace({ bottom: window.innerHeight - r.top + 4, left, width });
      else setPlace({ top: r.bottom + 4, left, width });
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    setQuery("");
    setResults(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Tocar fuera cierra.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
      close();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  const placed = place !== null;
  useEffect(() => {
    if (open && placed) searchRef.current?.focus();
  }, [open, placed]);

  // Búsqueda en el servidor (con espera corta y cancelación de la anterior).
  const text = query.trim();
  const searchMode = text.length >= 2 && !!root?.meta.hasCatalog;
  useEffect(() => {
    if (!searchMode) {
      setResults(null);
      setSearching(false);
      return;
    }
    const ctl = new AbortController();
    setSearching(true);
    const t = setTimeout(() => {
      fetchSearch(text, ctl.signal)
        .then((r) => setResults(r.items))
        .catch(() => undefined)
        .finally(() => !ctl.signal.aborted && setSearching(false));
    }, 220);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [text, searchMode]);

  async function toggle(node: PickerNode) {
    if (!hasChildren(node)) return;
    const key = nodeKey(node);
    const isOpen = expanded.has(key);
    setExpanded((cur) => {
      const next = new Set(cur);
      if (isOpen) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!isOpen && !children[key]) await loadChildren(node, null);
  }

  async function loadChildren(node: PickerNode, cursor: string | null) {
    const key = nodeKey(node);
    setChildren((c) => ({ ...c, [key]: { items: c[key]?.items ?? [], nextCursor: c[key]?.nextCursor ?? null, loading: true, error: false } }));
    try {
      const page = await fetchChildren(node, cursor);
      setChildren((c) => ({ ...c, [key]: { items: appendUnique(c[key]?.items ?? [], page.items), nextCursor: page.nextCursor, loading: false, error: false } }));
    } catch {
      setChildren((c) => ({ ...c, [key]: { items: c[key]?.items ?? [], nextCursor: c[key]?.nextCursor ?? null, loading: false, error: true } }));
    }
  }

  async function loadMoreRoot() {
    if (!rootMore.nextCursor) return;
    try {
      const page = await fetchMoreRoot(rootMore.nextCursor);
      setRootMore((m) => ({ items: appendUnique(m.items, page.items), nextCursor: page.nextCursor }));
    } catch {
      /* se puede reintentar con la misma fila */
    }
  }

  async function sync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      await syncCatalogNow();
      clearResolvedCache();
      await loadRoot();
      setResolved(await fetchResolved(value, true).catch(() => null));
      setSyncMsg("Catálogo actualizado desde Meta.");
    } catch (err) {
      setSyncMsg(describeError(err));
    } finally {
      setSyncing(false);
    }
  }

  function choose(cfg: AdReferralConfig, node: PickerNode | null) {
    setResolved(node);
    onChange(cfg);
    close(true);
  }

  // Las filas que se ven, en orden, con su acción.
  const rootItems = useMemo(() => (root ? appendUnique(root.items, rootMore.items) : []), [root, rootMore.items]);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [{ kind: "any" }];
    if (!root) return out;
    if (!root.meta.hasCatalog) {
      const q = text.toLowerCase();
      for (const ad of root.loose) {
        if (!q || (ad.headline ?? "").toLowerCase().includes(q) || ad.adId.includes(q)) out.push({ kind: "loose", ad });
      }
      if (LOOSE_ID.test(text) && !root.loose.some((a) => a.adId === text)) out.push({ kind: "typed", id: text });
      return out;
    }
    if (searchMode) {
      for (const node of results ?? []) {
        out.push({ kind: "node", row: { key: nodeKey(node), node, depth: 0, parentKey: null, expandable: false, expanded: false } });
      }
      return out;
    }
    // «Cargar más» al final de cada lista abierta: se intercala tras el último hijo de cada nivel.
    const withMore: Row[] = [out[0]!];
    const pushMore = (parentKey: string | null, depth: number, st: ChildrenState | { nextCursor: string | null; loading?: boolean; error?: boolean } | undefined) => {
      if (st && (st.nextCursor || st.error)) withMore.push({ kind: "more", parentKey, depth });
    };
    const emitLevel = (nodes: readonly PickerNode[], depth: 0 | 1 | 2, parentKey: string | null, st: ChildrenState | { nextCursor: string | null } | undefined) => {
      for (const node of nodes) {
        const key = nodeKey(node);
        const isOpen = hasChildren(node) && expanded.has(key);
        withMore.push({ kind: "node", row: { key, node, depth, parentKey, expandable: hasChildren(node), expanded: isOpen } });
        if (isOpen) emitLevel(children[key]?.items ?? [], (depth + 1) as 1 | 2, key, children[key]);
      }
      pushMore(parentKey, depth, st);
    };
    emitLevel(rootItems, 0, null, { nextCursor: rootMore.nextCursor });
    return withMore;
  }, [root, rootItems, rootMore.nextCursor, children, expanded, searchMode, results, text]);

  // La fila activa siempre a la vista.
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, listId]);
  useEffect(() => setActive(0), [text]);

  function activate(i: number) {
    const r = rows[i];
    if (!r) return;
    if (r.kind === "any") choose({}, null);
    else if (r.kind === "node") choose(configFor(r.row.node), r.row.node);
    else if (r.kind === "loose") choose({ sourceId: r.ad.adId }, null);
    else if (r.kind === "typed") choose({ sourceId: r.id }, null);
    else if (r.kind === "more") {
      if (r.parentKey === null) void loadMoreRoot();
      else {
        const parent = findNode(r.parentKey);
        if (parent) void loadChildren(parent, children[r.parentKey]?.nextCursor ?? null);
      }
    }
  }

  function findNode(key: string): PickerNode | null {
    for (const r of rows) if (r.kind === "node" && r.row.key === key) return r.row.node;
    return null;
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const key = e.key;
    if (key === "Escape") {
      e.stopPropagation();
      close(true);
      return;
    }
    if (key === "Tab") {
      close();
      return;
    }
    const cur = rows[active];
    // ← → solo valen sobre un nodo del árbol; en el cuadro de texto se queda el cursor.
    if ((key === "ArrowRight" || key === "ArrowLeft") && cur?.kind === "node" && !searchMode && (text === "" || e.altKey)) {
      const nodeRows = rows.filter((r): r is Extract<Row, { kind: "node" }> => r.kind === "node").map((r) => r.row);
      const idx = nodeRows.findIndex((r) => r.key === cur.row.key);
      const out = nextFocus(nodeRows, idx, key);
      e.preventDefault();
      if (out.action === "toggle") void toggle(cur.row.node);
      else {
        const target = nodeRows[out.index];
        const ni = rows.findIndex((r) => r.kind === "node" && r.row.key === target?.key);
        if (ni >= 0) setActive(ni);
      }
      return;
    }
    if (key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (key === "Home" && (e.ctrlKey || text === "")) {
      e.preventDefault();
      setActive(0);
    } else if (key === "End" && (e.ctrlKey || text === "")) {
      e.preventDefault();
      setActive(rows.length - 1);
    } else if (key === "Enter") {
      e.preventDefault();
      activate(active);
    }
  }

  const summary = summarizeSelection(value, resolved);
  const sel = (node: PickerNode) => nodeMatchesConfig(node, value);
  const fresh = freshnessLabel(root?.meta.syncedAt ?? null);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="tree"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        data-testid="ad-picker-trigger"
        className={cn(
          "flex min-h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 py-1.5 text-left text-sm shadow-sm",
          "focus-visible:border-brand focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft",
          "disabled:cursor-not-allowed disabled:opacity-50",
          invalid ? "border-danger" : "border-input"
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {resolved && scope.level !== "any" ? <Thumb node={resolved} /> : null}
          <span className="min-w-0">
            <span className={cn("block truncate", scope.level === "any" && "text-text-3")} data-testid="ad-picker-title">
              {summary.title}
            </span>
            {scope.level !== "any" && (
              <span className={cn("block truncate text-xs", summary.orphan ? "text-warning-text" : "text-text-3")} data-testid="ad-picker-subtitle">
                {summary.subtitle}
              </span>
            )}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
      </button>

      {open &&
        place &&
        createPortal(
          <div
            ref={popoverRef}
            style={{ position: "fixed", top: place.top, bottom: place.bottom, left: place.left, width: place.width }}
            className="z-[70] overflow-hidden rounded-md border bg-popover shadow-pop"
            onKeyDown={onKeyDown}
            data-testid="ad-picker-popover"
          >
            <div className="relative border-b">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={root && !root.meta.hasCatalog ? "Buscar anuncio o pegar un ID…" : "Buscar campaña, conjunto o anuncio…"}
                aria-label="Buscar campaña, conjunto o anuncio"
                aria-controls={listId}
                autoComplete="off"
                className="h-10 w-full bg-transparent pl-9 pr-9 text-sm text-foreground focus:outline-none"
              />
              {searching && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-text-3" aria-hidden />}
            </div>

            <ul id={listId} role="tree" aria-label="Campañas, conjuntos y anuncios" className="max-h-80 overflow-y-auto py-1" data-testid="ad-picker-tree">
              {rootError ? (
                <li className="space-y-2 px-3 py-3 text-sm text-danger-text" role="presentation">
                  <p>{rootError}</p>
                  <button type="button" className="underline" onMouseDown={(e) => { e.preventDefault(); void loadRoot(); }}>
                    Reintentar
                  </button>
                </li>
              ) : !root ? (
                <li className="flex items-center gap-2 px-3 py-3 text-sm text-text-3" role="presentation">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Cargando…
                </li>
              ) : (
                rows.map((r, i) => {
                  const common = { id: `${listId}-${i}`, onMouseEnter: () => setActive(i) };
                  if (r.kind === "any") {
                    return (
                      <li key="any" role="treeitem" aria-selected={scope.level === "any"} {...common}
                        onMouseDown={(e) => { e.preventDefault(); activate(i); }}
                        className={cn("flex cursor-pointer items-center gap-2 px-3 py-2 text-sm", i === active && "bg-accent")} data-testid="ad-option-any">
                        <Check className={cn("h-3.5 w-3.5 shrink-0", scope.level === "any" ? "opacity-100" : "opacity-0")} aria-hidden />
                        <span>Cualquier anuncio</span>
                      </li>
                    );
                  }
                  if (r.kind === "more") {
                    const st = r.parentKey ? children[r.parentKey] : undefined;
                    return (
                      <li key={`more-${r.parentKey ?? "root"}`} role="treeitem" aria-selected={false} {...common}
                        onMouseDown={(e) => { e.preventDefault(); activate(i); }}
                        style={{ paddingLeft: 12 + (r.depth + 1) * 18 }}
                        className={cn("cursor-pointer py-1.5 pr-3 text-xs text-brand", i === active && "bg-accent")}>
                        {st?.error ? "No se pudo cargar. Reintentar" : st?.loading ? "Cargando…" : "Cargar más"}
                      </li>
                    );
                  }
                  if (r.kind === "typed") {
                    return (
                      <li key={`typed-${r.id}`} role="treeitem" aria-selected={false} {...common}
                        onMouseDown={(e) => { e.preventDefault(); activate(i); }}
                        className={cn("cursor-pointer px-3 py-2 text-sm", i === active && "bg-accent")}>
                        Usar el anuncio con ID <strong>{r.id}</strong>
                      </li>
                    );
                  }
                  if (r.kind === "loose") {
                    const on = scope.level === "ad" && scope.id === r.ad.adId;
                    return (
                      <li key={`loose-${r.ad.adId}`} role="treeitem" aria-selected={on} {...common}
                        onMouseDown={(e) => { e.preventDefault(); activate(i); }}
                        className={cn("flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm", i === active && "bg-accent")}>
                        <Check className={cn("h-3.5 w-3.5 shrink-0", on ? "opacity-100" : "opacity-0")} aria-hidden />
                        <span className="min-w-0">
                          <span className="block truncate">{r.ad.headline || `Anuncio ${r.ad.adId}`}</span>
                          <span className="block truncate text-xs text-text-3">ID {r.ad.adId}</span>
                        </span>
                      </li>
                    );
                  }
                  const { row } = r;
                  const n = row.node;
                  const st = statusLabel(n.level === "ad" ? n.status : n.active ? "ACTIVE" : "PAUSED");
                  const path = searchMode ? pathLabel(n) : "";
                  return (
                    <li key={row.key} role="none">
                      <div
                        id={`${listId}-${i}`}
                        role="treeitem"
                        aria-level={row.depth + 1}
                        aria-expanded={row.expandable ? row.expanded : undefined}
                        aria-selected={sel(n)}
                        onMouseEnter={() => setActive(i)}
                        onMouseDown={(e) => { e.preventDefault(); activate(i); }}
                        style={{ paddingLeft: 8 + row.depth * 18 }}
                        className={cn("flex cursor-pointer items-center gap-2 py-1.5 pr-3 text-sm", i === active && "bg-accent")}
                        data-testid={`ad-option-${n.level}`}
                        data-id={n.id}
                      >
                        {row.expandable && !searchMode ? (
                          <button
                            type="button"
                            tabIndex={-1}
                            aria-label={row.expanded ? "Plegar" : "Desplegar"}
                            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); void toggle(n); }}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-3 hover:bg-subtle"
                          >
                            {children[row.key]?.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : row.expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                          </button>
                        ) : (
                          <span className="w-6 shrink-0" aria-hidden />
                        )}
                        <Thumb node={n} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-medium">{nodeTitle(n)}</span>
                            {sel(n) && <Check className="h-3.5 w-3.5 shrink-0 text-brand" aria-label="Elegido" />}
                          </span>
                          <span className="block truncate text-xs text-text-3">
                            {n.level === "ad" ? [path || [n.adsetName, n.campaignName].filter(Boolean).join(" · "), `ID ${n.id}`].filter(Boolean).join(" · ") : [chooseLabel(n), path].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        {st && <Badge variant={st.active ? "success" : "secondary"}>{st.label}</Badge>}
                        {n.level !== "ad" && !st && <span className="shrink-0 text-xs text-text-3">{coverageLabel(n)}</span>}
                      </div>
                      {row.expanded && !children[row.key]?.loading && (children[row.key]?.items.length ?? 0) === 0 && !children[row.key]?.error && (
                        <p style={{ paddingLeft: 40 + row.depth * 18 }} className="py-1 text-xs text-text-3">Sin elementos</p>
                      )}
                    </li>
                  );
                })
              )}
              {root && rows.length === 1 && root.meta.hasCatalog && searchMode && !searching && (
                <li className="px-3 py-2 text-sm text-text-3" role="presentation">Sin resultados para «{text}»</li>
              )}
            </ul>

            <div className="space-y-1 border-t bg-subtle px-3 py-2 text-xs text-text-3">
              {root && !root.meta.hasCatalog ? (
                <p data-testid="ad-picker-degraded">
                  {root.meta.connector
                    ? "Aún no hay anuncios sincronizados: sincroniza desde Meta para elegir campañas y conjuntos."
                    : "Para elegir una campaña o un conjunto conecta tu cuenta publicitaria en Ajustes → Anuncios. Mientras tanto puedes elegir un anuncio que ya trajo gente, o pegar su ID."}
                </p>
              ) : (
                <p>Se activa con la campaña, el conjunto o el anuncio que elijas. Los nombres se leen de Meta; guardamos solo sus IDs.</p>
              )}
              {root?.meta.connector && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span data-testid="ad-picker-fresh">{fresh ? `Catálogo actualizado ${fresh}` : "Sin sincronizar todavía"}</span>
                  <button
                    type="button"
                    disabled={syncing}
                    onMouseDown={(e) => { e.preventDefault(); void sync(); }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-accent disabled:opacity-50"
                    data-testid="ad-picker-sync"
                  >
                    <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} aria-hidden /> Actualizar desde Meta
                  </button>
                </div>
              )}
              {syncMsg && <p role="status">{syncMsg}</p>}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
