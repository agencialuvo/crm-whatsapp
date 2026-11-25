import { CASE_HANDLE_PREFIX, EDGE_HANDLES, caseHandle, switchCaseIds, waitReplyConfigSchema, type EdgeHandle } from "@/lib/automation";
import {
  TRIGGER_NODE_TYPE,
  handleLabel,
  handlesOf,
  type GraphPayload,
  type GraphViewport,
  type Pos,
} from "@/lib/automation-graph";
import { CREATABLE_TRIGGERS, stepLabel } from "@/lib/automation-dto";
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
export type NodeKind = "trigger" | "message" | "media" | "wait" | "condition" | "switch" | "waitReply" | "action";

export function nodeKindOf(type: string): NodeKind {
  switch (type) {
    case TRIGGER_NODE_TYPE:
      return "trigger";
    case "send_whatsapp":
      return "message";
    case "send_media":
      return "media";
    case "delay":
    case "wait_until":
      return "wait";
    case "condition":
      return "condition";
    case "switch":
      return "switch";
    case "wait_reply":
      return "waitReply";
    default:
      return "action"; // add_tag · remove_tag · set_stage · set_var · code_js · human_handoff
  }
}

/* ─── Metadatos de los bloques: UNA sola fuente (paleta, nodos y minimapa) ─── */

/** El rol visual de un bloque: decide el color de su encabezado y de su borde izquierdo. */
export type NodeTone = "trigger" | "condition" | "wait" | "message" | "crm";

/** Nombres de icono (de `lucide-react`); la correspondencia con el componente vive en la capa de React. */
export type IconName =
  | "Zap"
  | "UserPlus"
  | "ArrowRightLeft"
  | "Megaphone"
  | "CalendarPlus"
  | "CalendarCheck"
  | "CalendarCheck2"
  | "Receipt"
  | "CalendarX"
  | "Cake"
  | "Gift"
  | "Headset"
  | "Stamp"
  | "Play"
  | "GitBranch"
  | "Clock"
  | "CalendarClock"
  | "MessageSquareReply"
  | "MessageCircle"
  | "Image"
  | "Tag"
  | "Eraser"
  | "Flag"
  | "Variable"
  | "Braces"
  | "Split";

export type BlockMeta = { group: string; tone: NodeTone; icon: IconName };

/** Disparadores: subgrupo e icono (el tono siempre es `trigger`). */
export const TRIGGER_META: Record<(typeof CREATABLE_TRIGGERS)[number], BlockMeta> = {
  lead_created: { group: "Contactos y pipeline", tone: "trigger", icon: "UserPlus" },
  stage_changed: { group: "Contactos y pipeline", tone: "trigger", icon: "ArrowRightLeft" },
  ad_referral: { group: "Anuncios", tone: "trigger", icon: "Megaphone" },
  booking_created: { group: "Citas", tone: "trigger", icon: "CalendarPlus" },
  booking_confirmed: { group: "Citas", tone: "trigger", icon: "CalendarCheck" },
  booking_no_show: { group: "Citas", tone: "trigger", icon: "CalendarX" },
  booking_completed: { group: "Citas", tone: "trigger", icon: "CalendarCheck2" },
  sale_completed: { group: "Ventas", tone: "trigger", icon: "Receipt" },
  birthday: { group: "Fechas", tone: "trigger", icon: "Cake" },
  tag_added: { group: "Contactos y pipeline", tone: "trigger", icon: "Tag" },
  loyalty_reward_unlocked: { group: "Fidelización", tone: "trigger", icon: "Gift" },
  loyalty_stamp_earned: { group: "Fidelización", tone: "trigger", icon: "Stamp" },
  manual: { group: "Manual", tone: "trigger", icon: "Play" },
};

