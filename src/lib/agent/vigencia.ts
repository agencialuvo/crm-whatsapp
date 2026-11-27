/**
 * Mejora 11 — ¿Sigue en pie el turno del agente justo antes de actuar? Pura.
 *
 * El turno decide si contestar ANTES de llamar al modelo, y la llamada (con reintentos) puede tardar minutos.
 * Si en ese tiempo alguien apagó la IA de la conversación, la tomó una persona (traspaso), se apagó el agente o
 * contestaron desde la Bandeja, el agente no debe hablar encima.
 */

export type MotivoCancelacion =
  | "conversacion_borrada"
  | "ia_apagada"
  | "traspasada"
  | "agente_apagado"
  | "persona_respondio";

export type EstadoDelTurno = {
  /** `null` = la conversación ya no existe. */
  conversation: { aiEnabled: boolean; handoffAt: Date | null; isTest: boolean } | null;
  /** El interruptor global del agente (`agent_profile.enabled`); `null` = no hay perfil. */
  agentEnabled: boolean | null;
  /** Hay un saliente de una PERSONA (no de la IA) posterior al entrante que este turno contesta. */
  personaRespondio: boolean;
};

export function decidirVigencia(e: EstadoDelTurno): { ok: true } | { ok: false; motivo: MotivoCancelacion } {
  if (!e.conversation) return { ok: false, motivo: "conversacion_borrada" };
  if (e.conversation.handoffAt) return { ok: false, motivo: "traspasada" };
  if (!e.conversation.aiEnabled) return { ok: false, motivo: "ia_apagada" };
  // El Laboratorio evalúa el comportamiento aunque el agente esté apagado (igual que al empezar el turno).
  if (!e.conversation.isTest && e.agentEnabled !== true) return { ok: false, motivo: "agente_apagado" };
  if (e.personaRespondio) return { ok: false, motivo: "persona_respondio" };
  return { ok: true };
}
