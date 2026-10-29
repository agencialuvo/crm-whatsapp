import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { getDb, schema } from "@/lib/db";
import type { LoyaltyMilestone } from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { MIN_ADJUST_NOTE, milestoneProgress, sortMilestones, type LoyaltySettingsInput } from "@/lib/loyalty";
import { normalizeMx } from "@/lib/meta/client";
import { SalonError } from "@/server/business/http";

/**
 * Módulo de Fidelización Virtual — tarjeta de sellos por cliente.
 *
 * Toda consulta pasa por `scoped()`. Las mutaciones de sellos son atómicas: una
 * sola transacción actualiza la tarjeta y deja la fila del historial, y cada
 * UPDATE lleva su condición en el WHERE (no lee-y-escribe), así que dos cajas
 * sellando a la vez no pierden un sello ni canjean dos veces el mismo premio.
 *
 * Las funciones aceptan la conexión o la transacción en curso (`DbExecutor`): así
 * el sello de una venta va en la MISMA transacción que el cobro.
 */

/** La conexión o la transacción en curso. */
export type DbExecutor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

const settingsT = schema.loyaltySettings;
const cardT = schema.customerLoyaltyCard;
const txT = schema.loyaltyTransaction;

export type LoyaltySettings = typeof settingsT.$inferSelect;
export type CustomerLoyaltyCard = typeof cardT.$inferSelect;
export type LoyaltyTransaction = typeof txT.$inferSelect;
export type LoyaltyTransactionType = LoyaltyTransaction["type"];
export type { LoyaltyMilestone };

export interface RegisterLoyaltyTransactionParams {
  organizationId: string;
  contactId: string;
  type: LoyaltyTransactionType;
  staffId?: string | null;
  saleId?: string | null;
  notes?: string | null;
  /** Solo para `adjusted`: sellos a sumar (positivo) o quitar (negativo). Distinto de 0. */
  stampsChange?: number;
  /** Solo para `redeemed`: el hito a canjear. Sin él, el mejor premio alcanzado. */
  milestoneStamps?: number;
}

export interface RegisterLoyaltyTransactionResult {
  card: CustomerLoyaltyCard;
  transaction: LoyaltyTransaction;
  /** La tarjeta tiene al menos un premio canjeable. */
  rewardReady: boolean;
  /** Esta transacción cruzó algún hito (el momento de avisar al cliente). */
  rewardJustUnlocked: boolean;
  /** Los hitos que esta transacción acaba de desbloquear, de menor a mayor. */
  unlocked: LoyaltyMilestone[];
  /** El hito canjeado (solo en `redeemed`). */
  redeemed: LoyaltyMilestone | null;
  /** Sellos del premio final (cierra la tarjeta). */
  stampsRequired: number;
  /** Sellos que faltan para el siguiente hito (0 si ya alcanzó todos). */
  stampsRemaining: number;
}

/* ------------------------------- configuración ------------------------------ */

/** Configuración del programa; si la organización no tiene, crea la de por defecto. */
export async function getLoyaltySettings(
  organizationId: string,
  db: DbExecutor = getDb()
): Promise<LoyaltySettings> {
  const find = () =>
    db.select().from(settingsT).where(scoped(settingsT.organizationId, organizationId)).limit(1);

  const [existing] = await find();
  if (existing) return existing;

  // `onConflictDoNothing`: dos peticiones simultáneas no chocan con el índice único.
  await db
    .insert(settingsT)
    .values({ id: newId("loyaltySettings"), organizationId })
    .onConflictDoNothing({ target: settingsT.organizationId });

  const [created] = await find();
  if (!created) throw new SalonError("loyalty_settings_unavailable", 404, "No se pudo leer la configuración de fidelización");
  return created;
}

/**
 * Guarda la configuración del programa: los hitos (ordenados por sello; ya traen solo lo
 * suyo según su tipo), el icono de los sellos y el aspecto de la tarjeta. El icono y los
 * servicios referidos deben ser de esta organización.
 */
