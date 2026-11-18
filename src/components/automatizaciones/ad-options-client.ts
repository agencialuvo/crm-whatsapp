import type { AdOptionsPage, AdOptionsRoot, PickerNode } from "@/lib/ad-picker";
import { adScopeOf, type AdReferralConfig } from "@/lib/automation";
import { apiFetch } from "@/components/negocio/api";

/**
 * 047 — El cliente de `/api/automations/ad-options` y de la sincronización manual. Una sola forma de pedir; el
 * nombre vivo de lo elegido se guarda unos segundos en memoria para no repetir la consulta al abrir y cerrar.
 */

const BASE = "/api/automations/ad-options";

export const fetchRoot = () => apiFetch<AdOptionsRoot>(BASE);

export const fetchMoreRoot = (cursor: string) => apiFetch<AdOptionsPage>(`${BASE}?cursor=${encodeURIComponent(cursor)}`);

export function fetchChildren(parent: Pick<PickerNode, "level" | "id">, cursor: string | null): Promise<AdOptionsPage> {
  const key = parent.level === "campaign" ? "campaignId" : "adsetId";
  const qs = new URLSearchParams({ [key]: parent.id });
  if (cursor) qs.set("cursor", cursor);
  return apiFetch<AdOptionsPage>(`${BASE}?${qs.toString()}`);
}

export const fetchSearch = (q: string, signal?: AbortSignal) =>
  apiFetch<{ items: PickerNode[] }>(`${BASE}?q=${encodeURIComponent(q)}`, { signal });

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; node: PickerNode | null }>();

/** Lo que el catálogo sabe HOY de lo elegido en un flujo (nombre vivo). null si no está (aún no sincronizado). */
export async function fetchResolved(cfg: AdReferralConfig, force = false): Promise<PickerNode | null> {
  const { level, id } = adScopeOf(cfg);
  if (level === "any" || !id) return null;
  const key = `${level}:${id}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.node;
  const r = await apiFetch<{ node: PickerNode | null }>(`${BASE}?resolve=${encodeURIComponent(key)}`);
  cache.set(key, { at: Date.now(), node: r.node });
  return r.node;
}

export const clearResolvedCache = () => cache.clear();

/** «Actualizar desde Meta»: la sincronización manual del catálogo (enfriamiento de 60 s por negocio). */
export const syncCatalogNow = () => apiFetch<{ ok: true }>("/api/settings/meta-ads/sync", { method: "POST" });
