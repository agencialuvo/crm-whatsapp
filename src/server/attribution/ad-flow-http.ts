import { apiError } from "@/lib/api";
import { AdFlowError } from "@/server/attribution/ad-flow";

/**
 * Enrutamiento por anuncio — la traducción de errores de sus route handlers. Aparte de `ad-flow.ts` a
 * propósito: `@/lib/api` arrastra la sesión de Better Auth, y `ad-flow.ts` lo carga el camino del agente
 * y el de la ingesta, que no deben cargarla.
 */

/** Errores esperados → respuesta con el contrato `{ error: { code, message } }`. Lo demás se relanza (500). */
export function adFlowErrorResponse(err: unknown): Response {
  if (err instanceof AdFlowError) return apiError(err.status, err.code, err.message);
  throw err;
}
