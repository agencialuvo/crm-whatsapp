import { count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import type { Channel } from "@/lib/channels";
import {
  cleanLabel,
  ignoreKeyOf,
  ignoreKeysOfContact,
  IGNORED_LIMIT,
  primaryIgnoreKey,
  type ContactIdentity,
  type ParsedIgnoredEntry,
} from "@/lib/ignored-number";

/**
 * Números que el agente de IA ignora — el acceso a la base de datos.
 *
 * `ignored_number` es la FUENTE DE VERDAD: se consulta al evaluar cada turno y no toca `contact.ai_paused` ni la
 * conversación. Quitar un número de la lista surte efecto de inmediato porque no hay estado copiado que limpiar.
 * Toda consulta lleva `scoped()`: una organización nunca ve ni cambia la lista de otra.
 */

export type IgnoredNumberRow = typeof schema.ignoredNumber.$inferSelect;

const table = schema.ignoredNumber;

/**
 * ¿El agente debe callarse con este contacto? Una sola consulta indexada (índice único de la tabla).
 *
 * LANZA si la base falla: quien lo llama decide qué hacer (en el flujo del agente, ante la duda, no se responde).
 */
export async function isIgnoredContact(organizationId: string, contact: ContactIdentity): Promise<boolean> {
  const keys = ignoreKeysOfContact(contact);
  if (keys.length === 0) return false;
  const rows = await getDb()
    .select({ id: table.id })
    .from(table)
    .where(scoped(table.organizationId, organizationId, eq(table.channel, contact.channel), inArray(table.key, keys)))
    .limit(1);
  return rows.length > 0;
}

/** La entrada que ignora a este contacto, o `null`. La Bandeja la usa para mostrar «Número ignorado» y para quitarlo. */
export async function findIgnoredForContact(
  organizationId: string,
  contact: ContactIdentity
): Promise<IgnoredNumberRow | null> {
  const keys = ignoreKeysOfContact(contact);
  if (keys.length === 0) return null;
  const rows = await getDb()
    .select()
    .from(table)
    .where(scoped(table.organizationId, organizationId, eq(table.channel, contact.channel), inArray(table.key, keys)))
    .limit(1);
  return rows[0] ?? null;
}

/** La identidad de un contacto de ESTA organización (para ignorarlo desde la Bandeja). `null` si no existe o es de otra. */
export async function contactIdentityById(organizationId: string, contactId: string): Promise<ContactIdentity | null> {
  const rows = await getDb()
    .select({
      channel: schema.contact.channel,
      waIdentity: schema.contact.waIdentity,
      phone: schema.contact.phone,
      waUserId: schema.contact.waUserId,
    })
    .from(schema.contact)
    .where(scoped(schema.contact.organizationId, organizationId, eq(schema.contact.id, contactId)))
    .limit(1);
  return rows[0] ?? null;
}

/** La identidad con la que se compara el contacto de una conversación. `null` si la conversación no existe. */
export async function contactIdentityOfConversation(
  organizationId: string,
  conversationId: string
): Promise<ContactIdentity | null> {
  const rows = await getDb()
    .select({
      channel: schema.contact.channel,
      waIdentity: schema.contact.waIdentity,
      phone: schema.contact.phone,
      waUserId: schema.contact.waUserId,
    })
    .from(schema.conversation)
    .innerJoin(schema.contact, eq(schema.contact.id, schema.conversation.contactId))
    .where(scoped(schema.conversation.organizationId, organizationId, eq(schema.conversation.id, conversationId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * ¿El agente debe quedarse callado en esta conversación porque su contacto está en la lista?
 *
 * Es lo que llama el flujo del agente, y por eso NUNCA lanza: ante la duda (la base no contesta) devuelve `true`.
 * Responderle a un número que el dueño pidió ignorar —su familia, un proveedor— es peor que perder un turno, y el
 * mensaje no se pierde: sigue en la Bandeja. Callarse no deja marcas: ni traspaso, ni aviso, ni pausa en el contacto.
 */
export async function isConversationSilenced(organizationId: string, conversationId: string): Promise<boolean> {
  try {
    const identity = await contactIdentityOfConversation(organizationId, conversationId);
    return identity ? await isIgnoredContact(organizationId, identity) : false;
  } catch (err) {
    console.error(
      `[agente] no se pudo consultar la lista de números ignorados de ${conversationId}; el agente no responde:`,
      err
    );
    return true;
  }
}

/** Las entradas de la organización, la más reciente primero. `search` busca en el número y en la nota. */
export async function listIgnored(
  organizationId: string,
  filters: { channel?: Channel; search?: string } = {}
): Promise<IgnoredNumberRow[]> {
  // Los comodines del LIKE no son parte de lo que escribe quien busca.
  const term = (filters.search ?? "").trim().replace(/[%_\\]/g, "");
  return getDb()
    .select()
    .from(table)
    .where(
      scoped(
        table.organizationId,
        organizationId,
        filters.channel ? eq(table.channel, filters.channel) : undefined,
        term ? or(ilike(table.key, `%${term}%`), ilike(table.label, `%${term}%`)) : undefined
      )
    )
    .orderBy(desc(table.createdAt))
    .limit(IGNORED_LIMIT);
}

export async function countIgnored(organizationId: string): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(table).where(scoped(table.organizationId, organizationId));
  return row?.n ?? 0;
}

/** Lo que se agrega: un número que escribió una persona, o un contacto de la Bandeja (cualquier canal). */
export type AddIgnoredInput =
  | { raw: string; label?: string | null }
  | { contact: ContactIdentity; label?: string | null };

export type AddIgnoredResult =
  | { status: "added"; entry: IgnoredNumberRow }
  | { status: "duplicate" }
  | { status: "limit"; limit: number }
  | { status: "invalid"; error: string };

export async function addIgnored(
  organizationId: string,
  input: AddIgnoredInput,
  userId?: string | null
): Promise<AddIgnoredResult> {
  let channel: Channel;
  let key: string;
  if ("raw" in input) {
    const parsed = ignoreKeyOf(input.raw);
    if (!parsed.ok) return { status: "invalid", error: parsed.error };
    channel = "whatsapp";
    key = parsed.key;
  } else {
    const primary = primaryIgnoreKey(input.contact);
    if (!primary) return { status: "invalid", error: "Este contacto no tiene un número o identidad que ignorar." };
    channel = input.contact.channel;
    key = primary;
  }
  const label = cleanLabel(input.label);
  if (!label.ok) return { status: "invalid", error: label.error };

  // Tope blando: dos altas simultáneas al límite podrían pasarse por una; el número es de comodidad, no de seguridad.
  if ((await countIgnored(organizationId)) >= IGNORED_LIMIT) return { status: "limit", limit: IGNORED_LIMIT };

  const inserted = await getDb()
    .insert(table)
    .values({
      id: newId("ignoredNumber"),
      organizationId,
      channel,
      key,
      label: label.label,
      createdByUserId: userId || null,
    })
    .onConflictDoNothing({ target: [table.organizationId, table.channel, table.key] })
    .returning();
  const entry = inserted[0];
  return entry ? { status: "added", entry } : { status: "duplicate" };
}

export type AddIgnoredManyResult = {
  added: IgnoredNumberRow[];
  /** Ya estaban en la lista. */
  duplicates: ParsedIgnoredEntry[];
  /** No cupieron: la lista llegó al tope. */
  overLimit: ParsedIgnoredEntry[];
};

/**
 * Agrega varias entradas ya leídas (`parseIgnoredInput`) de WhatsApp en un solo viaje. Las que ya estaban se
 * reportan como duplicadas y las que no caben en el tope, como `overLimit`; nada de eso es un error.
 */
export async function addIgnoredMany(
  organizationId: string,
  entries: ParsedIgnoredEntry[],
  userId?: string | null
): Promise<AddIgnoredManyResult> {
  if (entries.length === 0) return { added: [], duplicates: [], overLimit: [] };
  const room = Math.max(0, IGNORED_LIMIT - (await countIgnored(organizationId)));
  const fits = entries.slice(0, room);
  const overLimit = entries.slice(room);
  if (fits.length === 0) return { added: [], duplicates: [], overLimit };

  const inserted = await getDb()
    .insert(table)
    .values(
      fits.map((e) => ({
        id: newId("ignoredNumber"),
        organizationId,
        channel: "whatsapp" as const,
        key: e.key,
        label: e.label,
        createdByUserId: userId || null,
      }))
    )
    .onConflictDoNothing({ target: [table.organizationId, table.channel, table.key] })
    .returning();
  const addedKeys = new Set(inserted.map((r) => r.key));
  return { added: inserted, duplicates: fits.filter((e) => !addedKeys.has(e.key)), overLimit };
}

/** Quita una entrada de ESTA organización. `false` si no existe (o es de otra). */
export async function removeIgnored(organizationId: string, id: string): Promise<boolean> {
  const removed = await getDb()
    .delete(table)
    .where(scoped(table.organizationId, organizationId, eq(table.id, id)))
    .returning({ id: table.id });
  return removed.length > 0;
}
