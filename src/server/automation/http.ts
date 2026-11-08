import { apiError } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import type { SessionContext } from "@/lib/auth/session";
import { automationsEnabled } from "@/server/automation/flag";

/**
 * Automatizaciones — lo común a sus route handlers (`route.ts` solo exporta handlers, así que la
 * guarda de entrada y la traducción de errores viven aquí). Mismo trato que el módulo SALON.
 */

/** Error esperado del dominio: lleva el código HTTP y un mensaje para la persona. */
export class AutomationError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422,
    message: string
  ) {
    super(message);
    this.name = "AutomationError";
  }
}

/**
 * Guarda de entrada. Devuelve la `Response` que corta la petición, o `null` si puede seguir.
 *
 * - Apagado (`AUTOMATIONS`) → 404: si la instancia no lo enciende, ese endpoint no existe.
 * - Configurar flujos que le escriben a clientes es del dueño o administrador, como el resto de
 *   Ajustes: un miembro del equipo recibe 403.
 */
export function automationGate(session: SessionContext): Response | null {
  if (!automationsEnabled()) return new Response(null, { status: 404 });
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  return null;
}

/** Errores esperados → respuesta con el contrato `{ error: { code, message } }`. Lo demás se relanza (500). */
export function automationErrorResponse(err: unknown): Response {
  if (err instanceof AutomationError) return apiError(err.status, err.code, err.message);
  throw err;
}
