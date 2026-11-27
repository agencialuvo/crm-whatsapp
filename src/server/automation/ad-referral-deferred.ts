import { eq, gte, inArray } from "drizzle-orm";
import { adReferralDedupeKey, adReferralDedupeKeyFor, adScopeOf, matchesAdTrigger, parseAdReferralConfig, type AdHierarchy } from "@/lib/automation";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { chunk } from "@/lib/meta/ads";
import { loadAdContext, loadAdHierarchy } from "@/server/automation/ad-referral";
import { emitAutomationEvent } from "@/server/automation/events";
import { automationsEnabled } from "@/server/automation/flag";
import { dbTriggerStore, type TriggerStore } from "@/server/automation/trigger-store";

/**
 * 047 — El otro lado del retraso lógico de los disparadores por conjunto y por campaña.
 *
 * Cuando llega el primer mensaje de un anuncio nuevo, su conjunto y su campaña todavía no están en el catálogo
 * (`meta_ad`): la ingesta solo encola la consulta, jamás espera a Meta. Ese flujo no se descarta: cuando el worker
 * resuelve el anuncio (`markSynced`, o el listado de la cuenta), se vuelve a evaluar para las conversaciones de las
 * últimas 48 h con ese `source_id` y SOLO para los flujos de conjunto/campaña (los de anuncio ya arrancaron).
 *
 * Es idempotente: `automation_run` es único por organización + flujo + contacto + llave, así que repetirlo (cada
 * sincronización lo llama) no duplica nada. Y nunca lanza: el catálogo ya se guardó y es lo que importa.
 */

export const DEFERRED_WINDOW_MS = 48 * 60 * 60 * 1000;

export async function emitDeferredAdReferrals(
  organizationId: string,
  adIds: readonly string[],
  now: Date = new Date(),
  store: TriggerStore = dbTriggerStore,
  enabled: () => boolean = automationsEnabled
): Promise<number> {
  if (!enabled() || adIds.length === 0) return 0;
  try {
    const flows = await store.activeFlows(organizationId, "ad_referral");
    const scopedFlows = flows.filter((f) => {
      const level = adScopeOf(parseAdReferralConfig(f.triggerConfig)).level;
      return level === "adset" || level === "campaign";
    });
    if (scopedFlows.length === 0) return 0;

    const cutoff = new Date(now.getTime() - DEFERRED_WINDOW_MS);
    const a = schema.adAttribution;
    let started = 0;
    const hierarchies = new Map<string, AdHierarchy>();
    for (const lote of chunk([...new Set(adIds)], 500)) {
      if (lote.length === 0) continue;
      // Bloque 3 — Solo atribuciones de conversaciones REALES: una del Laboratorio (`is_test`) jamás arranca flujos.
      const rows = await getDb()
        .select({ contactId: a.contactId, sourceId: a.sourceId, headline: a.headline })
        .from(a)
        .innerJoin(schema.conversation, eq(schema.conversation.id, a.conversationId))
        .where(
          scoped(
            a.organizationId,
            organizationId,
            inArray(a.sourceId, lote),
            gte(a.createdAt, cutoff),
            eq(schema.conversation.isTest, false)
          )
        );
      for (const r of rows) {
        if (!r.sourceId) continue;
        let h = hierarchies.get(r.sourceId);
        if (!h) {
          h = await loadAdHierarchy(organizationId, r.sourceId);
          hierarchies.set(r.sourceId, h);
        }
        const sourceId = r.sourceId;
        const context = await loadAdContext(organizationId, sourceId, r.headline);
        started += await emitAutomationEvent(
          {
            organizationId,
            trigger: "ad_referral",
            contactId: r.contactId,
            dedupeKey: adReferralDedupeKey(sourceId),
            dedupeKeyFor: (f) => adReferralDedupeKeyFor(parseAdReferralConfig(f.triggerConfig), sourceId),
            context,
            matches: (f) => {
              const cfg = parseAdReferralConfig(f.triggerConfig);
              const level = adScopeOf(cfg).level;
              return (level === "adset" || level === "campaign") && matchesAdTrigger(cfg, h!) === "yes";
            },
          },
          store,
          () => now
        );
      }
    }
    return started;
  } catch (err) {
    console.error("[automatizaciones] la re-evaluación diferida del anuncio falló:", err instanceof Error ? err.message : err);
    return 0;
  }
}
