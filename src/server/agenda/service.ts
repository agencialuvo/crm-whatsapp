import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { dayIsoInTz, labelInTz } from "@/lib/time/slots";
import { CONNECTOR_META, type ConnectorId } from "@/lib/agenda-connectors";
import {
  computeAvailability,
  findSlot,
  type AvailableSlot,
  type SlotTarget,
} from "@/server/agenda/availability";
import { getSettings, type CalendarSettings } from "@/server/agenda/settings";
import {
  clearOffers,
  findOffered,
  getOffers,
  replaceOffers,
  type OfferedSlot,
} from "@/server/agenda/offers";
import {
  bindConnector,
  markConnectorAuthError,
} from "@/server/agenda/connectors";
import { ConnectorError } from "@/server/agenda/connectors/types";
import { advanceLeadForContact } from "@/server/leads/auto-stage";
import {
  onBookingClosed,
  onBookingCompleted,
  onBookingConfirmed,
  onBookingCreated,
  onBookingNoShow,
  onBookingRescheduled,
} from "@/server/automation/triggers";
import { publish } from "@/server/events/bus";
import { notify } from "@/server/notifications/service";
import { requestCalendarSync } from "@/server/agenda/calendar-sync/sync";
import { shortClientName } from "@/server/agenda/calendar-sync/event";
import { getGoogleConnectionInfo } from "@/server/agenda/connectors/google-credentials";

/**
 * 015 — Ciclo de vida de la cita y las dos reglas INNEGOCIABLES:
 *
 *  1. Quien conduce la conversación (agente in-process o cerebro externo) solo
 *     puede reservar un instante que ya se ofreció a ESA conversación
 *     (`offered_slot`, comparación por epoch exacto).
 *  2. Al confirmar se re-valida el hueco y la base lo cierra con su índice
 *     único parcial; si se ocupó, se responde `slot_taken` con alternativas
 *     frescas y NO se crea nada. Nunca se confirma una reserva que no se creó.
 *
 * Y una regla de honestidad: la entrega de la reunión (el conector) corre
 * DESPUÉS de escribir la verdad del CRM y es best-effort. Si el proveedor está
 * caído, la cita se crea igual con el enlace pendiente — un tercero no puede
 * costarnos la conversión, ni hacernos prometer un enlace que no existe.
 */

export type BookingErrorCode =
  | "slot_taken"
  | "slot_not_offered"
  | "not_found"
  | "invalid"
  /** Paso 4: un bloqueo traído de Google Calendar; se cambia allí, no en Vocero. */
  | "external_block";

export class BookingError extends Error {
  code: BookingErrorCode;
  /**
   * Horarios para re-ofrecer. En `slot_taken` son alternativas frescas YA
   * registradas como la nueva oferta de la conversación; en `slot_not_offered`
   * es lo que sí se había ofrecido.
   */
  slots: OfferedSlot[];

  constructor(
    code: BookingErrorCode,
    message: string,
    slots: OfferedSlot[] = []
  ) {
    super(message);
    this.name = "BookingError";
    this.code = code;
    this.slots = slots;
  }
}

type BookingRow = typeof schema.booking.$inferSelect;

export type BookingResult = {
  booking: BookingRow;
  meetingLink: string | null;
  linkPending: boolean;
  label: string;
};

/** Cuántas alternativas se devuelven cuando el hueco se ocupó. */
const FRESH_ALTERNATIVES = 3;

