/** DTOs que viajan por la API interna (lado cliente). */

import type { Channel } from "@/lib/channels";

export type ConversationDto = {
  id: string;
  /** 014: canal de la conversacion, para el distintivo de la bandeja. */
  channel: Channel;
  contact: { id: string; name: string; phone: string | null };
  stageName: string | null;
  aiEnabled: boolean;
  handoffAt: string | null;
  handoffReason: string | null;
  lastInboundAt: string | null;
  lastMessageAt: string | null;
  /**
   * 042 — La llave de orden de la lista: `coalesce(last_message_at, created_at)`, en ISO. Es lo que el cliente
   * usa para ordenar y para saber dónde cae una conversación que cambió.
   */
  sortKey: string;
  unreadCount: number;
  windowOpen: boolean;
  windowRemainingMs: number;
  /**
   * 042 — Cuándo se cierra la ventana normal del canal (ISO). `null` con `windowOpen: true` = un canal sin
   * ventana, que no vence jamás; `null` con `windowOpen: false` = no hay ventana (sin mensajes del cliente).
   * El cliente deriva el estado de aquí con su reloj; `windowOpen`/`windowRemainingMs` son la foto del servidor.
   */
  windowExpiresAt: string | null;
  /**
   * 024 — La ventana humana del canal (Instagram y Messenger:
   * hasta 7 días con la etiqueta de agente humano). `null` en un canal que no
   * la tiene. `open` = la ventana normal ya cerró pero una persona todavía
   * puede contestar; `remainingMs` es lo que le queda.
   */
  humanWindow: {
    open: boolean;
    remainingMs: number;
    /** 042 — Cuándo se acaba la extensión humana (ISO); siempre presente si el canal la tiene y hubo un entrante. */
    expiresAt: string | null;
  } | null;
  /**
   * 028 — Lo que el compositor puede ofrecer en este canal: adjuntos, y
   * ubicación o contacto. El servidor rechaza lo demás igual.
   */
  composer: { media: boolean; structured: boolean };
  preview: string | null;
  /** 018: el anuncio que abrió la conversación, para la marca de la lista. */
  anuncio: {
    headline: string | null;
    sourceId: string | null;
    /** `post` si fue una publicación y no un anuncio. */
    sourceType: string | null;
  } | null;
};

/** 018 — De qué anuncio llegó un contacto, como lo ve la bandeja. */
export type AnuncioDto = {
  sourceId: string | null;
  sourceType: string | null;
  /** Solo https. */
  sourceUrl: string | null;
  headline: string | null;
  body: string | null;
  mediaType: string | null;
  /** Imagen del creativo, servida por `/api/media/{id}`. */
  imageAssetId: string | null;
  /** Si Meta mandó identificador de clic. El valor no sale del servidor. */
  hasCtwaClid: boolean;
  capturedAt: string;
  /**
   * 038 — La jerarquía del anuncio según la Marketing API. Ausente (o null)
   * sin la bandera, sin credenciales o mientras el anuncio no se sincroniza.
   */
  adName?: string | null;
  adsetName?: string | null;
  campaignName?: string | null;
};

/** 008 — Adjunto de un mensaje, para previsualización en el hilo. */
export type MessageMediaDto = {
  assetId: string;
  kind:
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "location"
    | "contacts";
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
  caption: string | null;
  fetchStatus: "available" | "pending" | "failed";
  /** location {latitude, longitude, name?, address?} / contacts (subset). */
  payload: unknown;
};

export type MessageDto = {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  type: string;
  text: string | null;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  /** Motivo del fallo en lenguaje llano cuando status = "failed". */
  error: string | null;
  aiGenerated: boolean;
  /** 008 — Origen del saliente (en entrantes viene 'operator' y se ignora). */
  origin: "ai" | "operator" | "manual" | "template";
  media: MessageMediaDto | null;
  createdAt: string;
};

export type TemplateDto = {
  id: string;
  name: string;
  language: string;
  category: string;
  body: string;
  status: "draft" | "pending" | "approved" | "rejected";
  rejectionReason: string | null;
};

export type StageDto = {
  id: string;
  name: string;
  position: number;
  kind: "open" | "won" | "lost";
  /** 044 — Papel en el avance automático del lead (null = ninguna regla la toca). */
  autoRole?: AutoStageRole | null;
};

/** Un dato de la ficha. Escalar a propósito: ver `server/bot/ficha`. */
export type FichaValue = string | number | boolean;

/**
 * Ficha de calificación del lead. Claves libres: cada negocio califica
 * distinto, así que las define quien pregunta —el agente o el dueño— y el CRM
 * no las cablea.
 */
export type FichaDto = Record<string, FichaValue>;

