import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Tiempo: todas las columnas son `timestamp without time zone` y el marco es
 * UTC. Drizzle lo respeta en ambas direcciones; `now()` de los `defaultNow()`
 * solo lo respeta porque la conexión fija `TimeZone: "UTC"`
 * (ver src/lib/db/index.ts). No cambies una columna a `timestamptz` de forma
 * aislada: al leerla Drizzle seguiría añadiéndole "+0000" salvo que también
 * lleve `{ withTimezone: true }`.
 */

/* ============================================================
 * Auth (Better Auth + plugin organization)
 * ============================================================ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  activeOrganizationId: text("active_organization_id"),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  metadata: text("metadata"),
});

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});


/* ============================================================
 * Barberías, salones y manicure (módulo SALON)
 *
 * Catálogo (servicios y combos), equipo (staff, comisiones, horarios) y caja
 * (ventas). Dinero SIEMPRE en centavos enteros. Las tablas se crean igual en
 * toda instancia —unas tablas vacías son inertes—; lo que enciende la UI y la
 * API es la bandera `SALON` (src/server/business/flag.ts).
 * ============================================================ */

// Servicios individuales (Corte, Barba, Mascarilla, etc.)
export const service = pgTable(
  "service",
  {
    id: text("id").primaryKey(), // prefix: 'srv'
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    priceCents: integer("price_cents").notNull(), // en centavos (ej: 2500 = S/ 25.00)
    durationMinutes: integer("duration_minutes").notNull().default(30), // relativo/estimado
    photoUrl: text("photo_url"), // Sin uso (queda por compatibilidad): la imagen vive en `imageMediaId`
    /** Imagen elegida de la biblioteca (Medios). Si el medio se borra, queda sin imagen. */
    imageMediaId: text("image_media_id").references(() => mediaLibraryItem.id, {
      onDelete: "set null",
    }),
    /** Porcentaje de comisión por defecto para este servicio (0-100) */
    defaultCommissionPercentage: integer("default_commission_percentage").default(50),
    active: boolean("active").notNull().default(true),
    /**
     * El servicio «Otro» de la organización: un cobro a criterio cuyo monto se
     * escribe al vender (un tinte, un diseño). Existe uno por organización, lo
     * crea la primera venta y NUNCA aparece en el catálogo.
     */
    isOther: boolean("is_other").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("service_org_idx").on(t.organizationId, t.active),
    uniqueIndex("service_org_other_uq").on(t.organizationId).where(sql`${t.isOther}`),
    check("service_price_nonneg", sql`${t.priceCents} >= 0`),
    check("service_duration_pos", sql`${t.durationMinutes} > 0`),
    check(
      "service_commission_pct",
      sql`${t.defaultCommissionPercentage} is null or ${t.defaultCommissionPercentage} between 0 and 100`
    ),
  ]
);

