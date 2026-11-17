import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import type { AutoStageRole, AutoStageRule, LossReason, StageChangeSource } from "@/lib/types";
import { publish } from "@/server/events/bus";
import { AL_FINAL, columnOrder, lockPipeline, placeAt, renumberColumn, topPosition } from "@/server/leads/column-order";
import { reportStageChange } from "@/server/attribution/conversions";
import { onLeadCreated, onLeadStageChanged } from "@/server/automation/triggers";

/**
 * La ÚNICA puerta que escribe `lead.stage_id`.
 *
 * Regla dura: mover un lead y registrar el movimiento son
 * la misma operación, en la misma transacción. Hoy hay cuatro caminos que
 * cambian de etapa (el dueño arrastra, el bot avanza, el agente in-process, la
 * reubicación al borrar una etapa); si cada uno copiara el "anota el evento",
 * el quinto que alguien agregue lo olvidaría. Y olvidarlo NO truena: solo hace
 * que las gráficas mientan meses después.
 *
 * Un unit test de vigilancia (`tests/unit/stage-history-guard.test.ts`) escanea
 * `src/` y falla si aparece una escritura de `stageId` fuera de este archivo.
 * No lo "arregles" moviendo el UPDATE a otro lado: es un guardarraíl.
 */

type LeadRow = typeof schema.lead.$inferSelect;

export type MoveResult =
  | { ok: true; lead: LeadRow; changed: boolean; reorderedStageIds: string[] }
  | {
      ok: false;
      reason: "lead_not_found" | "stage_not_found" | "loss_reason_required";
    };

export type MoveInput = {
  organizationId: string;
  leadId: string;
  toStageId: string;
  /**
   * 044 — ÍNDICE dentro de la columna destino (0 = arriba; `AL_FINAL` = al final; se acota al tamaño de
   * la columna). La puerta renumera la columna en la misma transacción. Sin él, un lead que CAMBIA de
   * etapa entra arriba de la columna destino; uno que no cambia de etapa conserva su lugar.
   */
  position?: number;
  /**
   * 044 — Condición evaluada DENTRO de la transacción, con el lead ya bloqueado (`FOR UPDATE`). Si
   * devuelve `false` no se mueve nada (`changed: false`). Es lo que vuelve idempotentes y a prueba de
   * carreras a las reglas automáticas: el segundo disparo ve el lead ya movido y no hace nada.
   */
  onlyIf?: (current: { stageId: string; kind: "open" | "won" | "lost"; role: AutoStageRole | null }) => boolean;
  /** 044 — Qué regla automática lo mueve (queda en la bitácora). */
  autoRule?: AutoStageRule;
  /** Quién lo movió; NULL cuando no fue una persona. */
  actorUserId?: string | null;
  source: StageChangeSource;
  /** Obligatorio al ENTRAR a una etapa perdida. */
  lossReason?: LossReason | null;
  lossNote?: string | null;
  /** Por defecto, ahora. */
  occurredAt?: Date;
  /**
   * Otros campos del lead que se escriben en el MISMO update. Existe para que
   * el PATCH del Pipeline no tenga que hacer dos viajes cuando el dueño mueve
   * la tarjeta y toca el monto en la misma acción.
   */
  extra?: Record<string, unknown>;
  /**
   * Lo movió un flujo de automatización (paso `set_stage`). Anti-bucle: el movimiento queda en la
   * bitácora como `sistema` pero NO dispara flujos `stage_changed` — si pudiera, `A → set_stage → B →
   * set_stage → A` correría para siempre. El encadenamiento controlado llegará con `automation_run`.
   */
  viaAutomation?: boolean;
};

