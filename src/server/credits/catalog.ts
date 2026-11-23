import { and, desc, eq, lte } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { DEFAULT_RATES, RATE_UNIT_KINDS, type RateUnitKind } from "@/lib/credits";
import { creditsEnabled } from "./flag";
import { assertInt } from "./internal";

/**
 * Monedas — el CATÁLOGO de la plataforma: tarifas versionadas, y las compras de paquetes de recarga. Las tarifas no
 * son de una organización (como `plan`): cambiar un precio es agregar una fila con su `effective_from`.
 */

export type RateRow = typeof schema.creditRate.$inferSelect;

/** La tarifa vigente de una clave en un instante: la de `effective_from` más reciente que ya empezó. Solo lectura. */
export async function getRate(key: string, at: Date = new Date()): Promise<RateRow | null> {
  const [row] = await getDb()
    .select()
    .from(schema.creditRate)
    .where(and(eq(schema.creditRate.key, key), lte(schema.creditRate.effectiveFrom, at)))
    .orderBy(desc(schema.creditRate.effectiveFrom))
    .limit(1);
  return row ?? null;
}

/** Agrega una versión de una tarifa. Nunca edita una existente: el historial de precios queda. */
export async function setRate(input: {
  key: string;
  service: "ai" | "whatsapp";
  category?: string | null;
  unitKind: RateUnitKind;
  /** Unidades por `unitKind`. 0 = se mide pero no se cobra. */
  amount: number;
  effectiveFrom?: Date;
  actorUserId?: string | null;
  note?: string | null;
}): Promise<{ status: "applied"; rate: RateRow } | { status: "duplicate" } | { status: "disabled" }> {
  if (!creditsEnabled()) return { status: "disabled" };
  assertInt(input.amount, "amount");
  if (input.amount < 0) throw new Error("amount no puede ser negativo");
  if (!(RATE_UNIT_KINDS as readonly string[]).includes(input.unitKind)) throw new Error(`unitKind inválido: ${input.unitKind}`);

  const [row] = await getDb()
    .insert(schema.creditRate)
    .values({
      id: newId("creditRate"),
      key: input.key,
      service: input.service,
      category: input.category ?? null,
      unitKind: input.unitKind,
      amount: input.amount,
      effectiveFrom: input.effectiveFrom ?? new Date(),
      createdByUserId: input.actorUserId || null,
      note: input.note ?? null,
    })
    .onConflictDoNothing({ target: [schema.creditRate.key, schema.creditRate.effectiveFrom] })
    .returning();
  return row ? { status: "applied", rate: row } : { status: "duplicate" };
}

export type TopupRow = typeof schema.creditTopup.$inferSelect;

/** Una compra de recarga vive esto antes de que se la dé por abandonada. */
export const TOPUP_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Crea el intento de compra de un paquete (`pending`). Copia las unidades y el precio del paquete: un cambio posterior
 * del catálogo no altera una compra ya hecha. Su id es el `external_reference` que viaja por la pasarela.
 */
export async function createTopupIntent(input: {
  organizationId: string;
  packId: string;
  userId?: string | null;
  now?: Date;
}): Promise<{ status: "created"; topup: TopupRow } | { status: "pack_not_found" } | { status: "disabled" }> {
  if (!creditsEnabled()) return { status: "disabled" };
  const db = getDb();
  const [pack] = await db
    .select()
    .from(schema.creditPack)
    .where(and(eq(schema.creditPack.id, input.packId), eq(schema.creditPack.active, true)))
    .limit(1);
  if (!pack) return { status: "pack_not_found" };
  const now = input.now ?? new Date();
  const [topup] = await db
    .insert(schema.creditTopup)
    .values({
      id: newId("creditTopup"),
      organizationId: input.organizationId,
      packId: pack.id,
      units: pack.units,
      amountCents: pack.priceCents,
      currency: pack.currency,
      status: "pending",
      createdByUserId: input.userId || null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + TOPUP_TTL_MS),
    })
    .returning();
  return { status: "created", topup: topup! };
}

/** Anota en la compra con qué orden y cargo de la pasarela se cobra. Solo completa datos; nunca toca el estado ni el saldo. */
export async function setTopupGateway(organizationId: string, topupId: string, gw: { gateway: string; orderId?: string; chargeId?: string }): Promise<void> {
  if (!creditsEnabled()) return;
  await getDb()
    .update(schema.creditTopup)
    .set({ gateway: gw.gateway, ...(gw.orderId ? { gatewayOrderId: gw.orderId } : {}), ...(gw.chargeId ? { gatewayChargeId: gw.chargeId } : {}) })
    .where(scoped(schema.creditTopup.organizationId, organizationId, eq(schema.creditTopup.id, topupId)));
}

/**
 * Cierra una compra que SIGUE pendiente (falló el cobro, venció la orden…) con su motivo. Una compra ya pagada o
 * reembolsada no se toca jamás: solo `pending` cambia aquí.
 */
export async function closePendingTopup(organizationId: string, topupId: string, status: "failed" | "abandoned", reason: string): Promise<void> {
  if (!creditsEnabled()) return;
  await getDb()
    .update(schema.creditTopup)
    .set({ status, failureReason: reason.slice(0, 200) })
    .where(scoped(schema.creditTopup.organizationId, organizationId, and(eq(schema.creditTopup.id, topupId), eq(schema.creditTopup.status, "pending"))));
}

/** Deja un aviso en una compra pendiente (p. ej. un pago que no coincide) sin cerrarla. */
export async function noteTopupIssue(organizationId: string, topupId: string, reason: string): Promise<void> {
  if (!creditsEnabled()) return;
  await getDb()
    .update(schema.creditTopup)
    .set({ failureReason: reason.slice(0, 200) })
    .where(scoped(schema.creditTopup.organizationId, organizationId, and(eq(schema.creditTopup.id, topupId), eq(schema.creditTopup.status, "pending"))));
}

/** Una compra de ESTA organización. Solo lectura. */
export async function getTopup(organizationId: string, topupId: string): Promise<TopupRow | null> {
  const [row] = await getDb()
    .select()
    .from(schema.creditTopup)
    .where(scoped(schema.creditTopup.organizationId, organizationId, eq(schema.creditTopup.id, topupId)))
    .limit(1);
  return row ?? null;
}

/**
 * Siembra las tarifas provisionales (`DEFAULT_RATES`) de las claves que NO tienen ninguna fila. Una clave con
 * cualquier versión —aunque sea futura— se deja como está: nunca pisa lo que alguien decidió. Idempotente.
 * Devuelve cuántas sembró; con `CREDITS` apagada, 0 sin tocar la base.
 */
export async function ensureDefaultRates(): Promise<number> {
  if (!creditsEnabled()) return 0;
  let seeded = 0;
  for (const r of DEFAULT_RATES) {
    const [any] = await getDb().select({ id: schema.creditRate.id }).from(schema.creditRate).where(eq(schema.creditRate.key, r.key)).limit(1);
    if (any) continue;
    const res = await setRate({
      key: r.key,
      service: r.service,
      category: r.category,
      unitKind: r.unitKind,
      amount: r.amount,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      note: r.note,
    });
    if (res.status === "applied") seeded++;
  }
  return seeded;
}
