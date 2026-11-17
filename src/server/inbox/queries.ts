import { and, eq, gt, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { CHANNEL_ORDER, type Channel } from "@/lib/channels";
import {
  encodeListCursor,
  encodeThreadCursor,
  type ListCursor,
  type ThreadCursor,
} from "@/lib/inbox-cursor";
import { busquedaDeContacto } from "@/server/search-sql";
import { replyWindow } from "@/server/inbox/window";
import { capabilitiesFor, windowMsFor } from "@/server/channels/capabilities";
import { serializeMessage } from "@/server/inbox/ingest";
import type {
  ConversationDto,
  ConversationsPageDto,
  InboxCountsDto,
  MessagesPageDto,
} from "@/lib/types";

/**
 * 018 — El anuncio de origen viaja con la conversación. La llave única
 * (organización, conversación) garantiza a lo más una fila por renglón, así
 * que el LEFT JOIN no multiplica la lista.
 */
const anuncioDeLaConversacion = and(
  eq(schema.adAttribution.organizationId, schema.conversation.organizationId),
  eq(schema.adAttribution.conversationId, schema.conversation.id)
);

const anuncioDeLista = {
  id: schema.adAttribution.id,
  headline: schema.adAttribution.headline,
  sourceId: schema.adAttribution.sourceId,
  sourceType: schema.adAttribution.sourceType,
};

function aAnuncioDeLista(
  fila: {
    id: string | null;
    headline: string | null;
    sourceId: string | null;
    sourceType: string | null;
  } | null
): ConversationDto["anuncio"] {
  // Sin fila, drizzle devuelve el objeto con todo en null (o null a secas).
  if (!fila?.id) return null;
  return {
    headline: fila.headline,
    sourceId: fila.sourceId,
    sourceType: fila.sourceType,
  };
}

/**
 * 042 — La llave de orden de la lista. Es EXACTAMENTE la expresión de `conversation_list_idx`: si se
 * escribe distinta, Postgres deja de poder usar el índice.
 */
const llaveDeLista = sql`coalesce(${schema.conversation.lastMessageAt}, ${schema.conversation.createdAt})`;

/**
 * 042 — La hora del evento de un mensaje: cuándo lo escribió quien lo escribió (`wa_timestamp`) y, si no
 * hay, cuándo lo registró el CRM. Es la ÚNICA llave de orden del hilo y del preview, la misma que la que
 * muestra la burbuja, y la de `message_event_idx`.
 */
const horaDelEvento = sql`coalesce(${schema.message.waTimestamp}, ${schema.message.createdAt})`;

/**
 * Lo que la fila de la lista dice del último mensaje. Filtra por organización Y conversación y ordena por
 * la hora del evento para poder recorrer `message_event_idx` hacia atrás un solo paso: antes solo filtraba
 * por conversación y el índice, que empieza por organización, no se podía usar.
 */
const previewSql = sql<string | null>`(
  select coalesce(m.text, m.type)
  from message m
  where m.organization_id = ${schema.conversation.organizationId}
    and m.conversation_id = ${schema.conversation.id}
  order by coalesce(m.wa_timestamp, m.created_at) desc, m.created_at desc, m.id desc
  limit 1
)`;

const stageSql = sql<string | null>`(
  select s.name from lead l
  join pipeline_stage s on s.id = l.stage_id
  where l.contact_id = ${schema.contact.id}
  limit 1
)`;

export const PAGE_DEFAULT = 40;
export const PAGE_MAX = 100;
export const THREAD_PAGE_DEFAULT = 50;
export const DELTA_MAX = 200;

export type ListFilters = {
  q?: string;
  stage?: string;
  channel?: Channel;
  filter?: "all" | "unread" | "anuncios";
};

/** `q` y `stage`: lo que acota qué conversaciones se cuentan en los chips de cada bandeja. */
function filtrosBase(f: ListFilters): (SQL | undefined)[] {
  return [
    busquedaDeContacto(schema.contact.name, schema.contact.phone, f.q),
    f.stage && f.stage !== "all"
      ? sql`exists (
          select 1 from lead l join pipeline_stage s on s.id = l.stage_id
          where l.contact_id = ${schema.contact.id} and s.name = ${f.stage}
        )`
      : undefined,
  ];
}

function filtrosDeLista(f: ListFilters): (SQL | undefined)[] {
  return [
    ...filtrosBase(f),
    f.channel ? eq(schema.conversation.channel, f.channel) : undefined,
    f.filter === "unread" ? gt(schema.conversation.unreadCount, 0) : undefined,
    f.filter === "anuncios" ? isNotNull(schema.adAttribution.id) : undefined,
  ];
}

/** El SELECT común de la lista: conversación, contacto, anuncio, preview, etapa y la llave de orden en texto. */
function seleccionarConversaciones() {
  return getDb()
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
      preview: previewSql,
      stageName: stageSql,
      anuncio: anuncioDeLista,
      // Con microsegundos: es lo que viaja en el cursor (un Date de JavaScript los perdería).
      sortText: sql<string>`(${llaveDeLista})::text`,
    })
    .from(schema.conversation)
    .innerJoin(schema.contact, eq(schema.conversation.contactId, schema.contact.id))
    .leftJoin(schema.adAttribution, anuncioDeLaConversacion);
}

