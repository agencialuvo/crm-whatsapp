import { apiError, withAuth } from "@/lib/api";
import { atribucionDisabledResponse, atribucionEnabled } from "@/server/attribution/flag";
import { automationGate } from "@/server/automation/http";
import { listAdsets, listAds, listCampaigns, loadRoot, resolveOption, searchOptions } from "@/server/automation/ad-options";

export const dynamic = "force-dynamic";

/**
 * 047 — Las opciones del disparador «Llegó de un anuncio» (Campaña ▸ Conjunto ▸ Anuncio) desde el catálogo `meta_ad`.
 * Solo lectura y de la propia organización (la sesión la decide; nunca llega un `organizationId`). Mismo permiso que
 * editar automatizaciones; sin `ATRIBUCION` el catálogo no existe → 404.
 *
 *   (sin parámetros)        raíz: campañas + estado del catálogo (+ anuncios sueltos si no hay catálogo)
 *   ?campaignId=…           conjuntos de esa campaña
 *   ?adsetId=…              anuncios de ese conjunto
 *   ?q=…                    búsqueda plana (campañas, conjuntos y anuncios con su ruta)
 *   ?resolve=nivel:id       el nodo de un flujo ya guardado, con su nombre vivo
 *   &cursor=…               siguiente página
 */
export const GET = withAuth(async (session, req: Request) => {
  const denied = automationGate(session);
  if (denied) return denied;
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  const url = new URL(req.url);
  const org = session.organizationId;
  const cursor = url.searchParams.get("cursor");
  const campaignId = url.searchParams.get("campaignId");
  const adsetId = url.searchParams.get("adsetId");
  const q = url.searchParams.get("q");
  const resolve = url.searchParams.get("resolve");

  if (resolve) {
    const m = /^(ad|adset|campaign):(.{1,200})$/.exec(resolve);
    if (!m) return apiError(422, "invalid_resolve", "resolve debe ser ad:<id>, adset:<id> o campaign:<id>");
    return Response.json({ node: await resolveOption(org, m[1] as "ad" | "adset" | "campaign", m[2]!) });
  }
  if (q !== null) return Response.json({ items: await searchOptions(org, q), nextCursor: null });
  if (adsetId) return Response.json(await listAds(org, adsetId, cursor));
  if (campaignId) return Response.json(await listAdsets(org, campaignId, cursor));
  if (cursor) return Response.json(await listCampaigns(org, cursor));
  return Response.json(await loadRoot(org));
});
