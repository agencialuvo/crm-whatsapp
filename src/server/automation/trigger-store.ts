import { and, asc, eq, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { businessTimezone } from "@/server/analytics/period";

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

  async enqueueFirstStep(input) {
    const db = getDb();
    const s = schema.automationStep;
    // El primero en el orden del lienzo: el mismo criterio con que el worker elige el siguiente.
    const [first] = await db
      .select({ id: s.id })
      .from(s)
      .where(scoped(s.organizationId, input.organizationId, eq(s.flowId, input.flowId)))
      .orderBy(asc(s.positionY), asc(s.positionX), asc(s.id))
      .limit(1);
    if (!first) return false;

    // El índice único (org, flujo, contacto, llave) hace atómica la idempotencia: dos disparos
    // simultáneos del mismo evento insertan una sola fila.
    const inserted = await db
      .insert(schema.automationQueue)
      .values({
        id: newId("automationQueue"),
        organizationId: input.organizationId,
        flowId: input.flowId,
        contactId: input.contactId,
        stepId: first.id,
        scheduledFor: input.scheduledFor,
        dedupeKey: input.dedupeKey,
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
    return inserted.length > 0;
  },
};
