import { asc } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { kbChars, kbLimitError, type KbEntryLike } from "@/lib/kb-budget";

/**
 * Mejora 5 — ¿Cabe este cambio en el conocimiento de la organización? Devuelve el mensaje para el dueño (422
 * `kb_limit`) o `null`. Una edición que ACHICA el conocimiento siempre pasa, aunque siga por encima del tope (un
 * conocimiento cargado antes del tope tiene que poder depurarse). Tope blando: dos altas simultáneas al borde
 * podrían pasarse por una; el prompt recorta igual (`renderKbForPrompt`).
 */
export async function kbChangeError(
  organizationId: string,
  change: { add: KbEntryLike } | { edit: { id: string; patch: Partial<KbEntryLike> } }
): Promise<string | null> {
  const rows = await getDb()
    .select({
      id: schema.kbEntry.id,
      kind: schema.kbEntry.kind,
      question: schema.kbEntry.question,
      answer: schema.kbEntry.answer,
      content: schema.kbEntry.content,
    })
    .from(schema.kbEntry)
    .where(scoped(schema.kbEntry.organizationId, organizationId))
    .orderBy(asc(schema.kbEntry.createdAt));

  if ("add" in change) return kbLimitError([...rows, change.add]);

  const after = rows.map((r) => (r.id === change.edit.id ? { ...r, ...change.edit.patch } : r));
  if (kbChars(after) <= kbChars(rows)) return null;
  return kbLimitError(after);
}
