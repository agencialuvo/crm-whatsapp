import {
  bookingConfirmedDedupeKey,
  bookingCreatedDedupeKey,
  bookingNoShowDedupeKey,
  birthdayDedupeKey,
  birthdaySendAt,
  birthdayTargetDate,
  birthdaysDueOn,
  leadCreatedDedupeKey,
  loyaltyFlowMatches,
  loyaltyRewardDedupeKey,
  loyaltyStampDedupeKey,
  parseTriggerConfig,
  splitISODate,
  stageDedupeKey,
  stageFlowMatches,
  stampFlowMatches,
  tagAddedDedupeKey,
  tagFlowMatches,
} from "@/lib/automation";
import type { LoyaltyMilestone } from "@/lib/db/schema";
import { todayInTz } from "@/lib/time/slots";
import { emitAutomationEvent } from "@/server/automation/events";
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
 * Encola, HOY (en la zona horaria de cada negocio), el saludo de cumpleaños de cada flujo `birthday`
 * activo: el de quien cumple años hoy o, si el flujo tiene `daysOffset` (-1, -2…), el de quien los cumple
 * dentro de esos días. Una organización que falla no frena a las demás.
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
      // Cada flujo mira un cumpleaños distinto según su `daysOffset` (0 = hoy, -1 = mañana…): los
      // contactos se piden una vez por fecha objetivo, no una vez por flujo.
      const byTarget = new Map<string, string[]>();

      for (const flow of flows) {
        run.flows += 1;
        const config = parseTriggerConfig(flow.triggerConfig);
        const target = birthdayTargetDate(today, config.daysOffset);
        let contacts = byTarget.get(target);
        if (!contacts) {
          contacts = await store.birthdayContacts(organizationId, birthdaysDueOn(target));
          byTarget.set(target, contacts);
          run.contacts += contacts.length;
        }
        // El saludo sale HOY a su hora, aunque el cumpleaños sea dentro de unos días.
        const sendAt = birthdaySendAt(today, config.hour, timezone);
        if (!sendAt) continue;
        // Una vez por contacto, flujo y cumpleaños: el año es el del cumpleaños (el 31 de dic. un
        // saludo «1 día antes» es del cumpleaños del 1 de ene. del año que viene).
        const { year } = splitISODate(target);
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
    return await emitAutomationEvent(
      {
        organizationId: input.organizationId,
        trigger: "stage_changed",
        contactId: input.contactId,
        dedupeKey: stageDedupeKey(input.leadId, input.toStageId),
        matches: (f) => stageFlowMatches(parseTriggerConfig(f.triggerConfig), input.toStageId),
      },
      store,
      now
    );
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
    return await emitAutomationEvent(
      {
        organizationId: input.organizationId,
        trigger: "lead_created",
        contactId: input.contactId,
        dedupeKey: leadCreatedDedupeKey(input.leadId),
      },
      store,
      now
    );
  } catch (err) {
    console.error("[automatizaciones] el disparador de lead nuevo falló:", err);
    return 0;
  }
}

/**
 * Se le asignó una etiqueta a un contacto: arranca cada flujo `tag_added` activo que reaccione a ella. La llave lleva la
 * hora de la asignación: quitarla y volver a ponerla rearma el flujo; el mismo aviso dos veces no lo duplica.
 * Nunca lanza (lo llama `assignTag` y un fallo aquí no puede costar la asignación). Quien la llama decide si el
 * evento aplica: una etiqueta puesta por una automatización NO lo emite (anti-bucle, como `set_stage`).
 */
export async function onTagAdded(
  input: { organizationId: string; contactId: string; tagId: string; assignedAt: Date },
  store: TriggerStore = dbTriggerStore,
  enabled: () => boolean = automationsEnabled,
  now: () => Date = () => new Date()
): Promise<number> {
  if (!enabled()) return 0;
  try {
    return await emitAutomationEvent(
      {
        organizationId: input.organizationId,
        trigger: "tag_added",
        contactId: input.contactId,
        dedupeKey: tagAddedDedupeKey(input.tagId, input.assignedAt),
        context: { tagId: input.tagId },
        matches: (f) => tagFlowMatches(parseTriggerConfig(f.triggerConfig), input.tagId),
      },
      store,
      now
    );
  } catch (err) {
    console.error("[automatizaciones] el disparador de etiqueta falló:", err);
    return 0;
  }
}

/** Lo que se sabe de un premio desbloqueado: viaja en el `context` de la ejecución. */
export type LoyaltyUnlockInput = {
  organizationId: string;
  contactId: string;
  /** El movimiento de sellos que cruzó el hito (`loyalty_transaction.id`): con el hito, la llave de idempotencia. */
  transactionId: string;
  currentStamps: number;
  unlocked: readonly LoyaltyMilestone[];
};

