import { and, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { canConfigure } from "@/lib/auth/roles";
import {
  filterCategory,
  type NotificationCategory,
  type NotificationDto,
  type NotificationFilter,
  type NotificationListDto,
} from "@/lib/notifications";
import { publish } from "@/server/events/bus";

/**
 * Notificaciones del equipo. TODA lectura y escritura filtra por
 * `organization_id` (`scoped`): una organización nunca ve ni toca las de otra.
 *
 * Quien no es dueño ni administrador no ve las de Caja/Ventas (llevan montos).
 */

const n = schema.notifications;

type Row = typeof n.$inferSelect;

const toDto = (r: Row): NotificationDto => ({
  id: r.id,
  title: r.title,
  message: r.message,
  category: r.category,
  isRead: r.isRead,
  link: r.link,
  createdAt: r.createdAt.toISOString(),
});

/** Lo que este rol puede ver: sin las de ventas si no es dueño/administrador. */
function visibleTo(role: string | null | undefined): SQL | undefined {
  return canConfigure(role) ? undefined : ne(n.category, "venta");
}

/**
 * Registra una notificación y avisa en vivo a la campanita. NUNCA lanza: una
 * notificación es un aviso, no puede tumbar la cita, la venta ni el mensaje que
 * la originó.
 */
export async function notify(
  organizationId: string,
  input: { title: string; message: string; category: NotificationCategory; link?: string | null }
): Promise<void> {
  try {
    const id = newId("notification");
    await getDb()
      .insert(n)
      .values({
        id,
        organizationId,
        title: input.title.slice(0, 120),
        message: input.message.slice(0, 400),
        category: input.category,
        link: input.link ?? null,
      });
    publish(organizationId, { type: "notification.new", data: { notificationId: id } });
  } catch (err) {
    console.warn(`[notificaciones] no pude registrar el aviso: ${err}`);
  }
}

/** Por qué el agente pasó la conversación a una persona, dicho para el equipo. */
const HANDOFF_REASON: Record<string, string> = {
  cliente: "El cliente pidió hablar con una persona",
  modelo: "El agente pidió que una persona atienda esta conversación",
  error: "El agente no pudo continuar la conversación",
  ventana: "Pasaron las 24 h: solo una plantilla puede reabrir la conversación",
};

/**
 * «Atención humana»: el agente (o el cerebro externo) pasó una conversación a una
 * persona del equipo. Lleva a esa conversación en la bandeja. Las conversaciones de
 * prueba del Laboratorio no cuentan, y un traspaso repetido no duplica el aviso
 * mientras el anterior siga sin leer. Nunca lanza.
 */
export async function notifyHandoff(
  organizationId: string,
  conversationId: string,
  reason: string
): Promise<void> {
  try {
    const [conv] = await getDb()
      .select({
        contactId: schema.conversation.contactId,
        isTest: schema.conversation.isTest,
        name: schema.contact.name,
      })
      .from(schema.conversation)
      .innerJoin(schema.contact, eq(schema.contact.id, schema.conversation.contactId))
      .where(scoped(schema.conversation.organizationId, organizationId, eq(schema.conversation.id, conversationId)))
      .limit(1);
    if (!conv || conv.isTest) return;

    const link = `/bandeja?contact=${conv.contactId}`;
    const [dup] = await getDb()
      .select({ id: n.id })
      .from(n)
      .where(scoped(n.organizationId, organizationId, eq(n.link, link), eq(n.isRead, false), eq(n.category, "whatsapp")))
      .limit(1);
    if (dup) return;

    await notify(organizationId, {
      title: "Atención humana solicitada",
      message: `${conv.name} · ${HANDOFF_REASON[reason] ?? "Una persona debe atender esta conversación"}`,
      category: "whatsapp",
      link,
    });
  } catch (err) {
    console.warn(`[notificaciones] aviso de atención humana: ${err}`);
  }
}

export async function listNotifications(
  organizationId: string,
  role: string | null | undefined,
  opts: { filter?: NotificationFilter; limit?: number; offset?: number } = {}
): Promise<NotificationListDto> {
  const db = getDb();
  const filter = opts.filter ?? "todas";
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 50);
  const offset = Math.max(Math.floor(opts.offset ?? 0), 0);
  const category = filterCategory(filter);

  const where = scoped(
    n.organizationId,
    organizationId,
    visibleTo(role),
    category ? eq(n.category, category) : undefined,
    filter === "no_leidas" ? eq(n.isRead, false) : undefined
  );

  const [rows, unread] = await Promise.all([
    db
      .select()
      .from(n)
      .where(where)
      .orderBy(desc(n.createdAt), desc(n.id))
      .limit(limit + 1)
      .offset(offset),
    unreadCount(organizationId, role),
  ]);
  return {
    items: rows.slice(0, limit).map(toDto),
    unread,
    hasMore: rows.length > limit,
  };
}

export async function unreadCount(
  organizationId: string,
  role: string | null | undefined
): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(n)
    .where(scoped(n.organizationId, organizationId, eq(n.isRead, false), visibleTo(role)));
  return row?.count ?? 0;
}

/** Marca una como leída. Devuelve false si no existe en ESTA organización. */
export async function markRead(
  organizationId: string,
  role: string | null | undefined,
  id: string
): Promise<boolean> {
  const rows = await getDb()
    .update(n)
    .set({ isRead: true })
    .where(scoped(n.organizationId, organizationId, eq(n.id, id), visibleTo(role)))
    .returning({ id: n.id });
  return rows.length > 0;
}

/** Marca como leídas las indicadas, o todas las visibles si no se indica ninguna. */
export async function markAllRead(
  organizationId: string,
  role: string | null | undefined,
  ids?: string[]
): Promise<number> {
  const rows = await getDb()
    .update(n)
    .set({ isRead: true })
    .where(
      and(
        scoped(n.organizationId, organizationId, eq(n.isRead, false), visibleTo(role)),
        ids && ids.length > 0 ? inArray(n.id, ids) : undefined
      )
    )
    .returning({ id: n.id });
  return rows.length;
}