export type ContactDto = {
  id: string;
  name: string;
  /** null en contactos que llegaron solo con BSUID (003). */
  phone: string | null;
  notes: string | null;
  /** Etapa del embudo del lead asociado; null si el contacto no tiene lead. */
  stageName: string | null;
  archivedAt: string | null;
  /** De dónde salió el prospecto, capturada o deducida. */
  source?: SourceDto;
  /** Prioridad del lead asociado; null si nadie la fijó. */
  priority?: PriorityValue | null;
  /** Lo que se sabe del lead. `{}` mientras nadie haya calificado. */
  ficha?: FichaDto;
  /** 027 — El agente no le responde a esta persona: la atiende el dueño. */
  aiPaused?: boolean;
  /** 037 — Pidió no recibir mensajes automáticos (baja); el motor de automatizaciones no le envía. */
  optedOut?: boolean;
  optedOutAt?: string | null;
};

/* ============================================================
 * Bitácora de etapas
 * ============================================================ */

/** Por qué se perdió un trato. Lista corta a propósito: una taxonomía larga
 *  se responde "otro" y deja de informar. */
export type LossReason =
  | "precio"
  | "no_es_perfil"
  | "sin_presupuesto"
  | "eligio_otro"
  | "nunca_contesto"
  | "otro";

export const LOSS_REASON_LABEL: Record<LossReason, string> = {
  precio: "Le pareció caro",
  no_es_perfil: "No era el perfil",
  sin_presupuesto: "Sin presupuesto ahora",
  eligio_otro: "Se fue con otro",
  nunca_contesto: "Nunca contestó",
  otro: "Otro",
};

/** Quién provocó un movimiento de etapa. */
export type StageChangeSource = "dueno" | "bot" | "sistema" | "migracion";

/** 044 — Papel de una etapa en el avance automático del lead. */
export type AutoStageRole = "new" | "conversation" | "interested" | "client";
/** 044 — Qué regla automática movió un lead. */
export type AutoStageRule = "first_reply" | "booking" | "sale";

/* ============================================================
 * Fuente del prospecto
 * ============================================================ */

export type SourceValue =
  | "anuncio"
  | "organico"
  | "referido"
  | "conocido"
  | "otro";

export type SourceDto = {
  /** "desconocida" cuando nadie la capturó y no se pudo deducir. */
  value: SourceValue | "desconocida";
  /** `deducida` = la infirió el sistema; `capturada` = la puso el dueño. */
  source: "capturada" | "deducida";
};

/* ============================================================
 * Prioridad del lead
 * ============================================================ */

/** La fija el dueño; NULL = nadie la ha decidido (no es "media"). */
export type PriorityValue = "alta" | "media" | "baja";


/** 042 — Los filtros de la lista de la bandeja; viajan al servidor y también se aplican en el cliente. */
export type InboxFilters = {
  q: string;
  /** Nombre de la etapa, o `all`. */
  stage: string;
  channel: Channel | "all";
  filter: "all" | "unread" | "anuncios";
};

/** 042 — Los contadores de la pantalla, calculados en el servidor con los filtros vigentes. */
export type InboxCountsDto = {
  /** Sin ningún filtro: el número del encabezado. */
  total: number;
  /** Con `q` y `stage`: lo que dicen las marcas de cada bandeja. */
  byChannel: Partial<Record<Channel, number>>;
  /** Con además el canal elegido: los tres chips. */
  all: number;
  unread: number;
  anuncios: number;
};

export type ConversationsPageDto = {
  conversations: ConversationDto[];
  /** `null` = no hay más. Opaco. */
  nextCursor: string | null;
  /** El reloj del servidor al empezar la consulta: de aquí salen el `since` siguiente y el desfase del reloj. */
  serverTime: string;
  /** Presentes en la primera página y en los deltas; no en «cargar más». */
  counts?: InboxCountsDto;
  stages?: string[];
  /** Un delta que no cupo (más de 200): el cliente repone la primera página. */
  truncated?: boolean;
};

export type MessagesPageDto = {
  /** En orden ascendente por hora del evento. */
  messages: MessageDto[];
  hasMore: boolean;
  /** Cursor para pedir lo anterior; `null` si no hay más. */
  nextBefore: string | null;
  serverTime: string;
};

/* ============================================================
 * 044 — Tablero del Pipeline
 * ============================================================ */

/** Una tarjeta del tablero. */
export type BoardLeadDto = {
  id: string;
  stageId: string;
  position: number;
  lastActivityAt: string | null;
  contact: { id: string; name: string; phone: string | null };
  channel: Channel;
  conversationId: string | null;
  amountCents: number | null;
  currency: string | null;
  priority: PriorityValue | null;
  /** La regla automática que movió el lead a su etapa actual (si fue la última), para decirlo en el cajón. */
  lastAutoRule: AutoStageRule | null;
};

/** Totales de una columna, con los filtros aplicados (los calcula el servidor). */
export type StageTotalsDto = {
  count: number;
  /** Suma en centavos de lo sumable (la moneda del negocio). */
  sumCents: number;
  withoutAmount: number;
  otherCurrency: number;
};

export type BoardStageDto = StageDto & {
  autoRole: AutoStageRole | null;
  totals: StageTotalsDto;
  leads: BoardLeadDto[];
  nextCursor: string | null;
};

export type BoardFiltersDto = {
  q?: string;
  priority?: PriorityValue | "sin";
  tag?: string;
  channel?: Channel;
};
