import { apiError, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { buildPixelsPath, classifyGraphError, parsePixels, sanitizeError } from "@/lib/meta/ads";
import { graphRequest } from "@/lib/meta/client";
import { atribucionDisabledResponse, atribucionEnabled } from "@/server/attribution/flag";
import { getMetaAdsSettings } from "@/server/attribution/meta-ads/settings";

export const dynamic = "force-dynamic";

/**
 * 039 — Los datasets (píxeles) de la cuenta publicitaria, para elegir el de las conversiones en vez de
 * teclear su ID. Se lee con el token de la Marketing API ya guardado: el token NUNCA viaja al cliente.
 *
 * Es una ayuda, no un requisito: el dataset del canal de WhatsApp puede no aparecer en esta lista, y el
 * campo de ID a mano sigue existiendo. Un fallo de Meta responde con un mensaje legible y la pantalla se
 * queda con el campo manual.
 */
export const GET = withAuth(async (session) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const settings = await getMetaAdsSettings(session.organizationId);
  if (!settings) {
    return apiError(409, "sin_credenciales", "Conecta primero tu cuenta publicitaria para listar sus datasets");
  }
  try {
    const json = await graphRequest<unknown>(buildPixelsPath(settings.adAccountId), { token: settings.token });
    return Response.json({ pixels: parsePixels(json) });
  } catch (err) {
    if (err instanceof Error) {
      const problem = classifyGraphError(err);
      return apiError(422, `meta_${problem.kind}`, sanitizeError(`No se pudo leer la lista de datasets. ${problem.message}`).trim());
    }
    throw err;
  }
});
