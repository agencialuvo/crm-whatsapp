import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  birthdayRescueDedupeKey,
  closingWindowStartDay,
  inClosingWindow,
  rescuePeriodOf,
  type RescueBlock,
} from "@/lib/salon/birthday-campaign";
import { buildBirthdayRunContext } from "@/lib/salon/birthday-rescue";
import { todayInTz } from "@/lib/time/slots";
import { businessTimezone } from "@/server/analytics/period";
import { AutomationError } from "@/server/automation/http";
import { dbTriggerStore } from "@/server/automation/trigger-store";
import { getBirthdayCampaign } from "@/server/business/birthday-campaign";
import { flowGreetsLikeBirthday } from "@/server/business/birthday-rescue-settings";

/**
 * Cumpleaños — Paso 3: rescate de fin de mes («Última oportunidad»).
 *
 * El envío NO es un camino aparte: arranca un flujo MANUAL encendido (el que el negocio armó con su mensaje o su
 * plantilla) para cada cumpleañero que todavía no reservó ni aprovechó, con `enqueueFirstStep`, igual que el disparo
 * manual. Por eso hereda los controles del motor: baja del contacto, tope de mensajes por contacto, ventana de 24 h
 * de Meta (fuera de ella solo sale una plantilla), saldo de monedas, solo chats reales (nada del Laboratorio) y
 * reintentos. Un fallo de envío queda en el historial y el Panel lo cuenta como fallido, nunca como enviado.
 *
 * Reglas de cierre de mes:
 *  - solo dentro de la ventana de cierre (los últimos N días del mes, configurable): `outside_window` (409);
 *  - la audiencia se RECALCULA aquí con las reglas del Panel (`rescueBlock`): sin cita (ni en su mes ni una vigente
 *    más adelante), sin haber aprovechado, sin atención dentro del margen configurable, sin baja y con chat real; la
 *    lista que mande la pantalla solo acota, nunca agrega a nadie;
 *  - el mensaje NO puede felicitar como si fuera el día del cumpleaños (`greeting_copy`, 422): el rescate recuerda
 *    el beneficio y el plazo; para eso cada ejecución lleva `context.birthday` (`{{beneficio}}`, `{{cierre_mes}}`,
 *    `{{plazo}}`, `{{cumple}}`).
 *
 * Deduplicación, a dos niveles:
 *  1. Control del mes (`birthday_rescue`, único por organización + cliente + `AAAA-MM`): se reclama ANTES de
 *     encolar. Dos lanzamientos simultáneos (el automático y el botón, o dos flujos) no le mandan dos rescates al
 *     mismo cliente.
 *  2. La ejecución del motor lleva su propia llave `birthday_rescue:AAAA-MM` (separada del saludo `birthday:AAAA`):
 *     el índice único del `run` la vuelve idempotente por flujo.
 * Si el encolado falla, el control se suelta y el cliente vuelve a ser elegible.
 */

/** Tope por lanzamiento: un mes grande se lanza en tandas (la respuesta dice si quedaron pendientes). */
export const RESCUE_MAX_PER_LAUNCH = 300;

export type RescueSkipReason = RescueBlock | "not_birthday" | "error";

export type RescueLaunchResult = {
  period: string;
  flowId: string;
  /** A cuántos se intentó (después de la selección y el tope). */
  attempted: number;
  /** Ejecuciones creadas en el motor. */
  enqueued: number;
  /** Quiénes no entraron y por qué. */
  skipped: { contactId: string; reason: RescueSkipReason }[];
  /** Quedaron elegibles sin lanzar por el tope: hay que volver a lanzar. */
  remaining: number;
};

export type RescueFlow = { id: string; triggerType: string; active: boolean };

export type RescueAudience = {
  today: string;
  /** Ventana de cierre del negocio (días). */
  windowDays: number;
  /** El beneficio en palabras, para `{{beneficio}}`. */
  benefit: string;
  clients: { id: string; day: number; rescueBlock: RescueBlock | null }[];
};

export type RescueDeps = {
  loadFlow(organizationId: string, flowId: string): Promise<RescueFlow | null>;
  /** ¿El mensaje del flujo felicita como si fuera el día del cumpleaños? */
  flowGreets(organizationId: string, flowId: string): Promise<boolean>;
  /** El día del negocio, sus reglas y los cumpleañeros del mes con su bloqueo de rescate. */
  audience(organizationId: string, now: Date): Promise<RescueAudience>;
  /** Reclama el control del mes; `false` si ya estaba. */
  claim(input: { organizationId: string; contactId: string; period: string; flowId: string; userId: string | null }): Promise<boolean>;
  release(input: { organizationId: string; contactId: string; period: string }): Promise<void>;
  /** Encola la ejecución; `false` si ya existía una con esa llave para ese flujo. */
  enqueue(input: {
    organizationId: string;
    flowId: string;
    contactId: string;
    period: string;
    triggeredBy: string | null;
    context: Record<string, unknown>;
  }): Promise<boolean>;
  now(): Date;
};

