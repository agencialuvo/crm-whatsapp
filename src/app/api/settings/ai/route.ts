import { apiError, parseBody, withAuth } from "@/lib/api";
import { chatCompletionsUrl } from "@/lib/ai/presets";
import { canConfigure } from "@/lib/auth/roles";
import { isMockEnabled } from "@/lib/env";
import { validatePublicHttpUrl } from "@/lib/net-guard";
import {
  AiCredentialError,
  deleteAiCredential,
  saveAiCredential,
} from "@/server/ai/credentials";
import {
  aiSettingsPutSchema,
  baseUrlEfectiva,
  vistaAjustesIa,
} from "@/server/ai/settings";

export const dynamic = "force-dynamic";

/**
 * Ajustes → IA: el proveedor, el modelo y la llave de ESTA organización
 * (issue #85). La llave nunca sale de aquí: la respuesta lleva sus últimos 4,
 * el estado y, si el entorno trae `OPENROUTER_*`, el respaldo que aplica
 * mientras no haya nada guardado.
 */

export const GET = withAuth(async (session) => {
  return Response.json(await vistaAjustesIa(session.organizationId));
});

export const PUT = withAuth(async (session, req: Request) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const body = await parseBody(req, aiSettingsPutSchema);
  if (!body.ok) return body.response;

  const baseUrl = baseUrlEfectiva(body.data.provider, body.data.baseUrl);
  // SSRF: el servidor hará la petición a esta dirección. Con los mocks habilitados (nunca en producción) se permite local.
  const urlError = validatePublicHttpUrl(chatCompletionsUrl(baseUrl), { allowLocal: isMockEnabled() });
  if (urlError) return apiError(422, "bad_url", urlError);

  try {
    await saveAiCredential({
      organizationId: session.organizationId,
      provider: body.data.provider,
      baseUrl,
      model: body.data.model,
      token: body.data.token,
    });
  } catch (err) {
    if (err instanceof AiCredentialError) {
      return apiError(422, err.code, err.message);
    }
    throw err;
  }
  return Response.json(await vistaAjustesIa(session.organizationId));
});

export const DELETE = withAuth(async (session) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  await deleteAiCredential(session.organizationId);
  return Response.json(await vistaAjustesIa(session.organizationId));
});
