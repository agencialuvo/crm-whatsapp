import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { DEFAULT_COMMISSION_PERCENTAGE } from "@/lib/salon/commission";
import type { ComboInput, ServiceInput } from "@/lib/salon/schemas";
import type { ComboDto, ServiceDto } from "@/lib/salon/types";
import { comboStaffMap, serviceStaffMap } from "@/server/business/catalog-staff";
import { assertImageOwned } from "@/server/business/refs";
import {
  FOREIGN_KEY_VIOLATION,
  isPgError,
  SalonError,
  UNIQUE_VIOLATION,
} from "@/server/business/http";

/**
 * Módulo SALON — catálogo: servicios regulares y ofertas de publicidad.
 *
 * Cada servicio u oferta puede llevar una imagen de la biblioteca de Medios y
 * una lista de los profesionales que lo dan (sin lista = todo el equipo).
 *
 * Borrar es posible mientras nada lo haya vendido; si ya tiene ventas, la base
 * lo impide (las ventas son historia financiera) y la respuesta lo dice con un
 * 409 `in_use` para que la UI ofrezca DESACTIVAR, que es lo que corresponde.
 */

type ServiceRow = typeof schema.service.$inferSelect;
type ComboRow = typeof schema.combo.$inferSelect;
type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** La URL pública del archivo de un medio de la biblioteca. */
function imageUrlOf(mediaId: string | null): string | null {
  return mediaId ? `/api/medios/${mediaId}/archivo` : null;
}

function toServiceDto(r: ServiceRow, staffIds: string[]): ServiceDto {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    priceCents: r.priceCents,
    durationMinutes: r.durationMinutes,
    defaultCommissionPercentage:
      r.defaultCommissionPercentage ?? DEFAULT_COMMISSION_PERCENTAGE,
    active: r.active,
    imageMediaId: r.imageMediaId,
    imageUrl: imageUrlOf(r.imageMediaId),
    staffIds,
  };
}

function toComboDto(r: ComboRow, staffIds: string[]): ComboDto {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    priceCents: r.priceCents,
    durationMinutes: r.durationMinutes,
    keywordTrigger: r.keywordTrigger,
    active: r.active,
    imageMediaId: r.imageMediaId,
    imageUrl: imageUrlOf(r.imageMediaId),
    staffIds,
  };
}

const IN_USE = (what: string) =>
  new SalonError(
    "in_use",
    409,
    `${what} ya tiene ventas registradas y no se puede eliminar. Desactívalo para que deje de ofrecerse.`
  );

/* --------------------- imagen y profesionales (comunes) --------------------- */

/**
 * Imagen y profesionales que llegan del formulario, comprobados contra la
 * organización: un id ajeno o borrado se rechaza con un mensaje claro en vez de
 * guardar una referencia rota (o, peor, la de otro negocio).
 */
async function assertRefs(
  tx: Tx,
  organizationId: string,
  refs: { imageMediaId?: string | null; staffIds?: string[] }
): Promise<void> {
  await assertImageOwned(tx, organizationId, refs.imageMediaId);
  if (refs.staffIds && refs.staffIds.length > 0) {
    const found = await tx
      .select({ id: schema.staff.id })
      .from(schema.staff)
      .where(
        scoped(schema.staff.organizationId, organizationId, inArray(schema.staff.id, refs.staffIds))
      );
    if (found.length !== refs.staffIds.length) {
      throw new SalonError(
        "staff_not_found",
        422,
        "Alguno de los profesionales elegidos ya no existe. Revisa la lista."
      );
    }
  }
}

/** Reemplaza los profesionales de un servicio. `[]` = todo el equipo (sin filas). */
async function setServiceStaff(
  tx: Tx,
  organizationId: string,
  serviceId: string,
  ids: string[]
): Promise<void> {
  await tx.delete(schema.serviceStaff).where(eq(schema.serviceStaff.serviceId, serviceId));
  if (ids.length > 0) {
    await tx
      .insert(schema.serviceStaff)
      .values(ids.map((staffId) => ({ organizationId, serviceId, staffId })));
  }
}

