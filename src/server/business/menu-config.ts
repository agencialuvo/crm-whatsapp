import { and, asc, count, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  MENU_MAX_TEMPLATES,
  MENU_SYSTEM_TEMPLATES,
  menuBaseKeySchema,
  menuConfigSchema,
  menuTemplateNameSchema,
  findSystemTemplate,
  parseMenuConfig,
  suggestedTemplateKey,
  type MenuConfig,
} from "@/lib/menu-config";
import { SalonError, isPgError, UNIQUE_VIOLATION } from "@/server/business/http";

/**
 * Menú lateral personalizable — la configuración activa de la organización y sus plantillas guardadas.
 *
 * Solo guarda PRESENTACIÓN (visibilidad, orden, nombres, iconos): no concede ni quita acceso a nada y ocultar una
 * entrada jamás borra datos ni bloquea su ruta. Toda consulta pasa por `scoped()`. Lo que se escribe se valida aquí
 * con el esquema del catálogo (llaves de ítems y bloques, `iconKey` del catálogo de iconos, longitud de nombres,
 * «Ajustes» nunca oculto), aunque la ruta ya lo haya validado: este es el único escritor de la tabla.
 *
 * Las plantillas BASE del sistema viven en código (`MENU_SYSTEM_TEMPLATES`) y son de solo lectura: aquí no hay nada
 * que las escriba. Elegir una copia su contenido a la configuración activa; editarla después cambia la copia.
 */

const t = schema.menuConfig;

export type SavedMenuTemplate = {
  id: string;
  name: string;
  config: MenuConfig;
  updatedAt: string;
};

export type ActiveMenu = { config: MenuConfig; baseKey: string | null };

/** El primer mensaje de un esquema que no pasó, en una frase para la persona. */
function invalid(issues: { message: string }[]): SalonError {
  return new SalonError("invalid_menu", 422, issues[0]?.message ?? "La configuración del menú no es válida");
}

function checkConfig(raw: unknown): MenuConfig {
  const parsed = menuConfigSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues);
  return parsed.data;
}

function checkBaseKey(raw: unknown): string | null {
  const parsed = menuBaseKeySchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues);
  return parsed.data ?? null;
}

function checkName(raw: unknown): string {
  const parsed = menuTemplateNameSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues);
  // Una guardada no puede llamarse como una base del sistema: en el selector no se distinguirían.
  if (MENU_SYSTEM_TEMPLATES.some((s) => s.name.toLowerCase() === parsed.data.toLowerCase())) {
    throw new SalonError("name_taken", 409, "Ese nombre es de una plantilla del sistema. Elige otro.");
  }
  return parsed.data;
}

const NAME_TAKEN = new SalonError("name_taken", 409, "Ya tienes una plantilla con ese nombre. Elige otro.");

/* ------------------------------ configuración activa ------------------------------ */

/** La configuración activa (o `null` = menú estándar). Una guardada que ya no cumpla el esquema se ignora. */
export async function getActiveMenu(organizationId: string): Promise<ActiveMenu | null> {
  const [row] = await getDb()
    .select({ config: t.config, baseKey: t.baseKey })
    .from(t)
    .where(scoped(t.organizationId, organizationId, eq(t.kind, "active")))
    .limit(1);
  if (!row) return null;
  const config = parseMenuConfig(row.config);
  return config ? { config, baseKey: row.baseKey } : null;
}

/** Solo la configuración, para el menú: nunca lanza (un fallo de lectura deja el menú estándar). */
export async function getMenuConfig(organizationId: string): Promise<MenuConfig | null> {
  try {
    return (await getActiveMenu(organizationId))?.config ?? null;
  } catch {
    return null;
  }
}

/** Guarda la configuración activa (una sola por organización: la que existe se reemplaza). */
export async function saveActiveMenu(
  organizationId: string,
  input: { config: unknown; baseKey?: unknown }
): Promise<ActiveMenu> {
  const config = checkConfig(input.config);
  const baseKey = checkBaseKey(input.baseKey);
  await getDb()
    .insert(t)
    .values({ id: newId("menuConfig"), organizationId, kind: "active", name: null, baseKey, config })
    .onConflictDoUpdate({
      target: [t.organizationId],
      targetWhere: sql`${t.kind} = 'active'`,
      set: { config, baseKey, updatedAt: new Date() },
    });
  return { config, baseKey };
}

/** Vuelve al menú estándar. Las plantillas guardadas no se tocan. */
export async function resetActiveMenu(organizationId: string): Promise<void> {
  await getDb().delete(t).where(scoped(t.organizationId, organizationId, eq(t.kind, "active")));
}

/* ------------------------- el menú sigue al tipo de negocio ------------------------- */

/** `applied`: se aplicó la plantilla del sector · `cleared`: se volvió al estándar · `kept`: había un menú propio, no se toca · `none`: nada que hacer. */
export type SectorMenuSync = "applied" | "cleared" | "kept" | "none";

const canonical = (raw: unknown): string | null => {
  const parsed = parseMenuConfig(raw);
  return parsed ? JSON.stringify(parsed) : null;
};

