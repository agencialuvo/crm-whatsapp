import {
  birthdayDedupeKey,
  birthdaySendAt,
  birthdaysDueOn,
  leadCreatedDedupeKey,
  parseTriggerConfig,
  splitISODate,
  stageDedupeKey,
  stageFlowMatches,
} from "@/lib/automation";
import { todayInTz } from "@/lib/time/slots";
import { automationsEnabled } from "@/server/automation/flag";
import { dbTriggerStore, type TriggerStore } from "@/server/automation/trigger-store";

/**
 * Automatizaciones — los disparadores: lo que llena `automation_queue` solo.
 *
 * - Cumpleaños: un barrido (`runBirthdayTrigger`) que corre al arrancar y cada rato; es idempotente
 *   (una vez por contacto, flujo y año), así que repetirlo o reiniciar la app no duplica nada.
 * - Cambio de etapa y lead nuevo: se llaman desde la única puerta del embudo (`stage-history.ts`),
 *   ya fuera de su transacción.
 *
 * Todo el orquestado es puro respecto del mundo: entra por `TriggerStore`, así las reglas se prueban
 * con dobles. Apagado (`AUTOMATIONS`) no hace nada y no consulta la base.
 */

export type BirthdayRun = { organizations: number; flows: number; contacts: number; enqueued: number };

/**
 * Encola el saludo de cumpleaños de HOY (en la zona horaria de cada negocio) para quien cumple años
 * y tiene un flujo `birthday` activo. Una organización que falla no frena a las demás.
 */
export async function runBirthdayTrigger(
  now: Date = new Date(),
  store: TriggerStore = dbTriggerStore
): Promise<BirthdayRun> {
  const run: BirthdayRun = { organizations: 0, flows: 0, contacts: 0, enqueued: 0 };
  for (const organizationId of await store.listOrganizationIds()) {
    try {
      const flows = await store.activeFlows(organizationId, "birthday");
      if (flows.length === 0) continue;
      run.organizations += 1;

      // El día es el del NEGOCIO, no el del servidor: a las 23:00 en Lima ya es mañana en UTC.
      const timezone = await store.timezone(organizationId);
      const today = todayInTz(now, timezone);
      const { year } = splitISODate(today);
      const contacts = await store.birthdayContacts(organizationId, birthdaysDueOn(today));
      run.contacts += contacts.length;

      for (const flow of flows) {
        run.flows += 1;
        const sendAt = birthdaySendAt(today, parseTriggerConfig(flow.triggerConfig).hour, timezone);
        if (!sendAt) continue;
        for (const contactId of contacts) {
          const inserted = await store.enqueueFirstStep({
            organizationId,
            flowId: flow.id,
            contactId,
            // Si el barrido llega después de esa hora (la app arrancó tarde), queda vencida y sale al
            // instante: un saludo tarde, el mismo día, vale más que ninguno.
            scheduledFor: sendAt,
            dedupeKey: birthdayDedupeKey(year),
          });
          if (inserted) run.enqueued += 1;
        }
      }
    } catch (err) {
      console.error(`[automatizaciones] el barrido de cumpleaños falló en ${organizationId}:`, err);
    }
  }
  return run;
}

type LeadEvent = { organizationId: string; leadId: string; contactId: string };

/**
 * Un lead entró a una etapa: encola el primer paso de cada flujo `stage_changed` activo que reaccione
 * a ella. Una vez por lead y etapa (ir y volver no repite el mensaje). Nunca lanza: lo llama la
 * puerta del embudo y un fallo aquí no puede costar el movimiento del lead.
 */
export async function onLeadStageChanged(
  input: LeadEvent & { toStageId: string },
  store: TriggerStore = dbTriggerStore,
  enabled: () => boolean = automationsEnabled,
  now: () => Date = () => new Date()
): Promise<number> {
  if (!enabled()) return 0;
  try {
    const flows = (await store.activeFlows(input.organizationId, "stage_changed")).filter((f) =>
      stageFlowMatches(parseTriggerConfig(f.triggerConfig), input.toStageId)
    );
    return await enqueueForFlows(input, flows, stageDedupeKey(input.leadId, input.toStageId), store, now);
  } catch (err) {
    console.error("[automatizaciones] el disparador de cambio de etapa falló:", err);
    return 0;
  }
}

/** Nació un lead: encola el primer paso de cada flujo `lead_created` activo. Una vez por lead. Nunca lanza. */
export async function onLeadCreated(
  input: LeadEvent,
  store: TriggerStore = dbTriggerStore,
  enabled: () => boolean = automationsEnabled,
  now: () => Date = () => new Date()
): Promise<number> {
  if (!enabled()) return 0;
  try {
    const flows = await store.activeFlows(input.organizationId, "lead_created");
    return await enqueueForFlows(input, flows, leadCreatedDedupeKey(input.leadId), store, now);
  } catch (err) {
    console.error("[automatizaciones] el disparador de lead nuevo falló:", err);
    return 0;
  }
}

async function enqueueForFlows(
  input: LeadEvent,
  flows: { id: string }[],
  dedupeKey: string,
  store: TriggerStore,
  now: () => Date
): Promise<number> {
  if (flows.length === 0) return 0;
  // Sin chat de WhatsApp real no hay a dónde mandar (y un contacto del Laboratorio jamás recibe nada):
  // se evita llenar la cola de tareas que fallarían al instante.
  if (!(await store.hasRealConversation(input.organizationId, input.contactId))) return 0;

  let enqueued = 0;
  for (const flow of flows) {
    const inserted = await store.enqueueFirstStep({
      organizationId: input.organizationId,
      flowId: flow.id,
      contactId: input.contactId,
      scheduledFor: now(),
      dedupeKey,
    });
    if (inserted) enqueued += 1;
  }
  return enqueued;
}