// Combos/Ofertas para Publicidad Pagada
export const combo = pgTable(
  "combo",
  {
    id: text("id").primaryKey(), // prefix: 'cmb'
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // ej: "Combo Fresh"
    description: text("description").notNull(), // "Incluye corte, mascarilla, masajes..."
    priceCents: integer("price_cents").notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(60),
    /**
     * Palabra clave para enganchar con anuncios de Meta/TikTok (ej: "COMBO_FRESH").
     * Se guarda normalizada (MAYÚSCULAS, sin espacios) y es única por negocio.
     */
    keywordTrigger: text("keyword_trigger"),
    /** Imagen elegida de la biblioteca (Medios). Si el medio se borra, queda sin imagen. */
    imageMediaId: text("image_media_id").references(() => mediaLibraryItem.id, {
      onDelete: "set null",
    }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("combo_org_idx").on(t.organizationId, t.active),
    uniqueIndex("combo_org_keyword_uq")
      .on(t.organizationId, t.keywordTrigger)
      .where(sql`${t.keywordTrigger} is not null`),
    check("combo_price_nonneg", sql`${t.priceCents} >= 0`),
    check("combo_duration_pos", sql`${t.durationMinutes} > 0`),
  ]
);

// Integrantes del equipo (Barberos, Esteticistas, Manicuristas)
export const staff = pgTable(
  "staff",
  {
    id: text("id").primaryKey(), // prefix: 'stf'
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone"),
    active: boolean("active").notNull().default(true),
    /** Porcentaje global de comisión si aplica para todo (ej: 50%) */
    globalCommissionPercentage: integer("global_commission_percentage"),
    /** Foto elegida de la biblioteca (Medios). Si el medio se borra, queda sin foto. */
    imageMediaId: text("image_media_id").references(() => mediaLibraryItem.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("staff_org_idx").on(t.organizationId, t.active),
    check(
      "staff_commission_pct",
      sql`${t.globalCommissionPercentage} is null or ${t.globalCommissionPercentage} between 0 and 100`
    ),
  ]
);

// Comisiones personalizadas por barbero/servicio
export const staffServiceCommission = pgTable(
  "staff_service_commission",
  {
    id: text("id").primaryKey(), // prefix: 'ssc'
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    staffId: text("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    percentage: integer("percentage").notNull(), // Porcentaje específico para este barbero en este servicio
  },
  (t) => [
    uniqueIndex("staff_service_commission_uq").on(t.staffId, t.serviceId),
    index("staff_service_commission_org_idx").on(t.organizationId),
    check("staff_service_commission_pct", sql`${t.percentage} between 0 and 100`),
  ]
);

/**
 * Qué profesionales dan un servicio. SIN filas = lo da TODO el equipo (el valor
 * por defecto); con filas, solo los listados. «Todos» no se guarda como una fila
 * por profesional a propósito: un profesional nuevo debe poder dar lo que dan
 * todos sin que alguien tenga que acordarse de marcarlo.
 */
export const serviceStaff = pgTable(
  "service_staff",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    staffId: text("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.serviceId, t.staffId] }),
    index("service_staff_org_idx").on(t.organizationId),
    index("service_staff_staff_idx").on(t.staffId),
  ]
);

/** Igual que `service_staff`, para las ofertas: sin filas = todo el equipo. */
export const comboStaff = pgTable(
  "combo_staff",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    comboId: text("combo_id")
      .notNull()
      .references(() => combo.id, { onDelete: "cascade" }),
    staffId: text("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.comboId, t.staffId] }),
    index("combo_staff_org_idx").on(t.organizationId),
    index("combo_staff_staff_idx").on(t.staffId),
  ]
);

// Horario semanal / días libres por barbero. Sin fila para un día = sigue el
// horario del negocio (Ajustes → Agenda).
export const staffSchedule = pgTable(
  "staff_schedule",
  {
    id: text("id").primaryKey(), // prefix: 'sch'
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    staffId: text("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    dayOfWeek: integer("day_of_week").notNull(), // 0=Domingo, 1=Lunes, ...
    startTime: text("start_time").notNull(), // "10:00"
    endTime: text("end_time").notNull(), // "20:00"
    isOff: boolean("is_off").notNull().default(false), // Días libres
  },
  (t) => [
    uniqueIndex("staff_schedule_staff_day_uq").on(t.staffId, t.dayOfWeek),
    index("staff_schedule_org_idx").on(t.organizationId),
    check("staff_schedule_day", sql`${t.dayOfWeek} between 0 and 6`),
  ]
);

// Ventas de caja. Es un registro FINANCIERO: sobrevive a que se borre el
// contacto (el nombre queda en `customer_name`) y no se borra con el
// servicio/combo/barbero (esos se desactivan).
export const serviceSale = pgTable(
  "service_sale",
  {
    id: text("id").primaryKey(), // prefix: 'sls'
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    bookingId: text("booking_id").references(() => booking.id, { onDelete: "set null" }), // Si nació de una cita
    contactId: text("contact_id").references(() => contact.id, { onDelete: "set null" }),
    /** Nombre del cliente al cobrar: el historial no cambia si se renombra o borra el contacto. */
    customerName: text("customer_name").notNull(),
    staffId: text("staff_id")
      .notNull()
      .references(() => staff.id),
    serviceId: text("service_id").references(() => service.id),
    comboId: text("combo_id").references(() => combo.id),
    amountCents: integer("amount_cents").notNull(), // Precio real cobrado
    /** Cálculo automático del pago al barbero en el momento de la atención */
    staffCommissionCents: integer("staff_commission_cents").notNull(),
    businessNetCents: integer("business_net_cents").notNull(), // Lo que le queda a la barbería
    paymentMethod: text("payment_method", {
      enum: ["efectivo", "yape_plin", "tarjeta", "otro"],
    }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("service_sale_org_when_idx").on(t.organizationId, t.createdAt),
    // Una cita se cobra una sola vez: la base lo garantiza, no el botón.
    uniqueIndex("service_sale_booking_uq")
      .on(t.bookingId)
      .where(sql`${t.bookingId} is not null`),
    index("service_sale_org_staff_idx").on(t.organizationId, t.staffId, t.createdAt),
    check("service_sale_amount_nonneg", sql`${t.amountCents} >= 0`),
    check(
      "service_sale_split",
      sql`${t.staffCommissionCents} + ${t.businessNetCents} = ${t.amountCents}`
    ),
    // O es un servicio o es un combo; nunca ninguno ni los dos.
    check("service_sale_one_item", sql`num_nonnulls(${t.serviceId}, ${t.comboId}) = 1`),
  ]
);

/**
 * Los ítems de una venta (el «carrito»): una venta puede llevar varios servicios
 * u ofertas. `amount_cents` es lo que le toca a cada ítem del total cobrado (si
 * se editó el monto, se reparte proporcional al precio de lista), así la suma de
 * los ítems siempre es el monto de la venta y el desglose por servicio es exacto.
 * La fila de `service_sale` conserva como principal el primer ítem.
 */
export const serviceSaleItem = pgTable(
  "service_sale_item",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    saleId: text("sale_id")
      .notNull()
      .references(() => serviceSale.id, { onDelete: "cascade" }),
    serviceId: text("service_id").references(() => service.id),
    comboId: text("combo_id").references(() => combo.id),
    amountCents: integer("amount_cents").notNull(),
    position: integer("position").notNull().default(0),
    /** Solo en «Otro»: qué fue en concreto (p. ej. «Peinado para evento»). */
    note: text("note"),
  },
  (t) => [
    index("service_sale_item_org_idx").on(t.organizationId),
    index("service_sale_item_sale_idx").on(t.saleId),
    check("service_sale_item_amount_nonneg", sql`${t.amountCents} >= 0`),
    check("service_sale_item_one", sql`num_nonnulls(${t.serviceId}, ${t.comboId}) = 1`),
  ]
);

/**
 * Auditoría de la fecha de una venta. Cada corrección deja una fila: cuándo se
 * hizo, la fecha que tenía antes, la nueva y quién la hizo. Solo se inserta (la
 * app no tiene ninguna ruta que la edite o la borre) y NO lleva clave foránea a
 * la venta a propósito: si la venta se anula, el rastro del cambio se conserva.
 */
export const serviceSaleDateChange = pgTable(
  "service_sale_date_change",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    saleId: text("sale_id").notNull(),
    /** Instante de la venta antes y después del cambio (UTC). */
    previousAt: timestamp("previous_at").notNull(),
    newAt: timestamp("new_at").notNull(),
    changedAt: timestamp("changed_at").notNull().defaultNow(),
    changedByUserId: text("changed_by_user_id").notNull(),
    /** Nombre y correo de quien lo hizo, tal como eran en ese momento. */
    changedByLabel: text("changed_by_label").notNull(),
  },
  (t) => [
    index("service_sale_date_change_org_idx").on(t.organizationId, t.changedAt),
    index("service_sale_date_change_sale_idx").on(t.saleId),
  ]
);

/**
 * Auditoría de la edición de una venta (ítems, profesional y monto). Cada
 * corrección deja una fila con la venta TAL COMO ERA y TAL COMO QUEDÓ, quién la
 * hizo y cuándo. Solo se inserta y, como la de fechas, NO lleva clave foránea a
 * la venta: si se anula, el rastro se conserva.
 */
export const serviceSaleEdit = pgTable(
  "service_sale_edit",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    saleId: text("sale_id").notNull(),
    changedAt: timestamp("changed_at").notNull().defaultNow(),
    changedByUserId: text("changed_by_user_id").notNull(),
    /** Nombre y correo de quien lo hizo, tal como eran en ese momento. */
    changedByLabel: text("changed_by_label").notNull(),
    /** Foto de la venta antes y después: profesional, monto, comisión e ítems. */
    before: jsonb("before").notNull(),
    after: jsonb("after").notNull(),
  },
  (t) => [
    index("service_sale_edit_org_idx").on(t.organizationId, t.changedAt),
    index("service_sale_edit_sale_idx").on(t.saleId),
  ]
);

/* ============================================================
 * Dominio (toda tabla lleva organization_id NOT NULL + índice org-first)
 * ============================================================ */

export const contact = pgTable(
  "contact",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * Llave de resolución WhatsApp (003): teléfono normalizado (521→52) o
     * `bsuid:<id>` cuando Meta no manda wa_id. Estable de por vida.
     */
    /**
     * 014: canal por el que vive este contacto. Aditivo y con default: toda
     * fila existente sigue significando exactamente lo mismo.
     */
    channel: text("channel", { enum: ["whatsapp", "instagram", "messenger", "tiktok"] })
      .notNull()
      .default("whatsapp"),
    /**
     * Llave de resolucion. WhatsApp: telefono normalizado (521 a 52) o
     * `bsuid:<id>`. Instagram (014): `ig:<IGSID>`. Estable de por vida.
     * El nombre `wa_identity` se conserva porque es contrato publicado:
     * `/api/bot/context?waIdentity=...` lo recibe y lo devuelve, y hay
     * cerebros externos que dependen de el.
     */
    waIdentity: text("wa_identity").notNull(),
    /** Teléfono como ATRIBUTO opcional (003): falta en contactos BSUID. */
    phone: text("phone"),
    /** Business-Scoped User ID si se conoce (003). */
    waUserId: text("wa_user_id"),
    name: text("name").notNull(),
    /**
     * Quién puso este nombre.
     *
     * `perfil` = lo trajo WhatsApp y puede seguir actualizandose solo;
     * `manual` = lo escribio una persona en el CRM y NADIE lo pisa.
     *
     * Existe porque las dos cosas se necesitan a la vez: un contacto que
     * cambia su nombre de WhatsApp tiene que reflejarse (#51), y el operador
     * que renombro a alguien como "Juan - obra Polanco" no puede perder ese
     * trabajo con el siguiente mensaje.
     */
    nameSource: text("name_source", { enum: ["perfil", "manual"] })
      .notNull()
      .default("perfil"),
    notes: text("notes"),
    /**
     * Ficha de calificación que levanta un cerebro externo por
     * `PUT /api/bot/ficha`. Es un objeto libre a propósito: los datos que
     * importan de un lead los define cada negocio (una clínica querrá
     * "tratamiento", una constructora "metros"), y cablearlos como columnas
     * obligaría a migrar el CRM cada vez que alguien cambia su cuestionario.
     * Merge campo a campo; `null` explícito borra la clave.
     */
    ficha: jsonb("ficha").$type<Record<string, unknown>>(),
    /**
     * De dónde salió el prospecto. NULL = nadie la capturó, y entonces la API
     * la deduce. Así no hace falta backfill ni marcar en falso los contactos
     * que ya existían.
     */
    source: text("source", {
      enum: ["anuncio", "organico", "referido", "conocido", "otro"],
    }),
    /**
     * 027 — El agente no le responde a esta persona: clientes, miembros,
     * proveedores — gente a la que el dueño quiere atender él mismo.
     *
     * Vive en el CONTACTO y no solo en la conversación porque un contacto
     * importado todavía no tiene conversación (no se crean hilos vacíos), y
     * porque al eliminar una conversación (026) la siguiente nacería con el
     * agente encendido. La conversación lo hereda al crearse
     * (`getOrCreateConversation`); después manda el interruptor de la Bandeja.
     */
    aiPaused: boolean("ai_paused").notNull().default(false),
    /** Cumpleaños (solo día y mes; el año no se pide). Ambos o ninguno. */
    birthdayDay: smallint("birthday_day"),
    birthdayMonth: smallint("birthday_month"),
    /**
     * Módulo SALON: es cliente del salón. Se enciende con la primera venta en
     * Caja o al darlo de alta en Clientes; «eliminar cliente» solo lo apaga (el
     * contacto y sus ventas quedan).
     */
    salonClient: boolean("salon_client").notNull().default(false),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // 014: el canal entra en la llave. Sin el, un IGSID que coincidiera con
    // un telefono normalizado mezclaria dos personas en silencio.
    uniqueIndex("contact_org_channel_identity_uq").on(
      t.organizationId,
      t.channel,
      t.waIdentity
    ),
    index("contact_org_wa_user_id_idx").on(t.organizationId, t.waUserId),
    index("contact_org_name_idx").on(t.organizationId, t.name),
  ]
);

export const pipelineStage = pgTable(
  "pipeline_stage",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    /** open = etapa normal · won / lost = anclas no borrables */
    kind: text("kind", { enum: ["open", "won", "lost"] })
      .notNull()
      .default("open"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("stage_org_pos_idx").on(t.organizationId, t.position)]
);

export const lead = pgTable(
  "lead",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    stageId: text("stage_id")
      .notNull()
      .references(() => pipelineStage.id),
    position: integer("position").notNull().default(0),
    /**
     * Monto de la negociación en CENTAVOS ENTEROS. NULL = nadie lo capturó, que
     * no es lo mismo que cero: un trato sin monto no vale $0, simplemente no se
     * sabe, y el tablero lo dice con palabras en vez de sumar un cero.
     */
    amountCents: integer("amount_cents"),
    /** Moneda del monto; la del negocio al capturarlo (Ajustes → Marca). */
    currency: text("currency"),
    /**
     * Prioridad de cierre. NULL = nadie la ha decidido, que NO es lo mismo que
     * "media": nada la escribe automáticamente, así que el dueño puede confiar
     * en que lo que ve es lo que él puso.
     */
    priority: text("priority", { enum: ["alta", "media", "baja"] }),
    priorityUpdatedAt: timestamp("priority_updated_at"),
    lastActivityAt: timestamp("last_activity_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lead_contact_uq").on(t.contactId),
    index("lead_org_stage_idx").on(t.organizationId, t.stageId, t.position),
  ]
);

