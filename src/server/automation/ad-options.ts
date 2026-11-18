import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  adThumbUrl,
  decodeCursor,
  encodeCursor,
  type AdNode,
  type AdOptionsMeta,
  type AdOptionsPage,
  type AdOptionsRoot,
  type AdsetNode,
  type CampaignNode,
  type LooseAd,
  type PickerNode,
} from "@/lib/ad-picker";
import { normalizeText } from "@/lib/search";
import { hasMetaAdsSettings } from "@/server/attribution/meta-ads/settings";
import { UNACCENT_FROM, UNACCENT_TO } from "@/server/search-sql";

/**
 * 047 — Las opciones del selector del disparador «Llegó de un anuncio»: el catálogo `meta_ad` (el mismo que alimenta
 * Resultados y Ajustes → Anuncios) como árbol Campaña ▸ Conjunto ▸ Anuncio, PEREZOSO por nivel y con cursor, para
 * que una cuenta con miles de anuncios no se baje de golpe.
 *
 * Los nombres se leen del catálogo EN CADA PETICIÓN: nunca hay una copia que se desfase (lo que se vea es lo último
 * que el CRM sincronizó con Meta). La miniatura es la copia LOCAL del creativo (`/api/medios/<id>/archivo`), jamás
 * una URL de Meta (caducan y filtran un tercero). Todo va acotado a UNA organización; nada llama a Meta.
 */

export const PAGE_SIZE = 50;
export const MIN_SEARCH_CHARS = 2;

type Row = Record<string, unknown>;

const run = async (q: SQL): Promise<Row[]> => [...(await getDb().execute(q))] as Row[];

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

/** Un anuncio entra al árbol si la cuenta todavía lo lista (vincular un flujo a uno borrado no serviría). */
const LISTED = sql`status = 'synced' and listed_at is not null`;

const norm = (col: SQL | string) => sql`lower(translate(coalesce(${typeof col === "string" ? sql.raw(col) : col}, ''), ${UNACCENT_FROM}, ${UNACCENT_TO}))`;
const likeOf = (q: string) => `%${normalizeText(q).replace(/[\\%_]/g, "\\$&")}%`;

const rankOfActive = (activeExpr: SQL) => sql`(case when ${activeExpr} then 0 else 1 end)`;

/* ---------- Niveles ---------- */

export async function listCampaigns(organizationId: string, cursor: string | null): Promise<AdOptionsPage> {
  const c = decodeCursor(cursor);
  const rank = rankOfActive(sql`bool_or(effective_status = 'ACTIVE')`);
  const rows = await run(sql`
    select campaign_id as id, max(campaign_name) as name, count(*)::int as ad_count,
           count(distinct adset_id)::int as adset_count, coalesce(bool_or(effective_status = 'ACTIVE'), false) as active,
           ${rank} as r, lower(coalesce(max(campaign_name), '')) as n
    from meta_ad
    where organization_id = ${organizationId} and ${LISTED} and campaign_id is not null
    group by campaign_id
    having ${c ? sql`(${rank}, lower(coalesce(max(campaign_name), '')), campaign_id) > (${c.r}::int, ${c.n}::text, ${c.id}::text)` : sql`true`}
    order by r, n, campaign_id
    limit ${PAGE_SIZE + 1}`);
  return page(rows, (r): CampaignNode => ({
    level: "campaign",
    id: String(r.id),
    name: str(r.name),
    adsetCount: num(r.adset_count),
    adCount: num(r.ad_count),
    active: r.active === true,
  }));
}

