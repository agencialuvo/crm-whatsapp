import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { normalizeMx } from "@/lib/meta/client";
import type { ClientCreateInput, ClientInput } from "@/lib/salon/schemas";
import type {
  ContactMatchDto,
  SalonClientDetailDto,
  SalonClientDto,
} from "@/lib/salon/types";
import {
  SalonError,
  isPgError,
  UNIQUE_VIOLATION,
} from "@/server/business/http";
import {
  loadSaleItems,
  registerServiceSale,
} from "@/server/business/sales-service";

/**
 * Módulo SALON — clientes (CRUD).
 *
 * Un contacto es cliente del salón cuando `contact.salon_client` está
 * encendido: se enciende solo con su primera venta en Caja (ver
 * `registerServiceSale`) o al darlo de alta aquí. «Eliminar» solo lo apaga: el
 * contacto sigue en Contactos y sus ventas siguen en Caja (son dinero ya
 * cobrado); si vuelve a comprar, vuelve a ser cliente.
 */

/** Tope de la lista; más allá se afina con la búsqueda. */
const CLIENT_LIST_LIMIT = 1000;

const c = schema.contact;
const sale = schema.serviceSale;

const clientColumns = {
  id: c.id,
  name: c.name,
  phone: c.phone,
  birthdayDay: c.birthdayDay,
  birthdayMonth: c.birthdayMonth,
  notes: c.notes,
  salonClient: c.salonClient,
  registeredAt: c.createdAt,
  visits: sql<number>`count(${sale.id})::int`,
  lastVisitAt: sql<Date | null>`max(${sale.createdAt})`,
  totalCents: sql<number>`coalesce(sum(${sale.amountCents}), 0)::float8`,
};

type ClientRow = {
  id: string;
  name: string;
  phone: string | null;
  birthdayDay: number | null;
  birthdayMonth: number | null;
  notes: string | null;
  salonClient: boolean;
  registeredAt: Date | string;
  visits: number;
  lastVisitAt: Date | string | null;
  totalCents: number;
};

function omitSalonClient(r: ClientRow): Omit<ClientRow, "salonClient"> {
  const { salonClient, ...rest } = r;
  void salonClient;
  return rest;
}

function toDto(r: ClientRow): SalonClientDto {
  return {
    ...omitSalonClient(r),
    registeredAt: new Date(r.registeredAt).toISOString(),
    lastVisitAt: r.lastVisitAt ? new Date(r.lastVisitAt).toISOString() : null,
  };
}

/** Escapa `%`, `_` y `\` para que la búsqueda sea literal. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

/** Contacto + sus ventas (si las hay), acotado a la organización. */
function clientsQuery(organizationId: string) {
  return getDb()
    .select(clientColumns)
    .from(c)
    .leftJoin(
      sale,
      and(eq(sale.contactId, c.id), eq(sale.organizationId, organizationId)),
    );
}

/** Los clientes de la organización, la última visita primero. */
export async function listSalonClients(
  organizationId: string,
  q?: string,
  max: number = CLIENT_LIST_LIMIT,
): Promise<{ clients: SalonClientDto[]; truncated: boolean }> {
  const text = q?.trim().slice(0, 80);
  const rows = await clientsQuery(organizationId)
    .where(
      scoped(
        c.organizationId,
        organizationId,
        eq(c.salonClient, true),
        text
          ? or(
              ilike(c.name, likePattern(text)),
              ilike(c.phone, likePattern(text)),
            )
          : undefined,
      ),
    )
    .groupBy(c.id)
    .orderBy(sql`max(${sale.createdAt}) desc nulls last`, c.name)
    .limit(max + 1);
  return {
    clients: rows.slice(0, max).map(toDto),
    truncated: rows.length > max,
  };
}

/** ¿La búsqueda es un número de celular (solo dígitos, con espacios, «+» o guiones)? */
function phoneDigitsOf(text: string): string | null {
  if (!/^[\d\s+\-()]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, "");
  return digits.length >= 2 ? digits : null;
}

/**
 * Búsqueda global para el autocompletado de Caja y del alta de clientes: TODOS
 * los contactos de WhatsApp con celular (clientes y no clientes), por celular o
 * nombre. Los que ya son clientes salen primero. Acotada y sin montos.
 *
 * Por NOMBRE se muestran todas las coincidencias (dos «Piero» con celulares
 * distintos son dos personas). Por CELULAR se consolida por número normalizado:
 * una sola ficha por teléfono, la que ya es cliente o, si empatan, la más reciente.
 */
