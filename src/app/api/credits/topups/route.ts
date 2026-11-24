import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { startTopupPurchase } from "@/server/billing/credit-topup";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  packId: z.string().trim().min(1).max(64),
  /** Culqi EXIGE el teléfono del comprador (sin él rechaza la orden): solo dígitos con el código de país, de 7 a 14. */
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{7,14}$/, "Teléfono inválido: solo dígitos con el código de país, ej. 51999888777"),
});

/**
 * Comprar un paquete de monedas: crea la compra y la orden en Culqi y devuelve lo que el checkout necesita. Solo el
 * dueño de la cuenta (como los pagos de la suscripción), desde el propio sitio y con límite de tasa. Los paquetes
 * inactivos no se pueden comprar. Con `CREDITS` o `CULQI` apagadas no cobra nada. La organización sale SIEMPRE de la
 * sesión y el monto del paquete: el cuerpo no puede decidir ninguno de los dos.
 */
export const POST = withAuth(
  async (session, req: Request) => {
    if (session.role !== "owner") return apiError(403, "forbidden", "Solo el dueño de la cuenta puede comprar recargas");
    const origin = req.headers.get("origin");
    const base = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).origin : null;
    if (origin && base && origin !== base && origin !== new URL(req.url).origin) return apiError(403, "bad_origin", "Origen no permitido");
    const rate = checkRateLimit(`credit-topup:${session.organizationId}`, { windowMs: 60_000, max: 8 });
    if (!rate.allowed) return apiError(429, "rate_limited", "Demasiados intentos; espera un momento");

    const body = await parseBody(req, bodySchema);
    if (!body.ok) return body.response;
    const r = await startTopupPurchase({ organizationId: session.organizationId, userId: session.userId, packId: body.data.packId, phone: body.data.phone });
    if (!r.ok) return apiError(r.status, r.code, r.message);
    const { ok: _ok, ...purchase } = r;
    return Response.json(purchase, { status: 201 });
  },
  { allowInactive: true }
);
