import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { publish } from "@/server/events/bus";
import { notifyHandoff } from "@/server/notifications/service";

/**
 * Automatizaciones — la acción del paso `human_handoff`: pasa una conversación a una persona del equipo.
 *
 * Reutiliza la misma pausa que el toggle de la bandeja y el traspaso del agente (`aiEnabled`, `handoffAt`,
 * `handoffReason`), con un motivo propio (`automatizacion`), el mismo evento en vivo y el mismo aviso de «Atención humana».
 *
 * Idempotente y sin carreras: la transición va en UN `UPDATE … WHERE handoff_at IS NULL`, así que reintentar el paso (o dos
 * flujos a la vez) no pisa la hora ni el motivo originales ni duplica el aviso. Todo va acotado a la organización, y una
 * conversación del Laboratorio (sandbox) no se toca jamás.
 */
export type HandoffStatus = "paused" | "already_paused" | "not_found";

export async function handoffConversation(input: { organizationId: string; conversationId: string; note?: string }): Promise<{ status: HandoffStatus }> {
  const db = getDb();
  const c = schema.conversation;
  const now = new Date();
  const moved = await db
    .update(c)
    .set({ aiEnabled: false, handoffAt: now, handoffReason: "automatizacion", updatedAt: now })
    .where(and(eq(c.organizationId, input.organizationId), eq(c.id, input.conversationId), eq(c.isTest, false), isNull(c.handoffAt)))
    .returning({ id: c.id });
  if (moved.length === 1) {
    publish(input.organizationId, { type: "conversation.updated", data: { conversation: { id: input.conversationId, handoffReason: "automatizacion" } } });
    await notifyHandoff(input.organizationId, input.conversationId, "automatizacion", input.note);
    return { status: "paused" };
  }
  const [existing] = await db
    .select({ id: c.id })
    .from(c)
    .where(scoped(c.organizationId, input.organizationId, eq(c.id, input.conversationId), eq(c.isTest, false)))
    .limit(1);
  return { status: existing ? "already_paused" : "not_found" };
}
