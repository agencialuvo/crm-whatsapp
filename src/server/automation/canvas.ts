import { asc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  TRIGGER_NODE_TYPE,
  autoLayout,
  normalizeColumn,
  toLinear,
  validateGraph,
  type GraphIssue,
  type GraphPayload,
} from "@/lib/automation-graph";
import { MAX_STEPS_PER_FLOW, type FlowTriggerType } from "@/lib/automation-schemas";
import {
  assertRefsOwned,
  assertTemplateOwned,
  loadFlow,
  resolveTriggerConfig,
  serializeFlow,
} from "@/server/automation/flows";
import { compileFlowEdges, ensureEdges, getGraph, syncEdges, type Tx } from "@/server/automation/graph";
import { AutomationError } from "@/server/automation/http";

/**
 * Automatizaciones — el Modo Visual en el servidor: guardar el grafo dibujado y cambiar entre Modo Simple y Visual.
 *
 * Todo lo que escribe `saveGraph` ocurre en UNA transacción bajo el candado de la fila del flujo, con control de
 * concurrencia optimista: dos pestañas no se pisan en silencio y un grafo inválido no deja nada a medias
 * (spec 036, D7).
 */

const issuesMessage = (issues: GraphIssue[]) => issues.map((i) => i.message).join(" · ");

