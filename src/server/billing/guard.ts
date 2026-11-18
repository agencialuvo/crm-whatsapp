import { apiError, withAuth } from "@/lib/api";
import type { SessionContext } from "@/lib/auth/session";
import { billingEnabled } from "@/lib/mercadopago/config";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * 046 — La puerta de las rutas `/api/billing/*`: bandera apagada → 404 (indistinguible de una ruta inexistente);
 * sesión obligatoria y SIN el corte por suscripción (quien está bloqueado es quien más necesita pagar); las
 * mutaciones exigen rol dueño, origen del propio sitio y límite de tasa. La organización sale SIEMPRE de la sesión.
 */
export function withBilling<Args extends unknown[]>(
  handler: (session: SessionContext, req: Request, ...args: Args) => Promise<Response>,
  opts: { mutation?: boolean } = {}
): (req: Request, ...args: Args) => Promise<Response> {
  return async (req: Request, ...args: Args) => {
    if (!billingEnabled()) return new Response(null, { status: 404 });
    const wrapped = withAuth(
      async (session: SessionContext) => {
        if (opts.mutation) {
          if (session.role !== "owner") return apiError(403, "forbidden", "Solo el dueño de la cuenta puede gestionar el pago");
          const origin = req.headers.get("origin");
          const base = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).origin : null;
          if (origin && base && origin !== base && origin !== new URL(req.url).origin) return apiError(403, "bad_origin", "Origen no permitido");
          const rate = checkRateLimit(`billing:${session.organizationId}`, { windowMs: 60_000, max: 8 });
          if (!rate.allowed) return apiError(429, "rate_limited", "Demasiados intentos; espera un momento");
        }
        return handler(session, req, ...args);
      },
      { allowInactive: true }
    );
    return wrapped();
  };
}
