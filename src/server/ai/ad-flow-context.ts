import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type { AdFlowContext, AdFlowTarget } from "@/lib/ad-flow";
import { activeProviders, isOpenToAll } from "@/lib/salon/providers";
import { priceLabel } from "@/lib/salon/format";
import { findActiveAdFlow } from "@/server/attribution/ad-flow";
import { getBranding } from "@/server/branding";
import { catalogStaffMaps } from "@/server/business/catalog-staff";

/**
 * Enrutamiento por anuncio — lo que el agente sabe de la conversación que llegó de un anuncio con flujo.
 *
 * Resuelve `source_id` → flujo ACTIVO → servicio u oferta con sus datos oficiales (nombre, precio,
 * descripción, duración y quiénes lo dan). Devuelve datos, no texto: la directiva la arma
 * `buildAdFlowDirective` en `prompts.ts`.
 *
 * Quien llama decide qué hacer con un error (el pipeline lo ignora y responde con el comportamiento
 * genérico del anuncio): el enrutamiento mejora el turno, nunca lo tumba.
 */
export async function getAdFlowContext(
  organizationId: string,
  sourceId: string | null | undefined
): Promise<AdFlowContext | null> {
  if (!sourceId) return null;
  const row = await findActiveAdFlow(organizationId, sourceId);
  if (!row) return null;

  const target = await loadTarget(organizationId, row.serviceId, row.comboId);
  // Sin destino (se borró o se desactivó) y sin reglas, no queda nada que enrutar: comportamiento genérico.
  if (!target && !row.promptRules) return null;

  return {
    flowId: row.id,
    sourceId: row.sourceId,
    // Exclusivo solo tiene sentido si hay algo que perseguir.
    exclusive: row.exclusive && target !== null,
    promptRules: row.promptRules,
    target,
  };
}

async function loadTarget(
  organizationId: string,
  serviceId: string | null,
  comboId: string | null
): Promise<AdFlowTarget | null> {
  if (!serviceId && !comboId) return null;
  const db = getDb();

  let base: {
    kind: "service" | "combo";
    id: string;
    name: string;
    description: string | null;
    priceCents: number;
    priceMode: "fixed" | "variable";
    durationMinutes: number | null;
  } | null = null;

  if (serviceId) {
    const s = schema.service;
    const [r] = await db
      .select({
        id: s.id,
        name: s.name,
        description: s.description,
        priceCents: s.priceCents,
        priceMode: s.priceMode,
        durationMinutes: s.durationMinutes,
      })
      .from(s)
      .where(scoped(s.organizationId, organizationId, eq(s.id, serviceId), eq(s.active, true)))
      .limit(1);
    if (r) base = { kind: "service", ...r };
  } else if (comboId) {
    const c = schema.combo;
    const [r] = await db
      .select({
        id: c.id,
        name: c.name,
        description: c.description,
        priceCents: c.priceCents,
        durationMinutes: c.durationMinutes,
      })
      .from(c)
      .where(scoped(c.organizationId, organizationId, eq(c.id, comboId), eq(c.active, true)))
      .limit(1);
    if (r) base = { kind: "combo", ...r, priceMode: "fixed" };
  }
  if (!base) return null;

  const [{ currency }, maps, team] = await Promise.all([
    getBranding(organizationId),
    catalogStaffMaps(organizationId),
    db
      .select({ id: schema.staff.id, name: schema.staff.name })
      .from(schema.staff)
      .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.active, true))),
  ]);

  // Quiénes lo dan: si lo da todo el equipo no se dice nada; si no, el agente no ofrece a otro.
  const staff = team.map((m) => ({ id: m.id, name: m.name, active: true }));
  const item = {
    kind: base.kind,
    id: base.id,
    staffIds: (base.kind === "service" ? maps.services : maps.combos).get(base.id) ?? [],
  };
  const providers = isOpenToAll(item, staff) ? null : activeProviders(item, staff).map((m) => m.name);

  return {
    kind: base.kind,
    id: base.id,
    name: base.name,
    description: base.description?.trim() || null,
    priceLabel: priceLabel(base.priceMode, base.priceCents, currency),
    durationMinutes: base.durationMinutes,
    providers: providers && providers.length > 0 ? providers : null,
  };
}
