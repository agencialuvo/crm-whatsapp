import { and, asc, count, eq, gte } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { publish } from "@/server/events/bus";
import { runAgentTurn, type AnuncioSimulado } from "@/server/ai/pipeline";
import { describirAnuncioParaJuez, renderKb } from "@/server/ai/prompts";
import { getAdFlowContext, loadRivalOfferNames } from "@/server/ai/ad-flow-context";
import { computeScore, judgeCase } from "@/server/lab/judge";
import { AD_PERSONA_KEYS, PERSONAS, personasDeAnuncio, type Persona } from "@/server/lab/personas";
import { scoped } from "@/lib/db/tenant";
import {
  LAB_MAX_CASES,
  LAB_MAX_TURNS_PER_CASE,
  LAB_WINDOW_MS,
  labDailyLimit,
  labLimitMessage,
} from "@/lib/lab-limits";
import { getSubscriptionAccess } from "@/server/saas/enforcement";
import { sinSaldoDeMonedas } from "@/server/ai/metering";

/**
 * Runner del Laboratorio (FR-030/FR-034): corrida en segundo plano DENTRO del
 * proceso (sin cola externa), turnos secuenciales con debounce 0, timeout
 * global de 10 minutos, y lock de concurrencia por índice parcial UNIQUE en
 * BD (máx. 1 corrida `running` por organización).
 *
 * Sandbox (FR-031): las conversaciones se crean con is_test=true; el pipeline
 * del agente persiste las respuestas sin tocar la API, y el sender real lanza
 * si algo intenta enviarlas.
 */

const RUN_TIMEOUT_MS = 10 * 60 * 1000;

export class RunConflictError extends Error {}

/** Mejora 8 — La organización ya usó su cupo de corridas de las últimas 24 horas. */
export class RunLimitError extends Error {
  constructor(readonly limit: number) {
    super(labLimitMessage(limit));
    this.name = "RunLimitError";
  }
}

/**
 * Mejora 8 — Cuántas corridas por 24 horas le tocan a esta organización: pocas en Demo, sin saldo o con la
 * suscripción no activa; más con la suscripción activa (o sin módulo de suscripciones). Ante un fallo al leer
 * el plan o el saldo, el cupo menor: el Laboratorio es lo que se puede esperar, el costo no.
 */
export async function labRunLimitFor(organizationId: string): Promise<number> {
  try {
    const [access, sinSaldo] = await Promise.all([
      getSubscriptionAccess(organizationId),
      sinSaldoDeMonedas(organizationId),
    ]);
    return labDailyLimit({ subscriptionStatus: access.status, sinSaldo });
  } catch (err) {
    console.error("[lab] no se pudo leer el plan para el cupo del Laboratorio:", err);
    return labDailyLimit({ subscriptionStatus: "unknown", sinSaldo: true });
  }
}

/** Corridas de la organización en las últimas 24 horas (todas cuentan: también las fallidas, que gastaron). */
async function runsInWindow(organizationId: string, now: Date): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(schema.agentTestRun)
    .where(
      scoped(
        schema.agentTestRun.organizationId,
        organizationId,
        gte(schema.agentTestRun.startedAt, new Date(now.getTime() - LAB_WINDOW_MS))
      )
    );
  return row?.n ?? 0;
}

/** Bloque 2 — El flujo de anuncio que simula una corrida (lo valida la ruta: activo y de esta organización). */
export type AnuncioDeCorrida = { flowId: string; sourceId: string; headline: string | null };

