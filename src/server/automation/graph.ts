import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { compileLinearEdges, type CompiledEdge, type EdgeHandle } from "@/lib/automation";

/**
 * Automatizaciones — el grafo de un flujo: las aristas (`automation_edge`) y cómo se mantienen.
 *
 * Hasta el lienzo visual (Fase 5) todo flujo es «simple»: sus aristas se DERIVAN de la lista de pasos
 * (`compileLinearEdges`) y se recompilan en cada cambio de pasos. Mientras tanto, un flujo creado antes de las
 * aristas se cura solo (`ensureEdges`): al arrancar una ejecución o al pedir el grafo.
 */

export type Db = ReturnType<typeof getDb>;
/** Una transacción o la conexión: las funciones de aquí corren dentro de la transacción de quien las llama. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

/** El orden de ejecución: el mismo criterio de siempre (arriba antes que abajo, izquierda antes que derecha). */
const stepOrder = () => [
  asc(schema.automationStep.positionY),
  asc(schema.automationStep.positionX),
  asc(schema.automationStep.id),
];

/** Los pasos del flujo en orden de ejecución (los campos que necesita el compilador). */
export async function orderedSteps(tx: Tx, organizationId: string, flowId: string) {
  const s = schema.automationStep;
  return tx
    .select({ id: s.id, stepType: s.stepType, config: s.config })
    .from(s)
    .where(scoped(s.organizationId, organizationId, eq(s.flowId, flowId)))
    .orderBy(...stepOrder());
}

/** El modo de edición del flujo (`simple` si no existe: un flujo borrado no debe romper a quien pregunta). */
export async function flowEditorMode(tx: Tx, organizationId: string, flowId: string): Promise<"simple" | "canvas"> {
  const f = schema.automationFlow;
  const [row] = await tx
    .select({ mode: f.editorMode })
    .from(f)
    .where(scoped(f.organizationId, organizationId, eq(f.id, flowId)))
    .limit(1);
  return row?.mode ?? "simple";
}

/** La compilación del flujo tal como está hoy (sin tocar la base). */
export async function compileFlowEdges(tx: Tx, organizationId: string, flowId: string): Promise<CompiledEdge[]> {
  return compileLinearEdges(await orderedSteps(tx, organizationId, flowId));
}

/**
 * Recompila y guarda las aristas del flujo: borra las que había e inserta las nuevas, todo en la transacción de
 * quien llama (o en una propia). Idempotente.
 */
export async function syncEdges(organizationId: string, flowId: string, tx?: Tx, opts: { force?: boolean } = {}): Promise<number> {
  const run = async (t: Tx) => {
    // En `canvas` las aristas son las que el usuario dibujó: recompilarlas desde la lista las destruiría.
    if (!opts.force && (await flowEditorMode(t, organizationId, flowId)) === "canvas") return 0;
    const edges = await compileFlowEdges(t, organizationId, flowId);
    const e = schema.automationEdge;
    await t.delete(e).where(scoped(e.organizationId, organizationId, eq(e.flowId, flowId)));
    if (edges.length > 0) {
      await t.insert(e).values(
        edges.map((x) => ({
          id: newId("automationEdge"),
          organizationId,
          flowId,
          sourceStepId: x.sourceStepId,
          targetStepId: x.targetStepId,
          sourceHandle: x.sourceHandle,
        }))
      );
    }
    return edges.length;
  };
  return tx ? run(tx) : getDb().transaction(run);
}

/**
 * Curación perezosa: un flujo con 2 o más pasos y ninguna arista es de antes de las aristas; se compila y se
 * guarda. Las aristas del flujo en la base ya correctas no se tocan. Devuelve cuántas aristas insertó.
 * Concurrente-seguro: el índice único `(paso, asa)` descarta la inserción repetida.
 */
export async function ensureEdges(organizationId: string, flowId: string): Promise<number> {
  const db = getDb();
  const e = schema.automationEdge;
  // En `canvas` las aristas guardadas son la verdad, incluso si no hay ninguna.
  if ((await flowEditorMode(db, organizationId, flowId)) === "canvas") return 0;
  const [any] = await db
    .select({ id: e.id })
    .from(e)
    .where(scoped(e.organizationId, organizationId, eq(e.flowId, flowId)))
    .limit(1);
  if (any) return 0;
  const edges = await compileFlowEdges(db, organizationId, flowId);
  if (edges.length === 0) return 0;
  const inserted = await db
    .insert(e)
    .values(
      edges.map((x) => ({
        id: newId("automationEdge"),
        organizationId,
        flowId,
        sourceStepId: x.sourceStepId,
        targetStepId: x.targetStepId,
        sourceHandle: x.sourceHandle,
      }))
    )
    .onConflictDoNothing()
    .returning({ id: e.id });
  return inserted.length;
}

