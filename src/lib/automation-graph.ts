import { z } from "zod";
import { CODE_JS_MAX_PER_FLOW, caseHandle, compileLinearEdges, isEdgeHandle, switchCaseIds, type EdgeHandle } from "@/lib/automation";
import { STEP_GAP } from "@/lib/automation-dto";
import {
  FLOW_TRIGGER_TYPES,
  MAX_STEPS_PER_FLOW,
  STEP_TYPES,
  parseStepConfig,
  parseTriggerConfigFor,
  type FlowTriggerType,
  type StepType,
} from "@/lib/automation-schemas";

/**
 * Automatizaciones — reglas PURAS del lienzo (sin base de datos ni React), compartidas por el cliente (validación
 * en vivo) y el servidor (validación antes de guardar): el contrato del `PUT /graph`, la validación de topología,
 * la conversión a la lista del Modo Simple y el auto-orden.
 *
 * El nodo `trigger` es VIRTUAL: el disparador del flujo es `trigger_type` + `trigger_config`, no un paso; en el
 * lienzo es un nodo cuya única salida marca el paso de entrada (spec 036, D3).
 */

export const TRIGGER_NODE_TYPE = "trigger" as const;
export const NODE_TYPES = [TRIGGER_NODE_TYPE, ...STEP_TYPES] as const;
export type GraphNodeType = (typeof NODE_TYPES)[number];

const MAX_COORD = 100_000;
/** Redondea a entero (las posiciones son `integer` en la base) y acota al rango del contrato de `automation_step`. */
const coord = z
  .number()
  .finite()
  .transform((n) => Math.round(n))
  .pipe(z.number().int().min(-MAX_COORD).max(MAX_COORD));

const nodeId = z.string().trim().min(1).max(64);