/** Reemplaza los profesionales de una oferta. `[]` = todo el equipo (sin filas). */
async function setComboStaff(
  tx: Tx,
  organizationId: string,
  comboId: string,
  ids: string[]
): Promise<void> {
  await tx.delete(schema.comboStaff).where(eq(schema.comboStaff.comboId, comboId));
  if (ids.length > 0) {
    await tx
      .insert(schema.comboStaff)
      .values(ids.map((staffId) => ({ organizationId, comboId, staffId })));
  }
}

async function serviceStaffIds(tx: Tx, organizationId: string, id: string): Promise<string[]> {
  const rows = await tx
    .select({ staffId: schema.serviceStaff.staffId })
    .from(schema.serviceStaff)
    .where(
      and(
        eq(schema.serviceStaff.organizationId, organizationId),
        eq(schema.serviceStaff.serviceId, id)
      )
    );
  return rows.map((r) => r.staffId);
}

async function comboStaffIds(tx: Tx, organizationId: string, id: string): Promise<string[]> {
  const rows = await tx
    .select({ staffId: schema.comboStaff.staffId })
    .from(schema.comboStaff)
    .where(
      and(eq(schema.comboStaff.organizationId, organizationId), eq(schema.comboStaff.comboId, id))
    );
  return rows.map((r) => r.staffId);
}

/* ------------------------------ servicios ------------------------------ */

export async function listServices(organizationId: string): Promise<ServiceDto[]> {
  const rows = await getDb()
    .select()
    .from(schema.service)
    .where(scoped(schema.service.organizationId, organizationId, eq(schema.service.isOther, false)))
    .orderBy(asc(schema.service.name));
  const staffBy = await serviceStaffMap(organizationId);
  return rows.map((r) => toServiceDto(r, staffBy.get(r.id) ?? []));
}

export async function createService(
  organizationId: string,
  input: ServiceInput
): Promise<ServiceDto> {
  return getDb().transaction(async (tx) => {
    await assertRefs(tx, organizationId, input);
    const [row] = await tx
      .insert(schema.service)
      .values({
        id: newId("service"),
        organizationId,
        name: input.name,
        description: input.description ?? null,
        priceCents: input.priceCents,
        durationMinutes: input.durationMinutes,
        defaultCommissionPercentage:
          input.defaultCommissionPercentage ?? DEFAULT_COMMISSION_PERCENTAGE,
        active: input.active ?? true,
        imageMediaId: input.imageMediaId ?? null,
      })
      .returning();
    const staffIds = input.staffIds ?? [];
    await setServiceStaff(tx, organizationId, row!.id, staffIds);
    return toServiceDto(row!, staffIds);
  });
}

export async function updateService(
  organizationId: string,
  id: string,
  patch: Partial<ServiceInput>
): Promise<ServiceDto> {
  return getDb().transaction(async (tx) => {
    await assertRefs(tx, organizationId, patch);
    const [row] = await tx
      .update(schema.service)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.priceCents !== undefined && { priceCents: patch.priceCents }),
        ...(patch.durationMinutes !== undefined && {
          durationMinutes: patch.durationMinutes,
        }),
        ...(patch.defaultCommissionPercentage !== undefined && {
          defaultCommissionPercentage: patch.defaultCommissionPercentage,
        }),
        ...(patch.active !== undefined && { active: patch.active }),
        ...(patch.imageMediaId !== undefined && { imageMediaId: patch.imageMediaId }),
        updatedAt: new Date(),
      })
      .where(scoped(schema.service.organizationId, organizationId, eq(schema.service.id, id)))
      .returning();
    if (!row) throw new SalonError("not_found", 404, "El servicio no existe");
    if (patch.staffIds !== undefined) await setServiceStaff(tx, organizationId, id, patch.staffIds);
    return toServiceDto(row, await serviceStaffIds(tx, organizationId, id));
  });
}

export async function deleteService(organizationId: string, id: string): Promise<void> {
  try {
    const rows = await getDb()
      .delete(schema.service)
      .where(scoped(schema.service.organizationId, organizationId, eq(schema.service.id, id)))
      .returning({ id: schema.service.id });
    if (rows.length === 0) throw new SalonError("not_found", 404, "El servicio no existe");
  } catch (err) {
    if (isPgError(err, FOREIGN_KEY_VIOLATION)) throw IN_USE("Este servicio");
    throw err;
  }
}