type FilaDeLista = Awaited<ReturnType<ReturnType<typeof seleccionarConversaciones>["limit"]>>[number];

const aDto = (r: FilaDeLista): ConversationDto =>
  serializeConversation(r.conversation, r.contact, r.preview, r.stageName, aAnuncioDeLista(r.anuncio));

/** Los contadores de la pantalla (D1): se calculan con los filtros vigentes, en dos consultas cortas. */
async function contarBandeja(organizationId: string, f: ListFilters): Promise<InboxCountsDto> {
  const db = getDb();
  const base = and(
    eq(schema.conversation.organizationId, organizationId),
    eq(schema.conversation.isTest, false)
  );
  const [totalRows, porCanal] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.conversation)
      .where(base),
    db
      .select({
        channel: schema.conversation.channel,
        all: sql<number>`count(*)::int`,
        unread: sql<number>`(count(*) filter (where ${schema.conversation.unreadCount} > 0))::int`,
        anuncios: sql<number>`(count(*) filter (where ${schema.adAttribution.id} is not null))::int`,
      })
      .from(schema.conversation)
      .innerJoin(schema.contact, eq(schema.conversation.contactId, schema.contact.id))
      .leftJoin(schema.adAttribution, anuncioDeLaConversacion)
      .where(and(base, ...filtrosBase(f)))
      .groupBy(schema.conversation.channel),
  ]);

  const byChannel: InboxCountsDto["byChannel"] = {};
  let all = 0;
  let unread = 0;
  let anuncios = 0;
  for (const row of porCanal) {
    byChannel[row.channel] = row.all;
    if (!f.channel || f.channel === row.channel) {
      all += row.all;
      unread += row.unread;
      anuncios += row.anuncios;
    }
  }
  return { total: totalRows[0]?.n ?? 0, byChannel, all, unread, anuncios };
}

/** Las etapas presentes en la bandeja, en el orden del pipeline. */
async function etapasPresentes(organizationId: string): Promise<string[]> {
  const rows = await getDb()
    .select({
      name: schema.pipelineStage.name,
      position: sql<number>`min(${schema.pipelineStage.position})`,
    })
    .from(schema.conversation)
    .innerJoin(schema.lead, eq(schema.lead.contactId, schema.conversation.contactId))
    .innerJoin(schema.pipelineStage, eq(schema.pipelineStage.id, schema.lead.stageId))
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.isTest, false)
      )
    )
    .groupBy(schema.pipelineStage.name)
    .orderBy(sql`min(${schema.pipelineStage.position})`);
  return rows.map((r) => r.name);
}

