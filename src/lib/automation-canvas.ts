import { EDGE_HANDLES, waitReplyConfigSchema, type EdgeHandle } from "@/lib/automation";
import {
  TRIGGER_NODE_TYPE,
  handleLabel,
  type GraphPayload,
  type GraphViewport,
  type Pos,
} from "@/lib/automation-graph";
import { CREATABLE_TRIGGERS } from "@/lib/automation-dto";
import { STEP_TYPES, parseStepConfig, type FlowTriggerType, type StepType } from "@/lib/automation-schemas";

/**
 * Automatizaciones — la capa PURA del lienzo (sin React ni `@xyflow/react`): qué hay en la paleta, cómo se ve cada
 * tipo de bloque, la configuración con la que nace, y la conversión entre lo que guarda el servidor y lo que pinta
 * el lienzo. Separada de los componentes para poder probarla sin navegador.
 */

export const TRIGGER_NODE_ID = TRIGGER_NODE_TYPE;

/* ─── Datos de los nodos ─── */

export type TriggerData = { kind: "trigger"; triggerType: string; triggerConfig: Record<string, unknown> | null };
export type StepData = { kind: "step"; stepType: string; config: Record<string, unknown> };
/** Los problemas de validación de un nodo, para pintar la insignia. */
export type NodeIssues = { errors: string[]; warnings: string[] };
export type CanvasNodeData = (TriggerData | StepData) & { issues?: NodeIssues };

export type CanvasNodeLite = { id: string; type: string; position: Pos; data: CanvasNodeData };
export type CanvasEdgeLite = { id: string; source: string; target: string; sourceHandle?: string | null };

/** Cómo se dibuja cada tipo de paso: la clave de `nodeTypes` del lienzo. */
export type NodeKind = "trigger" | "message" | "wait" | "condition" | "waitReply" | "action";

export function nodeKindOf(type: string): NodeKind {
  switch (type) {
    case TRIGGER_NODE_TYPE:
      return "trigger";
    case "send_whatsapp":
      return "message";
    case "delay":
    case "wait_until":
      return "wait";
    case "condition":
      return "condition";
    case "wait_reply":
      return "waitReply";
    default:
      return "action"; // add_tag · remove_tag · set_stage
  }
}

/* ─── Salidas visibles de cada bloque ─── */

const SHORT_LABEL: Record<string, string> = {
  confirmed: "Confirma",
  declined: "No",
  reschedule: "Reagendar",
  other: "Otra cosa",
  timeout: "Sin resp.",
};

/** Las asas de salida que se pintan en cada tipo de bloque, con su rótulo corto. */
export function outputsOf(type: string): { id: EdgeHandle; label: string }[] {
  const h = (id: EdgeHandle, label = SHORT_LABEL[id] ?? handleLabel(id)) => ({ id, label });
  switch (type) {
    case "condition":
      return [h("true", "Sí"), h("false", "No")];
    case "wait_reply":
      return (["confirmed", "declined", "reschedule", "other", "timeout"] as const).map((x) => h(x));
    case "wait_until":
      return [h("default", "Siguiente"), h("late", "Si ya pasó")];
    default:
      return [h("default", "Siguiente")];
  }
}

/** El texto de una arista: solo las que salen de un asa que ramifica llevan rótulo. */
export function edgeLabelOf(handle: string | null | undefined): string | undefined {
  if (!handle || handle === "default") return undefined;
  return handleLabel(handle);
}

/* ─── Configuración con la que nace cada bloque ─── */

/**
 * La configuración inicial de un bloque recién soltado. Donde hay un valor razonable (esperar un día, «esperar
 * respuesta» con sus valores por defecto) ya es válida; donde falta algo que solo la persona sabe (qué etiqueta,
 * qué etapa, el texto del mensaje) queda vacía y la validación pide configurarlo.
 */
export function defaultConfigFor(stepType: string): Record<string, unknown> {
  switch (stepType) {
    case "delay":
      return { amount: 1, unit: "days" };
    case "wait_until":
      return { anchor: "booking.scheduledAt", offsetMinutes: -1440, lateAction: "skip_next" };
    case "wait_reply":
      return waitReplyConfigSchema.parse({});
    default:
      return {};
  }
}

