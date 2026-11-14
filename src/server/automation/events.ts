import type { FlowTriggerType } from "@/lib/automation-schemas";
import type { FlowRef, TriggerStore } from "@/server/automation/trigger-store";

/**
 * Automatizaciones — el punto de entrada ÚNICO de eventos.
 *
 * Un evento del negocio (un lead nace, cambia de etapa, se agenda una cita…) se emite aquí: se buscan los flujos
 * activos de ese disparador, se filtran por sus ajustes, y por cada uno se arranca una ejecución
 * (`automation_run`) con su primer paso en la cola. La idempotencia la da la llave: el mismo evento, el mismo
 * contacto y el mismo flujo arrancan UNA sola vez.
 *
 * No consulta nada por su cuenta: el mundo entra por `TriggerStore`, así las reglas se prueban con dobles. Quien
 * lo llama decide si el evento aplica (apagado, cita de prueba…) y atrapa los errores: emitir nunca debe costar
 * la operación que lo originó.
 */

export type AutomationEvent = {
  organizationId: string;
  trigger: FlowTriggerType;
  contactId: string;
  /** Idempotencia: el mismo evento repetido arranca una sola vez por flujo. */
  dedupeKey: string;
  /** Disparadores de cita: la cita que origina la ejecución (viaja con ella). */
  bookingId?: string | null;
  /** Datos estables del arranque que viajan en el `run` (anuncio, servicio…). */
  context?: Record<string, unknown>;
  /** Cuándo debe correr el primer paso (por defecto, ahora). */
  scheduledFor?: Date;
  /** Acota qué flujos reaccionan (p. ej. `stage_changed` con su etapa). Sin él, todos los activos. */
  matches?: (flow: FlowRef) => boolean;
};

/** Devuelve cuántas ejecuciones nuevas arrancó (0 si no había flujos, no aplicaba o ya estaban arrancadas). */
export async function emitAutomationEvent(
  event: AutomationEvent,
  store: TriggerStore,
  now: () => Date = () => new Date()
): Promise<number> {
  const flows = (await store.activeFlows(event.organizationId, event.trigger)).filter((f) => event.matches?.(f) ?? true);
  if (flows.length === 0) return 0;
  // Sin chat de WhatsApp real no hay a dónde mandar (y un contacto del Laboratorio jamás recibe nada): se evita
  // llenar la cola de ejecuciones que fallarían al instante.
  if (!(await store.hasRealConversation(event.organizationId, event.contactId))) return 0;

  let started = 0;
  for (const flow of flows) {
    const inserted = await store.enqueueFirstStep({
      organizationId: event.organizationId,
      flowId: flow.id,
      contactId: event.contactId,
      scheduledFor: event.scheduledFor ?? now(),
      dedupeKey: event.dedupeKey,
      ...(event.bookingId ? { bookingId: event.bookingId } : {}),
      ...(event.context ? { context: event.context } : {}),
    });
    if (inserted) started += 1;
  }
  return started;
}