/**
 * Bitácora de movimientos de etapa: append-only. Nada se actualiza ni se borra;
 * corregir un dato es agregar un movimiento nuevo.
 *
 * Es el cimiento de todo lo histórico: sin ella el CRM solo sabe dónde está
 * cada lead HOY, y "¿cuánto cerré en julio?" no tiene respuesta.
 *
 * Regla dura: la ÚNICA puerta que escribe aquí —y que escribe `lead.stage_id`—
 * es `src/server/leads/stage-history.ts`. Un unit test de vigilancia falla si
 * aparece otra escritura, porque un camino que mueva el lead sin registrar el
 * evento no truena: solo hace que las gráficas mientan meses después.
 */
export const leadStageEvent = pgTable(
  "lead_stage_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    leadId: text("lead_id")
      .notNull()
      .references(() => lead.id, { onDelete: "cascade" }),
    /** Denormalizado a propósito: casi toda agregación cruza con el contacto,
     *  y el join extra se pagaría en cada consulta. */
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** NULL = el lead nació en `toStage` (evento de creación). */
    fromStageId: text("from_stage_id").references(() => pipelineStage.id, {
      onDelete: "set null",
    }),
    fromStageName: text("from_stage_name"),
    toStageId: text("to_stage_id").references(() => pipelineStage.id, {
      onDelete: "set null",
    }),
    /** Snapshots: sobreviven al renombre y al borrado de la etapa, para que
     *  reorganizar el tablero de hoy no reescriba el embudo del pasado. */
    toStageName: text("to_stage_name").notNull(),
    toStageKind: text("to_stage_kind", { enum: ["open", "won", "lost"] })
      .notNull()
      .default("open"),
    /** Cuándo PASÓ (no cuándo se registró). */
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
    /** NULL = no lo movió una persona (bot, sistema, migración). */
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    source: text("source", {
      enum: ["dueno", "bot", "sistema", "migracion"],
    })
      .notNull()
      .default("dueno"),
    /** true = fecha SEMBRADA en la migración, no observada. Cuenta para los
     *  totales pero jamás para promedios de tiempo. */
    approximate: boolean("approximate").notNull().default(false),
    lossReason: text("loss_reason", {
      enum: [
        "precio",
        "no_es_perfil",
        "sin_presupuesto",
        "eligio_otro",
        "nunca_contesto",
        "otro",
      ],
    }),
    lossNote: text("loss_note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("lse_org_occurred_idx").on(t.organizationId, t.occurredAt),
    index("lse_lead_occurred_idx").on(t.leadId, t.occurredAt),
    index("lse_org_kind_occurred_idx").on(
      t.organizationId,
      t.toStageKind,
      t.occurredAt
    ),
    // Perder un trato sin motivo es imposible a nivel de BASE, no por
    // disciplina de cada ruta. La excepción es la siembra de la migración: no
    // puede inventar un motivo que nadie capturó.
    check(
      "lse_loss_reason_ck",
      sql`${t.toStageKind} <> 'lost' OR ${t.approximate} = true OR ${t.lossReason} IS NOT NULL`
    ),
  ]
);

