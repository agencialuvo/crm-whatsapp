import { withAuth } from "@/lib/api";
import { creditSummary } from "@/server/saas/credits-summary";

export const dynamic = "force-dynamic";

/**
 * El saldo, la cuota, el consumo del periodo y lo que cuesta cada plantilla, de LA organización de la sesión (nunca de
 * otra). Cualquier miembro puede leerlo: lo usan las pantallas de envío para decir el costo antes de enviar. Con las
 * monedas apagadas responde `{ enabled: false }` sin tocar la base.
 */
export const GET = withAuth(async (session) => Response.json(await creditSummary(session.organizationId)));
