"use client";

import { useCallback, useMemo, useState } from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import { apiErrorStatus, apiFetch, describeError } from "@/components/negocio/api";
import {
  TRIGGER_NODE_ID,
  defaultConfigFor,
  defaultTriggerConfig,
  edgeId,
  edgeLabelOf,
  fromServerGraph,
  isNewNodeId,
  newNodeId,
  nodeKindOf,
  sameStepConfig,
  toPayload,
  type CanvasNodeData,
  type CanvasNodeLite,
  type NodeIssues,
  type ServerGraph,
} from "@/lib/automation-canvas";
import {
  TRIGGER_NODE_TYPE,
  autoLayout,
  handlesOf,
  validateGraph,
  type GraphIssue,
  type GraphValidation,
  type GraphViewport,
  type Pos,
} from "@/lib/automation-graph";

/**
 * Automatizaciones — el estado del lienzo: nodos, aristas, selección, validación en vivo, «cambios sin guardar» y
 * el guardado atómico. La lógica que no es de React vive en `lib/automation-canvas.ts` y `lib/automation-graph.ts`
 * (la misma validación corre aquí en vivo y en el servidor antes de guardar).
 */

export type FlowNode = Node<CanvasNodeData, string>;
export type FlowEdge = Edge;

export type SaveResult =
  | { ok: true; warnings: GraphIssue[] }
  | { ok: false; status: number | null; message: string; stale: boolean };

/** Un nodo del servidor/DTO como nodo de React Flow. */
const toRf = (n: CanvasNodeLite): FlowNode => ({ id: n.id, type: n.type, position: n.position, data: n.data });

const rfEdge = (e: { id: string; source: string; target: string; sourceHandle?: string | null }): FlowEdge => {
  const label = edgeLabelOf(e.sourceHandle);
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? "default",
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
    ...(label ? { label, labelStyle: { fontSize: 11, fontWeight: 600 }, labelBgPadding: [6, 3] as [number, number], labelBgBorderRadius: 6 } : {}),
  };
};

/** Lo que `validateGraph` necesita de un nodo del lienzo. */
const forValidation = (n: FlowNode) =>
  n.data.kind === "trigger"
    ? { id: n.id, type: TRIGGER_NODE_TYPE as string, config: { triggerType: n.data.triggerType, triggerConfig: n.data.triggerConfig } as Record<string, unknown> }
    : { id: n.id, type: n.data.stepType, config: n.data.config };

const asLite = (n: FlowNode): CanvasNodeLite => ({ id: n.id, type: n.type ?? "", position: n.position, data: n.data });