export type GraphEdgeDto = { id: string; source: string; target: string; sourceHandle: EdgeHandle };

/**
 * El destino de un paso por un asa. Lee las aristas guardadas; si el flujo no tiene ninguna (anterior a las
 * aristas) cae a la compilación en memoria, así una tarea en vuelo durante un despliegue sigue su camino.
 */
export async function resolveNextStep(
  tx: Tx,
  organizationId: string,
  flowId: string,
  sourceStepId: string,
  handle: EdgeHandle
): Promise<string | null> {
  const e = schema.automationEdge;
  const stored = await tx
    .select({ source: e.sourceStepId, target: e.targetStepId, handle: e.sourceHandle })
    .from(e)
    .where(scoped(e.organizationId, organizationId, eq(e.flowId, flowId)));
  // Sin aristas guardadas: un flujo anterior a las aristas cae a la compilación; uno de lienzo, sin aristas, termina.
  if (stored.length === 0 && (await flowEditorMode(tx, organizationId, flowId)) === "canvas") return null;
  const edges: { source: string; target: string; handle: string }[] =
    stored.length > 0
      ? stored
      : (await compileFlowEdges(tx, organizationId, flowId)).map((x) => ({
          source: x.sourceStepId,
          target: x.targetStepId,
          handle: x.sourceHandle,
        }));
  return edges.find((x) => x.source === sourceStepId && x.handle === handle)?.target ?? null;
}

/**
 * El paso por el que arranca el flujo. `simple`: el primero en el orden de la lista. `canvas`: el que marcó la
 * salida del nodo disparador (`entry_step_id`); sin él, el flujo no arranca nada.
 */
export async function entryStepId(tx: Tx, organizationId: string, flowId: string): Promise<string | null> {
  const f = schema.automationFlow;
  const [flow] = await tx
    .select({ mode: f.editorMode, entry: f.entryStepId })
    .from(f)
    .where(scoped(f.organizationId, organizationId, eq(f.id, flowId)))
    .limit(1);
  if (flow?.mode === "canvas") return flow.entry ?? null;
  const s = schema.automationStep;
  const [first] = await tx
    .select({ id: s.id })
    .from(s)
    .where(scoped(s.organizationId, organizationId, eq(s.flowId, flowId)))
    .orderBy(...stepOrder())
    .limit(1);
  return first?.id ?? null;
}

/**
 * El grafo del flujo para la pantalla: nodos (los pasos, en orden), aristas, paso de entrada, modo de edición,
 * cámara/posición del disparador y el `updatedAt` (ms) con el que se guardará de forma optimista.
 */
export async function getGraph(organizationId: string, flowId: string) {
  await ensureEdges(organizationId, flowId);
  const db = getDb();
  const s = schema.automationStep;
  const e = schema.automationEdge;
  const f = schema.automationFlow;
  const [flow] = await db
    .select({ mode: f.editorMode, viewport: f.viewport, entry: f.entryStepId, updatedAt: f.updatedAt })
    .from(f)
    .where(scoped(f.organizationId, organizationId, eq(f.id, flowId)))
    .limit(1);
  const nodes = await db
    .select({
      id: s.id,
      stepType: s.stepType,
      config: s.config,
      positionX: s.positionX,
      positionY: s.positionY,
    })
    .from(s)
    .where(scoped(s.organizationId, organizationId, eq(s.flowId, flowId)))
    .orderBy(...stepOrder());
  const edges = await db
    .select({ id: e.id, source: e.sourceStepId, target: e.targetStepId, sourceHandle: e.sourceHandle })
    .from(e)
    .where(scoped(e.organizationId, organizationId, eq(e.flowId, flowId)))
    .orderBy(asc(e.sourceStepId), asc(e.sourceHandle));
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.stepType,
      config: n.config as Record<string, unknown>,
      position: { x: n.positionX, y: n.positionY },
    })),
    edges: edges satisfies GraphEdgeDto[],
    entryStepId: flow?.mode === "canvas" ? (flow.entry ?? null) : (nodes[0]?.id ?? null),
    editorMode: (flow?.mode ?? "simple") as "simple" | "canvas",
    viewport: (flow?.viewport ?? null) as Record<string, unknown> | null,
    updatedAt: flow?.updatedAt.getTime() ?? Date.now(),
  };
}
