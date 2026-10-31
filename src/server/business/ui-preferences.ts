import { eq, and, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  MAX_PAGE_SIZE_VIEWS,
  setTablePageSizeInputSchema,
  type SetTablePageSizeInput,
} from "@/lib/salon/cash-shifts";
import { SalonError } from "@/server/business/http";

/**
 * Preferencias de vista por persona y organización: cuántas filas por página
 * prefiere en cada tabla (`{ "clients": 25, "sales": 50 }`).
 *
 * Como el resto del módulo, no es una Server Action: recibe `organizationId` y
 * `userId` ya sacados de la sesión por la ruta que la llama.
 */

const prefs = schema.userUiPreferences;

/** Las filas por página guardadas de esta persona (vacío si nunca eligió). */
export async function getTablePageSizes(organizationId: string, userId: string): Promise<Record<string, number>> {
  const [row] = await getDb()
    .select({ sizes: prefs.tablePageSizes })
    .from(prefs)
    .where(scoped(prefs.organizationId, organizationId, eq(prefs.userId, userId)))
    .limit(1);
  return row?.sizes ?? {};
}

/**
 * Guarda las filas por página de UNA vista, sin pisar las demás. Es un solo
 * upsert que mezcla el JSON en la base (dos pestañas guardando vistas distintas no
 * se borran entre sí) y con tope de vistas para que el JSON no crezca sin límite.
 */
export async function setTablePageSize(
  organizationId: string,
  userId: string,
  input: SetTablePageSizeInput
): Promise<Record<string, number>> {
  const parsed = setTablePageSizeInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new SalonError("invalid_preference", 422, parsed.error.issues[0]?.message ?? "Preferencia no válida");
  }
  const patch = { [parsed.data.view]: parsed.data.pageSize };

  const [row] = await getDb()
    .insert(prefs)
    .values({
      id: newId("userUiPreferences"),
      organizationId,
      userId,
      tablePageSizes: patch,
    })
    .onConflictDoUpdate({
      target: [prefs.organizationId, prefs.userId],
      set: {
        tablePageSizes: sql`${prefs.tablePageSizes} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      },
      // Con el tope lleno solo se aceptan vistas que ya existen.
      setWhere: sql`(select count(*) from jsonb_object_keys(${prefs.tablePageSizes} || ${JSON.stringify(patch)}::jsonb)) <= ${MAX_PAGE_SIZE_VIEWS}`,
    })
    .returning({ sizes: prefs.tablePageSizes });

  if (!row) throw new SalonError("preferences_full", 422, "Demasiadas vistas guardadas");
  return row.sizes;
}

/** Quita lo guardado de una vista (vuelve a su valor por defecto). */
export async function clearTablePageSize(organizationId: string, userId: string, view: string): Promise<void> {
  const parsed = setTablePageSizeInputSchema.shape.view.safeParse(view);
  if (!parsed.success) throw new SalonError("invalid_preference", 422, "Nombre de vista no válido");
  await getDb()
    .update(prefs)
    .set({ tablePageSizes: sql`${prefs.tablePageSizes} - ${parsed.data}::text`, updatedAt: new Date() })
    .where(and(eq(prefs.organizationId, organizationId), eq(prefs.userId, userId)));
}
