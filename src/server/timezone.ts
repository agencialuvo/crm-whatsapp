import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { isValidTimeZone } from "@/lib/time/slots";
import { getBrandingTimezone, saveBrandingTimezone } from "@/server/branding";

/**
 * Zona horaria del negocio: ¿alguien ya la eligió? Cuenta como elegida la de Ajustes → Negocio → Marca
 * y la que ya guardó la agenda (una fila en `calendar_settings`). Mientras no haya ninguna, el sistema
 * toma la del país desde donde se usa (la que informa el navegador del dueño) en vez de una fija.
 */
export async function isTimezoneConfigured(organizationId: string): Promise<boolean> {
  if (await getBrandingTimezone(organizationId)) return true;
  const [row] = await getDb()
    .select({ id: schema.calendarSettings.id })
    .from(schema.calendarSettings)
    .where(eq(schema.calendarSettings.organizationId, organizationId))
    .limit(1);
  return !!row;
}

/**
 * Adopta la zona detectada SOLO si nadie había elegido una (jamás pisa una elección). Devuelve si
 * la guardó. Una zona que el motor no entiende se descarta.
 */
export async function adoptDetectedTimezone(organizationId: string, detected: string): Promise<boolean> {
  const tz = detected.trim();
  if (!tz || !isValidTimeZone(tz)) return false;
  if (await isTimezoneConfigured(organizationId)) return false;
  await saveBrandingTimezone(organizationId, tz);
  return true;
}
