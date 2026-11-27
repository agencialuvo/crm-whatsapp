import { and, eq, gt } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { decidirVigencia, type MotivoCancelacion } from "@/lib/agent/vigencia";

/**
 * Mejora 11 — Relee el estado AHORA, tras la llamada al modelo y antes de ejecutar la acción o enviar: la
 * conversación (IA encendida, sin traspaso), el interruptor del agente y si una persona ya contestó después del
 * entrante que este turno atiende. Si la consulta falla, el turno se cancela (mejor callar que hablar encima de
 * una persona; el mensaje sigue en la Bandeja).
 */
export async function revalidarTurno(input: {
  organizationId: string;
  conversationId: string;
  /** Hora del entrante que este turno contesta. */
  desde: Date;
}): Promise<{ ok: true } | { ok: false; motivo: MotivoCancelacion | "error_consulta" }> {
  const { organizationId, conversationId, desde } = input;
  try {
    const db = getDb();
    const [conv] = await db
      .select({
        aiEnabled: schema.conversation.aiEnabled,
        handoffAt: schema.conversation.handoffAt,
        isTest: schema.conversation.isTest,
      })
      .from(schema.conversation)
      .where(scoped(schema.conversation.organizationId, organizationId, eq(schema.conversation.id, conversationId)))
      .limit(1);
    const [perfil] = await db
      .select({ enabled: schema.agentProfile.enabled })
      .from(schema.agentProfile)
      .where(scoped(schema.agentProfile.organizationId, organizationId))
      .limit(1);
    const [humano] = await db
      .select({ id: schema.message.id })
      .from(schema.message)
      .where(
        scoped(
          schema.message.organizationId,
          organizationId,
          and(
            eq(schema.message.conversationId, conversationId),
            eq(schema.message.direction, "out"),
            eq(schema.message.aiGenerated, false),
            gt(schema.message.createdAt, desde)
          )
        )
      )
      .limit(1);
    return decidirVigencia({
      conversation: conv ?? null,
      agentEnabled: perfil ? perfil.enabled : null,
      personaRespondio: !!humano,
    });
  } catch (err) {
    console.error(`[agente] no se pudo revalidar el turno de ${conversationId}; no se envía:`, err);
    return { ok: false, motivo: "error_consulta" };
  }
}