export async function searchContactMatches(
  organizationId: string,
  q: string,
  max = 5,
): Promise<ContactMatchDto[]> {
  const text = q.trim().slice(0, 80);
  if (text.length < 2) return [];
  const digits = phoneDigitsOf(text);
  const rows = await clientsQuery(organizationId)
    .where(
      scoped(
        c.organizationId,
        organizationId,
        eq(c.channel, "whatsapp"),
        sql`${c.phone} is not null`,
        digits
          ? ilike(c.phone, likePattern(digits))
          : or(ilike(c.name, likePattern(text)), ilike(c.phone, likePattern(text))),
      ),
    )
    .groupBy(c.id)
    .orderBy(desc(c.salonClient), c.name)
    // Al consolidar por celular salen menos filas que las leídas: se lee de más.
    .limit(digits ? 50 : max);

  let picked = rows;
  if (digits) {
    const recency = (r: (typeof rows)[number]): number =>
      new Date(r.lastVisitAt ?? r.registeredAt).getTime();
    const best = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const key = normalizeMx((r.phone ?? "").replace(/\D/g, ""));
      const cur = best.get(key);
      if (
        !cur ||
        (r.salonClient && !cur.salonClient) ||
        (r.salonClient === cur.salonClient && recency(r) > recency(cur))
      ) {
        best.set(key, r);
      }
    }
    picked = [...best.values()].sort(
      (x, y) => Number(y.salonClient) - Number(x.salonClient) || recency(y) - recency(x),
    );
  }
  return picked.slice(0, max).map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone ?? "",
    birthdayDay: r.birthdayDay,
    birthdayMonth: r.birthdayMonth,
    salonClient: r.salonClient,
    visits: r.visits,
  }));
}

/** Ficha de un cliente con su historial; 404 si no existe o no es cliente. */
export async function getSalonClient(
  organizationId: string,
  contactId: string,
): Promise<SalonClientDetailDto> {
  const [row] = await clientsQuery(organizationId)
    .where(
      scoped(
        c.organizationId,
        organizationId,
        eq(c.id, contactId),
        eq(c.salonClient, true),
      ),
    )
    .groupBy(c.id);
  if (!row)
    throw new SalonError("client_not_found", 404, "El cliente no existe");

  const history = await getDb()
    .select({
      id: sale.id,
      createdAt: sale.createdAt,
      serviceName: schema.service.name,
      comboName: schema.combo.name,
      staffName: schema.staff.name,
      amountCents: sale.amountCents,
      paymentMethod: sale.paymentMethod,
    })
    .from(sale)
    .innerJoin(schema.staff, eq(schema.staff.id, sale.staffId))
    .leftJoin(schema.service, eq(schema.service.id, sale.serviceId))
    .leftJoin(schema.combo, eq(schema.combo.id, sale.comboId))
    .where(
      scoped(
        sale.organizationId,
        organizationId,
        eq(sale.contactId, contactId),
      ),
    )
    .orderBy(desc(sale.createdAt));

  const itemsBySale = await loadSaleItems(
    organizationId,
    history.map((h) => h.id),
  );
  return {
    client: toDto(row),
    history: history.map((h) => {
      const items = itemsBySale.get(h.id);
      return {
        id: h.id,
        createdAt: h.createdAt.toISOString(),
        itemKind:
          items?.[0]?.kind ??
          (h.comboName ? ("combo" as const) : ("service" as const)),
        itemName: items
          ? items.map((i) => i.name).join(" + ")
          : (h.comboName ?? h.serviceName ?? "—"),
        staffName: h.staffName,
        paymentMethod: h.paymentMethod,
        amountCents: h.amountCents,
      };
    }),
  };
}

/**
 * Alta de un cliente: un cliente siempre ha adquirido un servicio, así que el
 * alta REGISTRA su primera compra (al precio de lista, que sale del catálogo)
 * y esa venta lo vuelve cliente. Si el celular ya es de un contacto, se
 * reutiliza en vez de duplicar a la persona. Si ya es cliente, NO se duplica:
 * la atención se suma a su historial (una visita más y su monto al total
 * invertido); el nombre y el cumpleaños que lleguen sí actualizan su ficha.
 */
