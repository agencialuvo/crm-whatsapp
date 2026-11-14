import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { businessTimezone } from "@/server/analytics/period";
import { ensureEdges, entryStepId } from "@/server/automation/graph";

/**
 * Automatizaciones — la capa de base de datos de los disparadores (`triggers.ts` decide qué hacer;
 * esto lee y escribe). Toda consulta de dominio pasa por `scoped()`.
 */

export type FlowRef = {
  id: string;
  organizationId: string;
  triggerConfig: unknown;
};

export type EnqueueInput = {
  organizationId: string;
  flowId: string;
  contactId: string;
  scheduledFor: Date;
  /** Llave de idempotencia: la misma llave para el mismo contacto y flujo no se encola dos veces. */
  dedupeKey: string;
  /** Disparadores de cita: la cita que origina la tarea (viaja con el flujo). */
  bookingId?: string | null;
  /** Datos estables del arranque que se guardan en `automation_run.context` (anuncio, servicio…). */
  context?: Record<string, unknown>;
};

/** Lo que el orquestador necesita del mundo; en las pruebas se sustituye por dobles. */
export type TriggerStore = {
  listOrganizationIds(): Promise<string[]>;
  activeFlows(
    organizationId: string,
    triggerType: (typeof schema.automationFlow.$inferSelect)["triggerType"]
  ): Promise<FlowRef[]>;
  timezone(organizationId: string): Promise<string>;
  /** Contactos con chat de WhatsApp real cuyo cumpleaños es alguno de esos (día, mes). */
  birthdayContacts(organizationId: string, due: { day: number; month: number }[]): Promise<string[]>;
  hasRealConversation(organizationId: string, contactId: string): Promise<boolean>;
  /** Encola el primer paso del flujo. `true` si insertó; `false` si ya estaba encolado o el flujo no tiene pasos. */
  enqueueFirstStep(input: EnqueueInput): Promise<boolean>;
  /**
   * Cancela las tareas PENDIENTES de una cita (cancelada, reprogramada, cerrada). Devuelve cuántas.
   * `exceptTrigger` deja en paz los flujos de ese disparador: al marcar «No asistió» se cancelan los
   * recordatorios, pero no la tarea del propio flujo de no-show (ni al repetir la marca).
   */
  cancelPendingForBooking(
    organizationId: string,
    bookingId: string,
    reason: string,
    opts?: { exceptTrigger?: string }
  ): Promise<number>;
};