export const conversation = pgTable(
  "conversation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** Conversación del Laboratorio: jamás toca la API de WhatsApp. */
    isTest: boolean("is_test").notNull().default(false),
    /**
     * 014: canal de la conversacion. Denormalizado del contacto a proposito:
     * el ruteo de salida y el filtro de la bandeja lo leen en cada mensaje.
     */
    channel: text("channel", { enum: ["whatsapp", "instagram", "messenger", "tiktok"] })
      .notNull()
      .default("whatsapp"),
    /**
     * 014: identificador del hilo en la plataforma de origen. Zernio entrega
     * un conversationId opaco ("no asumas su formato") que hace falta para
     * responder; WhatsApp no lo necesita y queda null.
     */
    channelThreadRef: text("channel_thread_ref"),
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    handoffAt: timestamp("handoff_at"),
    handoffReason: text("handoff_reason", {
      // 008: manual_reply = el dueño respondió desde la app del teléfono.
      // hostilidad = el lead se puso agresivo y el agente se retiró.
      enum: [
        "cliente",
        "modelo",
        "error",
        "ventana",
        "hostilidad",
        "manual_reply",
      ],
    }),
    lastInboundAt: timestamp("last_inbound_at"),
    lastMessageAt: timestamp("last_message_at"),
    unreadCount: integer("unread_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Una conversación real por contacto; las de prueba no compiten.
    uniqueIndex("conversation_org_contact_real_uq")
      .on(t.organizationId, t.contactId)
      .where(sql`${t.isTest} = false`),
    index("conversation_org_last_idx").on(t.organizationId, t.lastMessageAt),
  ]
);

export const message = pgTable(
  "message",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    /** ID de WhatsApp — UNIQUE (idempotencia). Nullable en salientes de prueba. */
    waMessageId: text("wa_message_id").unique(),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    type: text("type").notNull().default("text"),
    text: text("text"),
    status: text("status", {
      enum: ["pending", "sent", "delivered", "read", "failed"],
    })
      .notNull()
      .default("pending"),
    error: text("error"),
    aiGenerated: boolean("ai_generated").notNull().default(false),
    /**
     * 008 — Origen del saliente: IA (bot), operador del CRM, manual desde la
     * app de WhatsApp Business del teléfono (echo), o plantilla. En entrantes
     * queda el default y la UI lo ignora.
     */
    origin: text("origin", {
      enum: ["ai", "operator", "manual", "template"],
    })
      .notNull()
      .default("operator"),
    /** 008 — Adjunto del mensaje (imagen, doc, ubicación…), si lo hay. */
    mediaAssetId: text("media_asset_id").references(() => mediaAsset.id, {
      onDelete: "set null",
    }),
    waTimestamp: timestamp("wa_timestamp"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("message_org_conv_idx").on(
      t.organizationId,
      t.conversationId,
      t.createdAt
    ),
  ]
);

/**
 * 008 — Adjuntos: archivo (imagen/video/audio/documento/sticker) copiado al
 * volumen local (`MEDIA_DIR`) o contenido estructurado (location/contacts) en
 * `payload`. Meta expira sus archivos (~30 días): el disco propio es la
 * fuente durable (constitución II: sin S3/R2).
 */
export const mediaAsset = pgTable(
  "media_asset",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "image",
        "video",
        "audio",
        "document",
        "sticker",
        "location",
        "contacts",
      ],
    }).notNull(),
    /** media id de Graph (entrantes/salientes subidos); NULL en location/contacts. */
    waMediaId: text("wa_media_id"),
    mimeType: text("mime_type"),
    fileName: text("file_name"),
    fileSize: integer("file_size"),
    caption: text("caption"),
    /** location {latitude, longitude, name?, address?} o contacts (subset). */
    payload: jsonb("payload"),
    /** Ruta relativa dentro de MEDIA_DIR; NULL si aún no descargado o no aplica. */
    storagePath: text("storage_path"),
    fetchStatus: text("fetch_status", {
      enum: ["available", "pending", "failed"],
    })
      .notNull()
      .default("pending"),
    fetchError: text("fetch_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("media_asset_org_idx").on(t.organizationId, t.createdAt),
    index("media_asset_wa_media_idx").on(t.waMediaId),
  ]
);