/** Los ajustes iniciales de un disparador recién elegido (el de cumpleaños nace con su hora de siempre). */
export function defaultTriggerConfig(triggerType: string): Record<string, unknown> | null {
  return triggerType === "birthday" ? { hour: 10, daysOffset: 0 } : null;
}

/* ─── La paleta ─── */

export type PaletteCategory = "triggers" | "logic" | "actions";
export type PaletteItem = {
  /** Estable: sirve de llave y viaja en el arrastre. */
  id: string;
  category: PaletteCategory;
  label: string;
  hint: string;
  kind: "trigger" | "step";
  triggerType?: FlowTriggerType;
  stepType?: StepType;
  /** Solo tiene sentido en un flujo que empieza con una cita. */
  needsBooking?: boolean;
  /** Aún no existe en el motor: se muestra, pero no se puede soltar. */
  soon?: boolean;
};

export const PALETTE_CATEGORY_LABELS: Record<PaletteCategory, string> = {
  triggers: "Disparadores",
  logic: "Lógica y esperas",
  actions: "Acciones",
};

const TRIGGER_ITEMS: Record<(typeof CREATABLE_TRIGGERS)[number], { label: string; hint: string }> = {
  lead_created: { label: "Lead nuevo", hint: "Cuando entra un lead nuevo" },
  stage_changed: { label: "Cambio de etapa", hint: "Cuando un lead pasa a una etapa" },
  ad_referral: { label: "Anuncio", hint: "Cuando alguien llega de un anuncio" },
  booking_created: { label: "Cita agendada", hint: "Al agendar (o reprogramar) una cita" },
  booking_confirmed: { label: "Cita confirmada", hint: "Al confirmar la asistencia" },
  booking_no_show: { label: "No asistió", hint: "Cuando se marca «No asistió»" },
  birthday: { label: "Cumpleaños", hint: "El día del cumpleaños del cliente" },
};

/** El orden en que se ofrecen los disparadores. */
const TRIGGER_ORDER: (keyof typeof TRIGGER_ITEMS)[] = [
  "lead_created",
  "stage_changed",
  "ad_referral",
  "booking_created",
  "booking_confirmed",
  "booking_no_show",
  "birthday",
];

export const PALETTE: PaletteItem[] = [
  ...TRIGGER_ORDER.map<PaletteItem>((t) => ({
    id: `trigger:${t}`,
    category: "triggers",
    kind: "trigger",
    triggerType: t,
    ...TRIGGER_ITEMS[t],
  })),
  { id: "step:condition", category: "logic", kind: "step", stepType: "condition", label: "Condición (Sí / No)", hint: "Decide por qué camino sigue el flujo" },
  { id: "step:delay", category: "logic", kind: "step", stepType: "delay", label: "Esperar tiempo", hint: "Una pausa, con hora de envío opcional" },
  { id: "step:wait_until", category: "logic", kind: "step", stepType: "wait_until", label: "Esperar hasta la cita", hint: "Antes o después de la hora de la cita", needsBooking: true },
  { id: "step:wait_reply", category: "logic", kind: "step", stepType: "wait_reply", label: "Esperar respuesta", hint: "Pausa hasta que el cliente conteste" },
  { id: "step:send_whatsapp", category: "actions", kind: "step", stepType: "send_whatsapp", label: "Enviar WhatsApp", hint: "Texto libre o plantilla aprobada" },
  { id: "soon:media", category: "actions", kind: "step", label: "Enviar multimedia", hint: "Imagen o video", soon: true },
  { id: "step:add_tag", category: "actions", kind: "step", stepType: "add_tag", label: "Asignar etiqueta", hint: "Marca al contacto" },
  { id: "step:remove_tag", category: "actions", kind: "step", stepType: "remove_tag", label: "Quitar etiqueta", hint: "Desmarca al contacto" },
  { id: "step:set_stage", category: "actions", kind: "step", stepType: "set_stage", label: "Cambiar etapa", hint: "Mueve al lead en el pipeline" },
];

/** El tipo MIME propio con el que viaja un bloque al arrastrarlo de la paleta al lienzo. */
export const PALETTE_DRAG_TYPE = "application/x-vocero-node";

