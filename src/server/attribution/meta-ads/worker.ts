import { atribucionEnabled } from "@/server/attribution/flag";
import { connectedOrganizations } from "@/server/attribution/meta-ads/settings";
import { defaultSyncDeps, syncOrganization, type SyncDeps, type SyncSummary } from "@/server/attribution/meta-ads/sync";

/**
 * 038 — El temporizador de la sincronización con la Marketing API.
 *
 * Dentro del proceso, como el resto del trabajo de fondo (sin colas externas).
 * Un solo temporizador cada 60 s: la jerarquía de los anuncios nuevos se resuelve
 * en un minuto, y el gasto se pide cada 3 h por organización (el propio
 * `syncOrganization` decide, así que un tick sin trabajo cuesta una consulta).
 * Solo corre con la bandera `ATRIBUCION`.
 */

const INTERVAL_MS = 60_000;

type State = { timer: NodeJS.Timeout | null; running: boolean };

// En globalThis: en dev los módulos se evalúan más de una vez y dos temporizadores se pisarían.
const g = globalThis as unknown as { __voceroMetaAdsWorker?: State };
const state = (): State => (g.__voceroMetaAdsWorker ??= { timer: null, running: false });

/** Una pasada por todas las organizaciones conectadas. Nunca lanza. */
export async function tickMetaAds(deps: SyncDeps = defaultSyncDeps): Promise<number> {
  const s = state();
  if (s.running || !atribucionEnabled()) return 0;
  s.running = true;
  try {
    const orgs = await connectedOrganizations();
    for (const org of orgs) await syncOrganization(org, deps);
    return orgs.length;
  } catch (err) {
    console.error("[meta-ads] la pasada falló:", err instanceof Error ? err.message : err);
    return 0;
  } finally {
    s.running = false;
  }
}

/** Enfriamiento del botón «Sincronizar ahora», por organización. */
const MANUAL_COOLDOWN_MS = 60_000;
const gm = globalThis as unknown as { __voceroMetaAdsManual?: Map<string, number> };
const manual = (): Map<string, number> => (gm.__voceroMetaAdsManual ??= new Map());

/** Sincronización pedida a mano. `null` si el enfriamiento no ha pasado (segundos que faltan). */
export async function syncNow(
  organizationId: string,
  deps: SyncDeps = defaultSyncDeps
): Promise<{ summary: SyncSummary } | { waitSeconds: number }> {
  const ahora = deps.now().getTime();
  const ultimo = manual().get(organizationId) ?? 0;
  if (ahora - ultimo < MANUAL_COOLDOWN_MS) {
    return { waitSeconds: Math.ceil((MANUAL_COOLDOWN_MS - (ahora - ultimo)) / 1000) };
  }
  manual().set(organizationId, ahora);
  return { summary: await syncOrganization(organizationId, deps, { forceSpend: true }) };
}

export function startMetaAdsWorker(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => void tickMetaAds(), INTERVAL_MS);
  s.timer.unref?.();
}

export function stopMetaAdsWorker(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}