export const graphNodeSchema = z.object({
  id: nodeId,
  type: z.enum(NODE_TYPES),
  /** Un paso: su `config`. El disparador: `{ triggerType, triggerConfig }`. */
  config: z.record(z.unknown()).default({}),
  position: z.object({ x: coord, y: coord }),
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphEdgeSchema = z.object({
  id: z.string().max(64).optional(),
  source: nodeId,
  target: nodeId,
  // Las asas estáticas o `case_<id>` (switch). Que el asa exista en SU nodo lo comprueba `validateGraph` (`invalid_handle`).
  sourceHandle: z
    .string()
    .refine(isEdgeHandle, "Asa de salida no válida")
    .transform((h) => h as EdgeHandle)
    .default("default"),
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const graphViewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite().min(0.05).max(8),
});
export type GraphViewport = z.infer<typeof graphViewportSchema>;

/** El cuerpo del `PUT /api/automations/[id]/graph`. `expectedUpdatedAt`: el `updatedAt` (ms) con el que se cargó. */
export const graphPayloadSchema = z.object({
  nodes: z.array(graphNodeSchema).max(MAX_STEPS_PER_FLOW + 1),
  edges: z.array(graphEdgeSchema).max(500),
  viewport: graphViewportSchema.nullish(),
  expectedUpdatedAt: z.number().int().nullish(),
});
export type GraphPayload = z.infer<typeof graphPayloadSchema>;

/* ─── Asas permitidas por tipo de nodo ─── */

const REPLY_HANDLES: EdgeHandle[] = ["confirmed", "declined", "reschedule", "other", "timeout"];

/**
 * Las asas de salida que tiene cada tipo de nodo. El `switch` las lleva en su configuración (un asa por caso, más
 * `default` = «Otro»), así que para él hace falta `config`.
 */
export function handlesOf(type: string, config?: unknown): EdgeHandle[] {
  switch (type) {
    case "switch":
      return [...switchCaseIds(config).map(caseHandle), "default"];
    case "condition":
      return ["true", "false"];
    case "wait_reply":
      return REPLY_HANDLES;
    case "wait_until":
      return ["default", "late"];
    default:
      return ["default"];
  }
}

/** Los nodos que dejan pasar tiempo: un ciclo que no atraviesa ninguno giraría sin parar en la cola. */
export const WAIT_NODE_TYPES: readonly string[] = ["delay", "wait_until", "wait_reply"];

/** Las salidas que, sin conectar, merecen un aviso (el flujo termina ahí): las de nodos que ramifican. */
const BRANCH_OUTPUTS: Record<string, EdgeHandle[]> = {
  condition: ["true", "false"],
  wait_reply: REPLY_HANDLES,
  wait_until: ["late"],
};

function branchOutputsOf(type: string, config?: unknown): EdgeHandle[] | undefined {
  return type === "switch" ? handlesOf(type, config) : BRANCH_OUTPUTS[type];
}

/* ─── Validación de topología ─── */

export type GraphIssue = { code: string; message: string; nodeIds?: string[] };
export type GraphValidation = { errors: GraphIssue[]; warnings: GraphIssue[] };

type VNode = { id: string; type: string; config?: Record<string, unknown> };
type VEdge = { source: string; target: string; sourceHandle: string };

const HANDLE_LABEL: Record<string, string> = {
  true: "Sí",
  false: "No",
  late: "Si ya pasó",
  default: "Siguiente",
  confirmed: "Confirma",
  declined: "Dice que no",
  reschedule: "Reagendar",
  other: "Otra cosa",
  timeout: "Sin respuesta",
};
/** El rótulo de un asa. Las de un `switch` (`case_<id>`) son genéricas aquí: el nombre del caso vive en la configuración. */
export const handleLabel = (h: string): string => HANDLE_LABEL[h] ?? (h.startsWith("case_") ? "Caso" : h);

/** ¿Hay un ciclo en el subgrafo de estos nodos? Devuelve los ids de uno, o `null`. Iterativo (sin recursión profunda). */
function findCycle(ids: string[], edges: VEdge[]): string[] | null {
  const inSet = new Set(ids);
  const adj = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const e of edges) if (inSet.has(e.source) && inSet.has(e.target)) adj.get(e.source)!.push(e.target);

  const color = new Map<string, 0 | 1 | 2>(ids.map((i) => [i, 0])); // 0 sin ver · 1 en curso · 2 listo
  for (const start of ids) {
    if (color.get(start) !== 0) continue;
    const stack: { id: string; i: number }[] = [{ id: start, i: 0 }];
    const path: string[] = [start];
    color.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const next = adj.get(top.id)![top.i++];
      if (next === undefined) {
        color.set(top.id, 2);
        stack.pop();
        path.pop();
        continue;
      }
      const c = color.get(next);
      if (c === 1) return path.slice(path.indexOf(next));
      if (c === 0) {
        color.set(next, 1);
        stack.push({ id: next, i: 0 });
        path.push(next);
      }
    }
  }
  return null;
}

/**
 * Valida un grafo. `errors` bloquean el guardado; `warnings` se muestran pero se guarda igual (spec 036, D9).
 * Pura: la usa el cliente en vivo y el servidor antes de persistir.
 */