export function useFlowGraph(flowId: string) {
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [meta, setMeta] = useState<{ updatedAt: number | null; viewport: ServerGraph["viewport"] }>({ updatedAt: null, viewport: null });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const apply = useCallback((g: ServerGraph) => {
    const rf = fromServerGraph(g);
    setNodes(rf.nodes.map(toRf));
    setEdges(rf.edges.map(rfEdge));
    setMeta({ updatedAt: g.updatedAt, viewport: g.viewport });
    setDirty(false);
  }, []);

  /** Carga (o recarga, descartando lo no guardado) el grafo del servidor. */
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      apply(await apiFetch<ServerGraph>(`/api/automations/${flowId}/graph`));
    } catch (err) {
      setLoadError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [flowId, apply]);

  /* ─── Validación en vivo (la misma del servidor) ─── */

  const validation = useMemo<GraphValidation>(
    () =>
      validateGraph({
        nodes: nodes.map(forValidation),
        edges: edges.map((e) => ({ source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? "default" })),
      }),
    [nodes, edges]
  );

  /** Los problemas de cada nodo, para pintar su insignia. */
  const issuesByNode = useMemo(() => {
    const map = new Map<string, NodeIssues>();
    const add = (issues: GraphIssue[], kind: "errors" | "warnings") => {
      for (const i of issues) {
        for (const id of i.nodeIds ?? []) {
          const cur = map.get(id) ?? { errors: [], warnings: [] };
          cur[kind].push(i.message);
          map.set(id, cur);
        }
      }
    };
    add(validation.errors, "errors");
    add(validation.warnings, "warnings");
    return map;
  }, [validation]);

  /** Los nodos con sus problemas dentro de `data` (los componentes solo leen `data`). */
  const shownNodes = useMemo(
    () => nodes.map((n) => (issuesByNode.has(n.id) ? { ...n, data: { ...n.data, issues: issuesByNode.get(n.id) } } : n)),
    [nodes, issuesByNode]
  );

  /* ─── Cambios del lienzo ─── */

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    // El disparador no se borra (hay exactamente uno): se puede reemplazar soltando otro desde la paleta.
    const allowed = changes.filter((c) => !(c.type === "remove" && c.id === TRIGGER_NODE_ID));
    setNodes((ns) => applyNodeChanges(allowed, ns));
    if (allowed.some((c) => c.type === "position" || c.type === "remove" || c.type === "add")) setDirty(true);
    // Un bloque que se borra se lleva sus conexiones.
    const removed = allowed.filter((c) => c.type === "remove").map((c) => c.id);
    if (removed.length) setEdges((es) => es.filter((e) => !removed.includes(e.source) && !removed.includes(e.target)));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => {
    setEdges((es) => applyEdgeChanges(changes, es));
    if (changes.some((c) => c.type === "remove" || c.type === "add")) setDirty(true);
  }, []);

  /** ¿Se puede trazar esta conexión? Una salida existente del tipo, a un bloque (no el disparador), sin cerrar un ciclo sin espera. */
  const isValidConnection = useCallback(
    (c: Connection | Edge): boolean => {
      const { source, target } = c;
      const handle = c.sourceHandle ?? "default";
      if (!source || !target || source === target || target === TRIGGER_NODE_ID) return false;
      const from = nodes.find((n) => n.id === source);
      const to = nodes.find((n) => n.id === target);
      if (!from || !to) return false;
      const fromType = from.data.kind === "trigger" ? TRIGGER_NODE_TYPE : from.data.stepType;
      if (!(handlesOf(fromType) as string[]).includes(handle)) return false;
      // Reemplaza la conexión que ya salía de esa asa; no debe crear un ciclo sin espera.
      const next = [...edges.filter((e) => !(e.source === source && (e.sourceHandle ?? "default") === handle)), { source, target, sourceHandle: handle }];
      const before = validation.errors.some((e) => e.code === "cycle_without_wait");
      const after = validateGraph({
        nodes: nodes.map(forValidation),
        edges: next.map((e) => ({ source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? "default" })),
      }).errors.some((e) => e.code === "cycle_without_wait");
      return before || !after;
    },
    [nodes, edges, validation]
  );

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    const handle = c.sourceHandle ?? "default";
    setEdges((es) => [
      // Una salida lleva a un solo destino: trazar otra conexión desde la misma asa reemplaza la anterior.
      ...es.filter((e) => !(e.source === c.source && (e.sourceHandle ?? "default") === handle)),
      rfEdge({ id: edgeId(c.source!, handle), source: c.source!, target: c.target!, sourceHandle: handle }),
    ]);
    setDirty(true);
  }, []);

  /* ─── Edición de bloques ─── */

  /** Suelta un bloque nuevo (de la paleta) y lo deja seleccionado. */
  const addStep = useCallback((stepType: string, position: Pos): string => {
    const id = newNodeId();
    setNodes((ns) => [
      ...ns.map((n) => (n.selected ? { ...n, selected: false } : n)),
      { id, type: nodeKindOf(stepType), position, selected: true, data: { kind: "step", stepType, config: defaultConfigFor(stepType) } },
    ]);
    setDirty(true);
    return id;
  }, []);

  /** Soltar un disparador REEMPLAZA el actual (hay exactamente uno): cambia su tipo y reinicia sus ajustes. */
  const setTriggerType = useCallback((triggerType: string) => {
    setNodes((ns) =>
      ns.map((n) =>
        n.id === TRIGGER_NODE_ID && n.data.kind === "trigger" && n.data.triggerType !== triggerType
          ? { ...n, selected: true, data: { kind: "trigger", triggerType, triggerConfig: defaultTriggerConfig(triggerType) } }
          : n.id === TRIGGER_NODE_ID
            ? { ...n, selected: true }
            : { ...n, selected: false }
      )
    );
    setDirty(true);
  }, []);

  /** La configuración válida que entrega el panel. No marca «sin guardar» si no cambió nada. */
  const updateStepConfig = useCallback((id: string, config: Record<string, unknown>) => {
    setNodes((ns) => {
      const cur = ns.find((n) => n.id === id);
      if (!cur || cur.data.kind !== "step" || sameStepConfig(cur.data.stepType, cur.data.config, config)) return ns;
      setDirty(true);
      return ns.map((n) => (n.id === id && n.data.kind === "step" ? { ...n, data: { ...n.data, config } } : n));
    });
  }, []);

  const updateTriggerConfig = useCallback((triggerConfig: Record<string, unknown> | null) => {
    setNodes((ns) => {
      const cur = ns.find((n) => n.id === TRIGGER_NODE_ID);
      if (!cur || cur.data.kind !== "trigger" || JSON.stringify(cur.data.triggerConfig) === JSON.stringify(triggerConfig)) return ns;
      setDirty(true);
      return ns.map((n) => (n.id === TRIGGER_NODE_ID && n.data.kind === "trigger" ? { ...n, data: { ...n.data, triggerConfig } } : n));
    });
  }, []);

  const deleteNode = useCallback((id: string) => {
    if (id === TRIGGER_NODE_ID) return;
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setDirty(true);
  }, []);

  const select = useCallback((id: string | null) => {
    setNodes((ns) => ns.map((n) => ((n.id === id) !== !!n.selected ? { ...n, selected: n.id === id } : n)));
  }, []);

  /** Re-acomoda todo por niveles (las posiciones son solo visuales). */
  const relayout = useCallback(() => {
    const entry = edges.find((e) => e.source === TRIGGER_NODE_ID)?.target ?? null;
    const steps = nodes.filter((n) => n.id !== TRIGGER_NODE_ID);
    const layout = autoLayout(
      steps.map((n) => n.id),
      edges.filter((e) => e.source !== TRIGGER_NODE_ID),
      entry
    );
    setNodes((ns) =>
      ns.map((n) => (n.id === TRIGGER_NODE_ID ? { ...n, position: layout.trigger } : layout.steps[n.id] ? { ...n, position: layout.steps[n.id]! } : n))
    );
    setDirty(true);
  }, [nodes, edges]);

  /* ─── Guardar ─── */

  const save = useCallback(
    async (viewport: GraphViewport | null): Promise<SaveResult> => {
      setSaving(true);
      try {
        const payload = toPayload(nodes.map(asLite), edges, { viewport, expectedUpdatedAt: meta.updatedAt });
        const saved = await apiFetch<ServerGraph & { warnings: GraphIssue[] }>(`/api/automations/${flowId}/graph`, { method: "PUT", json: payload });
        // El servidor devuelve los ids reales de los bloques nuevos: se conserva la selección buscando por tipo y posición.
        const wasSelected = nodes.find((n) => n.selected);
        apply(saved);
        if (wasSelected) {
          const stillThere = !isNewNodeId(wasSelected.id) ? wasSelected.id : saved.nodes.find((n) => n.position.x === wasSelected.position.x && n.position.y === wasSelected.position.y)?.id;
          if (stillThere) setNodes((ns) => ns.map((n) => (n.id === stillThere ? { ...n, selected: true } : n)));
        }
        return { ok: true, warnings: saved.warnings };
      } catch (err) {
        const status = apiErrorStatus(err);
        return { ok: false, status, message: describeError(err), stale: status === 409 && /guardó este flujo|stale/i.test(describeError(err)) };
      } finally {
        setSaving(false);
      }
    },
    [nodes, edges, meta.updatedAt, flowId, apply]
  );

  const selected = useMemo(() => nodes.find((n) => n.selected) ?? null, [nodes]);
  const triggerType = useMemo(() => {
    const t = nodes.find((n) => n.id === TRIGGER_NODE_ID);
    return t && t.data.kind === "trigger" ? t.data.triggerType : "";
  }, [nodes]);

  return {
    // datos
    nodes: shownNodes,
    edges,
    selected,
    triggerType,
    validation,
    viewport: meta.viewport,
    // estado
    loading,
    loadError,
    dirty,
    saving,
    // acciones
    load,
    onNodesChange,
    onEdgesChange,
    onConnect,
    isValidConnection,
    addStep,
    setTriggerType,
    updateStepConfig,
    updateTriggerConfig,
    deleteNode,
    select,
    relayout,
    save,
  };
}