/** Pasos: subgrupo, rol visual e icono. */
export const STEP_META: Record<StepType, BlockMeta> = {
  condition: { group: "Decisiones", tone: "condition", icon: "GitBranch" },
  delay: { group: "Esperas", tone: "wait", icon: "Clock" },
  wait_until: { group: "Esperas", tone: "wait", icon: "CalendarClock" },
  wait_reply: { group: "Esperas", tone: "wait", icon: "MessageSquareReply" },
  send_whatsapp: { group: "Mensajes", tone: "message", icon: "MessageCircle" },
  send_media: { group: "Mensajes", tone: "message", icon: "Image" },
  add_tag: { group: "CRM", tone: "crm", icon: "Tag" },
  remove_tag: { group: "CRM", tone: "crm", icon: "Eraser" },
  set_stage: { group: "CRM", tone: "crm", icon: "Flag" },
  switch: { group: "Decisiones", tone: "condition", icon: "Split" },
  set_var: { group: "Datos", tone: "crm", icon: "Variable" },
  code_js: { group: "Datos", tone: "crm", icon: "Braces" },
  human_handoff: { group: "CRM", tone: "crm", icon: "Headset" },
};

const FALLBACK_META: BlockMeta = { group: "Otros", tone: "crm", icon: "Zap" };

/** Los metadatos de un nodo del lienzo (disparador o paso). Un tipo desconocido cae a un aspecto neutro. */
export function metaOfNode(data: CanvasNodeData): BlockMeta {
  if (data.kind === "trigger") return (TRIGGER_META as Record<string, BlockMeta>)[data.triggerType] ?? { ...FALLBACK_META, tone: "trigger", icon: "Zap" };
  return (STEP_META as Record<string, BlockMeta>)[data.stepType] ?? FALLBACK_META;
}