export async function createSessionBooking(input: {
  organizationId: string;
  startUtc: string;
  source: "manual" | "ai";
  /** Obligatoria en el camino conversacional; de ella sale el contacto. */
  conversationId?: string | null;
  /** Camino manual del operador. */
  contactId?: string | null;
  /**
   * El profesional que atiende. Sin él («cualquiera disponible», la IA y el bot) se elige uno libre que dé el
   * servicio y trabaje toda la duración; con él, tiene que estar libre él. Sin equipo, la cita no lleva.
   */
  staffId?: string | null;
  /** Módulo SALON: el servicio u oferta de la cita y cuánto dura (si no, una franja). */
  serviceId?: string | null;
  comboId?: string | null;
  durationMinutes?: number;
  notes?: string | null;
  /**
   * true ⇒ exige que el instante figure entre los ofrecidos a la conversación
   * (agente/bot). El operador elige de la disponibilidad que está viendo, así
   * que reserva sin oferta previa.
   */
  requireOffer: boolean;
  now?: Date;
}): Promise<BookingResult> {
  const db = getDb();
  const settings = await getSettings(input.organizationId);

  if (Number.isNaN(Date.parse(input.startUtc))) {
    throw new BookingError("invalid", "Instante inválido");
  }

  // Contexto de la conversación: contacto y si es del Laboratorio.
  let isTest = false;
  let contactId = input.contactId ?? null;
  let contactName = "";
  if (input.conversationId) {
    const rows = await db
      .select({
        contactId: schema.conversation.contactId,
        isTest: schema.conversation.isTest,
      })
      .from(schema.conversation)
      .where(
        scoped(
          schema.conversation.organizationId,
          input.organizationId,
          eq(schema.conversation.id, input.conversationId)
        )
      )
      .limit(1);
    const conv = rows[0];
    if (!conv) throw new BookingError("not_found", "Conversación no encontrada");
    isTest = conv.isTest;
    contactId = contactId ?? conv.contactId;
  }

  if (!contactId) {
    throw new BookingError("invalid", "La cita necesita un contacto");
  }
  contactName = await getContactName(input.organizationId, contactId);

  // REGLA 1: solo se reserva lo que se ofreció.
  if (input.requireOffer) {
    if (!input.conversationId) {
      throw new BookingError(
        "invalid",
        "Se necesita la conversación para validar la oferta"
      );
    }
    const offers = await getOffers(input.organizationId, input.conversationId);
    if (!findOffered(offers, input.startUtc)) {
      throw new BookingError(
        "slot_not_offered",
        "Ese horario no se ofreció en esta conversación",
        offers
      );
    }
  }

  const leadRows = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        input.organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);

  // La cita dura lo que dura su servicio u oferta (todas las franjas que abarca tienen que estar libres).
  const durationMinutes =
    input.durationMinutes ??
    (await itemDuration(input.organizationId, input.serviceId, input.comboId)) ??
    settings.slotMinutes;
  const target: SlotTarget = {
    durationMinutes,
    serviceId: input.serviceId ?? null,
    comboId: input.comboId ?? null,
    staffId: input.staffId ?? null,
    // Solo el operador puede asignar a alguien que no recibe citas (cubrir una ausencia, por ejemplo).
    allowExcludedStaff: input.source === "manual" && !!input.staffId,
  };

  // REGLA 2: bajo el candado de la agenda de este negocio, el hueco se re-valida y se elige profesional. Dos
  // reservas simultáneas pasan una detrás de otra, así la segunda ya ve a la primera (también las que se
  // cruzan sin empezar a la misma hora, que el índice único no ve). Si aun así la base rechaza la fila
  // (23505: alguien que no pasa por aquí ocupó ese instante), se prueba con el siguiente libre.
  const outcome = await db.transaction(async (tx) => {
    await lockAgenda(tx, input.organizationId);
    const slot = await findSlot(input.organizationId, input.startUtc, {
      ...target,
      now: input.now,
      settings,
      db: tx,
    });
    if (!slot) return { slot: null, booking: null };
    const candidates: (string | null)[] = slot.staffIds.length > 0 ? slot.staffIds : [null];
    for (const staffId of candidates) {
      try {
        const row = await tx.transaction(async (sp) => {
          const inserted = await sp
            .insert(schema.booking)
            .values({
              id: newId("booking"),
              organizationId: input.organizationId,
              kind: "session",
              source: input.source === "ai" ? "ai" : "manual",
              contactId,
              conversationId: input.conversationId ?? null,
              leadId: leadRows[0]?.id ?? null,
              scheduledAt: new Date(slot.startUtc),
              durationMinutes,
              // Copia histórica: si el negocio cambia de conector, esta cita conserva
              // el que le tocó y sigue hablando con él al moverse o cancelarse.
              connector: settings.connector,
              isTest,
              staffId,
              serviceId: input.serviceId ?? null,
              comboId: input.comboId ?? null,
              notes: input.notes ?? null,
            })
            .returning();
          return inserted[0]!;
        });
        return { slot, booking: row };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return { slot, booking: null };
  });

  if (!outcome.slot) {
    throw new BookingError(
      "slot_taken",
      "Ese horario ya no está disponible",
      await refreshOffer(input.organizationId, input.conversationId, {
        now: input.now,
        target,
      })
    );
  }
  if (!outcome.booking) {
    // Todos los que estaban libres se ocuparon en el instante: sin cita creada.
    throw new BookingError(
      "slot_taken",
      "Ese horario acaba de ocuparse",
      await refreshOffer(input.organizationId, input.conversationId, {
        now: input.now,
        target,
      })
    );
  }
  const slot = outcome.slot;
  const booking: BookingRow = outcome.booking;

  // La oferta cumplió su propósito.
  if (input.conversationId) {
    await clearOffers(input.organizationId, input.conversationId).catch(
      (err) => {
        console.warn(`[agenda] no pude limpiar la oferta: ${err}`);
      }
    );
  }

  // Efectos secundarios: ninguno puede revertir la cita.
  const delivered = await deliverMeeting(booking, settings, contactName);
  // Paso 3: publicarla en Google Calendar (si está encendido). En segundo plano: nunca la retrasa.
  await requestCalendarSync(input.organizationId, delivered.id);
  // 044: agendar una cita lleva al lead a «Interesado» (solo desde Nuevo / En conversación, nunca hacia atrás;
  // una cita de prueba no mueve nada). Reemplaza al antiguo «avanza una etapa» sin mirar cuál era.
  if (!isTest) {
    await advanceLeadForContact({ organizationId: input.organizationId, contactId, rule: "booking" });
  }

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: delivered.id },
  });

  // Automatizaciones: una cita nueva puede arrancar un flujo (recordatorios). Nunca lanza, y una cita de
  // prueba jamás dispara nada.
  await onBookingCreated({
    organizationId: input.organizationId,
    bookingId: delivered.id,
    contactId,
    scheduledAt: delivered.scheduledAt,
    isTest,
  });

  // Aviso al equipo solo cuando la agenda el agente de IA: la cita que agenda una
  // persona del equipo ya la conoce quien la agendó (y las de prueba no cuentan).
  if (input.source === "ai" && !isTest) {
    await notify(input.organizationId, {
      title: "Cita agendada por el agente",
      message: `${contactName} · ${labelInTz(slot.startUtc, settings.timezone)}`,
      category: "cita",
      link: bookingLink(slot.startUtc, settings.timezone, delivered.id),
    });
  }

  return {
    booking: delivered,
    meetingLink: delivered.meetingLink,
    linkPending: delivered.linkPending,
    label: labelInTz(slot.startUtc, settings.timezone),
  };
}

