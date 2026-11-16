import { z } from "zod";
import { apiError, withAuth } from "@/lib/api";
import { PeriodError, periodFromRequest } from "@/server/analytics/period";
import { adsBlock } from "@/server/analytics/ads";

export const dynamic = "force-dynamic";

/** Una lista de ids de Meta (o `sin-identificar`) separada por comas: hasta 100, cada uno de 1 a 128 caracteres. */
const lista = z
  .string()
  .transform((v) => v.split(",").map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.string().min(1).max(128)).max(100));

/** 038 — Agrupar por campaña / conjunto / anuncio y filtrar. 040 — varios valores y llaves marcadas. */
const querySchema = z.object({
  group: z.enum(["ad", "adset", "campaign"]).default("ad"),
  campaignId: z.string().trim().min(1).max(128).optional(),
  adsetId: z.string().trim().min(1).max(128).optional(),
  campaignIds: lista.optional(),
  adsetIds: lista.optional(),
  selected: lista.optional(),
});

/**
 * 019 — De dónde llegan: conversaciones, prospectos y ventas por origen y por
 * anuncio. Con la Marketing API conectada (038, detrás de `ATRIBUCION`) suma la
 * jerarquía Campaña → Conjunto → Anuncio, el gasto y los costos.
 *
 * 040 — `campaignIds` y `adsetIds` filtran por la unión de varios valores (las casillas de la tabla);
 * `selected` son las llaves marcadas en la pestaña actual y solo cambian el Total.
 */
export const GET = withAuth(async (session, req: Request) => {
  try {
    const url = new URL(req.url);
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    const parsed = querySchema.safeParse({
      group: q("group"),
      campaignId: q("campaignId"),
      adsetId: q("adsetId"),
      campaignIds: q("campaignIds"),
      adsetIds: q("adsetIds"),
      selected: q("selected"),
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
        campaignIds: parsed.data.campaignIds ?? null,
        adsetIds: parsed.data.adsetIds ?? null,
        selected: parsed.data.selected ?? null,
      })
    );
  } catch (err) {
    if (err instanceof PeriodError) {
      return apiError(422, "invalid_period", err.message);
    }
    throw err;
  }
});
