import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { decideAutoStage, RULE_TARGET } from "@/lib/lead-auto-stage";
import type { AutoStageRule } from "@/lib/types";
import { getBranding } from "@/server/branding";
import { moveLeadToStage } from "@/server/leads/stage-history";

/**
 * 044 — Avance AUTOMÁTICO del lead (primer mensaje → conversación, cita → interesado, venta → cliente).
 *
 * Es solo el pegamento: la decisión vive en `decideAutoStage` (pura) y el movimiento en la puerta única
 * `moveLeadToStage`, que vuelve a evaluar la condición DENTRO de la transacción con el lead bloqueado
 * (`onlyIf`): dos señales casi simultáneas —la respuesta de la IA y la del operador— mueven el lead una
 * sola vez y la bitácora no registra un movimiento falso.
 *
 * Reglas del negocio que esto respeta:
 *  - Solo hacia adelante; jamás saca un lead de una etapa ganada/perdida.
 *  - Una etapa abierta sin rol la puso el dueño a propósito: las dos primeras reglas no la tocan.
 *  - Sin lead no se crea uno (una venta de mostrador no ensucia «prospectos»).
 *  - Si el negocio no tiene la etapa de destino (sin rol asignado), no pasa nada.
 *
 * NUNCA lanza: quien llama viene de enviar un mensaje, agendar una cita o cobrar, y eso ya está en
 * firme; un fallo aquí se registra y se sigue.
 */
export async function advanceLeadForContact(input: {
  organizationId: string;
  contactId: string;
  rule: AutoStageRule;
  /** Venta: si el lead no tenía monto, se queda con el de la venta (el tablero y el evento de compra a Meta lo usan). */
  amountCents?: number;
  actorUserId?: string | null;
}): Promise<{ moved: boolean }> {
  try {
    const db = getDb();
    const leadRows = await db
      .select({ id: schema.lead.id, amountCents: schema.lead.amountCents })
      .from(schema.lead)
      .where(scoped(schema.lead.organizationId, input.organizationId, eq(schema.lead.contactId, input.contactId)))
      .limit(1);
    const lead = leadRows[0];
    if (!lead) return { moved: false };

    const targetRole = RULE_TARGET[input.rule];
    const stageRows = await db
      .select({ id: schema.pipelineStage.id })
      .from(schema.pipelineStage)
      .where(
        scoped(
          schema.pipelineStage.organizationId,
          input.organizationId,
          eq(schema.pipelineStage.autoRole, targetRole)
        )
      )
      .limit(1);
    const target = stageRows[0];
    if (!target) return { moved: false };

    const extra: Record<string, unknown> = {};
    if (input.rule === "sale" && input.amountCents !== undefined && input.amountCents > 0 && lead.amountCents === null) {
      extra.amountCents = input.amountCents;
      extra.currency = (await getBranding(input.organizationId)).currency;
    }

    const res = await moveLeadToStage({
      organizationId: input.organizationId,
      leadId: lead.id,
      toStageId: target.id,
      actorUserId: input.actorUserId ?? null,
      source: "sistema",
      autoRule: input.rule,
      onlyIf: (current) => decideAutoStage({ rule: input.rule, current: { kind: current.kind, role: current.role } }) === targetRole,
      extra,
    });
    return { moved: res.ok && res.changed };
  } catch (error) {
    console.error(`[pipeline] la regla ${input.rule} no pudo mover el lead:`, error);
    return { moved: false };
  }
}

/**
 * 044 — Regla `first_reply`. Las conversaciones del Laboratorio (`is_test`) nunca mueven leads. Un envío
 * fallido no llega aquí (lanza antes). Nunca lanza.
 */
export async function avanzarPorRespuesta(organizationId: string, conversationId: string): Promise<void> {
  try {
    const rows = await getDb()
      .select({ contactId: schema.conversation.contactId, isTest: schema.conversation.isTest })
      .from(schema.conversation)
      .where(scoped(schema.conversation.organizationId, organizationId, eq(schema.conversation.id, conversationId)))
      .limit(1);
    const c = rows[0];
    if (!c || c.isTest) return;
    await advanceLeadForContact({ organizationId, contactId: c.contactId, rule: "first_reply" });
  } catch (error) {
    console.error("[pipeline] first_reply:", error);
  }
}

