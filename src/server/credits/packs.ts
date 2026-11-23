import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { PACK_LIMITS } from "@/lib/credits";

/**
 * Monedas — el CATÁLOGO de paquetes de recarga (`credit_pack`). Son datos de la plataforma, como los planes: no
 * pertenecen a una organización y solo el Super Admin los escribe. A propósito NO dependen de la bandera `CREDITS`:
 * se puede dejar listo el catálogo antes de encender las monedas (el listado para clientes sí sale vacío mientras
 * estén apagadas, ver `server/saas/credits-summary.ts`).
 *
 * Un paquete nunca se borra: se desactiva. Una compra (`credit_topup`) copia las unidades y el precio del paquete al
 * crearse, así que editar o desactivar un paquete jamás altera una compra ya hecha.
 */

export type PackRow = typeof schema.creditPack.$inferSelect;

export type PackInput = {
  name: string;
  /** Unidades que abona (1 moneda = 100). */
  units: number;
  priceCents: number;
  currency?: "PEN" | "USD";
  sortOrder?: number;
  active?: boolean;
};

/** Quién cambia el catálogo: queda en la auditoría del panel, dentro de la MISMA transacción que el cambio. */
export type PackActor = { userId: string; email?: string | null; ip?: string | null };

export type PackResult =
  | { status: "created" | "updated"; pack: PackRow; before: PackRow | null }
  | { status: "not_found" }
  | { status: "name_taken" }
  | { status: "limit_reached" }
  | { status: "nothing"; pack: PackRow };

const cleanName = (name: string) => name.replace(/\s+/g, " ").trim();

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

const snapshot = (p: PackRow) => ({ name: p.name, units: p.units, priceCents: p.priceCents, currency: p.currency, sortOrder: p.sortOrder, active: p.active });

/**
 * El rastro del cambio. Va en la misma transacción: no puede existir un cambio de catálogo sin su registro, ni un
 * registro de un cambio que no ocurrió. (Excepción deliberada a «solo la suscripción escribe la auditoría»: esta es la
 * única puerta del catálogo, y la prueba de vigilancia la nombra.)
 */
async function writeAudit(tx: Tx, actor: PackActor, action: string, before: PackRow | null, after: PackRow): Promise<void> {
  await tx.insert(schema.superAdminAudit).values({
    id: newId("superAdminAudit"),
    actorUserId: actor.userId,
    actorEmail: actor.email ?? null,
    action,
    before: before ? { packId: before.id, ...snapshot(before) } : null,
    after: { packId: after.id, ...snapshot(after) },
    ip: actor.ip ?? null,
  });
}

/** Defensa en profundidad: la API ya valida con zod, pero la puerta no confía en quien la llame. */
function assertPack(p: Partial<PackInput>): void {
  if (p.name !== undefined) {
    const n = cleanName(p.name);
    if (n.length < PACK_LIMITS.nameMin || n.length > PACK_LIMITS.nameMax) throw new Error(`name debe tener entre ${PACK_LIMITS.nameMin} y ${PACK_LIMITS.nameMax} caracteres`);
  }
  if (p.units !== undefined && (!Number.isInteger(p.units) || p.units < 1 || p.units > PACK_LIMITS.maxUnits)) throw new Error("units inválido");
  if (p.priceCents !== undefined && (!Number.isInteger(p.priceCents) || p.priceCents < 1 || p.priceCents > PACK_LIMITS.maxPriceCents)) throw new Error("priceCents inválido");
  if (p.sortOrder !== undefined && (!Number.isInteger(p.sortOrder) || p.sortOrder < 0 || p.sortOrder > PACK_LIMITS.maxSort)) throw new Error("sortOrder inválido");
  if (p.currency !== undefined && !PACK_LIMITS.currencies.includes(p.currency)) throw new Error("currency inválida");
}

/** El catálogo en el orden en que se muestra: por `sort_order`, luego el más barato primero. */
export async function listPacks(opts: { activeOnly?: boolean } = {}): Promise<PackRow[]> {
  const rows = await getDb()
    .select()
    .from(schema.creditPack)
    .where(opts.activeOnly ? eq(schema.creditPack.active, true) : undefined)
    .orderBy(asc(schema.creditPack.sortOrder), asc(schema.creditPack.priceCents), asc(schema.creditPack.id));
  return rows;
}

export async function getPack(id: string): Promise<PackRow | null> {
  const [row] = await getDb().select().from(schema.creditPack).where(eq(schema.creditPack.id, id)).limit(1);
  return row ?? null;
}

/** Serializa las altas y cambios de nombre: sin un índice único, esto es lo que evita dos paquetes con el mismo nombre. */
const lockCatalog = (tx: Pick<ReturnType<typeof getDb>, "execute">) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('credit_pack_catalog'))`);

const sameName = (a: string, b: string) => cleanName(a).toLowerCase() === cleanName(b).toLowerCase();

export async function createPack(input: PackInput, actor: PackActor): Promise<PackResult> {
  assertPack(input);
  return getDb().transaction(async (tx): Promise<PackResult> => {
    await lockCatalog(tx);
    const all = await tx.select().from(schema.creditPack);
    if (all.length >= PACK_LIMITS.maxPacks) return { status: "limit_reached" };
    if (all.some((p) => sameName(p.name, input.name))) return { status: "name_taken" };
    const [pack] = await tx
      .insert(schema.creditPack)
      .values({
        id: newId("creditPack"),
        name: cleanName(input.name),
        units: input.units,
        priceCents: input.priceCents,
        currency: input.currency ?? "PEN",
        sortOrder: input.sortOrder ?? 0,
        active: input.active ?? true,
      })
      .returning();
    await writeAudit(tx, actor, "credit_pack.create", null, pack!);
    return { status: "created", pack: pack!, before: null };
  });
}

/** Cambia lo que venga en `patch` (nombre, monedas, precio, moneda, orden, activo). Sin cambios reales → `nothing`. */
export async function updatePack(id: string, patch: Partial<PackInput>, actor: PackActor): Promise<PackResult> {
  assertPack(patch);
  return getDb().transaction(async (tx): Promise<PackResult> => {
    await lockCatalog(tx);
    const all = await tx.select().from(schema.creditPack);
    const before = all.find((p) => p.id === id);
    if (!before) return { status: "not_found" };
    if (patch.name !== undefined && all.some((p) => p.id !== id && sameName(p.name, patch.name!))) return { status: "name_taken" };

    const next = {
      name: patch.name !== undefined ? cleanName(patch.name) : before.name,
      units: patch.units ?? before.units,
      priceCents: patch.priceCents ?? before.priceCents,
      currency: patch.currency ?? before.currency,
      sortOrder: patch.sortOrder ?? before.sortOrder,
      active: patch.active ?? before.active,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).some((k) => next[k] !== before[k]);
    if (!changed) return { status: "nothing", pack: before };
    const [pack] = await tx.update(schema.creditPack).set(next).where(eq(schema.creditPack.id, id)).returning();
    const action = before.active !== pack!.active ? (pack!.active ? "credit_pack.activate" : "credit_pack.deactivate") : "credit_pack.update";
    await writeAudit(tx, actor, action, before, pack!);
    return { status: "updated", pack: pack!, before };
  });
}
