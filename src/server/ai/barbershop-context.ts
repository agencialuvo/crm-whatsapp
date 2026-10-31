import { getDb } from "@/lib/db";
import { service, combo, staff } from "@/lib/db/schema";
import { scoped } from "@/lib/db/tenant";
import { eq, isNotNull } from "drizzle-orm";
import { money } from "@/lib/salon/format";
import { getBranding } from "@/server/branding";
import { activeProviders, isOpenToAll } from "@/lib/salon/providers";
import { catalogStaffMaps } from "@/server/business/catalog-staff";
import { buildComboTriggerInstruction, detectComboTrigger } from "@/server/ai/combo-trigger";

/**
 * La instrucción prioritaria de un turno cuando el mensaje del cliente trae la
 * palabra clave de un combo activo; `null` si no hay coincidencia. Solo lee los
 * combos con palabra clave y no falla el turno: quien llama decide qué hacer
 * con un error (el pipeline lo ignora y responde sin la instrucción).
 */
export async function getComboTriggerInstruction(
  organizationId: string,
  messageText: string | null | undefined
): Promise<string | null> {
  if (!messageText) return null;
  const db = getDb();
  const combos = await db
    .select({
      name: combo.name,
      description: combo.description,
      priceCents: combo.priceCents,
      keywordTrigger: combo.keywordTrigger,
    })
    .from(combo)
    .where(
      scoped(
        combo.organizationId,
        organizationId,
        eq(combo.active, true),
        isNotNull(combo.keywordTrigger)
      )
    );
  const hit = detectComboTrigger(messageText, combos);
  if (!hit) return null;
  const { currency } = await getBranding(organizationId);
  return buildComboTriggerInstruction(hit, currency);
}

export async function getBarbershopAiContext(organizationId: string): Promise<string> {
  const db = getDb();
  // La moneda es la de Ajustes → Marca (soles por defecto).
  const { currency } = await getBranding(organizationId);

  // 1. Consultar servicios activos
  const serviciosActivos = await db
    .select({
      id: service.id,
      name: service.name,
      description: service.description,
      price: service.priceCents,
      duration: service.durationMinutes,
    })
    .from(service)
    .where(scoped(service.organizationId, organizationId, eq(service.active, true)));

  // 2. Consultar combos u ofertas activas (vital para publicidad pagada y palabras clave)
  const combosActivos = await db
    .select({
      id: combo.id,
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
      id: staff.id,
      name: staff.name,
    })
    .from(staff)
    .where(scoped(staff.organizationId, organizationId, eq(staff.active, true)));

  // Qué profesionales dan cada servicio u oferta (su lista). Si lo da todo el
  // equipo no se dice nada; si no, el agente no debe ofrecer a otro.
  const quienes = await catalogStaffMaps(organizationId);
  const equipo = personalActivo.map((p) => ({ id: p.id, name: p.name, active: true }));
  const loDan = (kind: "service" | "combo", id: string, staffIds: string[] | undefined): string => {
    const item = { kind, id, staffIds: staffIds ?? [] };
    if (isOpenToAll(item, equipo)) return "";
    const lista = activeProviders(item, equipo).map((m) => m.name);
    return lista.length > 0 ? ` Solo lo realiza: ${lista.join(", ")}.` : "";
  };

  // 4. Construir el texto estructurado para el prompt del sistema del LLM
  return `
[INSTRUCCIONES Y CONTEXTO DEL NEGOCIO - BARBERÍA/SALÓN]
Eres el asistente virtual experto de este local. Tu rol es atender con excelente trato, responder objeciones (precios, dirección, qué incluye), detectar ofertas de publicidad y ayudar a agendar citas.

### CATÁLOGO DE SERVICIOS REGULARES:
${
  serviciosActivos.length > 0
    ? serviciosActivos
        .map(
          (s) =>
            `- ${s.name}: ${money(s.price, currency)} (${s.duration} min).${s.description || ""}${loDan("service", s.id, quienes.services.get(s.id))}`
        )
        .join("\n")
    : "No hay servicios regulares configurados aún."
}

### OFERTAS ESPECIALES (Publicidad Pagada):
Si el cliente menciona o llega por una palabra clave de oferta (ej. su palabra clave asociada), ofrece directamente estos beneficios:
${
  combosActivos.length > 0
    ? combosActivos
        .map(
          (c) =>
            `- [Disparador / Palabra Clave: ${c.keyword ?? "Ninguna"}] ${c.name}: ${money(c.price, currency)} - Incluye:${c.description}${loDan("combo", c.id, quienes.combos.get(c.id))}`
        )
        .join("\n")
    : "No hay ofertas activas por el momento."
}

### PERSONAL (STAFF) DISPONIBLE:
Contamos con los siguientes profesionales: ${
    personalActivo.length > 0
      ? personalActivo.map((st) => st.name).join(", ")
      : "Equipo general de barberos"
  }.

### REGLAS DE RESPUESTA:
1. Responde de forma natural, amigable y directa orientada a cerrar la venta o agendar.
2. Si el cliente pregunta por precios o qué incluye un servicio, respóndete estrictamente con los datos de arriba.
3. Si el cliente desea reservar, pregúntale qué servicio u oferta desea y si prefiere a algún barbero en específico.
`.trim();
}