export const dbTriggerStore: TriggerStore = {
  async listOrganizationIds() {
    // Las organizaciones no son una tabla de dominio con tenant: es la lista de a quién recorrer.
    const rows = await getDb().select({ id: schema.organization.id }).from(schema.organization);
    return rows.map((r) => r.id);
  },

  async activeFlows(organizationId, triggerType) {
    const f = schema.automationFlow;
    return getDb()
      .select({ id: f.id, organizationId: f.organizationId, triggerConfig: f.triggerConfig })
      .from(f)
      .where(scoped(f.organizationId, organizationId, eq(f.triggerType, triggerType), eq(f.active, true)));
  },

  timezone: businessTimezone,

  async birthdayContacts(organizationId, due) {
    if (due.length === 0) return [];
    const c = schema.contact;
    const cv = schema.conversation;
    const rows = await getDb()
      .selectDistinct({ id: c.id })
      .from(c)
      // Solo quien tiene un chat de WhatsApp real: sin él no hay a dónde mandar el saludo.
      .innerJoin(cv, eq(cv.contactId, c.id))
      .where(
        scoped(
          c.organizationId,
          organizationId,
          eq(cv.organizationId, organizationId),
          eq(cv.channel, "whatsapp"),
          eq(cv.isTest, false),
          or(...due.map((d) => and(eq(c.birthdayDay, d.day), eq(c.birthdayMonth, d.month))))
        )
      );
    return rows.map((r) => r.id);
  },

  async hasRealConversation(organizationId, contactId) {
    const cv = schema.conversation;
    const [row] = await getDb()
      .select({ id: cv.id })
      .from(cv)
      .where(
        scoped(
          cv.organizationId,
          organizationId,
          eq(cv.contactId, contactId),
          eq(cv.channel, "whatsapp"),
          eq(cv.isTest, false)
        )
      )
      .limit(1);
    return !!row;
  },

  /**
   * Arranca una ejecución del flujo para el contacto: crea el `run` y encola su primer paso, en UNA transacción.
   * Idempotente a dos niveles: el índice único del `run` (org, flujo, contacto, llave) y el de la cola. Si la
   * tarea inicial choca (una llave de antes de los `run`), el `run` recién creado se borra: no quedan huérfanos.
   */
  async enqueueFirstStep(input) {
    const db = getDb();
    // Un flujo anterior a las aristas se cura aquí (lectura perezosa); no cambia nada si ya las tiene.
    await ensureEdges(input.organizationId, input.flowId);
    // El primero en el orden del lienzo: el mismo criterio con que el worker elige el siguiente.
    const first = await entryStepId(db, input.organizationId, input.flowId);
    if (!first) return false;

    return db.transaction(async (tx) => {
      const run = schema.automationRun;
      const runId = newId("automationRun");
      const future = input.scheduledFor.getTime() > Date.now();
      // El índice único decide: dos disparos simultáneos del mismo evento crean un solo `run`.
      const createdRun = await tx
        .insert(run)
        .values({
          id: runId,
          organizationId: input.organizationId,
          flowId: input.flowId,
          contactId: input.contactId,
          status: future ? "waiting" : "running",
          waitingFor: future ? "time" : null,
          currentStepId: first,
          context: { ...(input.bookingId ? { bookingId: input.bookingId } : {}), ...(input.context ?? {}) },
          dedupeKey: input.dedupeKey,
        })
        .onConflictDoNothing({ target: [run.organizationId, run.flowId, run.contactId, run.dedupeKey] })
        .returning({ id: run.id });
      if (createdRun.length === 0) return false;

      const inserted = await tx
        .insert(schema.automationQueue)
        .values({
          id: newId("automationQueue"),
          organizationId: input.organizationId,
          flowId: input.flowId,
          contactId: input.contactId,
          stepId: first,
          scheduledFor: input.scheduledFor,
          dedupeKey: input.dedupeKey,
          bookingId: input.bookingId ?? null,
          runId,
        })
        .onConflictDoNothing({
          target: [
            schema.automationQueue.organizationId,
            schema.automationQueue.flowId,
            schema.automationQueue.contactId,
            schema.automationQueue.dedupeKey,
          ],
        })
        .returning({ id: schema.automationQueue.id });
      if (inserted.length === 0) {
        await tx.delete(run).where(eq(run.id, runId));
        return false;
      }
      return true;
    });
  },

  /**
   * Cancela lo que quedaba de una cita: las EJECUCIONES (incluidas las de tareas ya tomadas) y las tareas
   * pendientes. Orden de candados: primero el `run`, luego la cola — el mismo con que avanza una ejecución —, así
   * una tarea en vuelo que termine después ve el `run` cancelado y no encola el paso siguiente.
   */
  async cancelPendingForBooking(organizationId, bookingId, reason, opts = {}) {
    const q = schema.automationQueue;
    const r = schema.automationRun;
    const f = schema.automationFlow;
    return getDb().transaction(async (tx) => {
      const exceptRuns = opts.exceptTrigger
        ? sql` and "q"."flow_id" not in (select "f"."id" from "automation_flow" as "f" where "f"."organization_id" = ${organizationId} and "f"."trigger_type" = ${opts.exceptTrigger})`
        : sql``;
      await tx
        .update(r)
        .set({ status: "cancelled", waitingFor: null, endedAt: new Date() })
        .where(
          scoped(
            r.organizationId,
            organizationId,
            inArray(r.status, ["running", "waiting"]),
            sql`"automation_run"."id" in (select "q"."run_id" from "automation_queue" as "q" where "q"."booking_id" = ${bookingId} and "q"."status" in ('pending', 'processing') and "q"."run_id" is not null${exceptRuns})`
          )
        );
      const rows = await tx
        .update(q)
        .set({ status: "cancelled", lockedAt: null, error: reason })
        .where(
          scoped(
            q.organizationId,
            organizationId,
            eq(q.bookingId, bookingId),
            eq(q.status, "pending"),
            opts.exceptTrigger
              ? sql`${q.flowId} not in (select ${f.id} from ${f} where ${f.organizationId} = ${organizationId} and ${f.triggerType} = ${opts.exceptTrigger})`
              : undefined
          )
        )
        .returning({ id: q.id });
      return rows.length;
    });
  },
};
