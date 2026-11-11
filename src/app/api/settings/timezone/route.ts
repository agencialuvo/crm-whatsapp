import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { adoptDetectedTimezone } from "@/server/timezone";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ timezone: z.string().trim().min(1).max(64) });

/**
 * La primera vez que entra quien administra el negocio, el navegador informa su zona horaria (la del
 * país donde está) y se guarda como la del negocio, SOLO si nadie había elegido una. Después se
 * cambia en Ajustes → Negocio → Marca. `{ saved: false }` no es un error: ya había una elegida.
 */
export const POST = withAuth(async (session, req: Request) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  const saved = await adoptDetectedTimezone(session.organizationId, body.data.timezone);
  return Response.json({ saved });
});