export async function startRun(
  organizationId: string,
  opts: { anuncio?: AnuncioDeCorrida | null } = {}
): Promise<string> {
  const db = getDb();
  const anuncio = opts.anuncio ?? null;
  // Mejora 8 — Cupo diario. La corrida en curso ya está limitada a una por el índice parcial UNIQUE.
  const limite = await labRunLimitFor(organizationId);
  if ((await runsInWindow(organizationId, new Date())) >= limite) {
    throw new RunLimitError(limite);
  }
  let runId: string;
  try {
    const inserted = await db
      .insert(schema.agentTestRun)
      .values({
        id: newId("testRun"),
        organizationId,
        status: "running",
        adFlowId: anuncio?.flowId ?? null,
        adSourceId: anuncio?.sourceId ?? null,
        adHeadline: anuncio?.headline ?? null,
      })
      .returning();
    runId = inserted[0]!.id;
  } catch (err) {
    // Violación del índice parcial UNIQUE → ya hay una corrida activa.
    if (isUniqueViolation(err)) {
      throw new RunConflictError("Ya hay una corrida en curso");
    }
    throw err;
  }

  // Mejora 8 — Tope de casos por corrida. Bloque 2 — En una corrida de anuncio, primero las personas que
  // llegan por el anuncio (sus guiones se arman al correr, con el servicio del flujo).
  const claves = [...(anuncio ? AD_PERSONA_KEYS : []), ...PERSONAS.map((p) => p.key)];
  await db.insert(schema.agentTestCase).values(
    claves.slice(0, LAB_MAX_CASES).map((key) => ({
      id: newId("testCase"),
      organizationId,
      runId,
      persona: key,
      status: "pending" as const,
    }))
  );

  // Fire-and-forget in-process: el POST regresa ya; el progreso va por SSE.
  void executeRun(runId, organizationId).catch(async (err) => {
    console.error("[lab] corrida falló:", err);
    await failRun(runId, organizationId, String(err));
  });

  return runId;
}

async function executeRun(
  runId: string,
  organizationId: string
): Promise<void> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("timeout de 10 minutos superado")),
      RUN_TIMEOUT_MS
    )
  );
  try {
    await Promise.race([runAllCases(runId, organizationId), timeout]);
  } catch (err) {
    await failRun(runId, organizationId, String(err));
  }
}

