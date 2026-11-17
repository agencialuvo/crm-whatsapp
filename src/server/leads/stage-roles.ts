import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type { AutoStageRole } from "@/lib/types";

/**
 * 044 — Reglas de qué rol puede llevar una etapa. Una etapa ganada solo puede ser «Cliente»; una perdida
 * no recibe movimientos automáticos; una abierta puede ser Nuevo, En conversación o Interesado. Cada rol es
 * de UNA etapa por negocio (lo sostiene un índice único; aquí se explica con palabras antes de chocar con él).
 */
export const OPEN_ROLES: readonly AutoStageRole[] = ["new", "conversation", "interested"];

export type RoleProblem = { status: 409 | 422; code: "invalid_role" | "role_taken"; message: string };

export async function checkStageRole(
  organizationId: string,
  stage: { id?: string; kind: "open" | "won" | "lost" },
  role: AutoStageRole | null
): Promise<RoleProblem | null> {
  if (role === null) return null;
  if (stage.kind === "lost") {
    return { status: 422, code: "invalid_role", message: "Una etapa perdida no recibe movimientos automáticos" };
  }
  if (stage.kind === "won" && role !== "client") {
    return { status: 422, code: "invalid_role", message: "Una etapa ganada solo puede ser «Cliente»" };
  }
  if (stage.kind === "open" && !OPEN_ROLES.includes(role)) {
    return { status: 422, code: "invalid_role", message: "«Cliente» solo puede ser una etapa ganada" };
  }
  const taken = await getDb()
    .select({ id: schema.pipelineStage.id, name: schema.pipelineStage.name })
    .from(schema.pipelineStage)
    .where(
      scoped(
        schema.pipelineStage.organizationId,
        organizationId,
        and(eq(schema.pipelineStage.autoRole, role), stage.id ? ne(schema.pipelineStage.id, stage.id) : undefined)
      )
    )
    .limit(1);
  if (taken[0]) {
    return {
      status: 409,
      code: "role_taken",
      message: `La etapa «${taken[0].name}» ya tiene ese papel. Quítaselo primero.`,
    };
  }
  return null;
}
