import { desc } from "drizzle-orm";
import { z } from "zod";
import { apiError, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isAiConfiguredFor } from "@/lib/ai/provider";
import { RunConflictError, RunLimitError, startRun } from "@/server/lab/runner";
import { atribucionEnabled } from "@/server/attribution/flag";
import { findActiveAdFlowById } from "@/server/attribution/ad-flow";

export const dynamic = "force-dynamic";

/** Historial de corridas con delta de score vs la anterior (FR-033). */
export const GET = withAuth(async (session) => {
  const db = getDb();
  const runs = await db
    .select()
    .from(schema.agentTestRun)
    .where(scoped(schema.agentTestRun.organizationId, session.organizationId))
    .orderBy(desc(schema.agentTestRun.startedAt))
    .limit(50);

  const withDelta = runs.map((run, i) => {
    // Bloque 2 — Se compara con la corrida anterior del MISMO tipo (mismo anuncio, o ninguna de anuncio).
    const prev = runs
      .slice(i + 1)
      .find((r) => r.status === "done" && r.score !== null && r.adSourceId === run.adSourceId);
    return {
      id: run.id,
      status: run.status,
      score: run.score,
      error: run.error,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      // Bloque 2 — Corrida de anuncio: qué anuncio se simuló (copia: el flujo pudo borrarse después).
      ad: run.adSourceId ? { flowId: run.adFlowId, sourceId: run.adSourceId, headline: run.adHeadline } : null,
      delta:
        run.status === "done" && run.score !== null && prev?.score != null
          ? run.score - prev.score
          : null,
    };
  });
  return Response.json({
    runs: withDelta,
    aiConfigured: await isAiConfiguredFor(session.organizationId),
  });
});

/** Bloque 2 — Cuerpo OPCIONAL: sin él (o vacío) es una corrida normal. */
const postSchema = z
  .object({ adFlowId: z.string().trim().min(1).max(64).nullish() })
  .strict();

export const POST = withAuth(async (session, req: Request) => {
  // Mejora 9 — Cambiar lo que sabe o cómo se prueba el agente es de quien configura, no de quien atiende.
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede correr el Laboratorio");
  }
  if (!(await isAiConfiguredFor(session.organizationId))) {
    return apiError(
      409,
      "ai_not_configured",
      "Configura tu proveedor de IA en Ajustes → IA para correr el Laboratorio"
    );
  }
  const texto = await req.text().catch(() => "");
  let crudo: unknown = {};
  try {
    crudo = texto.trim() ? JSON.parse(texto) : {};
  } catch {
    return apiError(422, "invalid", "El cuerpo no es JSON válido");
  }
  const body = postSchema.safeParse(crudo);
  if (!body.success) return apiError(422, "invalid", "Datos inválidos para la corrida");

  // Bloque 2 — Corrida «de anuncio»: el flujo tiene que existir, estar activo y ser de esta organización.
  let anuncio: { flowId: string; sourceId: string; headline: string | null } | null = null;
  if (body.data.adFlowId) {
    if (!atribucionEnabled()) {
      return apiError(422, "atribucion_off", "El enrutamiento por anuncio no está activo en esta instancia");
    }
    const flujo = await findActiveAdFlowById(session.organizationId, body.data.adFlowId);
    if (!flujo) {
      return apiError(422, "ad_flow_not_found", "Ese flujo de anuncio no existe o está pausado");
    }
    anuncio = { flowId: flujo.id, sourceId: flujo.sourceId, headline: flujo.headline };
  }

  try {
    const runId = await startRun(session.organizationId, { anuncio });
    return Response.json({ runId }, { status: 202 });
  } catch (err) {
    if (err instanceof RunLimitError) {
      return apiError(429, "lab_daily_limit", err.message);
    }
    if (err instanceof RunConflictError) {
      return apiError(
        409,
        "run_in_progress",
        "Ya hay una corrida en curso; espera a que termine"
      );
    }
    throw err;
  }
});