export async function updateLoyaltySettings(
  organizationId: string,
  input: LoyaltySettingsInput
): Promise<LoyaltySettings> {
  const db = getDb();
  await getLoyaltySettings(organizationId, db); // garantiza la fila

  const iconId = input.stampIconMediaId ?? null;
  if (iconId) {
    const m = schema.mediaLibraryItem;
    const [media] = await db
      .select({ id: m.id, kind: m.kind })
      .from(m)
      .where(scoped(m.organizationId, organizationId, eq(m.id, iconId)))
      .limit(1);
    if (!media) throw new SalonError("media_not_found", 404, "La imagen del sello no existe en tu biblioteca");
    if (media.kind !== "image") throw new SalonError("media_not_image", 422, "El icono del sello debe ser una imagen");
  }

  const serviceIds = [...new Set(input.milestones.flatMap((m) => (m.serviceIdRestriction ? [m.serviceIdRestriction] : [])))];
  if (serviceIds.length > 0) {
    const s = schema.service;
    const found = await db
      .select({ id: s.id })
      .from(s)
      .where(scoped(s.organizationId, organizationId, inArray(s.id, serviceIds)));
    if (found.length !== serviceIds.length) {
      throw new SalonError("service_not_found", 404, "Un servicio elegido para un premio ya no existe");
    }
  }

  const [row] = await db
    .update(settingsT)
    .set({
      milestones: sortMilestones(input.milestones),
      stampIconMediaId: iconId,
      cardTitle: input.cardTitle,
      brandColor: input.brandColor.toLowerCase(),
      updatedAt: new Date(),
    })
    .where(scoped(settingsT.organizationId, organizationId))
    .returning();
  if (!row) throw new SalonError("loyalty_settings_unavailable", 404, "No se pudo guardar la configuración de fidelización");
  return row;
}

/* --------------------------------- tarjetas --------------------------------- */

async function assertContactInOrg(db: DbExecutor, organizationId: string, contactId: string): Promise<void> {
  const [row] = await db
    .select({ id: schema.contact.id })
    .from(schema.contact)
    .where(scoped(schema.contact.organizationId, organizationId, eq(schema.contact.id, contactId)))
    .limit(1);
  if (!row) throw new SalonError("contact_not_found", 404, "Cliente no encontrado");
}

/** Tarjeta del cliente; si todavía no tiene, la crea en 0 sellos con su identificador de pase. */
export async function getOrCreateCustomerCard(
  organizationId: string,
  contactId: string,
  db: DbExecutor = getDb()
): Promise<CustomerLoyaltyCard> {
  const find = () =>
    db
      .select()
      .from(cardT)
      .where(scoped(cardT.organizationId, organizationId, eq(cardT.contactId, contactId)))
      .limit(1);

  const [existing] = await find();
  if (existing) return existing;

  await assertContactInOrg(db, organizationId, contactId);

  await db
    .insert(cardT)
    .values({
      id: newId("customerLoyaltyCard"),
      organizationId,
      contactId,
      currentStamps: 0,
      // Opaco y no adivinable: es el que viaja en el pase de Apple / Google Wallet.
      walletPassIdentifier: `vcr_${nanoid(24)}`,
    })
    .onConflictDoNothing({ target: [cardT.organizationId, cardT.contactId] });

  const [created] = await find();
  if (!created) throw new SalonError("loyalty_card_unavailable", 404, "No se pudo crear la tarjeta de fidelización");
  return created;
}

/* ------------------------------- transacciones ------------------------------ */

async function assertRefs(
  db: DbExecutor,
  organizationId: string,
  { staffId, saleId }: Pick<RegisterLoyaltyTransactionParams, "staffId" | "saleId">
): Promise<void> {
  if (staffId) {
    const [row] = await db
      .select({ id: schema.staff.id })
      .from(schema.staff)
      .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.id, staffId)))
      .limit(1);
    if (!row) throw new SalonError("staff_not_found", 404, "Miembro del equipo no encontrado");
  }
  if (saleId) {
    const [row] = await db
      .select({ id: schema.serviceSale.id })
      .from(schema.serviceSale)
      .where(scoped(schema.serviceSale.organizationId, organizationId, eq(schema.serviceSale.id, saleId)))
      .limit(1);
    if (!row) throw new SalonError("sale_not_found", 404, "Venta no encontrada");
  }
}