export async function moveLeadToStage(input: MoveInput): Promise<MoveResult> {
  const db = getDb();
  const occurredAt = input.occurredAt ?? new Date();

  // 016: se anota aquí dentro y se reporta a Meta DESPUÉS del commit. Una
  // llamada de red dentro de la transacción la mantendría abierta mientras
  // Meta piensa, y una conversión jamás vale una transacción larga.
  let toStageKind: "open" | "won" | "lost" | null = null;
  let fromStageId: string | null = null;

  const result = await db.transaction(async (tx) => {
    // 044: lo PRIMERO es el candado del pipeline de la organización (ver `lockPipeline`): un solo orden de
    // bloqueo para todos los caminos que mueven o reordenan leads, así no hay interbloqueos.
    await lockPipeline(tx, input.organizationId);

    const leadRows = await tx
      .select({ lead: schema.lead, stage: schema.pipelineStage })
      .from(schema.lead)
      .leftJoin(
        schema.pipelineStage,
        eq(schema.lead.stageId, schema.pipelineStage.id)
      )
      .where(
        scoped(
          schema.lead.organizationId,
          input.organizationId,
          eq(schema.lead.id, input.leadId)
        )
      )
      .limit(1)
      // 044: el lead queda bloqueado hasta el commit. Dos movimientos simultáneos del mismo lead se
      // serializan: el segundo ve el resultado del primero (y `onlyIf` puede descartarlo).
      .for("update", { of: schema.lead });

    const current = leadRows[0];
    if (!current) return { ok: false as const, reason: "lead_not_found" as const };

    if (
      input.onlyIf &&
      !input.onlyIf({
        stageId: current.lead.stageId,
        kind: current.stage?.kind ?? "open",
        role: current.stage?.autoRole ?? null,
      })
    ) {
      return { ok: true as const, lead: current.lead, changed: false, reorderedStageIds: [] as string[] };
    }

    const targetRows = await tx
      .select()
      .from(schema.pipelineStage)
      .where(
        scoped(
          schema.pipelineStage.organizationId,
          input.organizationId,
          eq(schema.pipelineStage.id, input.toStageId)
        )
      )
      .limit(1);

    const target = targetRows[0];
    if (!target) return { ok: false as const, reason: "stage_not_found" as const };

    const changed = current.lead.stageId !== target.id;
    toStageKind = target.kind;
    fromStageId = current.lead.stageId;

    // El motivo se exige al ENTRAR a la etapa perdida. Reordenar una tarjeta
    // que ya estaba ahí no vuelve a preguntar.
    if (changed && target.kind === "lost" && !input.lossReason) {
      return { ok: false as const, reason: "loss_reason_required" as const };
    }

    const wantsOrder = changed || input.position !== undefined;

    // Cambio de etapa SIN índice pedido → entra arriba con `min − 1` (sin renumerar el destino).
    const entraArriba = changed && input.position === undefined;
    const provisional = entraArriba ? await topPosition(tx, input.organizationId, target.id) : undefined;

    const updated = await tx
      .update(schema.lead)
      .set({
        ...(input.extra ?? {}),
        stageId: target.id,
        ...(provisional !== undefined ? { position: provisional } : {}),
        updatedAt: new Date(),
      })
      .where(
        scoped(
          schema.lead.organizationId,
          input.organizationId,
          eq(schema.lead.id, input.leadId)
        )
      )
      .returning();

    const leadRow = updated[0];
    if (!leadRow) return { ok: false as const, reason: "lead_not_found" as const };

    // 044: renumeración transaccional. El destino (si se pidió un índice) y el origen (se compacta).
    const reorderedStageIds: string[] = [];
    if (wantsOrder) {
      if (input.position !== undefined) {
        const sin = await columnOrder(tx, input.organizationId, target.id, leadRow.id);
        const orden = placeAt(sin, leadRow.id, input.position);
        if ((await renumberColumn(tx, input.organizationId, orden)) > 0) reorderedStageIds.push(target.id);
      }
      if (changed) {
        const origen = await columnOrder(tx, input.organizationId, current.lead.stageId);
        if ((await renumberColumn(tx, input.organizationId, origen)) > 0) reorderedStageIds.push(current.lead.stageId);
      }
    }

    if (changed) {
      await tx.insert(schema.leadStageEvent).values({
        id: newId("leadStageEvent"),
        organizationId: input.organizationId,
        leadId: leadRow.id,
        contactId: leadRow.contactId,
        fromStageId: current.stage?.id ?? null,
        fromStageName: current.stage?.name ?? null,
        toStageId: target.id,
        toStageName: target.name,
        toStageKind: target.kind,
        occurredAt,
        actorUserId: input.actorUserId ?? null,
        source: input.viaAutomation ? "sistema" : input.source,
        approximate: false,
        lossReason: target.kind === "lost" ? input.lossReason ?? null : null,
        lossNote: target.kind === "lost" ? input.lossNote ?? null : null,
        autoRule: input.autoRule ?? null,
      });
    }

    return { ok: true as const, lead: leadRow, changed, reorderedStageIds };
  });

  // 044 — Tiempo real: el tablero pide un delta (un movimiento) y, si se renumeró, vuelve a pedir esas columnas.
  // Después del commit, como todo evento del bus.
  if (result.ok && (result.changed || result.reorderedStageIds.length > 0)) {
    publish(input.organizationId, {
      type: "pipeline.lead",
      data: { leadId: result.lead.id, stageId: result.lead.stageId, fromStageId },
    });
    if (result.reorderedStageIds.length > 0) {
      publish(input.organizationId, { type: "pipeline.reordered", data: { stageIds: result.reorderedStageIds } });
    }
  }

  // 016 — Atribución: si esta instancia la tiene encendida, entrar a la etapa
  // que el negocio marcó como "lead calificado" o a una etapa ganada se le
  // reporta a Meta. Best-effort y ya fuera de la transacción: un fallo aquí
  // jamás puede costar el movimiento del lead, que ya está en firme.
  if (result.ok && result.changed && toStageKind !== null) {
    await reportStageChange({
      organizationId: input.organizationId,
      leadId: result.lead.id,
      contactId: result.lead.contactId,
      toStageId: result.lead.stageId,
      toStageKind,
    });
  }

  // Automatizaciones: entrar a una etapa puede disparar un flujo. Igual que lo anterior, ya fuera de la
  // transacción y sin poder fallar hacia arriba (`onLeadStageChanged` nunca lanza), y apagado no hace nada.
  if (result.ok && result.changed && !input.viaAutomation) {
    await onLeadStageChanged({
      organizationId: input.organizationId,
      leadId: result.lead.id,
      contactId: result.lead.contactId,
      toStageId: result.lead.stageId,
    });
  }

  return result;
}

