import { asc } from "drizzle-orm";
import { withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { kbChars, KB_MAX_CHARS, KB_MAX_ENTRIES, KB_WARN_CHARS } from "@/lib/kb-budget";

export const dynamic = "force-dynamic";

/**
 * Tamaño del knowledge base (FR-020, Mejora 5). Entra entero en cada turno del agente: `warnAt` avisa de que ya
 * pesa; `limit` es el tope duro al guardar (y lo que cabe en el prompt). `overLimit` = cargado antes del tope:
 * el agente solo lee lo que cabe.
 */
export const GET = withAuth(async (session) => {
  const db = getDb();
  const entries = await db
    .select()
    .from(schema.kbEntry)
    .where(scoped(schema.kbEntry.organizationId, session.organizationId))
    .orderBy(asc(schema.kbEntry.createdAt));
  const chars = kbChars(entries);
  return Response.json({
    chars,
    entries: entries.length,
    warnAt: KB_WARN_CHARS,
    limit: KB_MAX_CHARS,
    maxEntries: KB_MAX_ENTRIES,
    warning: chars >= KB_WARN_CHARS,
    overLimit: chars > KB_MAX_CHARS,
  });
});