export function validateGraph(input: { nodes: VNode[]; edges: VEdge[] }): GraphValidation {
  const errors: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];
  const err = (code: string, message: string, nodeIds?: string[]) => errors.push({ code, message, ...(nodeIds ? { nodeIds } : {}) });
  const warn = (code: string, message: string, nodeIds?: string[]) => warnings.push({ code, message, ...(nodeIds ? { nodeIds } : {}) });

  const { nodes, edges } = input;

  // Ids únicos.
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.id)) err("duplicate_node", `Hay dos bloques con el mismo id (${n.id}).`, [n.id]);
    seen.add(n.id);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Exactamente un disparador.
  const triggers = nodes.filter((n) => n.type === TRIGGER_NODE_TYPE);
  if (triggers.length !== 1) {
    err(
      "trigger_count",
      triggers.length === 0 ? "El flujo necesita un disparador." : "Solo puede haber un disparador: deja uno.",
      triggers.map((t) => t.id)
    );
  }
  const trigger = triggers[0];
  const steps = nodes.filter((n) => n.type !== TRIGGER_NODE_TYPE);
  if (steps.length > MAX_STEPS_PER_FLOW) err("too_many_steps", `Un flujo admite hasta ${MAX_STEPS_PER_FLOW} bloques.`);

  // El disparador: su tipo y sus ajustes.
  const triggerType = typeof trigger?.config?.triggerType === "string" ? (trigger.config.triggerType as string) : null;
  if (trigger) {
    if (!triggerType || !(FLOW_TRIGGER_TYPES as readonly string[]).includes(triggerType)) {
      err("invalid_trigger", "Elige cuándo se activa el flujo.", [trigger.id]);
    } else {
      const cfg = parseTriggerConfigFor(triggerType as FlowTriggerType, trigger.config?.triggerConfig ?? null);
      if (!cfg.ok) err("invalid_trigger", cfg.message, [trigger.id]);
    }
  }
  const isBookingTrigger = !!triggerType && triggerType.startsWith("booking_");

  // La configuración de cada paso y lo que exige del disparador.
  for (const n of steps) {
    if (!(STEP_TYPES as readonly string[]).includes(n.type)) {
      err("invalid_node", `Tipo de bloque desconocido (${n.type}).`, [n.id]);
      continue;
    }
    const parsed = parseStepConfig(n.type as StepType, n.config ?? {});
    if (!parsed.ok) err("invalid_config", `Configura el bloque: ${parsed.message}`, [n.id]);
    if (triggerType && !isBookingTrigger) {
      if (n.type === "wait_until") err("requires_booking", "«Esperar hasta la cita» solo sirve en flujos que empiezan con una cita.", [n.id]);
      const rule = (n.config?.rule ?? null) as { type?: string } | null;
      if (n.type === "condition" && rule?.type === "booking_confirmed") {
        err("requires_booking", "«La cita está confirmada» solo sirve en flujos que empiezan con una cita.", [n.id]);
      }
      const cases = n.type === "switch" && Array.isArray(n.config?.cases) ? (n.config!.cases as { rule?: { type?: string } }[]) : [];
      if (cases.some((k) => k?.rule?.type === "booking_confirmed")) {
        err("requires_booking", "«La cita está confirmada» solo sirve en flujos que empiezan con una cita.", [n.id]);
      }
    }
  }
  // Cada nodo de código gasta CPU del servidor compartido: tope por flujo.
  const codeNodes = steps.filter((n) => n.type === "code_js");
  if (codeNodes.length > CODE_JS_MAX_PER_FLOW) {
    err("too_many_code_nodes", `Un flujo admite hasta ${CODE_JS_MAX_PER_FLOW} bloques de código.`, codeNodes.map((n) => n.id));
  }

  // Aristas.
  const used = new Set<string>();
  let fromTrigger = 0;
  const validEdges: VEdge[] = [];
  for (const e of edges) {
    const from = byId.get(e.source);
    const to = byId.get(e.target);
    if (!from || !to) {
      err("edge_dangling", "Una conexión apunta a un bloque que no existe.", [e.source, e.target].filter((i) => !byId.has(i)));
      continue;
    }
    if (to.type === TRIGGER_NODE_TYPE) {
      err("edge_to_trigger", "Nada puede llevar de vuelta al disparador.", [to.id]);
      continue;
    }
    if (!handlesOf(from.type, from.config).includes(e.sourceHandle as EdgeHandle)) {
      err("invalid_handle", `«${handleLabel(e.sourceHandle)}» no es una salida de este bloque.`, [from.id]);
      continue;
    }
    const key = `${e.source}:${e.sourceHandle}`;
    if (used.has(key)) {
      err("duplicate_handle", `La salida «${handleLabel(e.sourceHandle)}» ya está conectada: una salida lleva a un solo destino.`, [from.id]);
      continue;
    }
    used.add(key);
    if (from.type === TRIGGER_NODE_TYPE) fromTrigger += 1;
    validEdges.push(e);
  }
  if (fromTrigger > 1) err("trigger_multiple_outputs", "El disparador solo puede llevar a un bloque.", trigger ? [trigger.id] : undefined);

  // Alcanzabilidad desde el disparador.
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of validEdges) out.get(e.source)!.push(e.target);
  const entry = trigger ? validEdges.find((e) => e.source === trigger.id)?.target : undefined;
  if (trigger && steps.length > 0 && !entry) warn("no_entry", "El disparador no está conectado a ningún bloque: el flujo no hará nada.", [trigger.id]);
  const reach = new Set<string>();
  if (trigger) {
    const queue = [trigger.id];
    reach.add(trigger.id);
    while (queue.length) {
      for (const t of out.get(queue.shift()!) ?? []) {
        if (reach.has(t)) continue;
        reach.add(t);
        queue.push(t);
      }
    }
  }
  const unreachable = steps.filter((n) => !reach.has(n.id));
  if (trigger && unreachable.length > 0) {
    warn("unreachable", `${unreachable.length === 1 ? "Un bloque no se alcanza" : `${unreachable.length} bloques no se alcanzan`} desde el disparador y nunca se ejecutará.`, unreachable.map((n) => n.id));
  }

  // Salidas de nodos que ramifican sin conectar: el flujo termina ahí (aviso, no error).
  for (const n of steps) {
    const wanted = branchOutputsOf(n.type, n.config);
    if (!wanted) continue;
    const open = wanted.filter((h) => !used.has(`${n.id}:${h}`));
    if (open.length > 0) {
      warn("open_output", `En este bloque, ${open.map((h) => `«${handleLabel(h)}»`).join(", ")} no ${open.length === 1 ? "está conectada" : "están conectadas"}: el flujo termina ahí.`, [n.id]);
    }
  }

  // Ciclos: solo valen si atraviesan una espera.
  const stepIds = steps.map((n) => n.id);
  const noWaitIds = steps.filter((n) => !WAIT_NODE_TYPES.includes(n.type)).map((n) => n.id);
  const bad = findCycle(noWaitIds, validEdges);
  if (bad) {
    err("cycle_without_wait", "Hay un ciclo sin ninguna espera: giraría sin parar. Agrega una espera dentro del ciclo.", bad);
  } else {
    const any = findCycle(stepIds, validEdges);
    if (any) warn("cycle", "Hay un ciclo: esos pasos se repetirán hasta que algo (una respuesta, una condición) lo corte.", any);
  }

  return { errors, warnings };
}

