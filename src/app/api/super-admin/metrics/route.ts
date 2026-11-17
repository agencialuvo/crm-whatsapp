import { withSuperAdmin } from "@/lib/auth/super-admin";
import { loadMetrics } from "@/server/super-admin/metrics";

export const dynamic = "force-dynamic";

/** El dashboard completo: totales por estado, plan × estado, conversión Demo → pago, MRR y altas. */
export const GET = withSuperAdmin(async () => Response.json(await loadMetrics()));
