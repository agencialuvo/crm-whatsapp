import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { classifyGraphError, normalizeAdAccountId } from "@/lib/meta/ads";
import { MetaApiError } from "@/lib/meta/client";
import { atribucionDisabledResponse, atribucionEnabled } from "@/server/attribution/flag";
import { countsByStatus, enqueueAllFromAttributions } from "@/server/attribution/meta-ads/catalog";
import {
  deleteMetaAdsSettings,
  fetchAccountInfo,
  getMetaAdsSettings,
  getMetaAdsView,
  saveMetaAdsSettings,
} from "@/server/attribution/meta-ads/settings";
import { syncOrganization } from "@/server/attribution/meta-ads/sync";

export const dynamic = "force-dynamic";

/**
 * 038 — La cuenta publicitaria del negocio para la Marketing API.
 *
 * Sin la bandera `ATRIBUCION` esto no existe (404). El token nunca sale: solo sus últimos 4.
 */

export const GET = withAuth(async (session) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  const counts = await countsByStatus(session.organizationId);
  return Response.json({ metaAds: await getMetaAdsView(session.organizationId, counts) });
});

const putSchema = z.object({
  /** `act_123…` o el número solo. */
  adAccountId: z.string().trim().min(1),
  /** Omitirlo conserva el ya guardado (para cambiar solo la cuenta). */
  token: z.string().trim().min(1).optional(),
});

export const PUT = withAuth(async (session, req: Request) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  const adAccountId = normalizeAdAccountId(body.data.adAccountId);
  if (!adAccountId) {
    return apiError(422, "cuenta_invalida", "El ID de la cuenta publicitaria son solo números (por ejemplo 1234567890 o act_1234567890)");
  }

  let token = body.data.token;
  if (!token) {
    token = (await getMetaAdsSettings(session.organizationId))?.token;
    if (!token) return apiError(422, "token_requerido", "Pega el token de la API de Marketing de Meta");
  }

  // Guardar = probar: un token que Meta rechaza no se guarda.
  let info: { name: string | null; currency: string | null; timezone: string | null };
  try {
    info = await fetchAccountInfo(adAccountId, token);
  } catch (err) {
    if (err instanceof MetaApiError || err instanceof Error) {
      const problem = classifyGraphError(err);
      const explicacion =
        problem.kind === "auth"
          ? "Meta rechazó el token (vencido o inválido)."
          : problem.kind === "permission"
            ? "El token no tiene el permiso ads_read o no ve esa cuenta publicitaria."
            : problem.kind === "rate_limit"
              ? "Meta pidió esperar un poco (límite de uso). Intenta de nuevo en unos minutos."
              : "No se pudo consultar la cuenta en Meta.";
      return apiError(422, `meta_${problem.kind}`, `${explicacion} ${problem.message}`.trim());
    }
    throw err;
  }

  await saveMetaAdsSettings({
    organizationId: session.organizationId,
    adAccountId,
    token,
    accountName: info.name,
    currency: info.currency,
    timezone: info.timezone,
  });
  // Se recupera la historia: los anuncios que ya trajeron gente entran a la cola. Fuera de la respuesta.
  await enqueueAllFromAttributions(session.organizationId);
  void syncOrganization(session.organizationId, undefined, { forceSpend: true });

  return Response.json({ ok: true, accountName: info.name, currency: info.currency });
});

export const DELETE = withAuth(async (session) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  await deleteMetaAdsSettings(session.organizationId);
  return Response.json({ ok: true });
});
