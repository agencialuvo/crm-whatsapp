import { asc, sql } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { checkStageRole } from "@/server/leads/stage-roles";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (session) => {
  const db = getDb();
  const stages = await db
    .select()
    .from(schema.pipelineStage)
    .where(scoped(schema.pipelineStage.organizationId, session.organizationId))
    .orderBy(asc(schema.pipelineStage.position));
  return Response.json({ stages });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** 044 — Papel en el avance automático (una etapa nueva es siempre abierta). */
  autoRole: z.enum(["new", "conversation", "interested"]).nullable().optional(),
});

export const POST = withAuth(async (session, req: Request) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const body = await parseBody(req, createSchema);
  if (!body.ok) return body.response;

  const problem = await checkStageRole(session.organizationId, { kind: "open" }, body.data.autoRole ?? null);
  if (problem) return apiError(problem.status, problem.code, problem.message);

  const db = getDb();
  const maxPos = await db
    .select({
      max: sql<number>`coalesce(max(${schema.pipelineStage.position}), -1)`,
    })
    .from(schema.pipelineStage)
    .where(scoped(schema.pipelineStage.organizationId, session.organizationId));

  const inserted = await db
    .insert(schema.pipelineStage)
    .values({
      id: newId("stage"),
      organizationId: session.organizationId,
      name: body.data.name,
      position: (maxPos[0]?.max ?? -1) + 1,
      kind: "open",
      autoRole: body.data.autoRole ?? null,
    })
    .returning();
  return Response.json({ stage: inserted[0] }, { status: 201 });
});
