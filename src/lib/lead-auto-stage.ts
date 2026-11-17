import type { AutoStageRole, AutoStageRule } from "@/lib/types";

/**
 * 044 — Reglas de avance AUTOMÁTICO del lead. Puras: sin base de datos ni red, para probarlas enteras.
 *
 * Principios (no negociables):
 *  - Solo hacia adelante: nunca retrocede un lead ni lo saca de una etapa ganada/perdida.
 *  - Una etapa abierta SIN rol la puso el dueño a propósito: las reglas 1 y 2 no la tocan.
 *  - La venta es la señal más fuerte: salta desde cualquier etapa abierta (con o sin rol).
 */

export type StageKind = "open" | "won" | "lost";

/** Etapa en la que está el lead ahora. */
export type CurrentStage = { kind: StageKind; role: AutoStageRole | null };

/** Qué rol de etapa persigue cada regla. */
export const RULE_TARGET: Record<AutoStageRule, AutoStageRole> = {
  first_reply: "conversation",
  booking: "interested",
  sale: "client",
};

/** Desde qué roles (de una etapa ABIERTA) puede avanzar cada regla. `"any"` = cualquier etapa abierta. */
const RULE_FROM: Record<AutoStageRule, readonly AutoStageRole[] | "any"> = {
  first_reply: ["new"],
  booking: ["new", "conversation"],
  sale: "any",
};

/** El rol al que debe moverse el lead, o `null` si la regla no aplica (el caso común, y es seguro). */
export function decideAutoStage(input: { rule: AutoStageRule; current: CurrentStage }): AutoStageRole | null {
  const { rule, current } = input;
  if (current.kind !== "open") return null; // ganadas y perdidas requieren trato manual
  const target = RULE_TARGET[rule];
  if (current.role === target) return null; // ya está donde la regla lo llevaría
  const from = RULE_FROM[rule];
  if (from === "any") return target;
  return current.role !== null && from.includes(current.role) ? target : null;
}

/** El texto que ve el operador cuando una regla movió el lead. */
export const AUTO_RULE_LABEL: Record<AutoStageRule, string> = {
  first_reply: "primera respuesta",
  booking: "cita agendada",
  sale: "venta registrada",
};

/** Texto de ayuda de cada rol en el gestor de etapas. */
export const AUTO_ROLE_LABEL: Record<AutoStageRole, { name: string; help: string }> = {
  new: { name: "Nuevo", help: "Los contactos que escriben por primera vez llegan aquí." },
  conversation: {
    name: "En conversación",
    help: "Los leads llegan aquí solos cuando un operador o la IA les responde por primera vez.",
  },
  interested: { name: "Interesado", help: "Los leads llegan aquí solos cuando agendan una cita." },
  client: { name: "Cliente", help: "Los leads llegan aquí solos cuando se les registra una venta en Caja." },
};