/**
 * Registra un movimiento de sellos y deja la tarjeta consistente, todo en una transacción.
 *
 * - `earned`: +1 sello. Si llega a `stampsRequired`, el resultado trae `rewardReady`.
 * - `redeemed`: resta `stampsRequired` sellos; falla (409) si la tarjeta no los tiene.
 * - `birthday_excluded`: solo deja constancia (0 sellos): el descuento de cumpleaños no acumula.
 * - `adjusted`: corrección manual con `stampsChange`; nunca deja la tarjeta bajo 0.
 */
export async function registerLoyaltyTransaction(
  params: RegisterLoyaltyTransactionParams,
  executor: DbExecutor = getDb()
): Promise<RegisterLoyaltyTransactionResult> {
  const { organizationId, contactId, type } = params;
  const staffId = params.staffId ?? null;
  const saleId = params.saleId ?? null;
  const notes = params.notes?.trim() ?? "";

  if (type === "adjusted") {
    const n = params.stampsChange;
    if (n === undefined || !Number.isInteger(n) || n === 0) {
      throw new SalonError("invalid_adjustment", 422, "El ajuste necesita un número entero de sellos distinto de 0");
    }
    if (notes.length < MIN_ADJUST_NOTE) {
      throw new SalonError("notes_required", 422, "El ajuste necesita un motivo (nota de auditoría)");
    }
  }

  const settings = await getLoyaltySettings(organizationId, executor);
  const card = await getOrCreateCustomerCard(organizationId, contactId, executor);
  await assertRefs(executor, organizationId, { staffId, saleId });

  const milestones = sortMilestones(settings.milestones);
  const finalStamps = milestones[milestones.length - 1]?.stamps ?? 0;

  // Canje: cada premio cuesta los sellos de su hito. Sin hito indicado, el mejor alcanzado.
  let redeemedMilestone: LoyaltyMilestone | null = null;
  if (type === "redeemed") {
    if (params.milestoneStamps !== undefined) {
      redeemedMilestone = milestones.find((m) => m.stamps === params.milestoneStamps) ?? null;
      if (!redeemedMilestone) {
        throw new SalonError("milestone_not_found", 422, "Ese premio ya no está en el programa");
      }
    } else {
      redeemedMilestone = milestoneProgress(milestones, card.currentStamps).best;
      if (!redeemedMilestone) {
        throw new SalonError("not_enough_stamps", 409, "La tarjeta todavía no alcanza ningún premio");
      }
    }
  }
  const cost = redeemedMilestone?.stamps ?? 0;
  const delta =
    type === "earned" ? 1 : type === "redeemed" ? -cost : type === "adjusted" ? params.stampsChange! : 0;

  // Dentro de una transacción ajena, `transaction()` abre un savepoint: si esto falla se
  // deshace solo lo del sello y quien llama decide si lo demás sigue.
  return executor.transaction(async (tx) => {
    const now = new Date();
    const mine = scoped(cardT.organizationId, organizationId, eq(cardT.id, card.id));
    let updated: CustomerLoyaltyCard | undefined;

    if (type === "earned") {
      [updated] = await tx
        .update(cardT)
        .set({
          currentStamps: sql`${cardT.currentStamps} + 1`,
          totalStampsEarned: sql`${cardT.totalStampsEarned} + 1`,
          lastStampedAt: now,
          updatedAt: now,
        })
        .where(mine)
        .returning();
    } else if (type === "redeemed") {
      // La condición va en el WHERE: si otra caja canjeó antes, no actualiza nada.
      [updated] = await tx
        .update(cardT)
        .set({
          currentStamps: sql`${cardT.currentStamps} - ${cost}`,
          totalRewardsRedeemed: sql`${cardT.totalRewardsRedeemed} + 1`,
          updatedAt: now,
        })
        .where(and(mine, gte(cardT.currentStamps, cost)))
        .returning();
      if (!updated) {
        throw new SalonError(
          "not_enough_stamps",
          409,
          `La tarjeta necesita ${cost} sellos para canjear «${redeemedMilestone?.title ?? "el premio"}»`
        );
      }
    } else if (type === "adjusted") {
      // `totalStampsEarned` es histórico de ganados: un ajuste hacia abajo no lo resta.
      [updated] = await tx
        .update(cardT)
        .set({
          currentStamps: sql`${cardT.currentStamps} + ${delta}`,
          totalStampsEarned: delta > 0 ? sql`${cardT.totalStampsEarned} + ${delta}` : cardT.totalStampsEarned,
          updatedAt: now,
        })
        .where(delta < 0 ? and(mine, gte(cardT.currentStamps, -delta)) : mine)
        .returning();
      if (!updated) {
        throw new SalonError("not_enough_stamps", 409, "El ajuste dejaría la tarjeta con sellos negativos");
      }
    } else {
      // birthday_excluded: no altera sellos; se relee la tarjeta para devolver su estado actual.
      [updated] = await tx.select().from(cardT).where(mine).limit(1);
    }

    if (!updated) throw new SalonError("loyalty_card_unavailable", 404, "Tarjeta de fidelización no encontrada");

    const [transaction] = await tx
      .insert(txT)
      .values({
        id: newId("loyaltyTransaction"),
        organizationId,
        cardId: card.id,
        saleId,
        type,
        stampsChange: delta,
        notes: notes || (redeemedMilestone ? `Canje: ${redeemedMilestone.title}` : null),
        staffId,
      })
      .returning();
    if (!transaction) throw new SalonError("loyalty_tx_failed", 409, "No se pudo registrar el movimiento");

    const progress = milestoneProgress(milestones, updated.currentStamps);
    // Desbloqueado = hito cruzado hacia arriba por esta transacción (un canje solo resta).
    const before = updated.currentStamps - delta;
    const unlocked = delta > 0 ? milestones.filter((m) => m.stamps > before && m.stamps <= updated.currentStamps) : [];
    return {
      card: updated,
      transaction,
      rewardReady: progress.best !== null,
      rewardJustUnlocked: unlocked.length > 0,
      unlocked,
      redeemed: redeemedMilestone,
      stampsRequired: finalStamps,
      stampsRemaining: progress.stampsRemaining,
    };
  });
}