/* ─── Del servidor al lienzo y de vuelta ─── */

/** Lo que devuelve `GET/PUT /api/automations/[id]/graph`. */
export type ServerGraph = {
  flow: { triggerType: string; triggerConfig: Record<string, unknown> | null };
  nodes: { id: string; type: string; config: Record<string, unknown>; position: Pos }[];
  edges: { id: string; source: string; target: string; sourceHandle: string }[];
  entryStepId: string | null;
  editorMode: "simple" | "canvas";
  viewport: (Partial<GraphViewport> & { trigger?: Pos }) | null;
  updatedAt: number;
};

export const edgeId = (source: string, handle: string | null | undefined) => `${source}:${handle ?? "default"}`;

/** El grafo del servidor como nodos y aristas del lienzo (el disparador es un nodo más; su salida es la entrada). */
export function fromServerGraph(g: ServerGraph): { nodes: CanvasNodeLite[]; edges: CanvasEdgeLite[] } {
  const trigger: CanvasNodeLite = {
    id: TRIGGER_NODE_ID,
    type: nodeKindOf(TRIGGER_NODE_TYPE),
    position: g.viewport?.trigger ?? { x: 0, y: 0 },
    data: { kind: "trigger", triggerType: g.flow.triggerType, triggerConfig: g.flow.triggerConfig },
  };
  const steps = g.nodes.map<CanvasNodeLite>((n) => ({
    id: n.id,
    type: nodeKindOf(n.type),
    position: n.position,
    data: { kind: "step", stepType: n.type, config: n.config },
  }));
  const edges = g.edges.map<CanvasEdgeLite>((e) => ({ id: edgeId(e.source, e.sourceHandle), source: e.source, target: e.target, sourceHandle: e.sourceHandle }));
  if (g.entryStepId) edges.unshift({ id: edgeId(TRIGGER_NODE_ID, "default"), source: TRIGGER_NODE_ID, target: g.entryStepId, sourceHandle: "default" });
  return { nodes: [trigger, ...steps], edges };
}

/** El lienzo como el cuerpo del `PUT` (todavía sin parsear: la ruta lo parsea). */
export function toPayload(
  nodes: CanvasNodeLite[],
  edges: CanvasEdgeLite[],
  opts: { viewport?: GraphViewport | null; expectedUpdatedAt?: number | null } = {}
): GraphPayload {
  return {
    nodes: nodes.map((n) =>
      n.data.kind === "trigger"
        ? { id: n.id, type: TRIGGER_NODE_TYPE, config: { triggerType: n.data.triggerType, triggerConfig: n.data.triggerConfig }, position: n.position }
        : { id: n.id, type: n.data.stepType as never, config: n.data.config, position: n.position }
    ),
    edges: edges.map((e) => ({ source: e.source, target: e.target, sourceHandle: ((e.sourceHandle ?? "default") as EdgeHandle) })),
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
    ...(opts.expectedUpdatedAt != null ? { expectedUpdatedAt: opts.expectedUpdatedAt } : {}),
  } as GraphPayload;
}

/** Un id temporal para un nodo recién creado: el servidor lo cambia por uno real al guardar. */
export function newNodeId(): string {
  return `new_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/** ¿Es un id temporal (aún no guardado)? */
export const isNewNodeId = (id: string): boolean => id.startsWith("new_");

/** Todos los tipos de paso tienen forma en el lienzo (si se añade uno al motor, esto lo recuerda en las pruebas). */
export const KNOWN_STEP_TYPES: readonly string[] = STEP_TYPES;
export const KNOWN_HANDLES: readonly string[] = EDGE_HANDLES;

/* ─── Comparar configuraciones ─── */

/** JSON con las claves ordenadas: dos configuraciones iguales se comparan iguales aunque las claves lleguen en otro orden. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * ¿Es la misma configuración? El formulario entrega la configuración YA normalizada (con los valores por defecto
 * del esquema), así que la guardada se normaliza igual antes de comparar: abrir un bloque sin tocarlo no es un cambio.
 */
export function sameStepConfig(stepType: string, current: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const normalized = parseStepConfig(stepType as StepType, current);
  return stableStringify(normalized.ok ? normalized.value : current) === stableStringify(next);
}