/**
 * 042 — Una página de la lista, por cursor (keyset): `(llave, id)` descendente, sin `OFFSET`.
 *
 * Pide `limit + 1` filas para saber si hay más sin una consulta aparte. Los contadores y las etapas solo
 * van en la primera página: «cargar más» no los recalcula.
 */
export async function listConversationsPage(
  organizationId: string,
  opts: { limit?: number; cursor?: ListCursor | null; filters?: ListFilters }
): Promise<ConversationsPageDto> {
  const serverTime = new Date().toISOString();
  const limit = Math.min(Math.max(opts.limit ?? PAGE_DEFAULT, 1), PAGE_MAX);
  const filters = opts.filters ?? {};
  const cursor = opts.cursor ?? null;

  const rows = await seleccionarConversaciones()
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.isTest, false),
        ...filtrosDeLista(filters),
        cursor
          ? sql`(${llaveDeLista}, ${schema.conversation.id}) < (${cursor.k}::timestamp, ${cursor.id})`
          : undefined
      )
    )
    .orderBy(sql`${llaveDeLista} desc`, sql`${schema.conversation.id} desc`)
    .limit(limit + 1);

  const hayMas = rows.length > limit;
  const pagina = hayMas ? rows.slice(0, limit) : rows;
  const ultima = pagina[pagina.length - 1];
  const nextCursor =
    hayMas && ultima ? encodeListCursor({ k: ultima.sortText, id: ultima.conversation.id }) : null;

  const page: ConversationsPageDto = { conversations: pagina.map(aDto), nextCursor, serverTime };
  if (!cursor) {
    const [counts, stages] = await Promise.all([
      contarBandeja(organizationId, filters),
      etapasPresentes(organizationId),
    ]);
    page.counts = counts;
    page.stages = stages;
  }
  return page;
}

/**
 * 042 — Lo que cambió desde `since`, SIN filtros (el cliente necesita el estado nuevo de una conversación
 * que dejó de cumplir un filtro para poder sacarla de la vista). «Cambió» es más que la fila de la
 * conversación: mover de etapa toca al lead, y un anuncio recién atribuido toca la atribución.
 */
export async function listConversationsDelta(
  organizationId: string,
  since: Date,
  filters: ListFilters = {}
): Promise<ConversationsPageDto> {
  const serverTime = new Date().toISOString();
  const rows = await seleccionarConversaciones()
    .leftJoin(
      schema.lead,
      and(
        eq(schema.lead.organizationId, schema.conversation.organizationId),
        eq(schema.lead.contactId, schema.conversation.contactId)
      )
    )
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.isTest, false),
        or(
          gt(schema.conversation.updatedAt, since),
          gt(schema.lead.updatedAt, since),
          gt(schema.adAttribution.createdAt, since)
        )
      )
    )
    .orderBy(sql`${llaveDeLista} desc`, sql`${schema.conversation.id} desc`)
    .limit(DELTA_MAX + 1);

  const truncated = rows.length > DELTA_MAX;
  const [counts, stages] = await Promise.all([
    contarBandeja(organizationId, filters),
    etapasPresentes(organizationId),
  ]);
  return {
    conversations: (truncated ? rows.slice(0, DELTA_MAX) : rows).map(aDto),
    nextCursor: null,
    serverTime,
    counts,
    stages,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Una conversación completa (con su preview y etapa), para el enlace directo y las respuestas de `PATCH`. */
export async function getConversationDto(
  organizationId: string,
  conversationId: string
): Promise<ConversationDto | null> {
  const rows = await seleccionarConversaciones()
    .where(scoped(schema.conversation.organizationId, organizationId, eq(schema.conversation.id, conversationId)))
    .limit(1);
  return rows[0] ? aDto(rows[0]) : null;
}

/** La conversación (real) de un contacto, para `/bandeja?contact=`: no depende de que esté en la página cargada. */
export async function getConversationByContact(
  organizationId: string,
  contactId: string
): Promise<ConversationDto | null> {
  const rows = await seleccionarConversaciones()
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.contactId, contactId),
        eq(schema.conversation.isTest, false)
      )
    )
    .limit(1);
  return rows[0] ? aDto(rows[0]) : null;
}