/* ------------------------------- combos -------------------------------- */

const KEYWORD_TAKEN = new SalonError(
  "keyword_taken",
  409,
  "Esa palabra clave ya la usa otra oferta. Elige una distinta."
);

export async function listCombos(organizationId: string): Promise<ComboDto[]> {
  const rows = await getDb()
    .select()
    .from(schema.combo)
    .where(scoped(schema.combo.organizationId, organizationId))
    .orderBy(asc(schema.combo.name));
  const staffBy = await comboStaffMap(organizationId);
  return rows.map((r) => toComboDto(r, staffBy.get(r.id) ?? []));
}

export async function createCombo(
  organizationId: string,
  input: ComboInput
): Promise<ComboDto> {
  try {
    return await getDb().transaction(async (tx) => {
      await assertRefs(tx, organizationId, input);
      const [row] = await tx
        .insert(schema.combo)
        .values({
          id: newId("combo"),
          organizationId,
          name: input.name,
          description: input.description,
          priceCents: input.priceCents,
          durationMinutes: input.durationMinutes,
          keywordTrigger: input.keywordTrigger ?? null,
          active: input.active ?? true,
          imageMediaId: input.imageMediaId ?? null,
        })
        .returning();
      const staffIds = input.staffIds ?? [];
      await setComboStaff(tx, organizationId, row!.id, staffIds);
      return toComboDto(row!, staffIds);
    });
  } catch (err) {
    if (isPgError(err, UNIQUE_VIOLATION)) throw KEYWORD_TAKEN;
    throw err;
  }
}

export async function updateCombo(
  organizationId: string,
  id: string,
  patch: Partial<ComboInput>
): Promise<ComboDto> {
  try {
    return await getDb().transaction(async (tx) => {
      await assertRefs(tx, organizationId, patch);
      const set = {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.priceCents !== undefined && { priceCents: patch.priceCents }),
        ...(patch.durationMinutes !== undefined && {
          durationMinutes: patch.durationMinutes,
        }),
        ...(patch.keywordTrigger !== undefined && {
          keywordTrigger: patch.keywordTrigger,
        }),
        ...(patch.active !== undefined && { active: patch.active }),
        ...(patch.imageMediaId !== undefined && { imageMediaId: patch.imageMediaId }),
      };
      const where = scoped(schema.combo.organizationId, organizationId, eq(schema.combo.id, id));
      // Un PATCH que solo cambia profesionales no tiene nada que poner en la fila
      // (la oferta no lleva `updated_at`): Drizzle no admite un UPDATE vacío.
      const [row] =
        Object.keys(set).length > 0
          ? await tx.update(schema.combo).set(set).where(where).returning()
          : await tx.select().from(schema.combo).where(where).limit(1);
      if (!row) throw new SalonError("not_found", 404, "La oferta no existe");
      if (patch.staffIds !== undefined) await setComboStaff(tx, organizationId, id, patch.staffIds);
      return toComboDto(row, await comboStaffIds(tx, organizationId, id));
    });
  } catch (err) {
    if (isPgError(err, UNIQUE_VIOLATION)) throw KEYWORD_TAKEN;
    throw err;
  }
}

export async function deleteCombo(organizationId: string, id: string): Promise<void> {
  try {
    const rows = await getDb()
      .delete(schema.combo)
      .where(scoped(schema.combo.organizationId, organizationId, eq(schema.combo.id, id)))
      .returning({ id: schema.combo.id });
    if (rows.length === 0) throw new SalonError("not_found", 404, "La oferta no existe");
  } catch (err) {
    if (isPgError(err, FOREIGN_KEY_VIOLATION)) throw IN_USE("Esta oferta");
    throw err;
  }
}

/** Los ids de servicios que existen en esta organización (para validar comisiones). */
export async function existingServiceIds(
  organizationId: string,
  ids: string[]
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await getDb()
    .select({ id: schema.service.id })
    .from(schema.service)
    .where(scoped(schema.service.organizationId, organizationId));
  const wanted = new Set(ids);
  return new Set(rows.map((r) => r.id).filter((id) => wanted.has(id)));
}