/* ─── Del lienzo a la lista (Modo Simple) ─── */

export type LinearInput = {
  nodes: { id: string; type: string; config: Record<string, unknown> }[];
  edges: { source: string; target: string; sourceHandle: string }[];
  /** El paso al que lleva el disparador. */
  entryStepId: string | null;
};
export type LinearResult =
  | { ok: true; order: string[]; configs: Record<string, Record<string, unknown>> }
  | { ok: false; reasons: string[] };

/** La acción de una rama en términos de la lista: el siguiente, el de después, o terminar. */
type BranchAction = "continue" | "skip_next" | "stop";

const BRANCH_KEYS: Record<string, { handle: EdgeHandle; key: string }[]> = {
  condition: [
    { handle: "true", key: "ifTrue" },
    { handle: "false", key: "ifFalse" },
  ],
  wait_until: [{ handle: "late", key: "lateAction" }],
  wait_reply: [
    { handle: "confirmed", key: "onConfirmed" },
    { handle: "declined", key: "onDeclined" },
    { handle: "reschedule", key: "onReschedule" },
    { handle: "other", key: "onOther" },
    { handle: "timeout", key: "onTimeout" },
  ],
};

const PATH_PRIORITY: EdgeHandle[] = ["default", "true", "confirmed", "declined", "reschedule", "other", "timeout", "false", "late"];

const keyOf = (source: string, handle: string, target: string) => `${source}|${handle}|${target}`;

/**
 * ¿Se puede expresar este grafo como la lista del Modo Simple? Recorre el camino principal desde la entrada,
 * deriva de cada rama su acción (`continue` = el siguiente, `skip_next` = el de después, sin arista = `stop`) y
 * COMPRUEBA que recompilar esa lista reproduce exactamente las aristas dibujadas. Si no, explica por qué y no
 * propone nada: nunca se destruye una topología (spec 036, D5).
 */
