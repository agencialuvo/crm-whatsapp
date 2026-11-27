import { asc } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { kbChangeError } from "@/server/ai/kb-limit";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (session) => {
  const db = getDb();
  const entries = await db
    .select()
    .from(schema.kbEntry)
    .where(scoped(schema.kbEntry.organizationId, session.organizationId))
    .orderBy(asc(schema.kbEntry.createdAt));
  return Response.json({ entries });
});

const createSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("qa"),
      question: z.string().trim().min(1).max(500),
      answer: z.string().trim().min(1).max(4000),
    }),
    z.object({
      kind: z.literal("block"),
      content: z.string().trim().min(1).max(8000),
    }),
  ]);

export const POST = withAuth(async (session, req: Request) => {
  // Mejora 9 — Cambiar lo que sabe o cómo se prueba el agente es de quien configura, no de quien atiende.
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede cambiar el conocimiento del agente");
  }
  const body = await parseBody(req, createSchema);
  if (!body.ok) return body.response;

  // Mejora 5 — El conocimiento tiene tope: entra entero en cada turno del agente.
  const limite = await kbChangeError(session.organizationId, {
    add: {
      kind: body.data.kind,
      question: body.data.kind === "qa" ? body.data.question : null,
      answer: body.data.kind === "qa" ? body.data.answer : null,
      content: body.data.kind === "block" ? body.data.content : null,
    },
  });
  if (limite) return apiError(422, "kb_limit", limite);

  const db = getDb();
  const inserted = await db
    .insert(schema.kbEntry)
    .values({
      id: newId("kbEntry"),
      organizationId: session.organizationId,
      kind: body.data.kind,
      question: body.data.kind === "qa" ? body.data.question : null,
      answer: body.data.kind === "qa" ? body.data.answer : null,
      content: body.data.kind === "block" ? body.data.content : null,
    })
    .returning();
  if (!inserted[0]) return apiError(500, "internal", "No se pudo crear");
  return Response.json({ entry: inserted[0] }, { status: 201 });
});