/**
 * Módulo Medios — la biblioteca de imágenes y videos del negocio (como la de
 * WordPress): se suben desde el dispositivo o se traen de un enlace, y se
 * reutilizan por su URL. Aparte de `media_asset`, que es el adjunto de una
 * conversación: aquí no hay mensaje, hay un archivo que alguien quiso guardar.
 * El binario vive en `MEDIA_DIR/<org>/medios/<id>`.
 */
export const mediaLibraryItem = pgTable(
  "media_library_item",
  {
    id: text("id").primaryKey(), // prefix: 'med'
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["image", "video"] }).notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    source: text("source", { enum: ["upload", "url"] }).notNull(),
    /** El enlace del que se trajo, cuando `source = 'url'`. */
    sourceUrl: text("source_url"),
    /** Quién lo subió; se conserva el nombre aunque el usuario se borre. */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("media_library_item_org_idx").on(t.organizationId, t.createdAt),
    check("media_library_item_size_pos", sql`${t.sizeBytes} > 0`),
  ]
);

export const metaCredentials = pgTable(
  "meta_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    wabaId: text("waba_id").notNull(),
    phoneNumberId: text("phone_number_id").notNull(),
    displayPhoneNumber: text("display_phone_number"),
    verifiedName: text("verified_name"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("meta_credentials_org_uq").on(t.organizationId),
    // El webhook enruta por phone_number_id: debe ser único en la instancia.
    uniqueIndex("meta_credentials_phone_uq").on(t.phoneNumberId),
  ]
);

/**
 * 014 - Credenciales del canal de Instagram. Tabla explicita (no un jsonb
 * generico) porque unas credenciales tienen forma fija y conocida: asi
 * conservan tipado e indices. El token se cifra con los mismos helpers que el
 * de WhatsApp; un segundo mecanismo de cifrado seria un segundo mecanismo que
 * auditar.
 */
export const instagramCredentials = pgTable(
  "instagram_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** De donde vienen los mensajes: API unificada o app propia de Meta. */
    source: text("source", { enum: ["zernio", "meta"] }).notNull(),
    /** IG_ID del perfil profesional: por el enruta el webhook. */
    igUserId: text("ig_user_id").notNull(),
    /** Zernio: accountId de la cuenta conectada. Meta directo: null. */
    accountRef: text("account_ref"),
    username: text("username"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /**
     * 030 — Obsoleta: el secreto iba en claro. Nada la escribe; el arranque
     * la cifra en las columnas de abajo y la deja en nulo. Se quita en una
     * versión mayor (spec 030, D6).
     */
    webhookSecret: text("webhook_secret"),
    /** 030 — Secreto HMAC de las entregas de Zernio, cifrado como el token. */
    webhookSecretCipher: text("webhook_secret_cipher"),
    webhookSecretIv: text("webhook_secret_iv"),
    webhookSecretTag: text("webhook_secret_tag"),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("instagram_credentials_org_uq").on(t.organizationId),
    uniqueIndex("instagram_credentials_ig_user_uq").on(t.igUserId),
    index("instagram_credentials_account_ref_idx").on(t.accountRef),
  ]
);

/**
 * 017 — Credenciales del canal de Messenger: la página de Facebook y su token
 * de acceso, cifrado con el mismo AES-256-GCM que los demás. Tabla propia y
 * explícita, como la de Instagram: unas credenciales tienen forma fija y
 * conocida, y esconderlas en un jsonb perdería el tipado y los índices.
 */
export const messengerCredentials = pgTable(
  "messenger_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** De donde vienen los mensajes: API unificada o app propia de Meta. */
    source: text("source", { enum: ["zernio", "meta"] })
      .notNull()
      .default("meta"),
    /**
     * ID de la página de Facebook: por él enruta el webhook de Meta
     * (`entry[].id`). En modo Zernio puede no conocerse — ahí enruta
     * `account_ref` — así que es opcional.
     */
    pageId: text("page_id"),
    pageName: text("page_name"),
    /** Zernio: accountId de la cuenta conectada. Meta directo: null. */
    accountRef: text("account_ref"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /**
     * 030 — Obsoleta: el secreto iba en claro. Nada la escribe; el arranque
     * la cifra en las columnas de abajo y la deja en nulo. Se quita en una
     * versión mayor (spec 030, D6).
     */
    webhookSecret: text("webhook_secret"),
    /** 030 — Secreto HMAC de las entregas de Zernio, cifrado como el token. */
    webhookSecretCipher: text("webhook_secret_cipher"),
    webhookSecretIv: text("webhook_secret_iv"),
    webhookSecretTag: text("webhook_secret_tag"),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messenger_credentials_org_uq").on(t.organizationId),
    uniqueIndex("messenger_credentials_page_uq").on(t.pageId),
    index("messenger_credentials_account_ref_idx").on(t.accountRef),
  ]
);

/**
 * 022 — Credenciales del canal de TikTok.
 *
 * TikTok no abre su API de mensajes a una app propia como hace Meta: llega por
 * la API unificada de Zernio. `source` existe, con un solo valor, para que una
 * fuente futura no pida otra migración (mismo patrón que
 * `messenger_credentials`).
 */
export const tiktokCredentials = pgTable(
  "tiktok_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    source: text("source", { enum: ["zernio"] }).notNull().default("zernio"),
    /** `accountId` de la cuenta en Zernio: por él enruta el webhook. */
    accountRef: text("account_ref").notNull(),
    /** Usuario de TikTok, solo para enseñarlo en Ajustes. */
    username: text("username"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /**
     * 030 — Obsoleta: el secreto iba en claro. Nada la escribe; el arranque
     * la cifra en las columnas de abajo y la deja en nulo. Se quita en una
     * versión mayor (spec 030, D6).
     */
    webhookSecret: text("webhook_secret"),
    /** 030 — Secreto HMAC de las entregas de Zernio, cifrado como el token. */
    webhookSecretCipher: text("webhook_secret_cipher"),
    webhookSecretIv: text("webhook_secret_iv"),
    webhookSecretTag: text("webhook_secret_tag"),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tiktok_credentials_org_uq").on(t.organizationId),
    uniqueIndex("tiktok_credentials_account_ref_uq").on(t.accountRef),
  ]
);