export const dbRescueDeps: RescueDeps = {
  async loadFlow(organizationId, flowId) {
    const f = schema.automationFlow;
    const [row] = await getDb()
      .select({ id: f.id, triggerType: f.triggerType, active: f.active })
      .from(f)
      .where(scoped(f.organizationId, organizationId, eq(f.id, flowId)))
      .limit(1);
    return row ?? null;
  },
  flowGreets: flowGreetsLikeBirthday,
  async audience(organizationId, now) {
    const timezone = await businessTimezone(organizationId);
    const today = todayInTz(now, timezone);
    const b = await getBirthdayCampaign(organizationId, today, timezone);
    return { today, windowDays: b.rescue.windowDays, benefit: b.rescue.benefit, clients: b.clients };
  },
  async claim(input) {
    const rows = await getDb()
      .insert(schema.birthdayRescue)
      .values({
        id: newId("birthdayRescue"),
        organizationId: input.organizationId,
        contactId: input.contactId,
        period: input.period,
        flowId: input.flowId,
        userId: input.userId,
      })
      .onConflictDoNothing({
        target: [schema.birthdayRescue.organizationId, schema.birthdayRescue.contactId, schema.birthdayRescue.period],
      })
      .returning({ id: schema.birthdayRescue.id });
    return rows.length > 0;
  },
  async release(input) {
    const br = schema.birthdayRescue;
    await getDb()
      .delete(br)
      .where(scoped(br.organizationId, input.organizationId, and(eq(br.contactId, input.contactId), eq(br.period, input.period))));
  },
  async enqueue(input) {
    return dbTriggerStore.enqueueFirstStep({
      organizationId: input.organizationId,
      flowId: input.flowId,
      contactId: input.contactId,
      scheduledFor: new Date(),
      dedupeKey: birthdayRescueDedupeKey(input.period),
      context: input.context,
    });
  },
  now: () => new Date(),
};

/**
 * Lanza el rescate del mes con un flujo manual. `contactIds` (opcional) acota a esos clientes; sin él, a todos los
 * elegibles (hasta `RESCUE_MAX_PER_LAUNCH`). `triggeredBy` es quien lo lanzó (`null` = el rescate automático).
 * Errores esperados (`AutomationError`): el flujo no existe, no es manual, está apagado, su mensaje felicita fuera de
 * fecha, o hoy no es la ventana de cierre. Un fallo con UN cliente no frena a los demás.
 */
export async function launchBirthdayRescue(
  input: {
    organizationId: string;
    flowId: string;
    contactIds?: readonly string[];
    triggeredBy: string | null;
    source?: "manual" | "auto";
    /** El instante del lanzamiento (por defecto, ahora). */
    now?: Date;
  },
  deps: RescueDeps = dbRescueDeps
): Promise<RescueLaunchResult> {
  const flow = await deps.loadFlow(input.organizationId, input.flowId);
  if (!flow) throw new AutomationError("not_found", 404, "El flujo no existe");
  if (flow.triggerType !== "manual") {
    throw new AutomationError("not_manual_flow", 422, "El rescate se envía con un flujo de disparador «Manual»");
  }
  if (!flow.active) throw new AutomationError("flow_inactive", 409, "Enciende el flujo para poder enviar el rescate");
  if (await deps.flowGreets(input.organizationId, flow.id)) {
    throw new AutomationError(
      "greeting_copy",
      422,
      "El mensaje de este flujo felicita como si fuera el día del cumpleaños. Para el rescate, recuerda el beneficio y el plazo ({{beneficio}}, {{cierre_mes}}, {{plazo}})"
    );
  }

  const { today, windowDays, benefit, clients } = await deps.audience(input.organizationId, input.now ?? deps.now());
  if (!inClosingWindow(today, windowDays)) {
    throw new AutomationError(
      "outside_window",
      409,
      `El rescate se envía en los últimos ${windowDays} días del mes (desde el día ${closingWindowStartDay(today, windowDays)})`
    );
  }
  const period = rescuePeriodOf(today);
  const skipped: RescueLaunchResult["skipped"] = [];

  let candidates = clients;
  if (input.contactIds) {
    const byId = new Map(clients.map((c) => [c.id, c]));
    candidates = [];
    for (const id of new Set(input.contactIds)) {
      const c = byId.get(id);
      if (c) candidates.push(c);
      else skipped.push({ contactId: id, reason: "not_birthday" });
    }
  }
  const eligible: { id: string; day: number }[] = [];
  for (const c of candidates) {
    if (c.rescueBlock === null) eligible.push(c);
    else if (input.contactIds) skipped.push({ contactId: c.id, reason: c.rescueBlock });
  }
  const batch = eligible.slice(0, RESCUE_MAX_PER_LAUNCH);

  let enqueued = 0;
  for (const { id: contactId, day } of batch) {
    const base = { organizationId: input.organizationId, contactId, period };
    let claimed: boolean;
    try {
      claimed = await deps.claim({ ...base, flowId: flow.id, userId: input.triggeredBy });
    } catch (err) {
      // Sin control no se encola (no hay cómo garantizar «una vez en el mes»): se omite y se sigue con los demás.
      console.error(`[cumpleaños] no se pudo reclamar el rescate de ${contactId}:`, err);
      skipped.push({ contactId, reason: "error" });
      continue;
    }
    if (!claimed) {
      skipped.push({ contactId, reason: "already_rescued" });
      continue;
    }
    try {
      const started = await deps.enqueue({
        ...base,
        flowId: flow.id,
        triggeredBy: input.triggeredBy,
        context: {
          source: "birthday_rescue",
          period,
          triggeredBy: input.triggeredBy ?? "auto",
          mode: input.source ?? "manual",
          birthday: buildBirthdayRunContext({ today, birthdayDay: day, benefit }),
        },
      });
      if (started) enqueued += 1;
      // Ya había una ejecución del rescate de este mes con este flujo: el control queda (no se reenvía).
      else skipped.push({ contactId, reason: "already_rescued" });
    } catch (err) {
      console.error(`[cumpleaños] no se pudo encolar el rescate de ${contactId}:`, err);
      // Sin ejecución no hay rescate: se suelta el control para poder reintentarlo.
      await deps.release(base).catch((e) => console.error("[cumpleaños] no se pudo soltar el control del rescate:", e));
      skipped.push({ contactId, reason: "error" });
    }
  }

  return {
    period,
    flowId: flow.id,
    attempted: batch.length,
    enqueued,
    skipped,
    remaining: eligible.length - batch.length,
  };
}