/** Guarda el grafo, el disparador, la entrada y la cámara. Devuelve el grafo guardado (con los ids ya reales) y los avisos. */
export async function saveGraph(organizationId: string, flowId: string, payload: GraphPayload) {
  // La validación de topología no necesita la base: se hace antes de abrir la transacción.
  const validation = validateGraph({
    nodes: payload.nodes.map((n) => ({ id: n.id, type: n.type, config: n.config })),
    edges: payload.edges.map((e) => ({ source: e.source, target: e.target, sourceHandle: e.sourceHandle })),
  });
  if (validation.errors.length > 0) throw new AutomationError("invalid_graph", 422, issuesMessage(validation.errors));

  const triggerNode = payload.nodes.find((n) => n.type === TRIGGER_NODE_TYPE)!; // `validateGraph` exige exactamente uno
  const triggerType = triggerNode.config.triggerType as FlowTriggerType;
  const stepNodes = payload.nodes.filter((n) => n.type !== TRIGGER_NODE_TYPE);

  // Las referencias deben ser de ESTA organización (etiqueta, etapa, plantilla): nunca se guarda una ajena.
  // 047: el alcance de un disparador de anuncio no se vuelve a exigir en el catálogo si no cambió (guardar el lienzo de
  // un flujo cuya campaña ya no está en Meta no debe fallar).
  const [existing] = await getDb()
    .select({ triggerConfig: schema.automationFlow.triggerConfig })
    .from(schema.automationFlow)
    .where(scoped(schema.automationFlow.organizationId, organizationId, eq(schema.automationFlow.id, flowId)))
    .limit(1);
  const triggerConfig = await resolveTriggerConfig(
    organizationId,
    triggerType,
    triggerNode.config.triggerConfig ?? null,
    (existing?.triggerConfig ?? null) as Record<string, unknown> | null
  );
  for (const n of stepNodes) {
    await assertTemplateOwned(organizationId, n.config);
    await assertRefsOwned(organizationId, n.config);
  }

  await getDb().transaction(async (tx) => {
    const f = schema.automationFlow;
    const s = schema.automationStep;
    const e = schema.automationEdge;
    const r = schema.automationRun;

    // El candado del flujo: dos guardados del mismo flujo se serializan, y el segundo ve el `updated_at` del primero.
    const [flow] = await tx
      .select()
      .from(f)
      .where(scoped(f.organizationId, organizationId, eq(f.id, flowId)))
      .for("update");
    if (!flow) throw new AutomationError("not_found", 404, "El flujo no existe");
    // Se compara en JS: `now()` de Postgres tiene microsegundos y un `Date` de JS, milisegundos.
    if (payload.expectedUpdatedAt != null && flow.updatedAt.getTime() !== payload.expectedUpdatedAt) {
      throw new AutomationError("stale_graph", 409, "Alguien guardó este flujo antes que tú. Recarga para ver sus cambios.");
    }

    const existing = await tx
      .select({ id: s.id, stepType: s.stepType })
      .from(s)
      .where(scoped(s.organizationId, organizationId, eq(s.flowId, flowId)));
    const existingById = new Map(existing.map((x) => [x.id, x]));
    if (stepNodes.length > MAX_STEPS_PER_FLOW) throw new AutomationError("too_many_steps", 422, `Un flujo admite hasta ${MAX_STEPS_PER_FLOW} bloques`);

    // Ids: los existentes se conservan (las ejecuciones en curso apuntan a ellos); los nuevos reciben id real.
    const idMap = new Map<string, string>();
    for (const n of stepNodes) {
      const known = existingById.get(n.id);
      if (known && known.stepType !== n.type) {
        throw new AutomationError("step_type_changed", 422, "El tipo de un bloque no cambia: elimínalo y crea otro.");
      }
      idMap.set(n.id, known ? n.id : newId("automationStep"));
    }

    // Los pasos que ya no están: sus ejecuciones se cancelan (igual que `deleteStep`) y el paso se borra.
    const keep = new Set(idMap.values());
    const gone = existing.filter((x) => !keep.has(x.id)).map((x) => x.id);
    if (gone.length > 0) {
      await tx
        .update(r)
        .set({ status: "cancelled", waitingFor: null, waitingUntil: null, endedAt: new Date() })
        .where(scoped(r.organizationId, organizationId, eq(r.flowId, flowId), inArray(r.currentStepId, gone), inArray(r.status, ["running", "waiting"])));
      await tx.delete(s).where(scoped(s.organizationId, organizationId, inArray(s.id, gone)));
    }

    for (const n of stepNodes) {
      const id = idMap.get(n.id)!;
      if (existingById.has(n.id)) {
        await tx
          .update(s)
          .set({ config: n.config, positionX: Math.round(n.position.x), positionY: Math.round(n.position.y) })
          .where(scoped(s.organizationId, organizationId, eq(s.id, id)));
      } else {
        await tx.insert(s).values({
          id,
          organizationId,
          flowId,
          stepType: n.type as typeof s.$inferInsert.stepType,
          config: n.config,
          positionX: Math.round(n.position.x),
          positionY: Math.round(n.position.y),
        });
      }
    }

    // Las aristas se reescriben enteras (los ids de las aristas no son estables ni importan). La del disparador
    // no es una arista: es la entrada del flujo.
    const triggerEdge = payload.edges.find((x) => x.source === triggerNode.id);
    const entryStepId = triggerEdge ? (idMap.get(triggerEdge.target) ?? null) : null;
    await tx.delete(e).where(scoped(e.organizationId, organizationId, eq(e.flowId, flowId)));
    const rows = payload.edges
      .filter((x) => x.source !== triggerNode.id)
      .map((x) => ({
        id: newId("automationEdge"),
        organizationId,
        flowId,
        sourceStepId: idMap.get(x.source)!,
        targetStepId: idMap.get(x.target)!,
        sourceHandle: x.sourceHandle,
      }));
    if (rows.length > 0) await tx.insert(e).values(rows);

    await tx
      .update(f)
      .set({
        editorMode: "canvas",
        triggerType,
        triggerConfig,
        entryStepId,
        // La cámara y la posición del disparador (que no es un paso): `{ x, y, zoom, trigger: { x, y } }`.
        viewport: { ...(payload.viewport ?? {}), trigger: triggerNode.position },
        // Un flujo encendido sin pasos no hace nada: se apaga (la misma regla que al borrar el último paso).
        ...(stepNodes.length === 0 && flow.active ? { active: false } : {}),
        updatedAt: new Date(),
      })
      .where(scoped(f.organizationId, organizationId, eq(f.id, flowId)));
  });

  const [flow, graph] = await Promise.all([loadFlow(organizationId, flowId), getGraph(organizationId, flowId)]);
  return { flow: serializeFlow(flow), ...graph, warnings: validation.warnings };
}

