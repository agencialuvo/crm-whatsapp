import { z } from "zod";
import { apiError, withAuth } from "@/lib/api";
import { PeriodError, periodFromRequest } from "@/server/analytics/period";
import { adsBlock } from "@/server/analytics/ads";

export const dynamic = "force-dynamic";

/** 038 — Agrupar por campaña / conjunto / anuncio y filtrar. Ids de Meta o `sin-identificar`. */
const querySchema = z.object({
  group: z.enum(["ad", "adset", "campaign"]).default("ad"),
  campaignId: z.string().trim().min(1).max(128).optional(),
  adsetId: z.string().trim().min(1).max(128).optional(),
});

/**
 * 019 — De dónde llegan: conversaciones, prospectos y ventas por origen y por
 * anuncio. Con la Marketing API conectada (038, detrás de `ATRIBUCION`) suma la
 * jerarquía Campaña → Conjunto → Anuncio, el gasto y los costos.
 */
export const GET = withAuth(async (session, req: Request) => {
  try {
    const url = new URL(req.url);
    const parsed = querySchema.safeParse({
      group: url.searchParams.get("group") ?? undefined,
      campaignId: url.searchParams.get("campaignId") ?? undefined,
      adsetId: url.searchParams.get("adsetId") ?? undefined,
    });
    if (!parsed.success) {
      return apiError(422, "invalid_query", "Agrupación o filtro inválido");
    }
    const period = await periodFromRequest(session.organizationId, url);
    return Response.json(
      await adsBlock(session.organizationId, period, {
        group: parsed.data.group,
        campaignId: parsed.data.campaignId ?? null,
        adsetId: parsed.data.adsetId ?? null,
      })
    );
  } catch (err) {
    if (err instanceof PeriodError) {
      return apiError(422, "invalid_period", err.message);
    }
    throw err;
  }
});