/* --------------------------------- consultas -------------------------------- */

export interface LoyaltyCardView {
  settings: LoyaltySettings;
  /** `null` si el cliente todavía no tiene tarjeta (no se crea al consultar). */
  card: CustomerLoyaltyCard | null;
  contact: { id: string; name: string; phone: string | null };
  /** Hay al menos un premio canjeable hoy. */
  rewardReady: boolean;
  /** Sellos que faltan para el siguiente hito (0 si ya alcanzó todos). */
  stampsRemaining: number;
  /** Premios alcanzados y canjeables hoy. */
  availableMilestones: LoyaltyMilestone[];
  nextMilestone: LoyaltyMilestone | null;
  /** Ruta pública del icono de los sellos (`null` = el palomito por defecto). */
  stampIconUrl: string | null;
  recent: LoyaltyTransaction[];
}

/** Cliente por `contactId` o por celular (mismo criterio que Caja: `waIdentity` o `phone`). */
export async function findLoyaltyContact(
  organizationId: string,
  by: { contactId?: string; phone?: string }
): Promise<{ id: string; name: string; phone: string | null }> {
  const db = getDb();
  const c = schema.contact;
  const phone = by.phone ? normalizeMx(by.phone) : null;
  const cond = by.contactId
    ? eq(c.id, by.contactId)
    : phone
      ? and(eq(c.channel, "whatsapp"), or(eq(c.waIdentity, phone), eq(c.phone, phone)))
      : undefined;
  if (!cond) throw new SalonError("contact_required", 422, "Indica el cliente (contactId o celular)");
  const [row] = await db
    .select({ id: c.id, name: c.name, phone: c.phone })
    .from(c)
    .where(scoped(c.organizationId, organizationId, cond))
    .limit(1);
  if (!row) throw new SalonError("contact_not_found", 404, "Cliente no encontrado");
  return row;
}

