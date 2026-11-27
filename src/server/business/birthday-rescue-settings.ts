import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  benefitLabel,
  looksLikeBirthdayGreeting,
  RESCUE_SETTINGS_DEFAULTS,
  type RescueSettings,
} from "@/lib/salon/birthday-rescue";
import { AutomationError } from "@/server/automation/http";

/**
 * Cumpleaños — ajustes del rescate de fin de mes (ventana de cierre, margen sin atención reciente, rescate
 * automático y beneficio) y lo que se sabe de los flujos con que puede salir. Todo por `scoped()`.
 */

export async function getRescueSettings(organizationId: string): Promise<RescueSettings & { lastAutoRunOn: string | null }> {
  const t = schema.birthdayRescueSettings;
  const [row] = await getDb()
    .select({
      autoEnabled: t.autoEnabled,
      flowId: t.flowId,
      windowDays: t.windowDays,
      minGapDays: t.minGapDays,
      sendHour: t.sendHour,
      benefitText: t.benefitText,
      lastAutoRunOn: t.lastAutoRunOn,
    })
    .from(t)
    .where(scoped(t.organizationId, organizationId))
    .limit(1);
  return row ?? { ...RESCUE_SETTINGS_DEFAULTS, lastAutoRunOn: null };
}

/**
 * Guarda los ajustes. El flujo del rescate automático debe existir y ser de disparador «Manual» (404 / 422); puede
 * estar apagado al guardar: el barrido avisará en la campanita si sigue apagado cuando toque enviar.
 */
export async function saveRescueSettings(organizationId: string, input: RescueSettings): Promise<RescueSettings> {
  if (input.flowId) {
    const f = schema.automationFlow;
    const [flow] = await getDb()
      .select({ triggerType: f.triggerType })
      .from(f)
      .where(scoped(f.organizationId, organizationId, eq(f.id, input.flowId)))
      .limit(1);
    if (!flow) throw new AutomationError("not_found", 404, "El flujo no existe");
    if (flow.triggerType !== "manual") {
      throw new AutomationError("not_manual_flow", 422, "El rescate se envía con un flujo de disparador «Manual»");
    }
  }
  const t = schema.birthdayRescueSettings;
  const values = { ...input, updatedAt: new Date() };
  await getDb()
    .insert(t)
    .values({ id: newId("birthdayRescueSettings"), organizationId, ...values })
    .onConflictDoUpdate({ target: t.organizationId, set: values });
  return input;
}

/** El beneficio en palabras: el texto del negocio o el descuento de cumpleaños de Caja. */
export async function resolveBenefit(organizationId: string, benefitText: string | null): Promise<string> {
  if (benefitText?.trim()) return benefitText.trim();
  const l = schema.loyaltySettings;
  const [row] = await getDb()
    .select({ enabled: l.birthdayEnabled, pct: l.birthdayPercentage })
    .from(l)
    .where(scoped(l.organizationId, organizationId))
    .limit(1);
  return benefitLabel({ benefitText, birthdayEnabled: row?.enabled ?? false, birthdayPercentage: row?.pct ?? null });
}

/**
 * Los textos que mandaría cada flujo: el mensaje de cada paso de envío, la leyenda de un medio y el cuerpo de la
 * plantilla elegida (con sus variables). Sirve para avisar ANTES de enviar si el mensaje felicita fuera de fecha.
 */
export async function flowMessageTexts(organizationId: string, flowIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(flowIds.map((id) => [id, []]));
  if (flowIds.length === 0) return out;
  const st = schema.automationStep;
  const steps = await getDb()
    .select({ flowId: st.flowId, stepType: st.stepType, config: st.config })
    .from(st)
    .where(scoped(st.organizationId, organizationId, inArray(st.flowId, [...flowIds]), inArray(st.stepType, ["send_whatsapp", "send_media"])));
  const templateIds = new Set<string>();
  const parsed = steps.map((s) => {
    const c = (s.config ?? {}) as { content?: unknown; caption?: unknown; templateId?: unknown; variables?: unknown };
    if (typeof c.templateId === "string") templateIds.add(c.templateId);
    return { flowId: s.flowId, c };
  });
  const bodies = new Map<string, string>();
  if (templateIds.size > 0) {
    const tp = schema.template;
    const rows = await getDb()
      .select({ id: tp.id, body: tp.body })
      .from(tp)
      .where(scoped(tp.organizationId, organizationId, inArray(tp.id, [...templateIds])));
    for (const r of rows) bodies.set(r.id, r.body);
  }
  for (const { flowId, c } of parsed) {
    const texts = out.get(flowId)!;
    if (typeof c.content === "string") texts.push(c.content);
    if (typeof c.caption === "string") texts.push(c.caption);
    if (typeof c.templateId === "string") {
      const body = bodies.get(c.templateId);
      if (body) texts.push(body);
      if (Array.isArray(c.variables)) for (const v of c.variables) if (typeof v === "string") texts.push(v);
    }
  }
  return out;
}

/** ¿Algún mensaje del flujo felicita como si fuera el día del cumpleaños? */
export async function flowGreetsLikeBirthday(organizationId: string, flowId: string): Promise<boolean> {
  const texts = (await flowMessageTexts(organizationId, [flowId])).get(flowId) ?? [];
  return texts.some(looksLikeBirthdayGreeting);
}

/** Flujos MANUALES encendidos con que puede salir el rescate, con el aviso de «felicita fuera de fecha». */
export async function listRescueFlows(organizationId: string): Promise<{ id: string; name: string; greetingCopy: boolean }[]> {
  const f = schema.automationFlow;
  const flows = await getDb()
    .select({ id: f.id, name: f.name })
    .from(f)
    .where(scoped(f.organizationId, organizationId, and(eq(f.triggerType, "manual"), eq(f.active, true))))
    .orderBy(asc(f.name));
  const texts = await flowMessageTexts(organizationId, flows.map((x) => x.id));
  return flows.map((x) => ({ ...x, greetingCopy: (texts.get(x.id) ?? []).some(looksLikeBirthdayGreeting) }));
}