/** 042 — El número de la barra lateral: un `SUM`, no una descarga de la lista. */
export async function unreadTotal(organizationId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`coalesce(sum(${schema.conversation.unreadCount}), 0)::int` })
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.isTest, false)
      )
    );
  return rows[0]?.n ?? 0;
}

export async function getConversation(
  organizationId: string,
  conversationId: string
) {
  const db = getDb();
  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
      anuncio: anuncioDeLista,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .leftJoin(schema.adAttribution, anuncioDeLaConversacion)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId)
      )
    )
    .limit(1);
  const row = rows[0];
  return row ? { ...row, anuncio: aAnuncioDeLista(row.anuncio) } : null;
}

/**
 * Mensajes de un hilo con `created_at` posterior a `since`, por hora del evento. El cliente no lo usa para
 * el hilo (un acuse de entrega no cambia `created_at`; ver la spec 042, D5), pero sigue siendo parte de la ruta.
 */
export async function listMessages(
  organizationId: string,
  conversationId: string,
  since?: Date
) {
  const db = getDb();
  return db
    .select({ message: schema.message, media: schema.mediaAsset })
    .from(schema.message)
    .leftJoin(
      schema.mediaAsset,
      eq(schema.message.mediaAssetId, schema.mediaAsset.id)
    )
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversationId),
        since ? gt(schema.message.createdAt, since) : undefined
      )
    )
    .orderBy(horaDelEvento, schema.message.createdAt, schema.message.id);
}

/**
 * 042 — Una página del hilo hacia arriba: los `limit` mensajes más recientes, o los `limit` anteriores al
 * cursor, entregados en orden ascendente. La llave es `(hora del evento, created_at, id)`.
 */
export async function listMessagesPage(
  organizationId: string,
  conversationId: string,
  opts: { limit?: number; before?: ThreadCursor | null }
): Promise<MessagesPageDto> {
  const serverTime = new Date().toISOString();
  const limit = Math.min(Math.max(opts.limit ?? THREAD_PAGE_DEFAULT, 1), PAGE_MAX);
  const before = opts.before ?? null;

  const rows = await getDb()
    .select({
      message: schema.message,
      media: schema.mediaAsset,
      t: sql<string>`(${horaDelEvento})::text`,
      c: sql<string>`(${schema.message.createdAt})::text`,
    })
    .from(schema.message)
    .leftJoin(schema.mediaAsset, eq(schema.message.mediaAssetId, schema.mediaAsset.id))
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversationId),
        before
          ? sql`(${horaDelEvento}, ${schema.message.createdAt}, ${schema.message.id}) < (${before.t}::timestamp, ${before.c}::timestamp, ${before.id})`
          : undefined
      )
    )
    .orderBy(
      sql`${horaDelEvento} desc`,
      sql`${schema.message.createdAt} desc`,
      sql`${schema.message.id} desc`
    )
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pagina = (hasMore ? rows.slice(0, limit) : rows).reverse();
  const masAntiguo = pagina[0];
  return {
    messages: pagina.map((r) => serializeMessage(r.message, r.media)) as MessagesPageDto["messages"],
    hasMore,
    nextBefore:
      hasMore && masAntiguo
        ? encodeThreadCursor({ t: masAntiguo.t, c: masAntiguo.c, id: masAntiguo.message.id })
        : null,
    serverTime,
  };
}

