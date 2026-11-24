import { eq } from "drizzle-orm";
import { manualDedupeKey, manualRunContext } from "@/lib/automation";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { AutomationError } from "@/server/automation/http";
import { dbTriggerStore, type TriggerStore } from "@/server/automation/trigger-store";

/**
 * Automatizaciones — el disparo MANUAL: arrancar un flujo `manual` para UN contacto.
 *
 * No es un camino aparte del motor: crea la misma ejecución (`automation_run` + su primera tarea) que cualquier
 * disparador, por `enqueueFirstStep`. Por eso hereda, sin repetirlos aquí, los controles que viven en el motor:
 * baja del contacto, tope de mensajes por contacto, ventana de 24 h de Meta (texto o plantilla), solo chats reales de
 * WhatsApp (nada del Laboratorio) y reintentos. Lo único que decide esta función es si la ejecución puede NACER.
 *
 * Idempotencia: la llave es el `batchId` que la pantalla genera al abrir el diálogo. El mismo `batchId` para el mismo
 * contacto y flujo no crea otra ejecución (doble clic, reintento de red); otro `batchId` es otra ejecución a propósito.
 */

export type ManualFlow = { id: string; triggerType: string; active: boolean };

export type ManualDeps = {
  store: TriggerStore;
  loadFlow(organizationId: string, flowId: string): Promise<ManualFlow | null>;
  contactExists(organizationId: string, contactId: string): Promise<boolean>;
  now(): Date;
};

export const dbManualDeps: ManualDeps = {
  store: dbTriggerStore,
  async loadFlow(organizationId, flowId) {
    const f = schema.automationFlow;
    const [row] = await getDb()
      .select({ id: f.id, triggerType: f.triggerType, active: f.active })
      .from(f)
      .where(scoped(f.organizationId, organizationId, eq(f.id, flowId)))
      .limit(1);
    return row ?? null;
  },
  async contactExists(organizationId, contactId) {
    const c = schema.contact;
    const [row] = await getDb()
      .select({ id: c.id })
      .from(c)
      .where(scoped(c.organizationId, organizationId, eq(c.id, contactId)))
      .limit(1);
    return !!row;
  },
  now: () => new Date(),
};

export type ManualResult = { started: boolean };

/**
 * Dispara el flujo para el contacto. `started: false` = esa llave ya estaba (se ignora, no es un error).
 * Errores esperados (`AutomationError`): el flujo no existe o no es manual, está apagado, el contacto no existe o no
 * tiene un chat real de WhatsApp al que mandar.
 */
export async function triggerManualFlow(
  input: { organizationId: string; flowId: string; contactId: string; batchId: string; triggeredBy: string },
  deps: ManualDeps = dbManualDeps
): Promise<ManualResult> {
  const flow = await deps.loadFlow(input.organizationId, input.flowId);
  if (!flow) throw new AutomationError("not_found", 404, "El flujo no existe");
  if (flow.triggerType !== "manual") {
    throw new AutomationError("not_manual_flow", 422, "Este flujo no es manual: solo los flujos con disparador «Manual» se inician a mano");
  }
  if (!flow.active) throw new AutomationError("flow_inactive", 409, "Enciende el flujo para poder ejecutarlo");
  if (!(await deps.contactExists(input.organizationId, input.contactId))) {
    throw new AutomationError("contact_not_found", 404, "El contacto no existe");
  }
  // Sin chat real de WhatsApp no hay a dónde mandar (y un contacto del Laboratorio jamás recibe nada): se dice ahora
  // en vez de dejar una ejecución que fallaría sola en la cola.
  if (!(await deps.store.hasRealConversation(input.organizationId, input.contactId))) {
    throw new AutomationError("no_conversation", 422, "Este contacto no tiene un chat de WhatsApp al que enviar");
  }

  const started = await deps.store.enqueueFirstStep({
    organizationId: input.organizationId,
    flowId: input.flowId,
    contactId: input.contactId,
    scheduledFor: deps.now(),
    dedupeKey: manualDedupeKey(input.batchId),
    context: manualRunContext(input.triggeredBy, input.batchId),
  });
  return { started };
}