export const agentProfile = pgTable(
  "agent_profile",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    name: text("name").notNull().default("Asistente"),
    tone: text("tone"),
    instructions: text("instructions"),
    escalationRules: text("escalation_rules"),
    greeting: text("greeting"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_profile_org_uq").on(t.organizationId)]
);

export const kbEntry = pgTable(
  "kb_entry",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["qa", "block"] }).notNull(),
    question: text("question"),
    answer: text("answer"),
    content: text("content"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("kb_org_idx").on(t.organizationId)]
);

export const template = pgTable(
  "template",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    language: text("language").notNull(),
    category: text("category").notNull(),
    body: text("body").notNull(),
    status: text("status", {
      enum: ["draft", "pending", "approved", "rejected"],
    })
      .notNull()
      .default("draft"),
    rejectionReason: text("rejection_reason"),
    waTemplateId: text("wa_template_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("template_org_name_lang_uq").on(
      t.organizationId,
      t.name,
      t.language
    ),
  ]
);

export const agentTestRun = pgTable(
  "agent_test_run",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["running", "done", "failed"] })
      .notNull()
      .default("running"),
    score: integer("score"),
    error: text("error"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    // Lock de concurrencia en BD: máximo 1 corrida activa por organización.
    uniqueIndex("test_run_org_running_uq")
      .on(t.organizationId)
      .where(sql`${t.status} = 'running'`),
    index("test_run_org_idx").on(t.organizationId, t.startedAt),
  ]
);

/* ============================================================
 * 015 — Motor de agenda (detrás de la bandera AGENDA)
 *
 * Las tablas se crean SIEMPRE, encendida o apagada la bandera: una tabla
 * vacía es inerte, y a cambio todas las instancias del mundo comparten la
 * misma estructura y la misma cadena de migraciones (ADR-001).
 * ============================================================ */

/** Configuración de la agenda del negocio: una fila por organización. */
export const calendarSettings = pgTable(
  "calendar_settings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** `{"mon":[{"start":"09:00","end":"18:00"}]}` — hora de PARED, no UTC. */
    weeklyHours: jsonb("weekly_hours").notNull(),
    slotMinutes: integer("slot_minutes").notNull().default(30),
    bufferMinutes: integer("buffer_minutes").notNull().default(0),
    minNoticeHours: integer("min_notice_hours").notNull().default(2),
    maxDaysAhead: integer("max_days_ahead").notNull().default(7),
    timezone: text("timezone").notNull().default("America/Mexico_City"),
    /**
     * Cómo se entrega la reunión. `enlace-fijo` no habla con nadie: es el
     * default y la razón de que encender la agenda no exija terceros.
     * Un fork agrega el suyo al catálogo del código sin tocar esta columna.
     */
    connector: text("connector").notNull().default("enlace-fijo"),
    /** Sala fija del conector `enlace-fijo`; null ⇒ citas sin link. */
    meetingLink: text("meeting_link"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("calendar_settings_org_uq").on(t.organizationId)]
);

/**
 * La cita. Una sola tabla para sesiones y bloqueos manuales: un bloqueo es
 * una cita sin contacto que ocupa agenda igual.
 */
export const booking = pgTable(
  "booking",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["session", "block"] })
      .notNull()
      .default("session"),
    status: text("status", {
      enum: ["agendada", "realizada", "no_show", "cancelada"],
    })
      .notNull()
      .default("agendada"),
    source: text("source", { enum: ["manual", "ai"] })
      .notNull()
      .default("manual"),
    contactId: text("contact_id").references(() => contact.id, {
      onDelete: "cascade",
    }),
    conversationId: text("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    leadId: text("lead_id").references(() => lead.id, { onDelete: "set null" }),
    /** Instante UTC. El horario semanal es de pared; esto ya está resuelto. */
    scheduledAt: timestamp("scheduled_at").notNull(),
    /** Capturada al crear: cambiar la configuración no reescribe el pasado. */
    durationMinutes: integer("duration_minutes").notNull(),
    /**
     * Con qué conector nació la ENTREGA. Reprogramar y cancelar hablan con
     * ESTE, no con el activo: si el negocio cambia de proveedor, las citas ya
     * confirmadas siguen viviendo donde se crearon.
     */
    connector: text("connector"),
    /** Id de la reunión/evento en el proveedor; null en `enlace-fijo`. */
    externalRef: text("external_ref"),
    /**
     * El link que se le dio al cliente. Se COPIA, no se lee de la
     * configuración: la cita es un hecho histórico, no una vista del presente.
     */
    meetingLink: text("meeting_link"),
    /**
     * El proveedor falló al crear la reunión. La cita existe igual —un tercero
     * caído no cuesta la conversión— y el operador reintenta desde "Citas".
     */
    linkPending: boolean("link_pending").notNull().default(false),
    /** Conversación del Laboratorio: jamás llama a un conector real. */
    isTest: boolean("is_test").notNull().default(false),
    notes: text("notes"),
    /**
     * Silla / profesional que atiende (módulo SALON). Null = sin asignar: es
     * lo que crean el agente y el flujo de siempre. Al borrar al profesional,
     * la cita queda sin asignar en vez de desaparecer.
     */
    staffId: text("staff_id").references(() => staff.id, { onDelete: "set null" }),
    /** Módulo SALON: el servicio u oferta para el que se agendó (uno de los dos, o ninguno). */
    serviceId: text("service_id").references(() => service.id, { onDelete: "set null" }),
    comboId: text("combo_id").references(() => combo.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("booking_org_when_idx").on(t.organizationId, t.scheduledAt),
    index("booking_org_staff_idx").on(t.organizationId, t.staffId, t.scheduledAt),
    index("booking_org_status_idx").on(t.organizationId, t.status),
    /**
     * Anti doble-booking ATÓMICO. La re-validación al confirmar deja una
     * ventana entre leer y escribir; esto la cierra en la BASE: dos
     * confirmaciones simultáneas del mismo instante no pueden ganar las dos, y
     * la perdedora recibe un 23505 que el servicio traduce a `slot_taken` con
     * alternativas frescas. Las citas de prueba quedan fuera: no consumen la
     * agenda real.
     */
    uniqueIndex("booking_org_active_slot_uq")
      // Multicupo (módulo SALON): único por instante Y silla. `coalesce` hace
      // que las citas sin asignar (staff_id null) sigan chocando entre sí como
      // antes (un NULL normal nunca choca): quien no asigna sillas no nota el
      // cambio.
      .on(t.organizationId, t.scheduledAt, sql`coalesce(${t.staffId}, '')`)
      .where(
        sql`${t.status} in ('agendada','realizada') and ${t.isTest} = false`
      ),
  ]
);