/** A dónde lleva el aviso de una cita: la agenda de ese día, con la cita abierta. */
function bookingLink(startUtc: string | Date, timezone: string, bookingId: string): string {
  const day = dayIsoInTz(new Date(startUtc), timezone);
  return `/citas?pestana=sillas&fecha=${day}&cita=${bookingId}`;
}

export async function createBlock(input: {
  organizationId: string;
  startUtc: string;
  durationMinutes: number;
  notes?: string | null;
}): Promise<BookingRow> {
  if (Number.isNaN(Date.parse(input.startUtc))) {
    throw new BookingError("invalid", "Instante inválido");
  }
  const db = getDb();
  try {
    const inserted = await db
      .insert(schema.booking)
      .values({
        id: newId("booking"),
        organizationId: input.organizationId,
        kind: "block",
        source: "manual",
        scheduledAt: new Date(input.startUtc),
        durationMinutes: input.durationMinutes,
        notes: input.notes ?? null,
      })
      .returning();
    const block = inserted[0]!;
    publish(input.organizationId, {
      type: "booking.updated",
      data: { bookingId: block.id },
    });
    return block;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new BookingError("slot_taken", "Ese horario ya está ocupado");
    }
    throw err;
  }
}

export async function rescheduleBooking(input: {
  organizationId: string;
  bookingId: string;
  startUtc: string;
  /** Con quién, si se pide a alguien concreto; sin él se conserva el profesional si sigue libre. */
  staffId?: string | null;
  now?: Date;
}): Promise<BookingResult> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  assertNotExternal(booking);
  if (booking.status === "cancelada") {
    throw new BookingError("invalid", "La cita está cancelada");
  }

  const settings = await getSettings(input.organizationId);
  const base: SlotTarget = {
    durationMinutes: booking.durationMinutes,
    serviceId: booking.serviceId,
    comboId: booking.comboId,
  };

  const outcome = await db.transaction(async (tx) => {
    await lockAgenda(tx, input.organizationId);
    // excludeBookingId: la propia cita no debe bloquearse a sí misma.
    const find = (target: SlotTarget) =>
      findSlot(input.organizationId, input.startUtc, {
        ...base,
        ...target,
        excludeBookingId: booking.id,
        now: input.now,
        settings,
        db: tx,
      });

    let slot: Awaited<ReturnType<typeof findSlot>> = null;
    let candidates: (string | null)[] = [booking.staffId];
    if (booking.kind === "block") {
      slot = await find({});
    } else {
      // Primero, quien se pidió o quien ya la tenía (si ya era suya, vale aunque no reciba citas nuevas).
      const preferred = input.staffId ?? booking.staffId;
      if (preferred) {
        slot = await find({ staffId: preferred, allowExcludedStaff: !input.staffId || preferred === booking.staffId });
        if (slot) candidates = [preferred];
      }
      // Si no se pidió a nadie en concreto y quien la tenía ya no puede, cualquiera libre.
      if (!slot && !input.staffId) {
        slot = await find({});
        if (slot) candidates = slot.staffIds.length > 0 ? slot.staffIds : [null];
      }
    }
    if (!slot) return { slot: null, next: null };

    for (const staffId of candidates) {
      try {
        const next = await tx.transaction(async (sp) => {
          const updated = await sp
            .update(schema.booking)
            // Reprogramar limpia la confirmación: la hora nueva hay que confirmarla de nuevo.
            .set({
              scheduledAt: new Date(slot.startUtc),
              ...(booking.kind === "session" && { staffId }),
              confirmedAt: null,
              // Mejora 1: la hora nueva ya se validó libre (también de lo ocupado en Google).
              googleConflictStart: null,
              googleConflictEnd: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.booking.id, booking.id))
            .returning();
          return updated[0]!;
        });
        return { slot, next };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return { slot, next: null };
  });

  if (!outcome.slot) {
    throw new BookingError("slot_taken", "Ese horario ya no está disponible");
  }
  if (!outcome.next) {
    throw new BookingError("slot_taken", "Ese horario acaba de ocuparse");
  }
  const slot = outcome.slot;
  const next: BookingRow = outcome.next;

  // Mover la reunión en el proveedor conserva el enlace: es la MISMA reunión,
  // en otra hora. Un fallo aquí no deshace nada — el enlace anterior sigue
  // sirviendo en la práctica.
  await withConnector(next, settings, async (conn, externalRef) => {
    await conn.updateMeeting(externalRef, {
      startUtc: slot.startUtc,
      durationMinutes: next.durationMinutes,
      timezone: settings.timezone,
    });
  });
  await requestCalendarSync(input.organizationId, next.id);

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: next.id },
  });

  // Automatizaciones: lo pendiente estaba anclado a la hora vieja; se cancela y el flujo se rearma con la
  // hora nueva. Nunca lanza.
  if (next.kind === "session") {
    await onBookingRescheduled({
      organizationId: input.organizationId,
      bookingId: next.id,
      contactId: next.contactId,
      scheduledAt: next.scheduledAt,
      isTest: next.isTest,
    });
  }
  return {
    booking: next,
    meetingLink: next.meetingLink,
    linkPending: next.linkPending,
    label: labelInTz(slot.startUtc, settings.timezone),
  };
}

