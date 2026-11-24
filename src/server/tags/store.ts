import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { MAX_TAGS_PER_ORG, tagKey, type TagDto, type TagWithCount } from "@/lib/tags";
import { onTagAdded } from "@/server/automation/triggers";

/**
 * Etiquetas de contacto: alta, lista, edición, borrado y asignación. Todo pasa por `scoped()`.
 *
 * Las usa la ficha del contacto (a mano) y los pasos `add_tag`/`remove_tag` del motor de automatizaciones.
 * Asignar es idempotente (`ON CONFLICT DO NOTHING`): dos pestañas, o un paso reintentado, no duplican.
 */

export class TagError extends Error {
  constructor(
    readonly code: "not_found" | "duplicate" | "limit" | "contact_not_found",
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "TagError";
  }
}

const toDto = (r: { id: string; name: string; color: string }): TagDto => ({ id: r.id, name: r.name, color: r.color });

/** Las etiquetas de la organización, por nombre, con cuántos contactos tiene cada una. */
export async function listTags(organizationId: string): Promise<TagWithCount[]> {
  const t = schema.tag;
  const rows = await getDb()
    .select({
      id: t.id,
      name: t.name,
      color: t.color,
      // Calificado a mano: dentro de la subconsulta Drizzle pinta las columnas SIN tabla.
      contactCount: sql<number>`(select count(*)::int from "contact_tag" as "ct" where "ct"."tag_id" = "tag"."id")`,
    })
    .from(t)
    .where(scoped(t.organizationId, organizationId))
    .orderBy(asc(sql`lower(${t.name})`), asc(t.id));
  return rows;
}

/** Busca por nombre sin distinguir mayúsculas. */
async function findByName(organizationId: string, name: string) {
  const t = schema.tag;
  const [row] = await getDb()
    .select()
    .from(t)
    .where(scoped(t.organizationId, organizationId, sql`lower(${t.name}) = ${tagKey(name)}`))
    .limit(1);
  return row ?? null;
}

/** Crea la etiqueta; si ya existe una con ese nombre (sin distinguir mayúsculas) lanza `duplicate`. */
export async function createTag(organizationId: string, input: { name: string; color: string }): Promise<TagDto> {
  if (await findByName(organizationId, input.name)) {
    throw new TagError("duplicate", 409, "Ya existe una etiqueta con ese nombre");
  }
  const t = schema.tag;
  const [counted] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(scoped(t.organizationId, organizationId));
  if ((counted?.n ?? 0) >= MAX_TAGS_PER_ORG) {
    throw new TagError("limit", 409, `Se alcanzó el máximo de ${MAX_TAGS_PER_ORG} etiquetas`);
  }

  const [row] = await getDb()
    .insert(t)
    .values({ id: newId("tag"), organizationId, name: input.name.trim(), color: input.color })
    .onConflictDoNothing()
    .returning();
  // Perdió la carrera contra otra creación idéntica: es un duplicado.
  if (!row) throw new TagError("duplicate", 409, "Ya existe una etiqueta con ese nombre");
  return toDto(row);
}

/** La etiqueta con ese nombre, creándola si no existe (para «crear al vuelo»). */
export async function ensureTag(organizationId: string, input: { name: string; color: string }): Promise<TagDto> {
  const found = await findByName(organizationId, input.name);
  if (found) return toDto(found);
  try {
    return await createTag(organizationId, input);
  } catch (err) {
    if (err instanceof TagError && err.code === "duplicate") {
      const again = await findByName(organizationId, input.name);
      if (again) return toDto(again);
    }
    throw err;
  }
}

export async function getTag(organizationId: string, tagId: string): Promise<TagDto | null> {
  const t = schema.tag;
  const [row] = await getDb().select().from(t).where(scoped(t.organizationId, organizationId, eq(t.id, tagId))).limit(1);
  return row ? toDto(row) : null;
}