export function toLinear(input: LinearInput): LinearResult {
  const reasons: string[] = [];
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const outOf = new Map<string, Map<string, string>>();
  for (const e of input.edges) {
    if (!outOf.has(e.source)) outOf.set(e.source, new Map());
    outOf.get(e.source)!.set(e.sourceHandle, e.target);
  }

  if (input.nodes.length === 0) return { ok: true, order: [], configs: {} };
  // Un Switch (N salidas) no cabe en una lista: el flujo se edita solo en el Modo Visual.
  const switches = input.nodes.filter((n) => n.type === "switch");
  if (switches.length > 0) {
    return {
      ok: false,
      reasons: [`${switches.length === 1 ? "Hay un bloque Switch" : `Hay ${switches.length} bloques Switch`}: tienen varias salidas y la lista no las puede mostrar.`],
    };
  }
  if (!input.entryStepId || !byId.has(input.entryStepId)) {
    return { ok: false, reasons: ["El disparador no está conectado a ningún bloque."] };
  }

  // El «siguiente» de un bloque en la lista. Con varias salidas a destinos distintos, el siguiente es el destino
  // cuyo propio siguiente es el OTRO destino (el que la rama «salta»): así `ifTrue: skip_next, ifFalse: continue`
  // se lee como lista aunque la rama «Sí» apunte más lejos que la «No».
  const targetsOf = (id: string): string[] => {
    const outs = outOf.get(id);
    if (!outs) return [];
    return [...new Set(PATH_PRIORITY.map((h) => outs.get(h)).filter((t): t is string => !!t))];
  };
  const pick = (id: string, guard: Set<string> = new Set()): string | undefined => {
    const targets = targetsOf(id);
    if (targets.length <= 1 || guard.has(id)) return targets[0];
    guard.add(id);
    for (const c of targets) {
      const succ = pick(c, guard);
      if (targets.every((o) => o === c || o === succ)) {
        guard.delete(id);
        return c;
      }
    }
    guard.delete(id);
    return targets[0];
  };

  // El camino principal.
  const order: string[] = [];
  const visited = new Set<string>();
  let cur: string | undefined = input.entryStepId;
  while (cur) {
    if (visited.has(cur)) {
      reasons.push("El flujo vuelve a un bloque anterior (un ciclo): la lista no puede repetir pasos.");
      break;
    }
    visited.add(cur);
    order.push(cur);
    cur = pick(cur);
  }
  if (reasons.length > 0) return { ok: false, reasons };

  // Un bloque que ninguna conexión alcanza pero que lleva a uno del camino (el que una rama «salta» en la lista)
  // se intercala justo antes de su destino. Lo demás queda fuera del camino y se explica.
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of input.nodes) {
      if (order.includes(n.id)) continue;
      const target = outOf.get(n.id)?.get("default") ?? targetsOf(n.id)[0];
      const at = target ? order.indexOf(target) : -1;
      if (at >= 0) {
        order.splice(at, 0, n.id);
        visited.add(n.id);
        changed = true;
      }
    }
  }
  // Lo que aún no tiene lugar (un tramo sin conexión desde el camino) se prueba al final de la lista; la
  // verificación por recompilación decide si eso reproduce el grafo (p. ej. tras una condición que siempre termina).
  const leftover = input.nodes.map((n) => n.id).filter((id) => !order.includes(id));
  const result = attempt([...order, ...leftover]);
  if (!result.ok && leftover.length > 0) {
    return {
      ok: false,
      reasons: [
        `${leftover.length === 1 ? "Un bloque está" : `${leftover.length} bloques están`} fuera del camino principal (en otra rama o sin conectar): la lista solo tiene una fila.`,
        ...result.reasons,
      ],
    };
  }
  return result;

  /** Deriva las acciones de cada rama para este orden y COMPRUEBA que recompilar la lista reproduce el grafo. */
  function attempt(list: string[]): LinearResult {
    const configs: Record<string, Record<string, unknown>> = {};
    const problems: string[] = [];
    const nameOf = (id: string) => {
      const c = byId.get(id)?.config as { name?: unknown } | undefined;
      return typeof c?.name === "string" && c.name.trim() ? `«${c.name.trim()}»` : `«${byId.get(id)?.type ?? id}»`;
    };
    list.forEach((id, i) => {
      const node = byId.get(id)!;
      const next = list[i + 1];
      const after = list[i + 2];
      const next0 = { ...node.config };
      for (const { handle, key } of BRANCH_KEYS[node.type] ?? []) {
        const target = outOf.get(id)?.get(handle);
        let action: BranchAction;
        if (!target) action = "stop";
        else if (target === next) action = "continue";
        else if (target === after) action = "skip_next";
        else {
          problems.push(`En ${nameOf(id)}, la salida «${handleLabel(handle)}» lleva a un bloque que la lista no puede representar (solo puede seguir con el siguiente o saltarse uno).`);
          continue;
        }
        next0[key] = action;
      }
      configs[id] = next0;
    });
    if (problems.length > 0) return { ok: false, reasons: problems };

    const recompiled = compileLinearEdges(list.map((id) => ({ id, stepType: byId.get(id)!.type, config: configs[id] })));
    const want = new Set(input.edges.map((e) => keyOf(e.source, e.sourceHandle, e.target)));
    const got = new Set(recompiled.map((e) => keyOf(e.sourceStepId, e.sourceHandle, e.targetStepId)));
    const same = want.size === got.size && [...want].every((k) => got.has(k));
    if (!same) {
      return { ok: false, reasons: ["Las conexiones dibujadas no se pueden expresar como una lista (por ejemplo, un bloque que no lleva al siguiente)."] };
    }
    return { ok: true, order: list, configs };
  }
}