/**
 * Reprograma la PRÓXIMA cita activa de la conversación. Es el camino del
 * agente: mover una cita no debería obligar a pausar la IA y pasarle el
 * problema a un humano.
 */
export async function rescheduleForConversation(input: {
  organizationId: string;
  conversationId: string;
  startUtc: string;
  now?: Date;
}): Promise<BookingResult> {
  const db = getDb();
  const now = input.now ?? new Date();

  const convRows = await db
    .select({ contactId: schema.conversation.contactId })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        input.organizationId,
        eq(schema.conversation.id, input.conversationId)
      )
    )
    .limit(1);
  const conv = convRows[0];
  if (!conv) throw new BookingError("not_found", "Conversación no encontrada");

  // Mismas reglas que al crear: el instante nuevo tiene que haberse ofrecido.
  const offers = await getOffers(input.organizationId, input.conversationId);
  if (!findOffered(offers, input.startUtc)) {
    throw new BookingError(
      "slot_not_offered",
      "Ese horario no se ofreció en esta conversación",
      offers
    );
  }

  const rows = await db
    .select()
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        input.organizationId,
        and(
          eq(schema.booking.contactId, conv.contactId),
          eq(schema.booking.kind, "session"),
          eq(schema.booking.status, "agendada"),
          gte(schema.booking.scheduledAt, now)
        )
      )
    )
    .orderBy(asc(schema.booking.scheduledAt))
    .limit(1);

  const target = rows[0];
  if (!target) {
    throw new BookingError("not_found", "No hay una cita activa que mover");
  }

  const result = await rescheduleBooking({
    organizationId: input.organizationId,
    bookingId: target.id,
    startUtc: input.startUtc,
    now: input.now,
  });
  await clearOffers(input.organizationId, input.conversationId).catch(() => {});
  return result;
}

