import { apiError, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { atribucionDisabledResponse, atribucionEnabled } from "@/server/attribution/flag";
import { syncNow } from "@/server/attribution/meta-ads/worker";

export const dynamic = "force-dynamic";

/** 038 — «Sincronizar ahora». Con enfriamiento de 60 s por negocio. */
export const POST = withAuth(async (session) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const res = await syncNow(session.organizationId);
  if ("waitSeconds" in res) {
    return apiError(429, "enfriamiento", `Espera ${res.waitSeconds} s antes de sincronizar de nuevo`);
  }
  if (res.summary.skipped === "sin_credenciales") {
    return apiError(409, "sin_credenciales", "Conecta primero la cuenta publicitaria");
  }
  return Response.json({ ok: true, summary: res.summary });
});
