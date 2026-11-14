import { eq } from "drizzle-orm";
import { adReferralDedupeKey, parseAdReferralConfig } from "@/lib/automation";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { emitAutomationEvent } from "@/server/automation/events";
import { automationsEnabled } from "@/server/automation/flag";
import { dbTriggerStore, type TriggerStore } from "@/server/automation/trigger-store";

/**
 * Automatizaciones — el disparador `ad_referral`: una conversación registró su anuncio de origen.
 *
 * Lo llama `registrarAnuncioDeOrigen` SOLO cuando la atribución es nueva (o reemplazada): una reentrega del
 * webhook, o un anuncio que no gana (el primero gana), no lo vuelve a disparar. La llave es por anuncio, así que
 * el mismo contacto no arranca dos veces el mismo flujo por el mismo anuncio.
 *
 * El `run` lleva una FOTO del contexto del anuncio —su titular y el servicio u oferta del `ad_flow` activo—, de
 * donde sale `{{servicio}}` en los mensajes. Nunca lanza: la atribución ya se guardó y es lo que importa.
 */

export type AdContext = {
  adSourceId: string;
  headline?: string;
  serviceName?: string;
  comboName?: string;
};

/** El contexto del anuncio: su titular y el servicio u oferta del flujo de enrutamiento activo (si lo hay). */
export async function loadAdContext(
  organizationId: string,
  sourceId: string,
  headline: string | null | undefined
): Promise<AdContext> {
  const ctx: AdContext = { adSourceId: sourceId, ...(headline ? { headline } : {}) };
  const f = schema.adFlow;
  const [flow] = await getDb()
    .select({ headline: f.headline, serviceId: f.serviceId, comboId: f.comboId })
    .from(f)
    .where(scoped(f.organizationId, organizationId, eq(f.sourceId, sourceId), eq(f.active, true)))
    .limit(1);
  if (!flow) return ctx;
  if (!ctx.headline && flow.headline) ctx.headline = flow.headline;
  if (flow.serviceId) {
    const [svc] = await getDb()
      .select({ name: schema.service.name })
      .from(schema.service)
      .where(scoped(schema.service.organizationId, organizationId, eq(schema.service.id, flow.serviceId)))
      .limit(1);
    if (svc) ctx.serviceName = svc.name;
  } else if (flow.comboId) {
    const [cmb] = await getDb()
      .select({ name: schema.combo.name })
      .from(schema.combo)
      .where(scoped(schema.combo.organizationId, organizationId, eq(schema.combo.id, flow.comboId)))
      .limit(1);
    if (cmb) ctx.comboName = cmb.name;
  }
  return ctx;
}

/** Devuelve cuántas ejecuciones arrancó. Nunca lanza. */
export async function emitAdReferral(
  input: { organizationId: string; contactId: string; sourceId: string; headline?: string | null },
  store: TriggerStore = dbTriggerStore,
  enabled: () => boolean = automationsEnabled,
  loadContext: typeof loadAdContext = loadAdContext,
  now: () => Date = () => new Date()
): Promise<number> {
  if (!enabled()) return 0;
  try {
    const context = await loadContext(input.organizationId, input.sourceId, input.headline);
    return await emitAutomationEvent(
      {
        organizationId: input.organizationId,
        trigger: "ad_referral",
        contactId: input.contactId,
        dedupeKey: adReferralDedupeKey(input.sourceId),
        context,
        // Un flujo con anuncio solo reacciona a ese; sin él, a cualquiera.
        matches: (f) => {
          const only = parseAdReferralConfig(f.triggerConfig).sourceId;
          return !only || only === input.sourceId;
        },
      },
      store,
      now
    );
  } catch (err) {
    console.error("[automatizaciones] el disparador de anuncio falló:", err);
    return 0;
  }
}