/** Idempotente: cancelar una cita ya cancelada no falla ni cambia nada. */
export async function cancelBooking(input: {
  organizationId: string;
  bookingId: string;
}): Promise<void> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  assertNotExternal(booking);
  if (booking.status === "cancelada") return;

  await db
    .update(schema.booking)
    .set({ status: "cancelada", updatedAt: new Date() })
    .where(eq(schema.booking.id, booking.id));

  const settings = await getSettings(input.organizationId);
  await withConnector(booking, settings, async (conn, externalRef) => {
    await conn.deleteMeeting(externalRef);
  });
  await requestCalendarSync(input.organizationId, booking.id);

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: booking.id },
  });

  // Automatizaciones: una cita cancelada ya no recibe recordatorios. Nunca lanza.
  await onBookingClosed({ organizationId: input.organizationId, bookingId: booking.id }, "booking_cancelled");
}

export async function markBookingStatus(input: {
  organizationId: string;
  bookingId: string;
  status: "realizada" | "no_show";
}): Promise<void> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  assertNotExternal(booking);
  try {
    await db
      .update(schema.booking)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(schema.booking.id, booking.id));
  } catch (err) {
    // Reactivar a `realizada` un instante que otra cita ya ocupa.
    if (isUniqueViolation(err)) {
      throw new BookingError("slot_taken", "Ese horario ya está ocupado");
    }
    throw err;
  }
  // El evento lleva el resultado en el título («[Realizada]», «[No asistió]»).
  await requestCalendarSync(input.organizationId, booking.id);
  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: booking.id },
  });

  // Automatizaciones (nunca lanzan): «no asistió» cancela los recordatorios pendientes y arranca los flujos
  // de no-show; «realizada» solo cancela lo pendiente.
  if (booking.kind === "session") {
    if (input.status === "no_show") {
      await onBookingNoShow({
        organizationId: input.organizationId,
        bookingId: booking.id,
        contactId: booking.contactId,
        scheduledAt: booking.scheduledAt,
        isTest: booking.isTest,
      });
    } else {
      // «Realizada»: cancela los recordatorios que quedaban y arranca los flujos de «Cita realizada» (una vez por cita).
      await onBookingCompleted({
        organizationId: input.organizationId,
        bookingId: booking.id,
        contactId: booking.contactId,
        scheduledAt: booking.scheduledAt,
        isTest: booking.isTest,
      });
    }
  }
}