export async function createSalonClient(
  organizationId: string,
  input: ClientCreateInput,
): Promise<SalonClientDetailDto> {
  const db = getDb();
  const phone = normalizeMx(input.phone);

  // La venta crea (o reutiliza) el contacto, lo marca cliente y guarda el cumpleaños.
  const { sale } = await registerServiceSale(organizationId, {
    customerName: input.name,
    customerPhone: phone,
    birthdayDay: input.birthdayDay ?? null,
    birthdayMonth: input.birthdayMonth ?? null,
    staffId: input.staffId,
    items: input.items,
    soldOn: input.soldOn ?? null,
    amountCents: input.amountCents,
    paymentMethod: input.paymentMethod,
    customCommissionPercentage: input.customCommissionPercentage ?? null,
  });

  const [created] = await db
    .select({ id: schema.serviceSale.contactId })
    .from(schema.serviceSale)
    .where(
      scoped(
        schema.serviceSale.organizationId,
        organizationId,
        eq(schema.serviceSale.id, sale.id),
      ),
    )
    .limit(1);
  const contactId = created?.id;
  if (!contactId)
    throw new SalonError("client_not_found", 404, "El cliente no existe");

  // El nombre y las notas que se escribieron aquí mandan sobre los del contacto.
  await db
    .update(c)
    .set({
      name: input.name,
      nameSource: "manual",
      archivedAt: null,
      updatedAt: new Date(),
      ...(input.notes ? { notes: input.notes } : {}),
    })
    .where(scoped(c.organizationId, organizationId, eq(c.id, contactId)));
  return getSalonClient(organizationId, contactId);
}

/** Edición completa de un cliente (nombre, celular, cumpleaños y notas). */
export async function updateSalonClient(
  organizationId: string,
  contactId: string,
  input: ClientInput,
): Promise<SalonClientDetailDto> {
  const db = getDb();
  const [current] = await db
    .select({
      channel: c.channel,
      phone: c.phone,
      waIdentity: c.waIdentity,
    })
    .from(c)
    .where(
      scoped(
        c.organizationId,
        organizationId,
        eq(c.id, contactId),
        eq(c.salonClient, true),
      ),
    )
    .limit(1);
  if (!current)
    throw new SalonError("client_not_found", 404, "El cliente no existe");

  const phone = normalizeMx(input.phone);
  const phoneChanged = phone !== current.phone;
  // La identidad de WhatsApp es el celular normalizado: si el contacto se
  // identificaba por él, el cambio la mueve también. Una identidad de otro tipo
  // (BSUID, otro canal) no se toca.
  const identityFollowsPhone =
    current.channel === "whatsapp" && current.waIdentity === current.phone;

  if (phoneChanged) {
    const [clash] = await db
      .select({ id: c.id })
      .from(c)
      .where(
        scoped(
          c.organizationId,
          organizationId,
          eq(c.channel, "whatsapp"),
          or(eq(c.waIdentity, phone), eq(c.phone, phone)),
        ),
      )
      .limit(1);
    if (clash && clash.id !== contactId) {
      throw new SalonError(
        "client_exists",
        409,
        "Ese celular ya pertenece a otro contacto",
      );
    }
  }

  try {
    await db
      .update(c)
      .set({
        name: input.name,
        nameSource: "manual",
        phone,
        ...(phoneChanged && identityFollowsPhone ? { waIdentity: phone } : {}),
        birthdayDay: input.birthdayDay ?? null,
        birthdayMonth: input.birthdayMonth ?? null,
        notes: input.notes ?? null,
        updatedAt: new Date(),
      })
      .where(scoped(c.organizationId, organizationId, eq(c.id, contactId)));
  } catch (err) {
    if (isPgError(err, UNIQUE_VIOLATION)) {
      throw new SalonError(
        "client_exists",
        409,
        "Ese celular ya pertenece a otro contacto",
      );
    }
    throw err;
  }
  return getSalonClient(organizationId, contactId);
}

/**
 * Quita clientes de Clientes. Dos casos, según lo que tengan detrás:
 *
 * - **Con historia** (atenciones cobradas, conversaciones, leads, citas o
 *   anuncios atribuidos): borrado LÓGICO. Solo se apagan como cliente; el
 *   contacto y sus ventas se conservan (es dinero ya cobrado) y si vuelve a
 *   comprar, vuelve a ser cliente.
 * - **Limpios** (nada de lo anterior): se borra el contacto de verdad.
 *
 * Lo que no existe o no es cliente de esta organización se ignora.
 */