/**
 * Un cliente desbloqueó uno o más premios. DEBE llamarse DESPUÉS del commit de la transacción que sumó el sello (el
 * mensaje no puede salir por un sello que luego se deshace). Arranca cada flujo `loyalty_reward_unlocked` activo, una
 * vez por premio cruzado, con el detalle del hito en `context.loyalty`. Nunca lanza.
 */
export async function onLoyaltyRewardUnlocked(
  input: LoyaltyUnlockInput,
  store: TriggerStore = dbTriggerStore,
  enabled: () => boolean = automationsEnabled,
  now: () => Date = () => new Date()
): Promise<number> {
  if (!enabled() || input.unlocked.length === 0) return 0;
  let started = 0;
  for (const m of input.unlocked) {
    try {
      started += await emitAutomationEvent(
        {
          organizationId: input.organizationId,
          trigger: "loyalty_reward_unlocked",
          contactId: input.contactId,
          dedupeKey: loyaltyRewardDedupeKey(input.transactionId, m.stamps),
          context: {
            loyalty: {
              milestoneStamps: m.stamps,
              title: m.title,
              rewardType: m.rewardType,
              ...(m.discountPercentage !== undefined ? { discountPercentage: m.discountPercentage } : {}),
              currentStamps: input.currentStamps,
              transactionId: input.transactionId,
            },
          },
          matches: (f) => loyaltyFlowMatches(parseTriggerConfig(f.triggerConfig), m.stamps),
        },
        store,
        now
      );
    } catch (err) {
      console.error("[automatizaciones] el disparador de premio de fidelidad falló:", err);
    }
  }
  return started;
}

/** Un sello ganado: lo que se sabe de la tarjeta tras sumarlo (viaja en el `context` de la ejecución). */
export type LoyaltyStampInput = {
  organizationId: string;
  contactId: string;
  /** El movimiento que sumó el sello (`loyalty_transaction.id`): la llave de idempotencia. */
  transactionId: string;
  /** Sellos de la tarjeta DESPUÉS de sumar. */
  currentStamps: number;
  /** Cuántos sumó este movimiento (un cobro suma 1). */
  stampsAdded: number;
  /** Su próximo premio (null si ya los alcanzó todos) y cuántos sellos le faltan. */
  nextMilestone: Pick<LoyaltyMilestone, "stamps" | "title" | "rewardType" | "discountPercentage"> | null;
  stampsToNext: number | null;
};

/**
 * Un cliente ganó un sello (cruce o no un premio). DEBE llamarse DESPUÉS del commit de la transacción que lo sumó. Arranca cada
 * flujo `loyalty_stamp_earned` activo cuyo filtro (`stamps` exacto / `minStamps`) coincida con los sellos de la tarjeta, una
 * sola vez por movimiento. El contexto usa la misma clave `loyalty` que el premio, sin los campos del hito: no interfiere con
 * `loyalty_reward_unlocked`. Nunca lanza.
 */
export async function onLoyaltyStampEarned(
  input: LoyaltyStampInput,
  store: TriggerStore = dbTriggerStore,
  enabled: () => boolean = automationsEnabled,
  now: () => Date = () => new Date()
): Promise<number> {
  if (!enabled() || input.stampsAdded <= 0) return 0;
  try {
    return await emitAutomationEvent(
      {
        organizationId: input.organizationId,
        trigger: "loyalty_stamp_earned",
        contactId: input.contactId,
        dedupeKey: loyaltyStampDedupeKey(input.transactionId),
        context: {
          loyalty: {
            currentStamps: input.currentStamps,
            stampsAdded: input.stampsAdded,
            stampsToNext: input.stampsToNext,
            nextMilestone: input.nextMilestone
              ? {
                  stamps: input.nextMilestone.stamps,
                  title: input.nextMilestone.title,
                  rewardType: input.nextMilestone.rewardType,
                  ...(input.nextMilestone.discountPercentage !== undefined ? { discountPercentage: input.nextMilestone.discountPercentage } : {}),
                }
              : null,
            transactionId: input.transactionId,
          },
        },
        matches: (f) => stampFlowMatches(parseTriggerConfig(f.triggerConfig), input.currentStamps),
      },
      store,
      now
    );
  } catch (err) {
    console.error("[automatizaciones] el disparador de sello ganado falló:", err);
    return 0;
  }
}

/* ─── Citas ─── */

export type BookingEvent = {
  organizationId: string;
  bookingId: string;
  /** Un bloqueo de agenda no tiene contacto: no dispara nada. */
  contactId: string | null;
  scheduledAt: Date;
  /** Una cita del Laboratorio (sandbox) jamás dispara nada. */
  isTest?: boolean;
};

