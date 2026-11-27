import { getDb } from "@/lib/db";
import { contact } from "@/lib/db/schema";
import { scoped } from "@/lib/db/tenant";
import { eq } from "drizzle-orm";

/**
 * Dispara el mensaje post-servicio pidiendo la reseña en Google Maps.
 */
export async function sendGoogleReviewPrompt(input: {
  organizationId: string;
  contactId: string;
  googleMapsReviewUrl: string;
}) {
  const db = getDb();

  const [c] = await db
    .select()
    .from(contact)
    .where(scoped(contact.organizationId, input.organizationId, eq(contact.id, input.contactId)))
    .limit(1);

  if (!c || (!c.phone && !c.waIdentity)) {
    return { success: false, error: "Contacto no encontrado o sin identificador de WhatsApp." };
  }

  const mensajeReseña = `¡Hola ${c.name}! ✂️ Gracias por visitarnos hoy. Queremos saber qué tal te pareció la atención. ¿Nos regalarías 1 minuto para dejarnos tu reseña aquí? Nos ayudas muchísimo: ${input.googleMapsReviewUrl}`;

  // Integración con el emisor de mensajes de Vocero CRM
  // await sendWhatsAppMessage({ organizationId: input.organizationId, to: c.waIdentity, text: mensajeReseña });

  return {
    success: true,
    message: mensajeReseña,
    status: "pendiente_envio" as const,
  };
}