export async function removeSalonClients(
  organizationId: string,
  ids: string[],
): Promise<{ removed: number; deleted: number; kept: number }> {
  // Todo en una sola transacción y con las filas bloqueadas: si llega una
  // conversación o una venta mientras se decide, la decisión no se queda vieja
  // (un borrado físico arrastraría en cascada lo que acaba de llegar).
  return getDb().transaction(async (tx) => {
    const found = await tx
      .select({ id: c.id })
      .from(c)
      .where(
        scoped(
          c.organizationId,
          organizationId,
          inArray(c.id, ids),
          eq(c.salonClient, true),
        ),
      )
      .for("update");
    const targets = found.map((r) => r.id);
    if (targets.length === 0) return { removed: 0, deleted: 0, kept: 0 };

    const withHistory = new Set<string>();
    const collect = (rows: { id: string | null }[]) => {
      for (const r of rows) if (r.id) withHistory.add(r.id);
    };
    collect(
      await tx
        .selectDistinct({ id: sale.contactId })
        .from(sale)
        .where(
          scoped(
            sale.organizationId,
            organizationId,
            inArray(sale.contactId, targets),
          ),
        ),
    );
    collect(
      await tx
        .selectDistinct({ id: schema.conversation.contactId })
        .from(schema.conversation)
        .where(
          scoped(
            schema.conversation.organizationId,
            organizationId,
            inArray(schema.conversation.contactId, targets),
          ),
        ),
    );
    collect(
      await tx
        .selectDistinct({ id: schema.lead.contactId })
        .from(schema.lead)
        .where(
          scoped(
            schema.lead.organizationId,
            organizationId,
            inArray(schema.lead.contactId, targets),
          ),
        ),
    );
    collect(
      await tx
        .selectDistinct({ id: schema.booking.contactId })
        .from(schema.booking)
        .where(
          scoped(
            schema.booking.organizationId,
            organizationId,
            inArray(schema.booking.contactId, targets),
          ),
        ),
    );
    collect(
      await tx
        .selectDistinct({ id: schema.adAttribution.contactId })
        .from(schema.adAttribution)
        .where(
          scoped(
            schema.adAttribution.organizationId,
            organizationId,
            inArray(schema.adAttribution.contactId, targets),
          ),
        ),
    );

    const keep = targets.filter((id) => withHistory.has(id));
    const clean = targets.filter((id) => !withHistory.has(id));
    if (keep.length > 0) {
      await tx
        .update(c)
        .set({ salonClient: false, updatedAt: new Date() })
        .where(scoped(c.organizationId, organizationId, inArray(c.id, keep)));
    }
    if (clean.length > 0) {
      await tx
        .delete(c)
        .where(scoped(c.organizationId, organizationId, inArray(c.id, clean)));
    }
    return {
      removed: targets.length,
      deleted: clean.length,
      kept: keep.length,
    };
  });
}

/** Quita a un cliente (mismas reglas que el borrado masivo). */
export async function removeSalonClient(
  organizationId: string,
  contactId: string,
): Promise<void> {
  const { removed } = await removeSalonClients(organizationId, [contactId]);
  if (removed === 0)
    throw new SalonError("client_not_found", 404, "El cliente no existe");
}

/**
 * «Crear cliente rápido» desde Citas: un contacto con solo nombre y celular, para
 * poder agendarle sin salir de la agenda. Si el celular ya es un contacto, se
 * devuelve ese (la misma persona nunca queda en dos fichas). No es cliente del
 * salón todavía: lo será con su primera venta en Caja.
 */
export async function quickCreateContact(
  organizationId: string,
  input: { name: string; phone: string },
): Promise<{ id: string; name: string; phone: string; existing: boolean }> {
  const phone = normalizeMx(input.phone);
  const db = getDb();
  const find = async () => {
    const [found] = await db
      .select({ id: schema.contact.id, name: schema.contact.name })
      .from(schema.contact)
      .where(
        scoped(
          schema.contact.organizationId,
          organizationId,
          eq(schema.contact.channel, "whatsapp"),
          or(eq(schema.contact.waIdentity, phone), eq(schema.contact.phone, phone)),
        ),
      )
      .limit(1);
    return found;
  };
  const existing = await find();
  if (existing) return { ...existing, phone, existing: true };

  const [created] = await db
    .insert(schema.contact)
    .values({
      id: newId("contact"),
      organizationId,
      name: input.name,
      nameSource: "manual",
      phone,
      waIdentity: phone,
      source: "conocido",
    })
    .onConflictDoNothing({
      target: [schema.contact.organizationId, schema.contact.channel, schema.contact.waIdentity],
    })
    .returning({ id: schema.contact.id, name: schema.contact.name });
  if (created) return { ...created, phone, existing: false };

  // Otro registro del mismo celular ganó la carrera: se reutiliza ese contacto.
  const winner = await find();
  if (!winner) {
    throw new SalonError("contact_not_found", 409, "No se pudo registrar al cliente. Intenta de nuevo.");
  }
  return { ...winner, phone, existing: true };
}
