import { and, desc, eq, isNotNull, max, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import type { AdFlowDto, AdFlowListDto, AdFlowParsed, AdFlowRowDto } from "@/lib/ad-flow";

/**
 * Enrutamiento por anuncio — los flujos de cada organización (detrás de la bandera `ATRIBUCION`; la
 * puerta de entrada vive en las rutas).
 *
 * Toda consulta pasa por `scoped()`: un id de OTRA organización responde igual que uno que no existe
 * (404), y un servicio u oferta de otra organización no se puede vincular (422), sin revelar que existe.
 */

/** Error esperado del dominio: lleva el código HTTP y un mensaje para la persona. */
export class AdFlowError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 422,
    message: string
  ) {
    super(message);
    this.name = "AdFlowError";
  }
}

/** Cuántos anuncios detectados se listan: más no se lee en una pantalla. */
export const MAX_DETECTED_ADS = 200;

const flow = schema.adFlow;

type FlowRow = typeof flow.$inferSelect;

function serialize(row: FlowRow, targetName: string | null): AdFlowDto {
  return {
    id: row.id,
    sourceId: row.sourceId,
    headline: row.headline,
    serviceId: row.serviceId,
    comboId: row.comboId,
    targetName,
    promptRules: row.promptRules,
    active: row.active,
    exclusive: row.exclusive,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Los anuncios que han traído conversaciones (de `ad_attribution`) junto con los flujos configurados:
 * un anuncio detectado sin flujo sale como «sin configurar», y un flujo creado a mano para un anuncio
 * que aún no ha traído a nadie sale con 0 conversaciones. Lo más reciente primero.
 */
export async function listAdFlows(organizationId: string): Promise<AdFlowListDto> {
  const db = getDb();
  const a = schema.adAttribution;

  const [detected, flows] = await Promise.all([
    db
      .select({
        sourceId: a.sourceId,
        conversations: sql<number>`count(*)::int`,
        lastSeenAt: max(a.createdAt),
        // El dato más reciente de cada anuncio (el titular puede cambiar entre campañas).
        headline: sql<string | null>`(array_agg(${a.headline} order by ${a.createdAt} desc))[1]`,
        sourceType: sql<string | null>`(array_agg(${a.sourceType} order by ${a.createdAt} desc))[1]`,
        imageAssetId: sql<
          string | null
        >`(array_agg(${a.imageAssetId} order by ${a.createdAt} desc) filter (where ${a.imageAssetId} is not null))[1]`,
      })
      .from(a)
      .where(scoped(a.organizationId, organizationId, isNotNull(a.sourceId)))
      .groupBy(a.sourceId)
      .orderBy(desc(max(a.createdAt)))
      .limit(MAX_DETECTED_ADS + 1),
    db
      .select({
        row: flow,
        serviceName: schema.service.name,
        comboName: schema.combo.name,
      })
      .from(flow)
      .leftJoin(schema.service, eq(schema.service.id, flow.serviceId))
      .leftJoin(schema.combo, eq(schema.combo.id, flow.comboId))
      .where(scoped(flow.organizationId, organizationId))
      .orderBy(desc(flow.updatedAt)),
  ]);

  const truncated = detected.length > MAX_DETECTED_ADS;
  const bySource = new Map(
    flows.map((f) => [f.row.sourceId, serialize(f.row, f.serviceName ?? f.comboName ?? null)])
  );

  const items: AdFlowRowDto[] = [];
  const seen = new Set<string>();
  for (const d of detected.slice(0, MAX_DETECTED_ADS)) {
    if (!d.sourceId) continue;
    seen.add(d.sourceId);
    const f = bySource.get(d.sourceId) ?? null;
    items.push({
      sourceId: d.sourceId,
      headline: d.headline ?? f?.headline ?? null,
      sourceType: d.sourceType,
      imageAssetId: d.imageAssetId,
      conversations: d.conversations,
      lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
      flow: f,
    });
  }
  // Configurados que todavía no han traído a nadie (o que quedaron fuera del tope).
  for (const [sourceId, f] of bySource) {
    if (seen.has(sourceId)) continue;
    items.push({
      sourceId,
      headline: f.headline,
      sourceType: null,
      imageAssetId: null,
      conversations: 0,
      lastSeenAt: null,
      flow: f,
    });
  }
  return { items, truncated };
}

/** El servicio u oferta deben ser de ESTA organización; devuelve su nombre. «Otro» no cuenta: no es del catálogo. */
async function resolveTargetName(
  organizationId: string,
  input: Pick<AdFlowParsed, "serviceId" | "comboId">
): Promise<string | null> {
  const db = getDb();
  if (input.serviceId) {
    const s = schema.service;
    const [row] = await db
      .select({ name: s.name })
      .from(s)
      .where(scoped(s.organizationId, organizationId, eq(s.id, input.serviceId), eq(s.isOther, false)))
      .limit(1);
    if (!row) throw new AdFlowError("service_not_found", 422, "El servicio elegido no existe");
    return row.name;
  }
  if (input.comboId) {
    const c = schema.combo;
    const [row] = await db
      .select({ name: c.name })
      .from(c)
      .where(scoped(c.organizationId, organizationId, eq(c.id, input.comboId)))
      .limit(1);
    if (!row) throw new AdFlowError("combo_not_found", 422, "La oferta elegida no existe");
    return row.name;
  }
  return null;
}

/** Crea el flujo del anuncio o, si ya había uno para ese `source_id`, lo actualiza. Idempotente. */
export async function upsertAdFlow(organizationId: string, input: AdFlowParsed): Promise<AdFlowDto> {
  const targetName = await resolveTargetName(organizationId, input);
  const values = {
    headline: input.headline,
    serviceId: input.serviceId,
    comboId: input.comboId,
    promptRules: input.promptRules,
    active: input.active,
    exclusive: input.exclusive,
  };
  const [row] = await getDb()
    .insert(flow)
    .values({ id: newId("adFlow"), organizationId, sourceId: input.sourceId, ...values })
    .onConflictDoUpdate({
      target: [flow.organizationId, flow.sourceId],
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  return serialize(row!, targetName);
}

export async function deleteAdFlow(organizationId: string, id: string): Promise<void> {
  const gone = await getDb()
    .delete(flow)
    .where(scoped(flow.organizationId, organizationId, eq(flow.id, id)))
    .returning({ id: flow.id });
  if (gone.length === 0) throw new AdFlowError("not_found", 404, "El flujo no existe");
}

/** El flujo ACTIVO de un anuncio, o null. Lo usa el agente. */
export async function findActiveAdFlow(
  organizationId: string,
  sourceId: string
): Promise<FlowRow | null> {
  const [row] = await getDb()
    .select()
    .from(flow)
    .where(scoped(flow.organizationId, organizationId, and(eq(flow.sourceId, sourceId), eq(flow.active, true))))
    .limit(1);
  return row ?? null;
}

export async function hasActiveAdFlow(organizationId: string, sourceId: string | null): Promise<boolean> {
  if (!sourceId) return false;
  return (await findActiveAdFlow(organizationId, sourceId)) !== null;
}