export async function listAdsets(organizationId: string, campaignId: string, cursor: string | null): Promise<AdOptionsPage> {
  const c = decodeCursor(cursor);
  const rank = rankOfActive(sql`bool_or(effective_status = 'ACTIVE')`);
  const rows = await run(sql`
    select adset_id as id, max(adset_name) as name, max(campaign_id) as campaign_id, max(campaign_name) as campaign_name,
           count(*)::int as ad_count, coalesce(bool_or(effective_status = 'ACTIVE'), false) as active,
           ${rank} as r, lower(coalesce(max(adset_name), '')) as n
    from meta_ad
    where organization_id = ${organizationId} and ${LISTED} and campaign_id = ${campaignId} and adset_id is not null
    group by adset_id
    having ${c ? sql`(${rank}, lower(coalesce(max(adset_name), '')), adset_id) > (${c.r}::int, ${c.n}::text, ${c.id}::text)` : sql`true`}
    order by r, n, adset_id
    limit ${PAGE_SIZE + 1}`);
  return page(rows, (r): AdsetNode => ({
    level: "adset",
    id: String(r.id),
    name: str(r.name),
    campaignId: str(r.campaign_id),
    campaignName: str(r.campaign_name),
    adCount: num(r.ad_count),
    active: r.active === true,
  }));
}

const AD_COLUMNS = sql`ad_id as id, ad_name as name, adset_id, adset_name, campaign_id, campaign_name, effective_status as status, creative_asset_id`;
const adNode = (r: Row): AdNode => ({
  level: "ad",
  id: String(r.id),
  name: str(r.name),
  adsetId: str(r.adset_id),
  adsetName: str(r.adset_name),
  campaignId: str(r.campaign_id),
  campaignName: str(r.campaign_name),
  status: str(r.status),
  thumbUrl: adThumbUrl(str(r.creative_asset_id)),
});

export async function listAds(organizationId: string, adsetId: string, cursor: string | null): Promise<AdOptionsPage> {
  const c = decodeCursor(cursor);
  const rank = rankOfActive(sql`effective_status = 'ACTIVE'`);
  const rows = await run(sql`
    select ${AD_COLUMNS}, ${rank} as r, lower(coalesce(ad_name, '')) as n
    from meta_ad
    where organization_id = ${organizationId} and ${LISTED} and adset_id = ${adsetId}
      ${c ? sql`and (${rank}, lower(coalesce(ad_name, '')), ad_id) > (${c.r}::int, ${c.n}::text, ${c.id}::text)` : sql``}
    order by r, n, ad_id
    limit ${PAGE_SIZE + 1}`);
  return page(rows, adNode);
}

function page<T extends PickerNode>(rows: Row[], map: (r: Row) => T): AdOptionsPage {
  const more = rows.length > PAGE_SIZE;
  const slice = rows.slice(0, PAGE_SIZE);
  const last = slice[slice.length - 1];
  return {
    items: slice.map(map),
    nextCursor: more && last ? encodeCursor({ r: num(last.r), n: String(last.n ?? ""), id: String(last.id) }) : null,
  };
}

/* ---------- Búsqueda y resolución ---------- */

/** Búsqueda plana (nombre sin acentos ni mayúsculas, o ID): campañas, conjuntos y anuncios con su ruta. */
export async function searchOptions(organizationId: string, q: string): Promise<PickerNode[]> {
  const text = q.trim();
  if (text.length < MIN_SEARCH_CHARS) return [];
  const like = likeOf(text);
  const raw = text;
  const campaigns = await run(sql`
    select campaign_id as id, max(campaign_name) as name, count(*)::int as ad_count, count(distinct adset_id)::int as adset_count,
           coalesce(bool_or(effective_status = 'ACTIVE'), false) as active
    from meta_ad where organization_id = ${organizationId} and ${LISTED} and campaign_id is not null
    group by campaign_id
    having ${norm(sql`max(campaign_name)`)} like ${like} or campaign_id = ${raw}
    order by 5 desc, 2 limit 8`);
  const adsets = await run(sql`
    select adset_id as id, max(adset_name) as name, max(campaign_id) as campaign_id, max(campaign_name) as campaign_name,
           count(*)::int as ad_count, coalesce(bool_or(effective_status = 'ACTIVE'), false) as active
    from meta_ad where organization_id = ${organizationId} and ${LISTED} and adset_id is not null
    group by adset_id
    having ${norm(sql`max(adset_name)`)} like ${like} or adset_id = ${raw}
    order by 6 desc, 2 limit 8`);
  const ads = await run(sql`
    select ${AD_COLUMNS}
    from meta_ad
    where organization_id = ${organizationId} and ${LISTED}
      and (${norm("ad_name")} like ${like} or ${norm("adset_name")} like ${like} or ${norm("campaign_name")} like ${like} or ad_id = ${raw})
    order by (case when effective_status = 'ACTIVE' then 0 else 1 end), lower(coalesce(ad_name, '')), ad_id
    limit 30`);
  return [
    ...campaigns.map((r): CampaignNode => ({ level: "campaign", id: String(r.id), name: str(r.name), adsetCount: num(r.adset_count), adCount: num(r.ad_count), active: r.active === true })),
    ...adsets.map((r): AdsetNode => ({ level: "adset", id: String(r.id), name: str(r.name), campaignId: str(r.campaign_id), campaignName: str(r.campaign_name), adCount: num(r.ad_count), active: r.active === true })),
    ...ads.map(adNode),
  ];
}