/**
 * Evento de nacimiento del lead. Sin él, el embudo no tendría de dónde arrancar
 * y "prospectos que entraron" no podría contarse desde la bitácora.
 *
 * Best-effort a propósito: quien lo llama viene de crear un lead (a veces desde
 * la ingesta de un mensaje de WhatsApp), y un fallo aquí jamás debe tumbar esa
 * ruta. El lead sin evento aparecería con su fecha de creación de todos modos.
 */
export async function recordLeadCreated(input: {
  organizationId: string;
  leadId: string;
  contactId: string;
  stageId: string;
  occurredAt?: Date;
  actorUserId?: string | null;
  source?: StageChangeSource;
}): Promise<void> {
  const db = getDb();
  const stage = await db
    .select({
      id: schema.pipelineStage.id,
      name: schema.pipelineStage.name,
      kind: schema.pipelineStage.kind,
    })
    .from(schema.pipelineStage)
    .where(
      scoped(
        schema.pipelineStage.organizationId,
        input.organizationId,
        eq(schema.pipelineStage.id, input.stageId)
      )
    )
    .limit(1);

  const s = stage[0];
  if (!s) return;

  await db.insert(schema.leadStageEvent).values({
    id: newId("leadStageEvent"),
    organizationId: input.organizationId,
    leadId: input.leadId,
    contactId: input.contactId,
    fromStageId: null,
    fromStageName: null,
    toStageId: s.id,
    toStageName: s.name,
    toStageKind: s.kind,
    occurredAt: input.occurredAt ?? new Date(),
    actorUserId: input.actorUserId ?? null,
    source: input.source ?? "sistema",
    approximate: false,
    // Un lead no puede nacer perdido: el CHECK de la base lo permitiría solo
    // con motivo, y aquí nunca hay uno que capturar.
    lossReason: null,
    lossNote: null,
  });

  // Automatizaciones: un lead nuevo puede disparar un flujo `lead_created`. Nunca lanza.
  await onLeadCreated({
    organizationId: input.organizationId,
    leadId: input.leadId,
    contactId: input.contactId,
  });
}

/**
 * Reubicación masiva al eliminar una etapa. Un evento por lead: el embudo debe
 * poder explicar por qué 30 tarjetas cambiaron de columna el mismo minuto.
 */
export async function relocateLeadsFromStage(input: {
  organizationId: string;
  fromStageId: string;
  toStageId: string;
  actorUserId?: string | null;
}): Promise<number> {
  const db = getDb();
  const leads = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        input.organizationId,
        eq(schema.lead.stageId, input.fromStageId)
      )
    )
    .orderBy(asc(schema.lead.position));

  const stageRows = await db
    .select({ name: schema.pipelineStage.name })
    .from(schema.pipelineStage)
    .where(
      scoped(
        schema.pipelineStage.organizationId,
        input.organizationId,
        eq(schema.pipelineStage.id, input.fromStageId)
      )
    )
    .limit(1);
  const fromName = stageRows[0]?.name ?? "una etapa eliminada";

  let moved = 0;
  for (const l of leads) {
    const res = await moveLeadToStage({
      organizationId: input.organizationId,
      leadId: l.id,
      toStageId: input.toStageId,
      // 044: al final de la columna destino, en el mismo orden en que estaban (no se invierten).
      position: AL_FINAL,
      actorUserId: input.actorUserId ?? null,
      source: "sistema",
      // Si el destino resulta ser la etapa perdida, el motivo no se puede
      // inventar pero tampoco puede faltar: se registra lo que de verdad pasó.
      lossReason: "otro",
      lossNote: `Reubicado al eliminar la etapa "${fromName}"`,
    });
    if (res.ok) moved += 1;
  }
  return moved;
}

/** El último motivo de pérdida registrado de un lead, si lo hay. */
export async function lastLossReason(
  organizationId: string,
  leadId: string
): Promise<{ reason: LossReason; note: string | null; at: Date } | null> {
  const db = getDb();
  const rows = await db
    .select({
      lossReason: schema.leadStageEvent.lossReason,
      lossNote: schema.leadStageEvent.lossNote,
      occurredAt: schema.leadStageEvent.occurredAt,
    })
    .from(schema.leadStageEvent)
    .where(
      scoped(
        schema.leadStageEvent.organizationId,
        organizationId,
        and(
          eq(schema.leadStageEvent.leadId, leadId),
          eq(schema.leadStageEvent.toStageKind, "lost")
        )
      )
    )
    .orderBy(asc(schema.leadStageEvent.occurredAt))
    .limit(50);

  const last = rows.filter((r) => r.lossReason).at(-1);
  if (!last?.lossReason) return null;
  return {
    reason: last.lossReason,
    note: last.lossNote,
    at: last.occurredAt,
  };
}