/**
 * Confirma la asistencia a una cita. La usan la agenda (botón «Confirmar asistencia», para quien confirmó
 * por llamada o en persona) y, en la Fase 4, el paso `wait_reply` cuando el cliente confirma por WhatsApp.
 *
 * Idempotente: confirmar una cita ya confirmada no falla ni vuelve a disparar el flujo. La actualización es
 * condicional (`confirmed_at is null`), así que dos confirmaciones simultáneas disparan UNA vez.
 */
export async function confirmBooking(input: {
  organizationId: string;
  bookingId: string;
}): Promise<{ confirmedAt: Date; alreadyConfirmed: boolean }> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  if (booking.kind !== "session") {
    throw new BookingError("invalid", "Un bloqueo no se confirma");
  }
  if (booking.status !== "agendada") {
    throw new BookingError("invalid", "Solo se puede confirmar una cita agendada");
  }
  if (booking.confirmedAt) return { confirmedAt: booking.confirmedAt, alreadyConfirmed: true };

  const now = new Date();
  const updated = await db
    .update(schema.booking)
    .set({ confirmedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.booking.id, booking.id),
        eq(schema.booking.organizationId, input.organizationId),
        eq(schema.booking.status, "agendada"),
        isNull(schema.booking.confirmedAt)
      )
    )
    .returning({ id: schema.booking.id });
  if (updated.length === 0) {
    // Otra confirmación (o una cancelación) se adelantó: lo que quedó guardado manda.
    const again = await getOwnBooking(input.organizationId, input.bookingId);
    if (again.status !== "agendada") throw new BookingError("invalid", "Solo se puede confirmar una cita agendada");
    return { confirmedAt: again.confirmedAt ?? now, alreadyConfirmed: true };
  }

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: booking.id },
  });
  await onBookingConfirmed({
    organizationId: input.organizationId,
    bookingId: booking.id,
    contactId: booking.contactId,
    scheduledAt: booking.scheduledAt,
    isTest: booking.isTest,
  });
  // El evento muestra «✓» en el título y «Asistencia confirmada» en la descripción.
  await requestCalendarSync(input.organizationId, input.bookingId);
  return { confirmedAt: now, alreadyConfirmed: false };
}

/**
 * Reintenta la entrega de una cita que quedó sin enlace porque el proveedor
 * falló. Habla con el conector con el que NACIÓ la cita, no con el activo.
 *
 * Sin esto, un hipo del proveedor sería una pérdida silenciosa que nadie
 * repara — que es exactamente lo que pasa hoy en el fork.
 */
export async function retryMeetingLink(input: {
  organizationId: string;
  bookingId: string;
}): Promise<BookingResult> {
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  if (!booking.linkPending) {
    throw new BookingError("invalid", "Esta cita no tiene un enlace pendiente");
  }
  const settings = await getSettings(input.organizationId);
  const contactName = booking.contactId
    ? await getContactName(input.organizationId, booking.contactId)
    : "";
  const delivered = await deliverMeeting(booking, settings, contactName);
  // El enlace nuevo va en la descripción del evento.
  await requestCalendarSync(input.organizationId, delivered.id);

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: delivered.id },
  });
  return {
    booking: delivered,
    meetingLink: delivered.meetingLink,
    linkPending: delivered.linkPending,
    label: labelInTz(delivered.scheduledAt.toISOString(), settings.timezone),
  };
}

/**
 * Crea la reunión en el proveedor y la guarda en la cita.
 *
 * SANDBOX: una cita del Laboratorio jamás llega a un conector. La aserción va
 * aquí, ANTES de resolver cuál es, para que valga igual para todos — hoy y
 * para el que agregue un fork mañana.
 */