export function serializeConversation(
  c: typeof schema.conversation.$inferSelect,
  contact: typeof schema.contact.$inferSelect,
  preview: string | null = null,
  stageName: string | null = null,
  anuncio: ConversationDto["anuncio"] = null
): ConversationDto {
  const caps = capabilitiesFor(c.channel);
  const windowMs = windowMsFor(c.channel);
  const now = new Date();
  // 024: la extensión humana solo existe en los canales que la declaran.
  const reply =
    caps.humanAgentWindowMs !== null
      ? replyWindow(c.channel, c.lastInboundAt)
      : null;
  const open = c.lastInboundAt ? now.getTime() - c.lastInboundAt.getTime() < windowMs : false;
  const remaining = !c.lastInboundAt
    ? 0
    : !Number.isFinite(windowMs)
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, windowMs - (now.getTime() - c.lastInboundAt.getTime()));
  // 042: instantes absolutos, para que el cliente cuente su propio reloj. Un canal sin ventana no vence (null).
  const windowExpiresAt =
    c.lastInboundAt && Number.isFinite(windowMs)
      ? new Date(c.lastInboundAt.getTime() + windowMs).toISOString()
      : null;
  const humanLimitMs = caps.humanAgentWindowMs !== null ? Math.max(windowMs, caps.humanAgentWindowMs) : null;
  const humanExpiresAt =
    c.lastInboundAt && humanLimitMs !== null && Number.isFinite(humanLimitMs)
      ? new Date(c.lastInboundAt.getTime() + humanLimitMs).toISOString()
      : null;
  return {
    id: c.id,
    channel: c.channel,
    contact: { id: contact.id, name: contact.name, phone: contact.phone },
    stageName,
    aiEnabled: c.aiEnabled,
    handoffAt: c.handoffAt?.toISOString() ?? null,
    handoffReason: c.handoffReason,
    lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    sortKey: (c.lastMessageAt ?? c.createdAt).toISOString(),
    unreadCount: c.unreadCount,
    // 022: la ventana es la del canal (48 h en TikTok, 24 en los demás).
    windowOpen: open,
    windowRemainingMs: remaining,
    windowExpiresAt,
    humanWindow: reply
      ? {
          open: reply.humanAgentTag,
          remainingMs: reply.humanAgentTag ? reply.operatorRemainingMs : 0,
          expiresAt: humanExpiresAt,
        }
      : null,
    composer: { media: caps.outboundMedia, structured: caps.structuredMessages },
    preview,
    anuncio,
  };
}

/**
 * 042 — Marca leída una conversación. Solo escribe si había algo por leer: un `markRead` sobre un contador
 * ya en 0 no toca la fila, no mueve `updated_at` y quien llama no publica nada. Cuando sí cambia, `updated_at`
 * avanza para que el delta de un cliente que estuvo desconectado lo recoja.
 */
export async function markConversationRead(
  organizationId: string,
  conversationId: string
): Promise<{ found: boolean; changed: boolean }> {
  const db = getDb();
  const updated = await db
    .update(schema.conversation)
    .set({ unreadCount: 0, updatedAt: new Date() })
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.id, conversationId),
        gt(schema.conversation.unreadCount, 0)
      )
    )
    .returning({ id: schema.conversation.id });
  if (updated[0]) return { found: true, changed: true };
  const exists = await db
    .select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.id, conversationId)
      )
    )
    .limit(1);
  return { found: exists.length > 0, changed: false };
}

export async function updateConversation(
  organizationId: string,
  conversationId: string,
  patch: { aiEnabled?: boolean; reactivate?: boolean; markRead?: boolean }
) {
  const db = getDb();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.aiEnabled !== undefined) set.aiEnabled = patch.aiEnabled;
  if (patch.reactivate) {
    set.handoffAt = null;
    set.handoffReason = null;
    set.aiEnabled = patch.aiEnabled ?? true;
  }
  if (patch.markRead) set.unreadCount = 0;

  const updated = await db
    .update(schema.conversation)
    .set(set)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.id, conversationId)
      )
    )
    .returning();
  return updated[0] ?? null;
}

/** Los canales válidos para el filtro `channel` de la ruta. */
export const CHANNELS_FILTRABLES = CHANNEL_ORDER;