/** El tono de un tipo de nodo de React Flow (clave de `nodeTypes`), para el minimapa. */
export function toneOfNodeKind(kind: string): NodeTone {
  switch (kind) {
    case "trigger":
      return "trigger";
    case "condition":
    case "switch":
      return "condition";
    case "wait":
    case "waitReply":
      return "wait";
    case "message":
    case "media":
      return "message";
    default:
      return "crm";
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
export function outputsOf(type: string, config?: unknown): { id: EdgeHandle; label: string }[] {
  const h = (id: EdgeHandle, label = SHORT_LABEL[id] ?? handleLabel(id)) => ({ id, label });
  switch (type) {
    case "switch": {
      // Una salida por caso (con su nombre) y «Otro» al final: lo mismo que `handlesOf("switch", config)`.
      const labels = switchCaseLabels(config);
      return [...switchCaseIds(config).map((id, i) => h(caseHandle(id), labels.get(id) ?? `Caso ${i + 1}`)), h("default", "Otro")];
    }
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

/** Los nombres de los casos de un switch, por id. */
function switchCaseLabels(config: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const cases = (config as { cases?: unknown } | null | undefined)?.cases;
  if (!Array.isArray(cases)) return out;
  for (const k of cases) {
    const c = k as { id?: unknown; label?: unknown } | null;
    if (typeof c?.id === "string" && typeof c.label === "string" && c.label.trim()) out.set(c.id, c.label.trim());
  }
  return out;
}

/**
 * El texto de una arista: solo las que salen de un asa que ramifica llevan rótulo. Las de un switch llevan el nombre
 * de su caso (`sourceConfig` es la configuración del nodo de origen) y «Otro» la de `default`.
 */
export function edgeLabelOf(handle: string | null | undefined, sourceType?: string, sourceConfig?: unknown): string | undefined {
  if (!handle) return undefined;
  if (sourceType === "switch") {
    if (handle === "default") return "Otro";
    if (handle.startsWith(CASE_HANDLE_PREFIX)) return switchCaseLabels(sourceConfig).get(handle.slice(CASE_HANDLE_PREFIX.length)) ?? "Caso";
  }
  if (handle === "default") return undefined;
  return handleLabel(handle);
}

/** Un id corto para un caso nuevo de un switch, que no choca con los que ya hay. */
export function newCaseId(existing: readonly string[]): string {
  for (;;) {
    const id = `c${Math.random().toString(36).slice(2, 8)}`;
    if (!existing.includes(id)) return id;
  }
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
    case "switch":
      return { cases: [] };
    case "code_js":
      return { code: DEFAULT_CODE_JS };
    default:
      return {};
  }
}

/** El ejemplo con el que nace un bloque de código: lee `input` y deja una variable para los pasos siguientes. */
export const DEFAULT_CODE_JS = `// input: { now, contact: { name, tagIds, stageId }, context, vars }
// Devuelve { vars: { clave: valor } }: los pasos siguientes la leen con {{vars.clave}}.
const nombre = (input.contact.name || "").trim();
return { vars: { iniciales: nombre.slice(0, 2).toUpperCase() } };`;

/** Los ajustes iniciales de un disparador recién elegido (el de cumpleaños nace con su hora de siempre). */
export function defaultTriggerConfig(triggerType: string): Record<string, unknown> | null {
  return triggerType === "birthday" ? { hour: 10, daysOffset: 0 } : null;
}

/* ─── La paleta ─── */

/** Cuatro roles, en el orden en que se piensa un flujo: qué lo inicia, qué consulta y decide, qué espera, qué hace. */
export type PaletteCategory = "triggers" | "decide" | "wait" | "actions";
export type PaletteItem = {
  /** Estable: sirve de llave y viaja en el arrastre. */
  id: string;
  category: PaletteCategory;
  label: string;
  hint: string;
  /** Subgrupo visual dentro de la categoría («Esperas», «Citas»…). Los de un mismo grupo van seguidos. */
  group: string;
  tone: NodeTone;
  icon: IconName;
  kind: "trigger" | "step";
  triggerType?: FlowTriggerType;
  stepType?: StepType;
  /** Solo tiene sentido en un flujo que empieza con una cita. */
  needsBooking?: boolean;
  /** Aún no existe en el motor: se muestra, pero no se puede soltar. */
  soon?: boolean;
};

export const PALETTE_CATEGORY_LABELS: Record<PaletteCategory, string> = {
  triggers: "Inicia el flujo",
  decide: "Consulta y decide",
  wait: "Espera",
  actions: "Actúa",
};

/** Una frase por categoría, bajo su encabezado en la paleta: qué hace ese tipo de bloque. */
export const PALETTE_CATEGORY_HINTS: Record<PaletteCategory, string> = {
  triggers: "Lo que activa el flujo. Cada flujo tiene uno solo.",
  decide: "Mira al contacto o sus datos y elige el camino.",
  wait: "Pausa hasta un momento o una respuesta.",
  actions: "Hace algo: manda un mensaje, etiqueta, mueve, avisa.",
};

/**
 * El rol de un bloque en una palabra, para su tarjeta (lienzo y lista). Sale del tono —ya único por rol—: los mensajes y las
 * acciones de CRM son los dos «Actúa».
 */
export const ROLE_LABELS: Record<NodeTone, string> = {
  trigger: "Inicia",
  condition: "Decide",
  wait: "Espera",
  message: "Actúa",
  crm: "Actúa",
};

/** El tono de un tipo de paso (`crm` si no se conoce: un paso que el catálogo no tiene se ve neutro). */
export const toneOfStepType = (stepType: string): NodeTone => (STEP_META as Record<string, BlockMeta>)[stepType]?.tone ?? "crm";

const TRIGGER_ITEMS: Record<(typeof CREATABLE_TRIGGERS)[number], { label: string; hint: string }> = {
  lead_created: { label: "Lead nuevo", hint: "Cuando entra un lead nuevo" },
  stage_changed: { label: "Cambio de etapa", hint: "Cuando un lead pasa a una etapa" },
  ad_referral: { label: "Anuncio", hint: "Cuando alguien llega de un anuncio" },
  booking_created: { label: "Cita agendada", hint: "Al agendar (o reprogramar) una cita" },
  booking_confirmed: { label: "Cita confirmada", hint: "Al confirmar la asistencia" },
  booking_no_show: { label: "No asistió", hint: "Cuando se marca «No asistió»" },
  booking_completed: { label: "Cita realizada", hint: "Cuando la cita se marca como realizada o se cobra en Caja" },
  sale_completed: { label: "Venta cobrada", hint: "Cuando se cobra una venta en Caja" },
  birthday: { label: "Cumpleaños", hint: "El día del cumpleaños del cliente" },
  tag_added: { label: "Etiqueta asignada", hint: "Cuando se le asigna una etiqueta a un contacto" },
  loyalty_reward_unlocked: { label: "Premio de fidelidad", hint: "Cuando un cliente completa los sellos de un premio" },
  loyalty_stamp_earned: { label: "Sello ganado", hint: "Con cada sello que suma un cliente, llegue o no a un premio" },
  manual: { label: "Manual", hint: "Lo inicias tú, para un contacto" },
};

/**
 * El orden en que se ofrecen los disparadores: por subgrupo (cada uno junto) y, dentro de él, en el orden en que ocurren las
 * cosas: se agenda, se confirma, se realiza (o no asiste); se cobra; gana un sello, llega al premio.
 */
const TRIGGER_ORDER: (keyof typeof TRIGGER_ITEMS)[] = [
  "lead_created",
  "stage_changed",
  "tag_added",
  "ad_referral",
  "booking_created",
  "booking_confirmed",
  "booking_completed",
  "booking_no_show",
  "sale_completed",
  "loyalty_stamp_earned",
  "loyalty_reward_unlocked",
  "birthday",
  "manual",
];

const stepItem = (
  stepType: StepType,
  category: PaletteCategory,
  label: string,
  hint: string,
  extra: Partial<PaletteItem> = {}
): PaletteItem => ({ id: `step:${stepType}`, category, kind: "step", stepType, label, hint, ...STEP_META[stepType], ...extra });

export const PALETTE: PaletteItem[] = [
  ...TRIGGER_ORDER.map<PaletteItem>((t) => ({
    id: `trigger:${t}`,
    category: "triggers",
    kind: "trigger",
    triggerType: t,
    ...TRIGGER_ITEMS[t],
    ...TRIGGER_META[t],
  })),
  stepItem("condition", "decide", "Condición (Sí / No)", "Mira al contacto y decide: sigue por «Sí» o por «No»"),
  stepItem("switch", "decide", "Switch (varias salidas)", "Elige entre varios caminos según el contacto o una variable"),
  stepItem("delay", "wait", "Esperar tiempo", "Una pausa de segundos a días, con hora de envío opcional"),
  stepItem("wait_until", "wait", "Esperar hasta la cita", "Antes o después de la hora de la cita", { needsBooking: true }),
  stepItem("wait_reply", "wait", "Esperar respuesta", "Pausa hasta que el cliente conteste"),
  stepItem("send_whatsapp", "actions", "Enviar WhatsApp", "Texto libre o plantilla aprobada"),
  stepItem("send_media", "actions", "Enviar multimedia", "Imagen o video de tu biblioteca"),
  stepItem("add_tag", "actions", "Asignar etiqueta", "Marca al contacto"),
  stepItem("remove_tag", "actions", "Quitar etiqueta", "Desmarca al contacto"),
  stepItem("set_stage", "actions", "Cambiar etapa", "Mueve al lead en el pipeline"),
  stepItem("human_handoff", "actions", "Pasar a una persona", "Apaga la IA y avisa al equipo en la bandeja"),
  stepItem("set_var", "actions", "Establecer variable", "Guarda un dato para que lo lean los pasos siguientes"),
  stepItem("code_js", "actions", "Código JavaScript", "Transforma datos con un script aislado (sin red ni acceso a datos)"),
];

/**
 * ¿Un texto de búsqueda encaja con el bloque? Sin acentos ni mayúsculas, contra nombre, ayuda, subgrupo y —si se da— su rol
 * («espera», «decide», «actúa», «inicia»), así que escribir el rol enseña todos los bloques de ese rol.
 */
export function paletteMatches(item: Pick<PaletteItem, "label" | "hint" | "group"> & { category?: PaletteCategory }, query: string): boolean {
  const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = norm(query).trim();
  if (!q) return true;
  const hay = norm(`${item.label} ${item.hint} ${item.group} ${item.category ? PALETTE_CATEGORY_LABELS[item.category] : ""}`);
  return q.split(/\s+/).every((w) => hay.includes(w));
}

/** El orden en que el selector «Tipo de paso» del Modo Simple ofrece los roles: primero lo que más se usa (mensajes y acciones). */
const STEP_CHOICE_ORDER: PaletteCategory[] = ["actions", "wait", "decide"];

/**
 * Los tipos de paso agrupados por rol, para el desplegable del Modo Simple: `{ value, label, group }` con los de un mismo grupo
 * juntos. Sale de la paleta, así que un paso nuevo aparece aquí sin tocar nada más.
 */
export function stepTypeChoices(): { value: StepType; label: string; group: string }[] {
  const steps = PALETTE.filter((i) => i.kind === "step" && i.stepType && !i.soon);
  return STEP_CHOICE_ORDER.flatMap((cat) =>
    steps.filter((i) => i.category === cat).map((i) => ({ value: i.stepType!, label: stepLabel(i.stepType!), group: PALETTE_CATEGORY_LABELS[cat] }))
  );
}


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
  /** Lo que esta instancia permite (hoy: el bloque de código, tras una bandera de plataforma). */
  capabilities?: { codeJs: boolean };
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

/* ─── Aristas: eliminar e insertar un paso en medio (lógica pura, la usa el lienzo) ─── */

/** Lo mínimo de una arista del lienzo que estas funciones leen. */
export type EdgeRef = { id: string; source: string; target: string; sourceHandle?: string | null };

/**
 * ¿Se puede insertar este tipo de paso en medio de una conexión? Solo los que tienen UNA salida normal («Siguiente»):
 * en uno que ramifica (condición, esperar respuesta, esperar hasta la cita) habría que decidir cuál rama continúa.
 */
export function canInsertOnEdge(stepType: string, config?: unknown): boolean {
  // El switch tiene varias salidas por diseño: insertarlo en medio dejaría una sola conectada y sin casos.
  if (stepType === "switch") return false;
  const handles = handlesOf(stepType, config);
  return handles.length === 1 && handles[0] === "default";
}

/** Quita una conexión. Devuelve las mismas aristas si el id no existe. */
export function removeEdgeById<E extends EdgeRef>(edges: readonly E[], id: string): E[] {
  return edges.filter((e) => e.id !== id);
}

/**
 * Inserta un paso nuevo (`nodeId`) en medio de la conexión `id`: `origen —asa→ nuevo —default→ destino`. La del
 * origen conserva su asa (`Sí`, `Confirma`…); ambas llevan el id que genera `edgeId`. Devuelve `null` si la conexión
 * no existe o el tipo no se puede insertar. No toca el resto de las aristas.
 */
export function insertStepOnEdge(
  edges: readonly EdgeRef[],
  id: string,
  stepType: string,
  nodeId: string
): { edges: EdgeRef[]; nodeId: string } | null {
  const old = edges.find((e) => e.id === id);
  if (!old || !canInsertOnEdge(stepType)) return null;
  const handle = old.sourceHandle ?? "default";
  const rest = edges.filter((e) => e.id !== id);
  return {
    nodeId,
    edges: [
      ...rest,
      { id: edgeId(old.source, handle), source: old.source, target: nodeId, sourceHandle: handle },
      { id: edgeId(nodeId, "default"), source: nodeId, target: old.target, sourceHandle: "default" },
    ],
  };
}

/** El punto medio entre dos posiciones (donde cae un paso insertado), redondeado a entero como el resto. */
export function midpoint(a: Pos, b: Pos): Pos {
  return { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
}