async function deliverMeeting(
  booking: BookingRow,
  settings: CalendarSettings,
  contactName: string
): Promise<BookingRow> {
  if (booking.isTest) return booking;
  const connectorId = (booking.connector ?? settings.connector) as ConnectorId;

  try {
    const conn = await bindConnector(
      booking.organizationId,
      connectorId,
      settings
    );

    // Si la cita YA tiene reunión, esto es un reintento: se vuelve a leer, no
    // se crea otra. Sin esta rama, reintentar el enlace de un evento de Google
    // dejaría al dueño con dos citas en su calendario.
    const meeting =
      booking.externalRef && conn.refreshMeeting
        ? await conn.refreshMeeting(booking.externalRef)
        : await conn.createMeeting({
            // Privacidad: el título de la reunión (y del evento de Google) lleva el nombre con la inicial
            // del apellido; el calendario del negocio suele estar compartido.
            topic: contactName ? `Cita — ${shortClientName(contactName)}` : "Cita",
            startUtc: booking.scheduledAt.toISOString(),
            durationMinutes: booking.durationMinutes,
            timezone: settings.timezone,
            notes: booking.notes ?? undefined,
            // Llave de idempotencia: Google la usa como id del evento y de la conferencia de Meet.
            bookingId: booking.id,
            organizationId: booking.organizationId,
          });

    // Mejora 2: el evento de Meet nace en el calendario de publicación de ESE momento; se anota para poder
    // moverlo si el negocio cambia de calendario.
    const meetCalendarId =
      connectorId === "google" && meeting.externalId && !booking.calendarEventCalendarId
        ? ((await getGoogleConnectionInfo(booking.organizationId).catch(() => null))?.calendarId ?? null)
        : null;
    return await persistDelivery(booking.id, {
      externalRef: meeting.externalId ?? booking.externalRef,
      ...(meetCalendarId ? { calendarEventCalendarId: meetCalendarId } : {}),
      meetingLink: meeting.joinUrl,
      // Un conector que promete enlace por cita y no lo trajo todavía deja la
      // cita "sin enlace" — reintentable. `enlace-fijo` sin sala configurada,
      // en cambio, no tiene nada pendiente: simplemente no hay enlace.
      linkPending: CONNECTOR_META[connectorId].perBookingLink && !meeting.joinUrl,
    });
  } catch (err) {
    console.warn(
      `[agenda] el conector ${connectorId} no pudo entregar la reunión: ${err}`
    );
    if (err instanceof ConnectorError && err.isAuthError) {
      await markConnectorAuthError(booking.organizationId, connectorId).catch(
        () => {}
      );
    }
    // La cita ya existe y se queda: el enlace es lo único que falta. Se
    // conserva la referencia externa si ya la había, para que el reintento
    // sepa que no debe crear otra reunión.
    return await persistDelivery(booking.id, {
      externalRef: booking.externalRef,
      meetingLink: null,
      linkPending: true,
    });
  }
}

async function persistDelivery(
  bookingId: string,
  values: {
    externalRef: string | null;
    meetingLink: string | null;
    linkPending: boolean;
    calendarEventCalendarId?: string;
  }
): Promise<BookingRow> {
  const db = getDb();
  const rows = await db
    .update(schema.booking)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(schema.booking.id, bookingId))
    .returning();
  return rows[0]!;
}

/**
 * Corre un efecto sobre el proveedor de una cita ya creada (mover, borrar).
 * Best-effort y con el mismo guardarraíl de sandbox. Sin `external_ref` no hay
 * nada que mover: el conector no generó reunión (p. ej. el enlace fijo).
 */
async function withConnector(
  booking: BookingRow,
  settings: CalendarSettings,
  run: (
    conn: Awaited<ReturnType<typeof bindConnector>>,
    externalRef: string
  ) => Promise<void>
): Promise<void> {
  if (booking.isTest || !booking.externalRef) return;
  const connectorId = (booking.connector ?? settings.connector) as ConnectorId;
  try {
    const conn = await bindConnector(
      booking.organizationId,
      connectorId,
      settings
    );
    await run(conn, booking.externalRef);
  } catch (err) {
    console.warn(`[agenda] efecto en ${connectorId} falló: ${err}`);
    if (err instanceof ConnectorError && err.isAuthError) {
      await markConnectorAuthError(booking.organizationId, connectorId).catch(
        () => {}
      );
    }
  }
}

