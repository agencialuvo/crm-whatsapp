import { withAuth } from "@/lib/api";
import { activePacks } from "@/server/saas/credits-summary";

export const dynamic = "force-dynamic";

/**
 * Los paquetes de recarga que un cliente puede comprar (solo los ACTIVOS, sin orden interno ni fechas). Cualquier
 * miembro autenticado puede verlos; comprarlos llega en el siguiente sub-paso. Con las monedas apagadas responde
 * `{ enabled: false, packs: [] }` sin tocar la base.
 */
export const GET = withAuth(async () => Response.json(await activePacks()));
