import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { moveLeadToStage } from "@/server/leads/stage-history";
import { assignTag, TagError, tagIdsOfContact, unassignTag } from "@/server/tags/store";

/**
 * Automatizaciones — lo que el motor hace sobre el CRM: etiquetas, etapa y los datos de una condición.
 *
 * Aparte de `engine.ts` (que no toca la base) y de `queue.ts` (que es la cola): aquí vive el cableado a
 * los servicios del CRM, y el motor lo recibe por `Deps`.
 */

export type TagActionResult = "added" | "removed" | "unchanged" | "tag_not_found";

/** `add_tag` / `remove_tag`. Idempotente: repetirlo no cambia nada y no falla. */
export async function applyTag(
  organizationId: string,
  contactId: string,
  tagId: string,
  mode: "add" | "remove"
): Promise<TagActionResult> {
  try {
    if (mode === "add") return (await assignTag(organizationId, contactId, tagId)) ? "added" : "unchanged";
    return (await unassignTag(organizationId, contactId, tagId)) ? "removed" : "unchanged";
  } catch (err) {
    if (err instanceof TagError && err.code === "not_found") return "tag_not_found";
    throw err;
  }
}

export type StageActionResult =
  | { status: "moved" | "unchanged"; toStageId: string; fromStageId: string | null }
  | { status: "stage_not_found" | "contact_has_no_lead" };

/**
 * `set_stage`: mueve al lead del contacto por la única puerta del embudo (`moveLeadToStage`), con
 * `viaAutomation` (anti-bucle: no dispara `stage_changed`). Entrar a una etapa perdida exige motivo: se anota
 * «otro» y la nota «Automatización».
 */
export async function moveContactToStage(
  organizationId: string,
  contactId: string,
  stageId: string
): Promise<StageActionResult> {
  const l = schema.lead;
  const [lead] = await getDb()
    .select({ id: l.id, stageId: l.stageId })
    .from(l)
    .where(scoped(l.organizationId, organizationId, eq(l.contactId, contactId)))
    .limit(1);
  if (!lead) return { status: "contact_has_no_lead" };

  const res = await moveLeadToStage({
    organizationId,
    leadId: lead.id,
    toStageId: stageId,
    source: "sistema",
    viaAutomation: true,
    lossReason: "otro",
    lossNote: "Automatización",
  });
  if (!res.ok) {
    return res.reason === "stage_not_found" ? { status: "stage_not_found" } : { status: "contact_has_no_lead" };
  }
  return { status: res.changed ? "moved" : "unchanged", toStageId: stageId, fromStageId: lead.stageId };
}

/** Los datos que una condición necesita del contacto: sus etiquetas y su etapa de hoy. */
export async function contactFacts(
  organizationId: string,
  contactId: string
): Promise<{ tagIds: string[]; stageId: string | null }> {
  const l = schema.lead;
  const [lead] = await getDb()
    .select({ stageId: l.stageId })
    .from(l)
    .where(scoped(l.organizationId, organizationId, eq(l.contactId, contactId)))
    .limit(1);
  return { tagIds: await tagIdsOfContact(organizationId, contactId), stageId: lead?.stageId ?? null };
}