/**
 * Alternativas frescas para re-ofrecer. Si hay conversación, quedan
 * REGISTRADAS como su nueva oferta: el cliente puede aceptar una de inmediato
 * y la validación seguirá siendo válida.
 */
async function refreshOffer(
  organizationId: string,
  conversationId: string | null | undefined,
  opts: { now?: Date; target?: SlotTarget }
): Promise<OfferedSlot[]> {
  let fresh: AvailableSlot[] = [];
  try {
    // Las alternativas son para la MISMA cita: su duración, su servicio y, si se pidió, su profesional.
    const { allowExcludedStaff: _manual, ...target } = opts.target ?? {};
    fresh = (await computeAvailability(organizationId, { ...target, now: opts.now })).slice(
      0,
      FRESH_ALTERNATIVES
    );
  } catch (err) {
    console.warn(`[agenda] no pude calcular alternativas: ${err}`);
    return [];
  }
  const offers: OfferedSlot[] = fresh.map((s) => ({
    startUtc: s.startUtc,
    label: s.label,
  }));
  if (conversationId && offers.length > 0) {
    await replaceOffers(organizationId, conversationId, offers).catch((err) => {
      console.warn(`[agenda] no pude registrar la nueva oferta: ${err}`);
    });
  }
  return offers;
}

/**
 * Paso 4 — Lo ocupado que se trajo de Google Calendar es un REFLEJO: se mueve o se quita en Google y la
 * próxima lectura lo actualiza. Si se pudiera quitar aquí, la siguiente lectura lo volvería a poner.
 */
function assertNotExternal(booking: BookingRow): void {
  if (booking.busySource === "google") {
    throw new BookingError(
      "external_block",
      "Este bloqueo viene de tu Google Calendar: muévelo o bórralo allí y Vocero lo actualizará solo."
    );
  }
}

async function getOwnBooking(
  organizationId: string,
  bookingId: string
): Promise<BookingRow> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.id, bookingId)
      )
    )
    .limit(1);
  if (!rows[0]) throw new BookingError("not_found", "Cita no encontrada");
  return rows[0];
}

async function getContactName(
  organizationId: string,
  contactId: string
): Promise<string> {
  const db = getDb();
  const rows = await db
    .select({ name: schema.contact.name })
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        eq(schema.contact.id, contactId)
      )
    )
    .limit(1);
  return rows[0]?.name ?? "";
}

/**
 * El candado de la agenda de UN negocio, hasta el final de la transacción: las reservas y los cambios de hora
 * del mismo negocio pasan en fila (milisegundos), los de negocios distintos no se esperan.
 */
export async function lockAgenda(
  tx: Pick<ReturnType<typeof getDb>, "execute">,
  organizationId: string
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agenda:${organizationId}`}))`);
}

/** Cuánto dura el servicio u oferta de la cita (`null` si no tiene duración o no se pidió ninguno). */
async function itemDuration(
  organizationId: string,
  serviceId: string | null | undefined,
  comboId: string | null | undefined
): Promise<number | null> {
  if (!serviceId && !comboId) return null;
  const db = getDb();
  const rows = serviceId
    ? await db
        .select({ minutes: schema.service.durationMinutes })
        .from(schema.service)
        .where(scoped(schema.service.organizationId, organizationId, eq(schema.service.id, serviceId)))
        .limit(1)
    : await db
        .select({ minutes: schema.combo.durationMinutes })
        .from(schema.combo)
        .where(scoped(schema.combo.organizationId, organizationId, eq(schema.combo.id, comboId!)))
        .limit(1);
  const minutes = rows[0]?.minutes;
  return minutes && minutes > 0 ? minutes : null;
}

/** Citas que ocupan agenda de verdad. */
export const ACTIVE_STATUSES = ["agendada", "realizada"] as const;

/** 23505 = unique_violation de Postgres. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505") return true;
  // Drizzle envuelve el error del driver: el código real viaja en `cause`.
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "23505"
  );
}