/**
 * La memoria de lo ofrecido. Es lo que hace verificable el requisito
 * innegociable: sin fila aquí, no hay reserva.
 *
 * Vive en el CRM y no en quien conduce la conversación porque Vocero promete
 * "conecta TU propio cerebro": con la garantía del lado del cliente, cualquier
 * cerebro podría reservar un instante que jamás se ofreció y el CRM lo
 * aceptaría.
 */
export const offeredSlot = pgTable(
  "offered_slot",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    startUtc: timestamp("start_utc").notNull(),
    /** La etiqueta EXACTA que se le mostró al cliente. */
    label: text("label").notNull(),
    offeredAt: timestamp("offered_at").notNull().defaultNow(),
  },
  (t) => [index("offered_slot_conv_idx").on(t.conversationId, t.startUtc)]
);

/**
 * Credenciales del conector Zoom (app Server-to-Server del propio negocio).
 * Tabla explícita como las de WhatsApp e Instagram: unas credenciales tienen
 * forma fija y conocida, y así conservan tipado e índices. El secreto se cifra
 * con los mismos helpers; un segundo mecanismo sería otro que auditar.
 */
export const zoomCredentials = pgTable(
  "zoom_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    clientId: text("client_id").notNull(),
    secretCipher: text("secret_cipher").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretTag: text("secret_tag").notNull(),
    /** `error` SE ESCRIBE cuando el proveedor rechaza la autenticación. */
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("zoom_credentials_org_uq").on(t.organizationId)]
);

/**
 * Credenciales del conector Google (Calendar + Meet), de la app de Google
 * Cloud del propio negocio. DOS secretos cifrados: el client secret y el
 * refresh token pegado una sola vez.
 */
export const googleCredentials = pgTable(
  "google_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    clientSecretCipher: text("client_secret_cipher").notNull(),
    clientSecretIv: text("client_secret_iv").notNull(),
    clientSecretTag: text("client_secret_tag").notNull(),
    refreshTokenCipher: text("refresh_token_cipher").notNull(),
    refreshTokenIv: text("refresh_token_iv").notNull(),
    refreshTokenTag: text("refresh_token_tag").notNull(),
    calendarId: text("calendar_id").notNull().default("primary"),
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("google_credentials_org_uq").on(t.organizationId)]
);

export const agentTestCase = pgTable(
  "agent_test_case",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentTestRun.id, { onDelete: "cascade" }),
    persona: text("persona").notNull(),
    conversationId: text("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    transcript: jsonb("transcript"),
    veredicto: text("veredicto", { enum: ["verde", "amarillo", "rojo"] }),
    hallazgos: jsonb("hallazgos"),
    status: text("status", {
      enum: ["pending", "running", "done", "judge_failed"],
    })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("test_case_run_idx").on(t.runId)]
);

/* ============================================================
 * 016 — Atribución de anuncios y Conversions API
 * (detrás de la bandera ATRIBUCION)
 * ============================================================ */

/**
 * De qué anuncio vino una conversación. El primer referral gana: el UNIQUE de
 * abajo es lo que vuelve idempotente la captura ante los reintentos de Meta,
 * en vez de un "consulta y luego inserta" que dos webhooks simultáneos
 * ganarían los dos.
 */
export const adAttribution = pgTable(
  "ad_attribution",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    /**
     * El identificador del clic en el anuncio. Es la llave de TODO: sin él no
     * hay nada que reportarle a Meta. Nullable porque hay referrals sin clid,
     * y porque sin la bandera ATRIBUCION no se guarda (018): el origen del
     * anuncio se ve siempre, el identificador de clic solo si se atribuye.
     */
    ctwaClid: text("ctwa_clid"),
    sourceId: text("source_id"),
    sourceType: text("source_type"),
    sourceUrl: text("source_url"),
    headline: text("headline"),
    body: text("body"),
    mediaType: text("media_type"),
    /**
     * 018 — La imagen del creativo, copiada del CDN de Meta (su URL caduca en
     * días). Compartida por todas las conversaciones del mismo `source_id`: se
     * descarga una vez por anuncio. Borrar el adjunto deja la fila sin imagen,
     * no apuntando a nada.
     */
    imageAssetId: text("image_asset_id").references(() => mediaAsset.id, {
      onDelete: "set null",
    }),
    /**
     * El referral recortado a sus claves conocidas (018: con cotas de tamaño,
     * y sin `ctwa_clid` si la bandera estaba apagada). Es la póliza contra
     * "Meta agregó un campo", y de aquí se vuelve a leer la URL de la imagen
     * cuando hay que reparar la copia.
     */
    raw: jsonb("raw").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_attribution_org_conversation_uq").on(
      t.organizationId,
      t.conversationId
    ),
    index("ad_attribution_org_contact_idx").on(t.organizationId, t.contactId),
    // 018 — la imagen ya guardada de un anuncio, y a qué filas asignarla.
    index("ad_attribution_org_source_idx").on(t.organizationId, t.sourceId),
  ]
);

/**
 * Cada intento de reportarle un desenlace a Meta. Las filas `skipped` no son
 * basura: son la respuesta a "¿por qué este lead no aparece en Meta?", que sin
 * ellas se contesta adivinando.
 */
export const conversionEvent = pgTable(
  "conversion_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    attributionId: text("attribution_id").references(() => adAttribution.id, {
      onDelete: "set null",
    }),
    /** Nombre del catálogo de Meta tal cual (`QualifiedLead`, `Purchase`). */
    eventName: text("event_name").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed", "skipped"] })
      .notNull()
      .default("pending"),
    /** Motivo legible: por qué se omitió, o qué contestó Meta. */
    error: text("error"),
    /**
     * Acuse del envío. Es la única referencia que Meta pide para rastrear un
     * evento de su lado; sin persistirla, un `sent` no se puede reclamar.
     */
    fbTraceId: text("fb_trace_id"),
    sentAt: timestamp("sent_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // El dedup ES este índice: la fila se inserta ANTES de hablar con Meta y
    // con ON CONFLICT DO NOTHING. Dos movimientos simultáneos del mismo lead
    // no pueden mandar dos compras.
    uniqueIndex("conversion_event_org_conv_name_uq").on(
      t.organizationId,
      t.conversationId,
      t.eventName
    ),
    index("conversion_event_org_created_idx").on(
      t.organizationId,
      t.createdAt
    ),
  ]
);