/** La tarjeta de un cliente con su avance y últimos movimientos. Solo lee: no crea la tarjeta. */
export async function getLoyaltyCardView(
  organizationId: string,
  by: { contactId?: string; phone?: string }
): Promise<LoyaltyCardView> {
  const db = getDb();
  const contact = await findLoyaltyContact(organizationId, by);
  const settings = await getLoyaltySettings(organizationId);
  const [card] = await db
    .select()
    .from(cardT)
    .where(scoped(cardT.organizationId, organizationId, eq(cardT.contactId, contact.id)))
    .limit(1);
  const recent = card
    ? await db
        .select()
        .from(txT)
        .where(scoped(txT.organizationId, organizationId, eq(txT.cardId, card.id)))
        .orderBy(desc(txT.createdAt))
        .limit(20)
    : [];
  const progress = milestoneProgress(sortMilestones(settings.milestones), card?.currentStamps ?? 0);
  return {
    settings,
    card: card ?? null,
    contact,
    rewardReady: progress.best !== null,
    stampsRemaining: progress.stampsRemaining,
    availableMilestones: progress.reached,
    nextMilestone: progress.next,
    stampIconUrl: settings.stampIconMediaId ? `/api/medios/${settings.stampIconMediaId}/archivo` : null,
    recent,
  };
}

/* ------------------------------ caja (venta) -------------------------------- */

/**
 * Sello de una venta de Caja, dentro de la transacción de la venta.
 *
 * - Con descuento de cumpleaños: `birthday_excluded` (no suma sellos).
 * - Si no: `earned` (+1).
 *
 * La fidelización NUNCA bloquea un cobro: si falla (el savepoint deshace solo el sello),
 * la venta sigue y se devuelve `null`.
 */
export async function stampSale(
  tx: DbExecutor,
  p: {
    organizationId: string;
    contactId: string;
    saleId: string;
    staffId: string;
    birthdayDiscount: boolean;
  }
): Promise<RegisterLoyaltyTransactionResult | null> {
  try {
    return await registerLoyaltyTransaction(
      {
        organizationId: p.organizationId,
        contactId: p.contactId,
        staffId: p.staffId,
        saleId: p.saleId,
        type: p.birthdayDiscount ? "birthday_excluded" : "earned",
        notes: p.birthdayDiscount
          ? "Descuento de cumpleaños: no acumula sellos"
          : "Sello por venta en caja",
      },
      tx
    );
  } catch (err) {
    console.error("[loyalty] no se pudo sellar la venta", p.saleId, err);
    return null;
  }
}

/**
 * Anular una venta deshace su sello (como todo efecto derivado): se resta el sello que
 * ganó, sin bajar de 0, y queda un `adjusted` en el historial. Va dentro de la
 * transacción de la anulación.
 */
export async function reverseSaleStamp(
  tx: DbExecutor,
  organizationId: string,
  saleId: string
): Promise<void> {
  const [earned] = await tx
    .select({ cardId: txT.cardId })
    .from(txT)
    .where(scoped(txT.organizationId, organizationId, eq(txT.saleId, saleId), eq(txT.type, "earned")))
    .limit(1);
  if (!earned) return;
  await tx
    .update(cardT)
    .set({
      currentStamps: sql`GREATEST(${cardT.currentStamps} - 1, 0)`,
      totalStampsEarned: sql`GREATEST(${cardT.totalStampsEarned} - 1, 0)`,
      updatedAt: new Date(),
    })
    .where(scoped(cardT.organizationId, organizationId, eq(cardT.id, earned.cardId)));
  await tx.insert(txT).values({
    id: newId("loyaltyTransaction"),
    organizationId,
    cardId: earned.cardId,
    saleId: null, // la venta se borra; el historial conserva la nota
    type: "adjusted",
    stampsChange: -1,
    notes: "Venta anulada: se retira su sello",
  });
}
