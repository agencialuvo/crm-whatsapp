import { z } from "zod";
import { apiError, withAuth } from "@/lib/api";
import { NOTIFICATION_FILTERS } from "@/lib/notifications";
import { listNotifications } from "@/server/notifications/service";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  filtro: z.enum(NOTIFICATION_FILTERS).default("todas"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(5000).default(0),
});

/**
 * Las notificaciones de la organización de quien pregunta (la campanita pide 5; la
 * página pide de 20 en 20). Quien no es dueño ni administrador no ve las de ventas.
 */
export const GET = withAuth(async (session, req: Request) => {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const query = querySchema.safeParse(params);
  if (!query.success) {
    return apiError(422, "invalid_query", query.error.issues[0]?.message ?? "Consulta no válida");
  }
  const { filtro, limit, offset } = query.data;
  return Response.json(
    await listNotifications(session.organizationId, session.role, { filter: filtro, limit, offset })
  );
});
