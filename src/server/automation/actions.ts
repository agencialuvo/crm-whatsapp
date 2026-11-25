import { asc, count, desc, eq, gt, isNotNull, lte } from "drizzle-orm";
import { birthdaysDueOn, calendarDaysBetween, wholeDaysSince, type ConditionFacts } from "@/lib/automation";
import { stampsToNextMilestone as stampsToNext } from "@/lib/loyalty";
import { todayInTz } from "@/lib/time/slots";
import { businessTimezone } from "@/server/analytics/period";
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
    // `viaAutomation`: una etiqueta puesta por un flujo no dispara `tag_added` (anti-bucle).
    if (mode === "add") return (await assignTag(organizationId, contactId, tagId, { viaAutomation: true })) ? "added" : "unchanged";
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

/**
 * Los datos que una condición necesita del contacto, de AHORA (no de cuando arrancó el flujo): sus etiquetas y su
 * etapa y, para las jugadas de cumpleaños, asistencia y fidelización, si tiene una cita próxima, hace cuántos días vino
 * por última vez, cuántos sellos tiene y si hoy cumple años (en la zona horaria del negocio).
 */
export async function contactFacts(
  organizationId: string,
  contactId: string,
  now: Date = new Date()
): Promise<
  Pick<
    ConditionFacts,
    | "tagIds"
    | "stageId"
    | "hasUpcomingBooking"
    | "hasConfirmedUpcomingBooking"
    | "daysToNextBooking"
    | "visitCount"
    | "daysSinceLastVisit"
    | "stamps"
    | "stampsToNextMilestone"
    | "birthdayToday"
  >
> {
  const db = getDb();
  const l = schema.lead;
  const b = schema.booking;
  const card = schema.customerLoyaltyCard;
  const c = schema.contact;
  // Solo citas reales de un cliente (no bloqueos de agenda ni citas del Laboratorio).
  const real = (...extra: Parameters<typeof scoped>[2][]) =>
    scoped(b.organizationId, organizationId, eq(b.contactId, contactId), eq(b.kind, "session"), eq(b.isTest, false), ...extra);

  const [lead, tagIds, upcoming, confirmedUpcoming, visits, lastVisit, stampsRow, person, timezone, program] = await Promise.all([
    db.select({ stageId: l.stageId }).from(l).where(scoped(l.organizationId, organizationId, eq(l.contactId, contactId))).limit(1),
    tagIdsOfContact(organizationId, contactId),
    // La próxima cita agendada (la más cercana): de ella salen «tiene cita próxima» y «en cuántos días».
    db.select({ at: b.scheduledAt }).from(b).where(real(eq(b.status, "agendada"), gt(b.scheduledAt, now))).orderBy(asc(b.scheduledAt)).limit(1),
    // Alguna cita futura ya confirmada (no tiene por qué ser la más cercana).
    db.select({ id: b.id }).from(b).where(real(eq(b.status, "agendada"), gt(b.scheduledAt, now), isNotNull(b.confirmedAt))).limit(1),
    // Visitas acumuladas: las mismas citas que cuenta `visited_within_days` (realizadas, ya pasadas).
    db.select({ n: count() }).from(b).where(real(eq(b.status, "realizada"), lte(b.scheduledAt, now))),
    db
      .select({ at: b.scheduledAt })
      .from(b)
      .where(real(eq(b.status, "realizada"), lte(b.scheduledAt, now)))
      .orderBy(desc(b.scheduledAt))
      .limit(1),
    db
      .select({ stamps: card.currentStamps })
      .from(card)
      .where(scoped(card.organizationId, organizationId, eq(card.contactId, contactId)))
      .limit(1),
    db
      .select({ day: c.birthdayDay, month: c.birthdayMonth })
      .from(c)
      .where(scoped(c.organizationId, organizationId, eq(c.id, contactId)))
      .limit(1),
    businessTimezone(organizationId),
    // Solo lectura (no crea la configuración por defecto): los hitos del programa, para «cuánto falta para el siguiente».
    db
      .select({ milestones: schema.loyaltySettings.milestones })
      .from(schema.loyaltySettings)
      .where(scoped(schema.loyaltySettings.organizationId, organizationId))
      .limit(1),
  ]);

  const born = person[0];
  const today = todayInTz(now, timezone);
  return {
    tagIds,
    stageId: lead[0]?.stageId ?? null,
    hasUpcomingBooking: upcoming.length > 0,
    hasConfirmedUpcomingBooking: confirmedUpcoming.length > 0,
    // Días de calendario del NEGOCIO (hoy = 0): una cita de mañana a las 00:30 es «1» aunque falten menos de 24 h.
    daysToNextBooking: upcoming[0] ? Math.max(0, calendarDaysBetween(today, todayInTz(upcoming[0].at, timezone))) : null,
    visitCount: Number(visits[0]?.n ?? 0),
    daysSinceLastVisit: lastVisit[0] ? wholeDaysSince(lastVisit[0].at, now) : null,
    stamps: stampsRow[0]?.stamps ?? 0,
    stampsToNextMilestone: stampsToNext(program[0]?.milestones ?? [], stampsRow[0]?.stamps ?? 0),
    birthdayToday: !!born?.day && !!born?.month && birthdaysDueOn(today).some((d) => d.day === born.day && d.month === born.month),
  };
}