/** Conexión del negocio con su dataset de Meta (token cifrado en reposo). */
export const capiSettings = pgTable(
  "capi_settings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    datasetId: text("dataset_id").notNull(),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /**
     * Qué etapa significa "lead calificado" PARA ESTE NEGOCIO. Las etapas
     * sembradas de Vocero no incluyen ninguna con ese nombre y cada quien
     * renombra las suyas, así que se elige en vez de adivinarse. NULL = ese
     * evento no se emite. `set null` a propósito: borrar la etapa apaga el
     * evento, no rompe la configuración.
     */
    qualifiedStageId: text("qualified_stage_id").references(
      () => pipelineStage.id,
      { onDelete: "set null" }
    ),
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("capi_settings_org_uq").on(t.organizationId)]
);

/* ============================================================
 * Proveedor de IA (Ajustes → IA)
 * ============================================================ */

/**
 * Credencial del proveedor de IA de la organización (puerto de `ai_credentials`
 * de Vocero Cloud, issue #85). Una fila por organización: proveedor (su
 * `base_url` OpenAI-compatible), modelo y token cifrado con los mismos helpers
 * que el de WhatsApp; hacia fuera solo `token_last4`.
 *
 * `status` lo escribe el adaptador según lo que respondió QUIEN COBRA: 401 →
 * `paused_invalid_token`, 402 → `paused_no_credit`. Un 429 o un 500 no pausan
 * (ver `server/ai/credentials.ts`). Guardar un token nuevo vuelve a `active`.
 *
 * Sin fila, el adaptador cae a las variables `OPENROUTER_*` del entorno
 * (respaldo para instalaciones automatizadas); con fila, la fila manda.
 */
export const aiCredentials = pgTable(
  "ai_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Preset de la UI; `base_url` es lo que de verdad identifica al proveedor. */
    provider: text("provider", { enum: ["openrouter", "openai_compatible"] })
      .notNull()
      .default("openrouter"),
    baseUrl: text("base_url").notNull(),
    model: text("model").notNull(),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /** Lo ÚNICO del token que puede salir hacia el cliente. */
    tokenLast4: text("token_last4").notNull(),
    status: text("status", {
      enum: ["active", "paused_invalid_token", "paused_no_credit"],
    })
      .notNull()
      .default("active"),
    statusReason: text("status_reason"),
    statusChangedAt: timestamp("status_changed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_credentials_org_uq").on(t.organizationId)]
);

/* ============================================================
 * 021 — Despacho al cerebro
 * ============================================================ */

/**
 * El outbox del despachador (spec 021): los turnos que el CRM le empuja a un
 * cerebro externo. El mensaje ya está en `message` antes de que exista una
 * fila aquí: bandeja primero, cerebro después.
 *
 * Misma tabla, columnas y estados que `dispatch` de Vocero Cloud, sin lo que
 * allá es de la plataforma (`brain_generation`, `expires_at`, `brain_kind`,
 * `responded_message_id`).
 */
export const dispatch = pgTable(
  "dispatch",
  {
    /** Es el `dispatchId` que viaja al cerebro: la clave de idempotencia. */
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: [
        "pendiente",
        "en_vuelo",
        "entregado",
        "caducado_a_humano",
        "descartado",
      ],
    })
      .notNull()
      .default("pendiente"),
    /** Sube al tomar la fila: distingue a dos dueños de un mismo lease. */
    attempts: integer("attempts").notNull().default(0),
    /**
     * La ventana de agrupado: cada mensaje nuevo de la conversación la empuja
     * hacia adelante. El worker solo toma filas cuyo `not_before` ya venció,
     * así que una ráfaga se junta sola.
     */
    notBefore: timestamp("not_before").notNull().defaultNow(),
    firstMessageAt: timestamp("first_message_at").notNull(),
    lastMessageAt: timestamp("last_message_at").notNull(),
    leasedUntil: timestamp("leased_until"),
    /**
     * 025 — Los entrantes que este despacho le DEBE al cerebro: los que lo
     * encolaron o lo extendieron.
     *
     * La ráfaga se delimita por el último saliente, y eso confunde «sin
     * responder» con «sin entregar»: lo que el cliente escribe mientras el
     * cerebro piensa queda DETRÁS de su respuesta. Con los ids anotados, ese
     * mensaje viaja aunque ya haya una respuesta después de él. Nulo en filas
     * anteriores a esta columna, que se comportan como antes.
     */
    messageIds: jsonb("message_ids").$type<string[]>(),
    /** Motivo del último fallo. Nunca el cuerpo firmado ni la llave. */
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    /**
     * La pieza central de esta tabla: como máximo UN despacho vivo por
     * conversación. De aquí salen el agrupado de ráfagas y el orden, y
     * sobreviven a que alguien reescriba el worker, porque la garantía la da
     * Postgres y no la lógica.
     */
    uniqueIndex("dispatch_conversation_vivo_uq")
      .on(t.conversationId)
      .where(sql`${t.status} in ('pendiente', 'en_vuelo')`),
    /**
     * La tarjeta «Quién responde» pregunta por el último entregado y el último
     * fallido. Con `updated_at` en el índice esa pregunta cuesta lo mismo con
     * cien filas que con un millón; sin él, cada refresco ordenaba todo el
     * histórico. (En Vocero Cloud es `dispatch_org_status_idx`, sin la tercera
     * columna: este es su superconjunto.)
     */
    index("dispatch_org_status_updated_idx").on(
      t.organizationId,
      t.status,
      t.updatedAt
    ),
    // La consulta del worker: pendientes cuya ventana ya venció.
    index("dispatch_status_notbefore_idx").on(t.status, t.notBefore),
  ]
);

/**
 * Notificaciones del equipo (la campanita y `/notificaciones`): una fila por cosa
 * que pasó en el negocio — una cita agendada o cancelada, una venta, un contacto
 * nuevo por WhatsApp. Son de la ORGANIZACIÓN (todas las personas del equipo ven las
 * mismas), siempre se leen y se marcan filtrando por `organization_id`. `link` es
 * la ruta interna a la que lleva (la cita, la venta).
 */
export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(), // prefix: 'ntf'
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    message: text("message").notNull(),
    category: text("category", { enum: ["cita", "venta", "whatsapp", "sistema"] }).notNull(),
    isRead: boolean("is_read").notNull().default(false),
    link: text("link"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("notifications_org_created_idx").on(t.organizationId, t.createdAt),
    index("notifications_org_unread_idx").on(t.organizationId, t.isRead),
  ]
);
