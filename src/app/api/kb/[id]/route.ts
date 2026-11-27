import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { kbChangeError } from "@/server/ai/kb-limit";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  question: z.string().trim().min(1).max(500).optional(),
  answer: z.string().trim().min(1).max(4000).optional(),
  content: z.string().trim().min(1).max(8000).optional(),
});

export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  // Mejora 9 — Cambiar lo que sabe o cómo se prueba el agente es de quien configura, no de quien atiende.
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede cambiar el conocimiento del agente");
  }
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  // Mejora 5 — Una edición que agranda el conocimiento por encima del tope se rechaza; achicarlo siempre se puede.
  const limite = await kbChangeError(session.organizationId, { edit: { id, patch: body.data } });
  if (limite) return apiError(422, "kb_limit", limite);

  const db = getDb();
  const updated = await db
    .update(schema.kbEntry)
    .set({ ...body.data, updatedAt: new Date() })
    .where(
      scoped(
        schema.kbEntry.organizationId,
        session.organizationId,
        eq(schema.kbEntry.id, id)
      )
    )
    .returning();
  if (!updated[0]) return apiError(404, "not_found", "Entrada no encontrada");
  return Response.json({ entry: updated[0] });
});

export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  // Mejora 9 — Cambiar lo que sabe o cómo se prueba el agente es de quien configura, no de quien atiende.
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede cambiar el conocimiento del agente");
  }
  const { id } = await ctx.params;
  const db = getDb();
  const deleted = await db
    .delete(schema.kbEntry)
    .where(
      scoped(
        schema.kbEntry.organizationId,
        session.organizationId,
        eq(schema.kbEntry.id, id)
      )
    )
    .returning();
  if (!deleted[0]) return apiError(404, "not_found", "Entrada no encontrada");
  return Response.json({ deleted: true });
});