/**
 * El nodo de un flujo ya guardado, con su nombre VIVO. Cuenta cualquier anuncio sincronizado (aunque la cuenta ya no
 * lo liste): un flujo atado a un anuncio pausado o archivado se sigue mostrando con su nombre. null si no está.
 */
export async function resolveOption(organizationId: string, level: "ad" | "adset" | "campaign", id: string): Promise<PickerNode | null> {
  if (level === "campaign") {
    const [r] = await run(sql`
      select campaign_id as id, max(campaign_name) as name, count(*)::int as ad_count, count(distinct adset_id)::int as adset_count,
             coalesce(bool_or(effective_status = 'ACTIVE'), false) as active
      from meta_ad where organization_id = ${organizationId} and status = 'synced' and campaign_id = ${id} group by campaign_id`);
    return r ? { level: "campaign", id: String(r.id), name: str(r.name), adsetCount: num(r.adset_count), adCount: num(r.ad_count), active: r.active === true } : null;
  }
  if (level === "adset") {
    const [r] = await run(sql`
      select adset_id as id, max(adset_name) as name, max(campaign_id) as campaign_id, max(campaign_name) as campaign_name,
             count(*)::int as ad_count, coalesce(bool_or(effective_status = 'ACTIVE'), false) as active
      from meta_ad where organization_id = ${organizationId} and status = 'synced' and adset_id = ${id} group by adset_id`);
    return r ? { level: "adset", id: String(r.id), name: str(r.name), campaignId: str(r.campaign_id), campaignName: str(r.campaign_name), adCount: num(r.ad_count), active: r.active === true } : null;
  }
  const [r] = await run(sql`select ${AD_COLUMNS} from meta_ad where organization_id = ${organizationId} and status = 'synced' and ad_id = ${id} limit 1`);
  return r ? adNode(r) : null;
}

/* ---------- Raíz: campañas + estado del catálogo ---------- */

export async function loadMeta(organizationId: string): Promise<AdOptionsMeta> {
  const [row] = await run(sql`
    select count(*)::int as n, max(synced_at) as synced_at
    from meta_ad where organization_id = ${organizationId} and ${LISTED}`);
  const synced = row?.synced_at;
  return {
    connector: await hasMetaAdsSettings(organizationId).catch(() => false),
    hasCatalog: num(row?.n) > 0,
    syncedAt: synced instanceof Date ? synced.toISOString() : typeof synced === "string" ? new Date(synced).toISOString() : null,
  };
}

/** Sin catálogo: los anuncios que ya trajeron gente (titular del primer mensaje), para elegir «Un anuncio» como hoy. */
export async function listLooseAds(organizationId: string): Promise<LooseAd[]> {
  const rows = await run(sql`
    select source_id, (array_agg(headline order by created_at desc))[1] as headline
    from ad_attribution where organization_id = ${organizationId} and source_id is not null
    group by source_id order by max(created_at) desc limit 100`);
  return rows.map((r) => ({ adId: String(r.source_id), headline: str(r.headline) }));
}

export async function loadRoot(organizationId: string): Promise<AdOptionsRoot> {
  const meta = await loadMeta(organizationId);
  const first = meta.hasCatalog ? await listCampaigns(organizationId, null) : { items: [], nextCursor: null };
  return { ...first, meta, loose: meta.hasCatalog ? [] : await listLooseAds(organizationId) };
}