async function runAllCases(
  runId: string,
  organizationId: string
): Promise<void> {
  const db = getDb();
  const cases = await db
    .select()
    .from(schema.agentTestCase)
    .where(eq(schema.agentTestCase.runId, runId))
    .orderBy(asc(schema.agentTestCase.createdAt));

  const kbEntries = await db
    .select()
    .from(schema.kbEntry)
    .where(eq(schema.kbEntry.organizationId, organizationId));
  const kbText = renderKb(kbEntries);

  const profileRows = await db
    .select()
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const profile = profileRows[0];
  const behaviorText = profile
    ? [
        `Nombre: ${profile.name}`,
        profile.tone ? `Tono: ${profile.tone}` : null,
        profile.instructions ? `Instrucciones: ${profile.instructions}` : null,
        profile.escalationRules ? `Escalado: ${profile.escalationRules}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  // Bloque 2 — ¿Corrida de anuncio? El anuncio simulado viaja al turno (solo `is_test`) y al juez.
  const [run] = await db
    .select({ adSourceId: schema.agentTestRun.adSourceId, adHeadline: schema.agentTestRun.adHeadline })
    .from(schema.agentTestRun)
    .where(scoped(schema.agentTestRun.organizationId, organizationId, eq(schema.agentTestRun.id, runId)))
    .limit(1);
  const anuncio: AnuncioSimulado | null = run?.adSourceId
    ? { sourceId: run.adSourceId, headline: run.adHeadline, body: null }
    : null;
  let personasAnuncio: Persona[] = [];
  let anuncioText: string | null = null;
  if (anuncio) {
    // El flujo pudo cambiar o desactivarse desde que se lanzó: se lee AHORA, igual que el agente.
    const adFlow = await getAdFlowContext(organizationId, anuncio.sourceId).catch(() => null);
    const otro = (await loadRivalOfferNames(organizationId, adFlow?.target ?? null).catch(() => []))[0] ?? null;
    personasAnuncio = personasDeAnuncio({
      objetivo: adFlow?.target?.name ?? anuncio.headline ?? "su servicio",
      otro,
    });
    anuncioText = describirAnuncioParaJuez({ headline: anuncio.headline, sourceId: anuncio.sourceId, adFlow });
  }

  let done = 0;
  const total = cases.length;
  publishProgress(organizationId, runId, "running", done, total);

  for (const testCase of cases) {
    const persona = [...personasAnuncio, ...PERSONAS].find((p) => p.key === testCase.persona);
    if (!persona) continue;

    await db
      .update(schema.agentTestCase)
      .set({ status: "running" })
      .where(eq(schema.agentTestCase.id, testCase.id));

    const { transcript, conversationId } = await runConversation(
      organizationId,
      persona,
      anuncio
    );

    const outcome = await judgeCase({
      organizationId,
      personaKey: persona.key,
      transcript,
      kbText,
      behaviorText,
      anuncioText,
    });

    await db
      .update(schema.agentTestCase)
      .set({
        conversationId,
        transcript,
        status: outcome.status,
        veredicto: outcome.status === "done" ? outcome.verdict.veredicto : null,
        hallazgos: outcome.status === "done" ? outcome.verdict.hallazgos : null,
      })
      .where(eq(schema.agentTestCase.id, testCase.id));

    done += 1;
    publishProgress(organizationId, runId, "running", done, total);
  }

  const finalCases = await db
    .select({
      status: schema.agentTestCase.status,
      veredicto: schema.agentTestCase.veredicto,
    })
    .from(schema.agentTestCase)
    .where(eq(schema.agentTestCase.runId, runId));
  const score = computeScore(finalCases);

  await getDb()
    .update(schema.agentTestRun)
    .set({ status: "done", score, finishedAt: new Date() })
    .where(eq(schema.agentTestRun.id, runId));
  publishProgress(organizationId, runId, "done", done, total, score);
}

/** Conversa el guion completo contra el agente real; corta al primer handoff. */
async function runConversation(
  organizationId: string,
  persona: Persona,
  anuncio: AnuncioSimulado | null = null
): Promise<{
  transcript: { role: "cliente" | "agente"; text: string }[];
  conversationId: string;
}> {
  const db = getDb();

  // Contacto sintético ARCHIVADO (no aparece en la lista ni genera leads).
  const contactId = await upsertTestContact(organizationId, persona);

  const convId = newId("conversation");
  await db.insert(schema.conversation).values({
    id: convId,
    organizationId,
    contactId,
    isTest: true,
    aiEnabled: true,
  });

  // Mejora 8 — Tope de turnos por caso.
  for (const line of persona.script.slice(0, LAB_MAX_TURNS_PER_CASE)) {
    const now = new Date();
    await db.insert(schema.message).values({
      id: newId("message"),
      organizationId,
      conversationId: convId,
      direction: "in",
      type: "text",
      text: line,
      status: "delivered",
      waTimestamp: now,
    });
    await db
      .update(schema.conversation)
      .set({ lastInboundAt: now, lastMessageAt: now, updatedAt: now })
      .where(eq(schema.conversation.id, convId));

    // Turno REAL del agente, secuencial y sin debounce (FR-030).
    await runAgentTurn(convId, { anuncioSimulado: anuncio });

    const convRows = await db
      .select({ handoffAt: schema.conversation.handoffAt })
      .from(schema.conversation)
      .where(eq(schema.conversation.id, convId))
      .limit(1);
    if (convRows[0]?.handoffAt) break; // primer handoff → fin del guion
  }

  const messages = await db
    .select()
    .from(schema.message)
    .where(eq(schema.message.conversationId, convId))
    .orderBy(asc(schema.message.createdAt));

  return {
    conversationId: convId,
    transcript: messages
      .filter((m) => m.text)
      .map((m) => ({
        role: m.direction === "in" ? ("cliente" as const) : ("agente" as const),
        text: m.text!,
      })),
  };
}

async function upsertTestContact(
  organizationId: string,
  persona: Persona
): Promise<string> {
  const db = getDb();
  const inserted = await db
    .insert(schema.contact)
    .values({
      id: newId("contact"),
      organizationId,
      phone: persona.phone,
      waIdentity: persona.phone,
      name: persona.contactName,
      archivedAt: new Date(),
    })
    // Ídem que en el alta manual: desde 014 el índice único incluye `channel`,
    // y un ON CONFLICT que no lo nombra no corresponde a ningún índice. Sin
    // esto, TODA corrida del Laboratorio muere antes de la primera persona.
    .onConflictDoNothing({
      target: [
        schema.contact.organizationId,
        schema.contact.channel,
        schema.contact.waIdentity,
      ],
    })
    .returning();
  if (inserted[0]) return inserted[0].id;
  const rows = await db
    .select({ id: schema.contact.id })
    .from(schema.contact)
    .where(
      and(
        eq(schema.contact.organizationId, organizationId),
        eq(schema.contact.phone, persona.phone)
      )
    )
    .limit(1);
  return rows[0]!.id;
}

async function failRun(
  runId: string,
  organizationId: string,
  error: string
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agentTestRun)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(eq(schema.agentTestRun.id, runId));
  publishProgress(organizationId, runId, "failed", 0, PERSONAS.length);
}

function publishProgress(
  organizationId: string,
  runId: string,
  status: string,
  done: number,
  total: number,
  score?: number | null
): void {
  publish(organizationId, {
    type: "lab.run",
    data: { runId, status, progress: { done, total }, score },
  });
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}
