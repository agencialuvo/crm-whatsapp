import { getDb } from "@/lib/db";
import { service, combo, staff } from "@/lib/db/schema";
import { scoped } from "@/lib/db/tenant";
import { eq } from "drizzle-orm";

export async function getBarbershopAiContext(organizationId: string) {
  const db = getDb();

  // 1. Consultar servicios activos
  const serviciosActivos = await db
    .select({
      name: service.name,
      description: service.description,
      price: service.priceCents,
      duration: service.durationMinutes,
    })
    .from(service)
    .where(scoped(service.organizationId, organizationId, eq(service.active, true)));

  // 2. Consultar combos/ofertas activas (vital para publicidad pagada)
  const combosActivos = await db
    .select({
      name: combo.name,
      description: combo.description,
      price: combo.priceCents,
      keyword: combo.keywordTrigger,
    })
    .from(combo)
    .where(scoped(combo.organizationId, organizationId, eq(combo.active, true)));

  // 3. Consultar staff disponible
  const personalActivo = await db
    .select({
      name: staff.name,
    })
    .from(staff)
    .where(scoped(staff.organizationId, organizationId, eq(staff.active, true)));

  // 4. Construir el texto del prompt del sistema para el LLM
  const promptContext = `
Eres el asistente virtual experto de la barbería/salón de belleza. Tu objetivo es atender amablemente, responder objeciones (precios, dirección, qué incluye), detectar ofertas y agendar citas eficientemente.

### CATÁLOGO DE SERVICIOS REGULARES:
${serviciosActivos.map(s => `- ${s.name}: S/ ${(s.price / 100).toFixed(2)} (${s.duration} min).${s.description || ''}`).join('\n')}

### OFERTAS ESPECIALES (Publicidad Pagada):
Si el cliente menciona o llega por una palabra clave de oferta, ofrece directamente estos beneficios:
${combosActivos.map(c => `- [Palabra clave: ${c.keyword}]${c.name}: S/ ${(c.price / 100).toFixed(2)} - Incluye:${c.description}`).join('\n')}

### EQUIPO DE TRABAJO (Staff):
Contamos con los siguientes profesionales disponibles según la agenda: ${personalActivo.map(st => st.name).join(', ')}.

### REGLAS DE NEGOCIO:
1. Si el cliente pregunta por un servicio o precio, respóndele basándote estrictamente en la lista anterior.
2. Si el cliente quiere reservar, pregúntale qué servicio u oferta desea y con qué barbero (o si prefiere al primero disponible).
3. Verifica la disponibilidad antes de confirmar la cita en Google Calendar.
`;

  return promptContext;
}