/** Emite el evento de cita: arranca cada flujo de ese disparador, anclado a la cita. */
async function enqueueBookingFlows(
  input: BookingEvent,
  triggerType: "booking_created" | "booking_confirmed" | "booking_no_show",
  dedupeKey: string,
  store: TriggerStore,
  now: () => Date
): Promise<number> {
  if (input.isTest || !input.contactId) return 0;
  return emitAutomationEvent(
    {
      organizationId: input.organizationId,
      trigger: triggerType,
      contactId: input.contactId,
      dedupeKey,
      bookingId: input.bookingId,
    },
    store,
    now
  );
}

/**
 * Se agendó una cita: arranca cada flujo `booking_created` activo. La llave lleva la hora, así que un
 * reintento no duplica y una reprogramación (otra hora) rearma el flujo. Nunca lanza: lo llama la agenda y
 * un fallo aquí no puede costar la cita.
 */
export async function onBookingCreated(
  input: BookingEvent,
  store: TriggerStore = dbTriggerStore,
  enabled: () => boolean = automationsEnabled,
  now: () => Date = () => new Date()
): Promise<number> {
  if (!enabled()) return 0;
  try {
    return await enqueueBookingFlows(input, "booking_created", bookingCreatedDedupeKey(input.bookingId, input.scheduledAt), store, now);
  } catch (err) {
    console.error("[automatizaciones] el disparador de cita creada falló:", err);
    return 0;
  }
}

/** Se confirmó la asistencia: arranca cada flujo `booking_confirmed` activo. Nunca lanza. */
export async function onBookingConfirmed(
  input: BookingEvent,
  store: TriggerStore = dbTriggerStore,
  enabled: () => boolean = automationsEnabled,
  now: () => Date = () => new Date()
): Promise<number> {
  if (!enabled()) return 0;
  try {
    return await enqueueBookingFlows(input, "booking_confirmed", bookingConfirmedDedupeKey(input.bookingId, input.scheduledAt), store, now);
  } catch (err) {
    console.error("[automatizaciones] el disparador de cita confirmada falló:", err);
    return 0;
  }
}

/**
 * El cliente no llegó: cancela lo que quedaba pendiente de esa cita (los recordatorios ya no tienen
 * sentido) y arranca cada flujo `booking_no_show` activo. Nunca lanza.
 */
export async function onBookingNoShow(
  input: BookingEvent,
  store: TriggerStore = dbTriggerStore,
  enabled: () => boolean = automationsEnabled,
  now: () => Date = () => new Date()
): Promise<number> {
  if (!enabled()) return 0;
  try {
    // Los recordatorios ya no tienen sentido; la tarea del propio flujo de no-show NO se toca (así marcar dos
    // veces «No asistió» no cancela el mensaje que acaba de encolarse).
    await store.cancelPendingForBooking(input.organizationId, input.bookingId, "booking_no_show", {
      exceptTrigger: "booking_no_show",
    });
    return await enqueueBookingFlows(input, "booking_no_show", bookingNoShowDedupeKey(input.bookingId), store, now);
  } catch (err) {
    console.error("[automatizaciones] el disparador de no-show falló:", err);
    return 0;
  }
}

/**
 * La cita cambió de hora: lo pendiente estaba anclado a la hora vieja, así que se cancela y se rearma
 * `booking_created` con la hora nueva. Nunca lanza.
 */
export async function onBookingRescheduled(
  input: BookingEvent,
  store: TriggerStore = dbTriggerStore,
  enabled: () => boolean = automationsEnabled,
  now: () => Date = () => new Date()
): Promise<number> {
  if (!enabled()) return 0;
  try {
    await store.cancelPendingForBooking(input.organizationId, input.bookingId, "booking_rescheduled");
  } catch (err) {
    console.error("[automatizaciones] no se pudo cancelar lo pendiente de la cita movida:", err);
  }
  return onBookingCreated(input, store, enabled, now);
}

/**
 * La cita terminó (cancelada o realizada): lo que quedaba pendiente ya no aplica. Nunca lanza.
 * `reason` queda en la tarea cancelada.
 */
export async function onBookingClosed(
  input: { organizationId: string; bookingId: string },
  reason: "booking_cancelled" | "booking_completed",
  store: TriggerStore = dbTriggerStore,
  enabled: () => boolean = automationsEnabled
): Promise<number> {
  if (!enabled()) return 0;
  try {
    return await store.cancelPendingForBooking(input.organizationId, input.bookingId, reason);
  } catch (err) {
    console.error("[automatizaciones] no se pudo cancelar lo pendiente de la cita:", err);
    return 0;
  }
}