/**
 * Adapta el menú al tipo de negocio que se acaba de elegir, SIN pisar lo que la organización personalizó:
 * - sin menú activo → se aplica la plantilla del sector (`insert … onConflictDoNothing`: si otra pestaña guardó un
 *   menú entre la lectura y la escritura, gana el de la persona);
 * - con un menú activo que es EXACTAMENTE una plantilla del sistema aplicada antes (`baseKey` de una base y mismo
 *   contenido) → nadie lo tocó, así que se cambia por la del sector nuevo (o vuelve al estándar);
 * - con cualquier otro menú activo → se conserva tal cual.
 * Es una forma conservadora: un menú que se cargó en el editor y se guardó pasa por `configFromResolved` y casi nunca
 * coincide byte a byte con la plantilla, así que se trata como personalizado y no se toca.
 */
export async function syncSectorMenu(organizationId: string, categoryKey: string): Promise<SectorMenuSync> {
  const target = findSystemTemplate(suggestedTemplateKey(categoryKey));
  if (!target) return "none";
  const db = getDb();
  const [row] = await db
    .select({ config: t.config, baseKey: t.baseKey })
    .from(t)
    .where(scoped(t.organizationId, organizationId, eq(t.kind, "active")))
    .limit(1);

  const targetConfig = target.config ? checkConfig(target.config) : null;

  if (!row) {
    if (!targetConfig) return "none";
    await db
      .insert(t)
      .values({ id: newId("menuConfig"), organizationId, kind: "active", name: null, baseKey: target.key, config: targetConfig })
      .onConflictDoNothing({ target: [t.organizationId], where: sql`${t.kind} = 'active'` });
    return "applied";
  }

  const previous = findSystemTemplate(row.baseKey);
  const untouched = !!previous && !!previous.config && canonical(row.config) === canonical(previous.config);
  if (!untouched) return "kept";
  if (previous.key === target.key) return "none";

  // Se escribe solo si la fila sigue siendo la que se leyó (otra pestaña pudo cambiarla entre tanto).
  const same = scoped(t.organizationId, organizationId, eq(t.kind, "active"), eq(t.baseKey, previous.key));
  if (!targetConfig) {
    await db.delete(t).where(same);
    return "cleared";
  }
  await db.update(t).set({ config: targetConfig, baseKey: target.key, updatedAt: new Date() }).where(same);
  return "applied";
}

/* ------------------------------ plantillas guardadas ------------------------------ */

type TemplateRow = { id: string; name: string | null; config: unknown; updatedAt: Date };

function toTemplate(r: TemplateRow): SavedMenuTemplate | null {
  const config = parseMenuConfig(r.config);
  return config && r.name ? { id: r.id, name: r.name, config, updatedAt: r.updatedAt.toISOString() } : null;
}

export async function listMenuTemplates(organizationId: string): Promise<SavedMenuTemplate[]> {
  const rows = await getDb()
    .select({ id: t.id, name: t.name, config: t.config, updatedAt: t.updatedAt })
    .from(t)
    .where(scoped(t.organizationId, organizationId, eq(t.kind, "template")))
    .orderBy(asc(t.name));
  return rows.flatMap((r) => {
    const tpl = toTemplate(r);
    return tpl ? [tpl] : [];
  });
}

export async function createMenuTemplate(
  organizationId: string,
  input: { name: unknown; config: unknown }
): Promise<SavedMenuTemplate> {
  const name = checkName(input.name);
  const config = checkConfig(input.config);
  const db = getDb();
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(t)
    .where(scoped(t.organizationId, organizationId, eq(t.kind, "template")));
  if (n >= MENU_MAX_TEMPLATES) {
    throw new SalonError("too_many_templates", 409, `Puedes guardar hasta ${MENU_MAX_TEMPLATES} plantillas. Elimina alguna.`);
  }
  try {
    const [row] = await db
      .insert(t)
      .values({ id: newId("menuConfig"), organizationId, kind: "template", name, config })
      .returning({ id: t.id, name: t.name, config: t.config, updatedAt: t.updatedAt });
    const tpl = row ? toTemplate(row) : null;
    if (!tpl) throw new SalonError("invalid_menu", 422, "No se pudo guardar la plantilla");
    return tpl;
  } catch (err) {
    if (isPgError(err, UNIQUE_VIOLATION)) throw NAME_TAKEN;
    throw err;
  }
}

export async function updateMenuTemplate(
  organizationId: string,
  id: string,
  patch: { name?: unknown; config?: unknown }
): Promise<SavedMenuTemplate> {
  const set: { name?: string; config?: MenuConfig; updatedAt: Date } = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = checkName(patch.name);
  if (patch.config !== undefined) set.config = checkConfig(patch.config);
  try {
    const [row] = await getDb()
      .update(t)
      .set(set)
      .where(scoped(t.organizationId, organizationId, and(eq(t.id, id), eq(t.kind, "template"))))
      .returning({ id: t.id, name: t.name, config: t.config, updatedAt: t.updatedAt });
    if (!row) throw new SalonError("not_found", 404, "La plantilla no existe");
    const tpl = toTemplate(row);
    if (!tpl) throw new SalonError("invalid_menu", 422, "La plantilla no es válida");
    return tpl;
  } catch (err) {
    if (isPgError(err, UNIQUE_VIOLATION)) throw NAME_TAKEN;
    throw err;
  }
}

export async function deleteMenuTemplate(organizationId: string, id: string): Promise<void> {
  const rows = await getDb()
    .delete(t)
    .where(scoped(t.organizationId, organizationId, and(eq(t.id, id), eq(t.kind, "template"))))
    .returning({ id: t.id });
  if (rows.length === 0) throw new SalonError("not_found", 404, "La plantilla no existe");
}
