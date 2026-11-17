import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { checkStageRole } from "@/server/leads/stage-roles";
import { relocateLeadsFromStage } from "@/server/leads/stage-history";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  position: z.number().int().min(0).optional(),
  /** 044 — Papel en el avance automático; `null` lo quita. */
  autoRole: z.enum(["new", "conversation", "interested", "client"]).nullable().optional(),
});

export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  if (body.data.autoRole !== undefined) {
    const found = await db
      .select({ id: schema.pipelineStage.id, kind: schema.pipelineStage.kind })
      .from(schema.pipelineStage)
      .where(scoped(schema.pipelineStage.organizationId, session.organizationId, eq(schema.pipelineStage.id, id)))
      .limit(1);
    if (!found[0]) return apiError(404, "not_found", "Etapa no encontrada");
    const problem = await checkStageRole(session.organizationId, found[0], body.data.autoRole);
    if (problem) return apiError(problem.status, problem.code, problem.message);
  }
  const updated = await db
    .update(schema.pipelineStage)
    .set({
      ...(body.data.autoRole !== undefined ? { autoRole: body.data.autoRole } : {}),
      ...(body.data.name !== undefined ? { name: body.data.name } : {}),
      ...(body.data.position !== undefined
        ? { position: body.data.position }
        : {}),
    })
    .where(
      scoped(
        schema.pipelineStage.organizationId,
        session.organizationId,
        eq(schema.pipelineStage.id, id)
      )
    )
    .returning();
  if (!updated[0]) return apiError(404, "not_found", "Etapa no encontrada");
  return Response.json({ stage: updated[0] });
});

export const DELETE = withAuth(async (session, req: Request, ctx: Params) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const moveTo = url.searchParams.get("moveTo");

  const db = getDb();
  const rows = await db
    .select()
    .from(schema.pipelineStage)
    .where(
      scoped(
        schema.pipelineStage.organizationId,
        session.organizationId,
        eq(schema.pipelineStage.id, id)
      )
    )
    .limit(1);
  const stage = rows[0];
  if (!stage) return apiError(404, "not_found", "Etapa no encontrada");
  if (stage.kind !== "open") {
    return apiError(
      409,
      "anchor_stage",
      'Las etapas ancla ("ganado" y "perdido") no se pueden eliminar'
    );
  }

  const leadsInStage = await db
    .select({ n: count() })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        session.organizationId,
        eq(schema.lead.stageId, id)
      )
    );
  const n = leadsInStage[0]?.n ?? 0;

  if (n > 0) {
    if (!moveTo) {
      return apiError(
        409,
        "stage_has_leads",
        "La etapa tiene tarjetas: indica ?moveTo=<etapa destino> para reasignarlas"
      );
    }
    const dest = await db
      .select({ id: schema.pipelineStage.id })
      .from(schema.pipelineStage)
      .where(
        scoped(
          schema.pipelineStage.organizationId,
          session.organizationId,
          eq(schema.pipelineStage.id, moveTo)
        )
      )
      .limit(1);
    if (!dest[0] || moveTo === id) {
      return apiError(422, "invalid_move_to", "Etapa destino inválida");
    }
    // Por la puerta única, un evento por lead: el embudo debe poder explicar
    // por qué treinta tarjetas cambiaron de columna el mismo minuto.
    await relocateLeadsFromStage({
      organizationId: session.organizationId,
      fromStageId: id,
      toStageId: moveTo,
      actorUserId: session.userId,
    });
  }

  await db
    .delete(schema.pipelineStage)
    .where(
      scoped(
        schema.pipelineStage.organizationId,
        session.organizationId,
        eq(schema.pipelineStage.id, id)
      )
    );
  return Response.json({ deleted: true, movedLeads: n });
});