/* ─── Posiciones ─── */

export type Pos = { x: number; y: number };

/** Posiciones de la lista en una columna, en el orden de ejecución (lo que el Modo Simple entiende). */
export function normalizeColumn(order: string[]): Record<string, Pos> {
  return Object.fromEntries(order.map((id, i) => [id, { x: 0, y: i * STEP_GAP }]));
}

/**
 * Auto-orden por niveles: el disparador arriba, cada bloque en el nivel de su camino más corto desde la entrada,
 * repartidos en horizontal por nivel. Lo que no se alcanza va debajo. Devuelve posiciones enteras.
 */
export function autoLayout(
  stepIds: string[],
  edges: { source: string; target: string }[],
  entryStepId: string | null,
  opts: { dx?: number; dy?: number } = {}
): { trigger: Pos; steps: Record<string, Pos> } {
  const dx = opts.dx ?? 300;
  const dy = opts.dy ?? 160;
  const set = new Set(stepIds);
  const adj = new Map<string, string[]>(stepIds.map((i) => [i, []]));
  for (const e of edges) if (set.has(e.source) && set.has(e.target)) adj.get(e.source)!.push(e.target);

  const level = new Map<string, number>();
  const rows: string[][] = [];
  const place = (id: string, l: number) => {
    level.set(id, l);
    (rows[l] ??= []).push(id);
  };
  if (entryStepId && set.has(entryStepId)) {
    place(entryStepId, 0);
    const queue = [entryStepId];
    while (queue.length) {
      const id = queue.shift()!;
      for (const t of adj.get(id) ?? []) {
        if (level.has(t)) continue;
        place(t, level.get(id)! + 1);
        queue.push(t);
      }
    }
  }
  // Lo inalcanzable, debajo y en su propia fila por grupos de cuatro.
  const rest = stepIds.filter((i) => !level.has(i));
  const base = rows.length;
  rest.forEach((id, i) => place(id, base + Math.floor(i / 4)));

  const steps: Record<string, Pos> = {};
  rows.forEach((row, l) => {
    row.forEach((id, i) => {
      steps[id] = { x: Math.round((i - (row.length - 1) / 2) * dx), y: Math.round((l + 1) * dy) };
    });
  });
  return { trigger: { x: 0, y: 0 }, steps };
}