/** Los pasos y aristas guardados de un flujo, listos para `toLinear`. */
async function loadForLinear(tx: Tx, organizationId: string, flowId: string) {
  const s = schema.automationStep;
  const e = schema.automationEdge;
  const steps = await tx
    .select({ id: s.id, stepType: s.stepType, config: s.config })
    .from(s)
    .where(scoped(s.organizationId, organizationId, eq(s.flowId, flowId)))
    .orderBy(asc(s.positionY), asc(s.positionX), asc(s.id));
  const edges = await tx
    .select({ source: e.sourceStepId, target: e.targetStepId, sourceHandle: e.sourceHandle })
    .from(e)
    .where(scoped(e.organizationId, organizationId, eq(e.flowId, flowId)));
  return { steps, edges };
}

/**
 * Cambia el modo de edición.
 * - Simple → Visual: las aristas compiladas pasan a ser las dibujadas, el primer paso es la entrada y los pasos se
 *   acomodan por niveles.
 * - Visual → Simple: solo si el grafo se puede expresar como lista (`toLinear`, que lo comprueba recompilando);
 *   si no, 409 `graph_not_linear` con los motivos y NO se toca nada. Nunca se destruye una topología.
 */
export async function setEditorMode(organizationId: string, flowId: string, mode: "simple" | "canvas") {
  // Un flujo anterior a las aristas se cura antes de convertir (lectura perezosa de la Fase 3).
  if (mode === "canvas") await ensureEdges(organizationId, flowId);

  await getDb().transaction(async (tx) => {
    const f = schema.automationFlow;
    const s = schema.automationStep;
    const [flow] = await tx
      .select()
      .from(f)
      .where(scoped(f.organizationId, organizationId, eq(f.id, flowId)))
      .for("update");
    if (!flow) throw new AutomationError("not_found", 404, "El flujo no existe");
    if (flow.editorMode === mode) return; // ya está: idempotente

    const { steps, edges } = await loadForLinear(tx, organizationId, flowId);

    if (mode === "canvas") {
      const live = edges.length > 0 ? edges : (await compileFlowEdges(tx, organizationId, flowId)).map((x) => ({ source: x.sourceStepId, target: x.targetStepId }));
      const entry = steps[0]?.id ?? null;
      const layout = autoLayout(
        steps.map((x) => x.id),
        live,
        entry
      );
      for (const st of steps) {
        const p = layout.steps[st.id]!;
        await tx.update(s).set({ positionX: p.x, positionY: p.y }).where(scoped(s.organizationId, organizationId, eq(s.id, st.id)));
      }
      await tx
        .update(f)
        .set({ editorMode: "canvas", entryStepId: entry, viewport: { trigger: layout.trigger }, updatedAt: new Date() })
        .where(scoped(f.organizationId, organizationId, eq(f.id, flowId)));
      return;
    }

    // Visual → Simple.
    const result = toLinear({
      nodes: steps.map((x) => ({ id: x.id, type: x.stepType, config: (x.config ?? {}) as Record<string, unknown> })),
      edges,
      entryStepId: flow.entryStepId,
    });
    if (!result.ok) {
      throw new AutomationError(
        "graph_not_linear",
        409,
        `Este flujo tiene ramas que la lista no puede mostrar: ${result.reasons.join(" ")} Edítalo en el Modo Visual o simplifícalo antes de volver.`
      );
    }
    const column = normalizeColumn(result.order);
    for (const id of result.order) {
      await tx
        .update(s)
        .set({ config: result.configs[id]!, positionX: column[id]!.x, positionY: column[id]!.y })
        .where(scoped(s.organizationId, organizationId, eq(s.id, id)));
    }
    await tx
      .update(f)
      .set({ editorMode: "simple", entryStepId: null, viewport: null, updatedAt: new Date() })
      .where(scoped(f.organizationId, organizationId, eq(f.id, flowId)));
    // Vuelven a derivarse de la lista (que ahora lleva las acciones de cada rama).
    await syncEdges(organizationId, flowId, tx, { force: true });
  });

  const [flow, graph] = await Promise.all([loadFlow(organizationId, flowId), getGraph(organizationId, flowId)]);
  return { flow: serializeFlow(flow), ...graph };
}