export async function updateTag(
  organizationId: string,
  tagId: string,
  patch: { name?: string; color?: string }
): Promise<TagDto> {
  const t = schema.tag;
  if (patch.name !== undefined) {
    const same = await findByName(organizationId, patch.name);
    if (same && same.id !== tagId) throw new TagError("duplicate", 409, "Ya existe una etiqueta con ese nombre");
  }
  const set: Partial<typeof t.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.color !== undefined) set.color = patch.color;
  let row;
  try {
    [row] = await getDb().update(t).set(set).where(scoped(t.organizationId, organizationId, eq(t.id, tagId))).returning();
  } catch {
    // El índice único cubre la carrera que la comprobación de arriba no ve.
    throw new TagError("duplicate", 409, "Ya existe una etiqueta con ese nombre");
  }
  if (!row) throw new TagError("not_found", 404, "La etiqueta no existe");
  return toDto(row);
}

/** Borra la etiqueta; sus asignaciones se van por la cascada de la base. */
export async function deleteTag(organizationId: string, tagId: string): Promise<void> {
  const t = schema.tag;
  const gone = await getDb()
    .delete(t)
    .where(scoped(t.organizationId, organizationId, eq(t.id, tagId)))
    .returning({ id: t.id });
  if (gone.length === 0) throw new TagError("not_found", 404, "La etiqueta no existe");
}

/** Las etiquetas de un contacto. */
export async function tagsOfContact(organizationId: string, contactId: string): Promise<TagDto[]> {
  const t = schema.tag;
  const ct = schema.contactTag;
  return getDb()
    .select({ id: t.id, name: t.name, color: t.color })
    .from(ct)
    .innerJoin(t, eq(t.id, ct.tagId))
    .where(scoped(ct.organizationId, organizationId, eq(ct.contactId, contactId)))
    .orderBy(asc(sql`lower(${t.name})`), asc(t.id));
}

/** Solo los ids (lo que necesita una condición). */
export async function tagIdsOfContact(organizationId: string, contactId: string): Promise<string[]> {
  const ct = schema.contactTag;
  const rows = await getDb()
    .select({ tagId: ct.tagId })
    .from(ct)
    .where(scoped(ct.organizationId, organizationId, eq(ct.contactId, contactId)));
  return rows.map((r) => r.tagId);
}

async function assertContact(organizationId: string, contactId: string) {
  const c = schema.contact;
  const [row] = await getDb()
    .select({ id: c.id })
    .from(c)
    .where(scoped(c.organizationId, organizationId, eq(c.id, contactId)))
    .limit(1);
  if (!row) throw new TagError("contact_not_found", 404, "El contacto no existe");
}

/**
 * Asigna la etiqueta al contacto. Devuelve `true` si fue una asignación nueva, `false` si ya la tenía.
 *
 * Una asignación NUEVA avisa a las automatizaciones (`tag_added`), ya hecha y sin poder fallar hacia arriba. Con
 * `viaAutomation` (el paso `add_tag` del motor) NO avisa: es el anti-bucle de siempre (`set_stage` hace lo mismo), así
 * un flujo que etiqueta no puede disparar otro que etiqueta, y así sin fin.
 */
export async function assignTag(
  organizationId: string,
  contactId: string,
  tagId: string,
  opts: { viaAutomation?: boolean } = {}
): Promise<boolean> {
  if (!(await getTag(organizationId, tagId))) throw new TagError("not_found", 404, "La etiqueta no existe");
  await assertContact(organizationId, contactId);
  const rows = await getDb()
    .insert(schema.contactTag)
    .values({ organizationId, contactId, tagId })
    .onConflictDoNothing()
    .returning({ tagId: schema.contactTag.tagId, assignedAt: schema.contactTag.assignedAt });
  const added = rows[0];
  if (added && !opts.viaAutomation) {
    await onTagAdded({ organizationId, contactId, tagId, assignedAt: added.assignedAt });
  }
  return rows.length > 0;
}

/** Quita la etiqueta del contacto. Devuelve `true` si la tenía; quitar lo que no está no es un error. */
export async function unassignTag(organizationId: string, contactId: string, tagId: string): Promise<boolean> {
  const ct = schema.contactTag;
  const rows = await getDb()
    .delete(ct)
    .where(scoped(ct.organizationId, organizationId, eq(ct.contactId, contactId), eq(ct.tagId, tagId)))
    .returning({ tagId: ct.tagId });
  return rows.length > 0;
}

/** Cuáles de estos ids existen en la organización (para validar pasos antes de guardarlos). */
export async function existingTagIds(organizationId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const t = schema.tag;
  const rows = await getDb()
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.organizationId, organizationId), inArray(t.id, ids)));
  return new Set(rows.map((r) => r.id));
}
