import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { SECTOR_KEY_PATTERN } from "@/lib/business-sector";
import { chooseSector, skipSectorSetup } from "@/server/business/sector-setup";

export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("choose"), categoryKey: z.string().trim().regex(SECTOR_KEY_PATTERN) }),
  z.object({ action: z.literal("skip") }),
]);

/**
 * El sector del negocio: elegirlo (`choose`) o dejarlo para después (`skip`). Solo el propietario o un
 * administrador: cambia qué módulos trae el plan inicial.
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  if (body.data.action === "skip") {
    await skipSectorSetup(session.organizationId);
    return Response.json({ ok: true });
  }
  const result = await chooseSector(session.organizationId, body.data.categoryKey);
  if (!result.ok) {
    return apiError(422, "invalid_sector", "Ese tipo de negocio no existe. Elige uno de la lista.");
  }
  return Response.json({
    ok: true,
    categoryKey: result.categoryKey,
    planSlug: result.planSlug,
    planChanged: result.planChanged,
  });
});
