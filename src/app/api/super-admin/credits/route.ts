import { apiError, parseBody } from "@/lib/api";
import { withSuperAdmin } from "@/lib/auth/super-admin";
import { creditsReportQuerySchema, creditsRootActionSchema } from "@/lib/super-admin-credits";
import { creditsOverview, reconcileNow } from "@/server/super-admin/credits";

export const dynamic = "force-dynamic";

/**
 * Reporte de calibración de monedas (solo lectura): consumo por organización y servicio (IA / WhatsApp), estado de
 * cuota y saldo, y los `wouldCut` del modo sombra. Es de TODAS las organizaciones: solo Super Admin.
 */
export const GET = withSuperAdmin(async (_admin, req) => {
  const q = creditsReportQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return apiError(422, "invalid_query", "Rango inválido (days: 1–365)");
  return Response.json(await creditsOverview(q.data.days));
});

/** Conciliar ahora el saldo contra el libro (`repair` reescribe la caché desde el libro). */
export const POST = withSuperAdmin(async (_admin, req) => {
  const body = await parseBody(req, creditsRootActionSchema);
  if (!body.ok) return body.response;
  const state = await reconcileNow(body.data.repair === true);
  if (!state) return apiError(409, "credits_off", "Las monedas están apagadas en esta instancia (CREDITS).");
  return Response.json({ reconcile: state });
});
