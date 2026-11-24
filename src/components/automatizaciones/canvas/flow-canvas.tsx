"use client";

import "@xyflow/react/dist/style.css";
import "./canvas.css";

import { useCallback, useEffect, useRef, useState } from "react";
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { AlertTriangle, ArrowLeft, ArrowLeftRight, History, LayoutGrid, Loader2, Pencil, Play, Save, Trash2, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { apiFetch, describeError } from "@/components/negocio/api";
import type { MediaOption, StageOption, TagOption, TemplateOption } from "@/lib/automation-dto";
import { PALETTE, PALETTE_DRAG_TYPE, toneOfNodeKind, type PaletteItem } from "@/lib/automation-canvas";
import { cn } from "@/lib/utils";
import { CanvasEdgeActionsContext, CanvasRefsContext } from "./canvas-context";
import { TONE_STYLES } from "./node-icons";
import { VoceroEdge } from "./vocero-edge";
import { InspectorPanel } from "./inspector/inspector-panel";
import { NodePalette } from "./node-palette";
import { ActionNode } from "./nodes/action-node";
import { ConditionNode } from "./nodes/condition-node";
import { SwitchNode } from "./nodes/switch-node";
import { MediaNode } from "./nodes/media-node";
import { MessageNode } from "./nodes/message-node";
import { TriggerNode } from "./nodes/trigger-node";
import { WaitNode } from "./nodes/wait-node";
import { WaitReplyNode } from "./nodes/wait-reply-node";
import { useFlowGraph, type FlowNode } from "./use-flow-graph";

/** Estable (fuera del componente): React Flow vuelve a montar todos los nodos si este objeto cambia. */
const NODE_TYPES = {
  trigger: TriggerNode,
  message: MessageNode,
  media: MediaNode,
  wait: WaitNode,
  condition: ConditionNode,
  switch: SwitchNode,
  waitReply: WaitReplyNode,
  action: ActionNode,
} as const;

/** Estable por la misma razón que `NODE_TYPES`: un objeto nuevo en cada render remontaría todas las conexiones. */
const EDGE_TYPES = { vocero: VoceroEdge } as const;

/** El encuadre deja libre el espacio de la barra flotante (arriba) para que ningún bloque quede debajo. */
const FIT_OPTIONS = { maxZoom: 1, padding: { top: "140px", right: "40px", bottom: "40px", left: "40px" } } as const;

type Banner = { kind: "error" | "stale" | "ok"; message: string } | null;

export type FlowCanvasProps = {
  flowId: string;
  /** El nombre del flujo, en la barra flotante. */
  flowName: string;
  /** Un aviso de la pantalla que lo envuelve (error al cambiar de modo o de encendido), a la vista sobre el lienzo. */
  notice?: string | null;
  onBack: () => void;
  onHistory: () => void;
  onEditFlow: () => void;
  /** Solo en flujos con disparador Manual: abre «Ejecutar para un contacto». */
  onRunManual?: () => void;
  onDeleteFlow: () => void;
  onToggleActive: (active: boolean) => void;
  toggleDisabled?: boolean;
  active: boolean;
  templates: TemplateOption[];
  tags: TagOption[];
  stages: StageOption[];
  /** Los archivos de la biblioteca de Medios (para los bloques «Enviar multimedia»). */
  media?: MediaOption[];
  onTagCreated: (tag: TagOption) => void;
  /** El flujo cambió en el servidor (se encendió desde aquí): quien lo muestra lo vuelve a pedir. */
  onFlowChanged: () => void;
  /** Quien muestra el lienzo se entera de si hay cambios sin guardar (para advertir al cambiar de modo). */
  onDirtyChange?: (dirty: boolean) => void;
  /** Pide volver al Modo Simple (el padre decide si se puede y confirma si hay cambios). */
  onBackToSimple: () => void;
};

/**
 * Automatizaciones — el Modo Visual: el lienzo de React Flow con paleta, nodos por tipo, panel de configuración,
 * validación en vivo y guardado atómico. Se carga solo al abrir este modo (sin SSR): ver `flow-canvas-loader.tsx`.
 */
export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasInner({ flowId, flowName, notice, onBack, onHistory, onEditFlow, onRunManual, onDeleteFlow, onToggleActive, toggleDisabled, active, templates, tags, stages, media = [], onTagCreated, onFlowChanged, onDirtyChange, onBackToSimple }: FlowCanvasProps) {
  const g = useFlowGraph(flowId);
  const { screenToFlowPosition, getViewport, setCenter } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    void g.load();
    // Solo al montar (o si cambia de flujo): el hook devuelve funciones nuevas en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId]);

  useEffect(() => {
    onDirtyChange?.(g.dirty);
  }, [g.dirty, onDirtyChange]);

  // Cerrar la pestaña con cambios sin guardar: el navegador avisa.
  useEffect(() => {
    if (!g.dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [g.dirty]);

  /** Coloca un bloque de la paleta: un disparador reemplaza el actual; un paso entra en `position`. */
  const place = useCallback(
    (item: PaletteItem, position: { x: number; y: number }) => {
      if (item.soon || (item.stepType === "code_js" && !g.codeJsEnabled)) return;
      if (item.kind === "trigger" && item.triggerType) g.setTriggerType(item.triggerType);
      else if (item.stepType) g.addStep(item.stepType, { x: Math.round(position.x), y: Math.round(position.y) });
    },
    [g]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const item = PALETTE.find((i) => i.id === e.dataTransfer.getData(PALETTE_DRAG_TYPE));
      if (!item) return;
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // El bloque se suelta con el cursor en su centro (la carcasa mide ~240).
      place(item, { x: p.x - 120, y: p.y - 30 });
    },
    [screenToFlowPosition, place]
  );

  /** Tocar un bloque de la paleta lo añade en el centro de lo que se ve (con teclado y en el móvil no hay arrastre). */
  const addAtCenter = useCallback(
    (item: PaletteItem) => {
      const box = wrapper.current?.getBoundingClientRect();
      const jitter = (Math.random() - 0.5) * 60;
      const p = box ? screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) : { x: 0, y: 0 };
      place(item, { x: p.x - 120 + jitter, y: p.y - 30 + jitter });
    },
    [screenToFlowPosition, place]
  );

  async function save(publish: boolean) {
    setBanner(null);
    const vp = getViewport();
    const res = await g.save({ x: vp.x, y: vp.y, zoom: vp.zoom });
    if (!res.ok) {
      setBanner({ kind: res.stale ? "stale" : "error", message: res.message });
      return;
    }
    if (publish) {
      setPublishing(true);
      try {
        await apiFetch(`/api/automations/${flowId}`, { method: "PATCH", json: { active: true } });
        onFlowChanged();
      } catch (err) {
        setBanner({ kind: "error", message: `Se guardó, pero no se pudo encender: ${describeError(err)}` });
        return;
      } finally {
        setPublishing(false);
      }
    }
    setBanner({
      kind: "ok",
      message: res.warnings.length ? `Guardado. Revisa ${res.warnings.length === 1 ? "el aviso" : `los ${res.warnings.length} avisos`}.` : "Guardado.",
    });
    if (res.warnings.length) setProblemsOpen(true);
  }

  /** Lleva la vista a un bloque con problemas y lo selecciona. */
  function focusNode(id: string) {
    g.select(id);
    const n = g.nodes.find((x) => x.id === id);
    if (n) void setCenter(n.position.x + 120, n.position.y + 40, { zoom: 1, duration: 300 });
  }

  const { errors, warnings } = g.validation;
  const selected = g.selected;
  const blocked = errors.length > 0;

  if (g.loading) {
    return (
      <div className="flex h-full items-center justify-center bg-subtle text-sm text-text-3" role="status">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Cargando el lienzo…
      </div>
    );
  }
  if (g.loadError) {
    return (
      <div className="m-4 rounded-lg border border-danger-soft bg-danger-tint p-4 text-sm text-danger-text" role="alert">
        <p>{g.loadError}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void g.load()}>
          Reintentar
        </Button>
      </div>
    );
  }

  const hasCamera = typeof g.viewport?.x === "number" && typeof g.viewport?.y === "number" && typeof g.viewport?.zoom === "number";

  return (
    <CanvasRefsContext.Provider value={{ templates, tags, stages, media }}>
      <CanvasEdgeActionsContext.Provider value={{ deleteEdge: g.deleteEdge, insertStepOnEdge: (id, type) => void g.insertStepOnEdge(id, type), triggerType: g.triggerType, codeJsEnabled: g.codeJsEnabled }}>
      {/* Pantalla completa: la paleta, el lienzo y el panel comparten la altura del área; nada desplaza la página. */}
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background lg:flex-row">
        <NodePalette triggerType={g.triggerType} onAdd={addAtCenter} codeJsEnabled={g.codeJsEnabled} />

        <div ref={wrapper} className="vocero-flow relative min-h-0 min-w-0 flex-1" onDrop={onDrop} onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = "move"))}>
          {/* El lienzo ocupa todo el recuadro; el paneo y el zoom son solo de React Flow (la rueda no mueve la página). */}
          <ReactFlow<FlowNode>
            className="absolute inset-0"
            nodes={g.nodes}
            edges={g.edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={g.onNodesChange}
            onEdgesChange={g.onEdgesChange}
            onConnect={g.onConnect}
            isValidConnection={g.isValidConnection}
            onPaneClick={() => g.select(null)}
            deleteKeyCode={["Backspace", "Delete"]}
            minZoom={0.2}
            maxZoom={1.5}
            fitViewOptions={FIT_OPTIONS}
            panOnDrag
            zoomOnScroll
            preventScrolling
            {...(hasCamera ? { defaultViewport: { x: g.viewport!.x!, y: g.viewport!.y!, zoom: g.viewport!.zoom! } } : { fitView: true })}
            aria-label="Lienzo del flujo"
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} />
            {/* Zoom y «ver todo» abajo a la izquierda del lienzo; el mapa abajo a la derecha: fuera del flujo del DOM. */}
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap pannable zoomable position="bottom-right" ariaLabel="Mapa del flujo" nodeColor={(n) => TONE_STYLES[toneOfNodeKind((n.type as string) ?? "")].mini} />
          </ReactFlow>

          {/* Barra flotante: no empuja nada, deja pasar el ratón al lienzo salvo sobre sus propios controles. */}
          <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-col gap-2">
            <div className="pointer-events-auto flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-strong bg-card/95 px-3 py-2 shadow-md backdrop-blur">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" onClick={onBack} aria-label="Volver a Automatizaciones" title="Volver a Automatizaciones">
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                </Button>
                <h3 className="max-w-[220px] truncate text-sm font-bold tracking-tight" title={flowName}>
                  {flowName}
                </h3>
                {g.dirty ? <Badge variant="warning">Cambios sin guardar</Badge> : <Badge variant="secondary">Todo guardado</Badge>}
                <button
                  type="button"
                  onClick={() => setProblemsOpen((o) => !o)}
                  aria-expanded={problemsOpen}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    errors.length > 0 ? "bg-danger-tint text-danger-text" : warnings.length > 0 ? "bg-warning-tint text-warning-text" : "bg-success-tint text-success-text"
                  )}
                >
                  <AlertTriangle className="h-3 w-3" aria-hidden />
                  {errors.length === 0 && warnings.length === 0
                    ? "Sin problemas"
                    : [errors.length ? `${errors.length} ${errors.length === 1 ? "error" : "errores"}` : null, warnings.length ? `${warnings.length} ${warnings.length === 1 ? "aviso" : "avisos"}` : null]
                        .filter(Boolean)
                        .join(" · ")}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs font-medium text-text-2">
                  <Switch checked={active} disabled={toggleDisabled} label={`${active ? "Apagar" : "Encender"} el flujo`} onCheckedChange={onToggleActive} />
                  {active ? "Activo" : "Pausado"}
                </label>
                <Button variant="outline" size="sm" onClick={onHistory} title="Estado del motor e historial de este flujo">
                  <History className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Historial</span><span className="sr-only sm:hidden">Historial</span>
                </Button>
                {onRunManual && (
                  <Button size="sm" onClick={onRunManual} disabled={!active || g.dirty} title={!active ? "Enciende el flujo para poder ejecutarlo" : g.dirty ? "Guarda los cambios antes de ejecutarlo" : "Ejecutarlo para un contacto"}>
                    <Play className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Ejecutar</span><span className="sr-only sm:hidden">Ejecutar</span>
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={onEditFlow} title="Nombre y ajustes del disparador">
                  <Pencil className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Editar</span><span className="sr-only sm:hidden">Editar</span>
                </Button>
                <Button variant="outline" size="sm" onClick={onDeleteFlow} title="Eliminar este flujo">
                  <Trash2 className="h-4 w-4 text-danger-text" aria-hidden /> <span className="hidden sm:inline">Eliminar</span><span className="sr-only sm:hidden">Eliminar</span>
                </Button>
                <Button variant="outline" size="sm" onClick={g.relayout} title="Reacomoda los bloques por niveles">
                  <LayoutGrid className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Ordenar</span><span className="sr-only sm:hidden">Ordenar</span>
                </Button>
                <Button variant="outline" size="sm" onClick={onBackToSimple} title="Volver a la lista de pasos">
                  <Undo2 className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Modo Simple</span><span className="sr-only sm:hidden">Modo Simple</span>
                </Button>
                <Button size="sm" variant={active ? "default" : "outline"} disabled={g.saving || blocked || !g.dirty} onClick={() => void save(false)} title={blocked ? "Corrige los errores para guardar" : undefined}>
                  {g.saving && !publishing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />} Guardar
                </Button>
                {!active && (
                  <Button size="sm" disabled={g.saving || publishing || blocked} onClick={() => void save(true)} title={blocked ? "Corrige los errores para publicar" : "Guarda y enciende el flujo"}>
                    {publishing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowLeftRight className="h-4 w-4" aria-hidden />} Guardar y encender
                  </Button>
                )}
              </div>
            </div>

            {notice && (
              <p role="alert" className="pointer-events-auto rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text shadow-md">
                {notice}
              </p>
            )}

            {banner && (
              <div
                role={banner.kind === "ok" ? "status" : "alert"}
                className={cn(
                  "pointer-events-auto flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm shadow-md",
                  banner.kind === "ok" ? "border-success-soft bg-success-tint text-success-text" : "border-danger-soft bg-danger-tint text-danger-text"
                )}
              >
                <span>{banner.message}</span>
                {banner.kind === "stale" && (
                  <Button variant="outline" size="sm" onClick={() => void g.load().then(() => setBanner(null))}>
                    Recargar (descarta lo no guardado)
                  </Button>
                )}
              </div>
            )}

            {problemsOpen && (errors.length > 0 || warnings.length > 0) && (
              <ul className="pointer-events-auto max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border-strong bg-card p-2 shadow-md" aria-label="Problemas del flujo">
                {[...errors.map((i) => ({ i, kind: "error" as const })), ...warnings.map((i) => ({ i, kind: "warning" as const }))].map(({ i, kind }, k) => (
                  <li key={`${i.code}-${k}`}>
                    <button
                      type="button"
                      disabled={!i.nodeIds?.[0]}
                      onClick={() => i.nodeIds?.[0] && focusNode(i.nodeIds[0])}
                      className={cn(
                        "w-full rounded px-2 py-1 text-left text-xs",
                        kind === "error" ? "bg-danger-tint text-danger-text" : "bg-warning-tint text-warning-text",
                        i.nodeIds?.[0] && "hover:opacity-80"
                      )}
                    >
                      <span className="font-semibold">{kind === "error" ? "Error: " : "Aviso: "}</span>
                      {i.message}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {selected && (
          <InspectorPanel
            nodeId={selected.id}
            data={selected.data}
            flowId={flowId}
            templates={templates}
            tags={tags}
            stages={stages}
            media={media}
            triggerType={g.triggerType}
            onTagCreated={onTagCreated}
            onStepConfig={g.updateStepConfig}
            onTriggerType={g.setTriggerType}
            onTriggerConfig={g.updateTriggerConfig}
            onDelete={g.deleteNode}
            onClose={() => g.select(null)}
          />
        )}
      </div>
      </CanvasEdgeActionsContext.Provider>
    </CanvasRefsContext.Provider>
  );
}
