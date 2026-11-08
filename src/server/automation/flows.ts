import { asc, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  FLOW_TRIGGER_TYPES,
  MAX_STEPS_PER_FLOW,
  STEP_TYPES,
  parseStepConfig,
  parseTriggerConfigFor,
  type FlowCreateInput,
  type FlowPatchInput,
  type FlowTriggerType,
  type StepCreateInput,
  type StepPatchInput,
  type StepType,
} from "@/lib/automation-schemas";
import { AutomationError } from "@/server/automation/http";

/**
 * Automatizaciones — gestión de flujos y pasos (lo que usan las rutas de `/api/automations`).
 *
 * Toda consulta pasa por `scoped()`: un id de OTRA organización responde igual que uno que no
 * existe (404), sin revelar que existe. Las entradas ya vienen validadas por Zod; aquí van las reglas
 * que necesitan la base (la etapa y la plantilla existen, el flujo tiene pasos, el tope de nodos).
 */

type FlowRow = typeof schema.automationFlow.$inferSelect;
type StepRow = typeof schema.automationStep.$inferSelect;

const notFound = () => new AutomationError("not_found", 404, "El flujo no existe");

export function serializeFlow(f: FlowRow) {
  return {
    id: f.id,
    name: f.name,
    triggerType: f.triggerType,
    triggerConfig: (f.triggerConfig ?? null) as Record<string, unknown> | null,
    active: f.active,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

export function serializeStep(s: StepRow, order?: number) {
  return {
    id: s.id,
    flowId: s.flowId,
    stepType: s.stepType,
    config: s.config as Record<string, unknown>,
    positionX: s.positionX,
    positionY: s.positionY,
    // El orden de ejecución (1, 2, 3…): el del lienzo, de arriba abajo y de izquierda a derecha.
    ...(order !== undefined ? { order } : {}),
  };
}

async function loadFlow(organizationId: string, id: string): Promise<FlowRow> {
  const f = schema.automationFlow;
  const [row] = await getDb()
    .select()
    .from(f)
    .where(scoped(f.organizationId, organizationId, eq(f.id, id)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

/** El orden de ejecución: el mismo criterio con que el worker y los disparadores eligen el paso. */
const stepOrder = () => [
  asc(schema.automationStep.positionY),
  asc(schema.automationStep.positionX),
  asc(schema.automationStep.id),
];

async function countSteps(organizationId: string, flowId: string): Promise<number> {
  const s = schema.automationStep;
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(s)
    .where(scoped(s.organizationId, organizationId, eq(s.flowId, flowId)));
  return row?.n ?? 0;
}

/** `stage_changed` con etapa: la etapa debe ser de esta organización (no se guarda una referencia ajena). */
async function assertStageOwned(organizationId: string, config: Record<string, unknown> | null) {
  const stageId = config?.toStageId;
  if (typeof stageId !== "string") return;
  const st = schema.pipelineStage;
  const [row] = await getDb()
    .select({ id: st.id })
    .from(st)
    .where(scoped(st.organizationId, organizationId, eq(st.id, stageId)))
    .limit(1);
  if (!row) throw new AutomationError("stage_not_found", 422, "La etapa elegida no existe");
}

/** Una plantilla de un paso debe existir en esta organización (que esté aprobada se exige al enviar). */
async function assertTemplateOwned(organizationId: string, config: Record<string, unknown>) {
  const templateId = config.templateId;
  if (typeof templateId !== "string") return;
  const t = schema.template;
  const [row] = await getDb()
    .select({ id: t.id })
    .from(t)
    .where(scoped(t.organizationId, organizationId, eq(t.id, templateId)))
    .limit(1);
  if (!row) throw new AutomationError("template_not_found", 422, "La plantilla elegida no existe");
}

/** Valida los ajustes contra el tipo del flujo y, si procede, contra las etapas de la organización. */
async function resolveTriggerConfig(
  organizationId: string,
  triggerType: string,
  raw: unknown
): Promise<Record<string, unknown> | null> {
  if (!(FLOW_TRIGGER_TYPES as readonly string[]).includes(triggerType)) {
    throw new AutomationError("unsupported_trigger", 422, `El disparador «${triggerType}» aún no está disponible`);
  }
  const parsed = parseTriggerConfigFor(triggerType as FlowTriggerType, raw);
  if (!parsed.ok) throw new AutomationError("invalid_trigger_config", 422, parsed.message);
  await assertStageOwned(organizationId, parsed.value);
  return parsed.value;
}

/* ─── Flujos ─── */

export async function listFlows(organizationId: string) {
  const f = schema.automationFlow;
  const rows = await getDb()
    .select({
      id: f.id,
      name: f.name,
      triggerType: f.triggerType,
      active: f.active,
      createdAt: f.createdAt,
      // Nombres calificados a mano: dentro de la subconsulta Drizzle pinta las columnas SIN tabla y
      // `flow_id = id` compararía el paso consigo mismo (siempre 0).
      stepCount: sql<number>`(select count(*)::int from "automation_step" as "s" where "s"."flow_id" = "automation_flow"."id")`,
    })
    .from(f)
    .where(scoped(f.organizationId, organizationId))
    .orderBy(desc(f.createdAt), asc(f.id));
  return rows;
}

export async function createFlow(organizationId: string, input: FlowCreateInput) {
  const triggerConfig = await resolveTriggerConfig(organizationId, input.triggerType, input.triggerConfig);
  const [row] = await getDb()
    .insert(schema.automationFlow)
    .values({
      id: newId("automationFlow"),
      organizationId,
      name: input.name,
      triggerType: input.triggerType,
      triggerConfig,
      // Nace apagado: sin pasos no hay nada que ejecutar. Encenderlo exige al menos uno (`updateFlow`).
      active: false,
    })
    .returning();
  return serializeFlow(row!);
}

export async function getFlow(organizationId: string, id: string) {
  const flow = await loadFlow(organizationId, id);
  const s = schema.automationStep;
  const steps = await getDb()
    .select()
    .from(s)
    .where(scoped(s.organizationId, organizationId, eq(s.flowId, id)))
    .orderBy(...stepOrder());
  return { flow: serializeFlow(flow), steps: steps.map((st, i) => serializeStep(st, i + 1)) };
}

export async function updateFlow(organizationId: string, id: string, patch: FlowPatchInput) {
  const flow = await loadFlow(organizationId, id);
  const set: Partial<typeof schema.automationFlow.$inferInsert> = { updatedAt: new Date() };

  if (patch.name !== undefined) set.name = patch.name;
  if (patch.triggerConfig !== undefined) {
    set.triggerConfig = await resolveTriggerConfig(organizationId, flow.triggerType, patch.triggerConfig);
  }
  if (patch.active !== undefined) {
    // Encender un flujo vacío no hace nada y confunde: se pide al menos un paso.
    if (patch.active && !flow.active && (await countSteps(organizationId, id)) === 0) {
      throw new AutomationError("flow_without_steps", 409, "Agrega al menos un paso antes de encender el flujo");
    }
    set.active = patch.active;
  }

  const f = schema.automationFlow;
  const [row] = await getDb()
    .update(f)
    .set(set)
    .where(scoped(f.organizationId, organizationId, eq(f.id, id)))
    .returning();
  if (!row) throw notFound();
  return serializeFlow(row);
}

/** Borra el flujo; sus pasos, su cola y su historial se van por la cascada de la base. */
export async function deleteFlow(organizationId: string, id: string): Promise<void> {
  const f = schema.automationFlow;
  const gone = await getDb()
    .delete(f)
    .where(scoped(f.organizationId, organizationId, eq(f.id, id)))
    .returning({ id: f.id });
  if (gone.length === 0) throw notFound();
}

/* ─── Pasos ─── */

export async function createStep(organizationId: string, flowId: string, input: StepCreateInput) {
  await loadFlow(organizationId, flowId);
  if ((await countSteps(organizationId, flowId)) >= MAX_STEPS_PER_FLOW) {
    throw new AutomationError("too_many_steps", 409, `Un flujo admite hasta ${MAX_STEPS_PER_FLOW} pasos`);
  }
  await assertTemplateOwned(organizationId, input.config as Record<string, unknown>);
  const [row] = await getDb()
    .insert(schema.automationStep)
    .values({
      id: newId("automationStep"),
      organizationId,
      flowId,
      stepType: input.stepType,
      config: input.config,
      positionX: input.positionX,
      positionY: input.positionY,
    })
    .returning();
  return serializeStep(row!);
}

export async function updateStep(
  organizationId: string,
  flowId: string,
  stepId: string,
  patch: StepPatchInput
) {
  await loadFlow(organizationId, flowId);
  const s = schema.automationStep;
  const [step] = await getDb()
    .select()
    .from(s)
    .where(scoped(s.organizationId, organizationId, eq(s.flowId, flowId), eq(s.id, stepId)))
    .limit(1);
  if (!step) throw new AutomationError("not_found", 404, "El paso no existe");

  const set: Partial<typeof schema.automationStep.$inferInsert> = {};
  if (patch.config !== undefined) {
    if (!(STEP_TYPES as readonly string[]).includes(step.stepType)) {
      throw new AutomationError("unsupported_step", 422, `El paso «${step.stepType}» aún no se puede editar`);
    }
    const parsed = parseStepConfig(step.stepType as StepType, patch.config);
    if (!parsed.ok) throw new AutomationError("invalid_step_config", 422, parsed.message);
    await assertTemplateOwned(organizationId, parsed.value);
    set.config = parsed.value;
  }
  if (patch.positionX !== undefined) set.positionX = patch.positionX;
  if (patch.positionY !== undefined) set.positionY = patch.positionY;

  const [row] = await getDb()
    .update(s)
    .set(set)
    .where(scoped(s.organizationId, organizationId, eq(s.flowId, flowId), eq(s.id, stepId)))
    .returning();
  if (!row) throw new AutomationError("not_found", 404, "El paso no existe");
  return serializeStep(row);
}

/**
 * Borra un paso. Su cola pendiente se va con él (cascada) y su historial se conserva con `step_id`
 * en NULL. Un flujo encendido que se queda sin pasos se apaga, para no quedar activo sin hacer nada.
 */
export async function deleteStep(organizationId: string, flowId: string, stepId: string): Promise<void> {
  const flow = await loadFlow(organizationId, flowId);
  const s = schema.automationStep;
  const gone = await getDb()
    .delete(s)
    .where(scoped(s.organizationId, organizationId, eq(s.flowId, flowId), eq(s.id, stepId)))
    .returning({ id: s.id });
  if (gone.length === 0) throw new AutomationError("not_found", 404, "El paso no existe");

  if (flow.active && (await countSteps(organizationId, flowId)) === 0) {
    const f = schema.automationFlow;
    await getDb()
      .update(f)
      .set({ active: false, updatedAt: new Date() })
      .where(scoped(f.organizationId, organizationId, eq(f.id, flowId)));
  }
}
