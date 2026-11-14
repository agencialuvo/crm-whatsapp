import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * El turno REAL del agente (pipeline → contexto del flujo → prompt → agenda) contra PostgreSQL real, con el
 * modelo simulado: se captura lo que el pipeline le manda al LLM. Conversaciones `is_test` (sandbox): nada
 * toca la API de WhatsApp. Corre con `pnpm test:db`.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

type Sent = { role: string; content: string }[];
const calls: Sent[] = [];
const nextAction: Record<string, unknown> = { action: "reply", text: "ok" };

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  chatJson: vi.fn(async (_schema: unknown, messages: Sent) => {
    calls.push(messages);
    return { ok: true, data: nextAction };
  }),
}));
vi.mock("@/lib/ai/provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/provider")>()),
  isAiConfiguredFor: vi.fn(async () => true),
}));

describe.skipIf(!live)("el agente con enrutamiento por anuncio (turno real)", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let pipeline: typeof import("@/server/ai/pipeline");
  let adFlow: typeof import("@/server/attribution/ad-flow");
  let adFlowSchema: (typeof import("@/lib/ad-flow"))["adFlowSchema"];

  const tag = Date.now().toString(36);
  let org = "";
  let srv = "";
  let createdProfile = false;
  const ids = { contacts: [] as string[], convs: [] as string[] };
  const SRC = (n: string) => `agent${tag}${n}`;

  beforeAll(async () => {
    process.env.ATRIBUCION = "on";
    ({ eq, inArray } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    pipeline = await import("@/server/ai/pipeline");
    adFlow = await import("@/server/attribution/ad-flow");
    ({ adFlowSchema } = await import("@/lib/ad-flow"));

    const [first] = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    org = first!.id;
    // El turno necesita un perfil de agente; si el negocio no tiene, se crea uno temporal.
    const [profile] = await db.select({ id: schema.agentProfile.id }).from(schema.agentProfile).where(eq(schema.agentProfile.organizationId, org));
    if (!profile) {
      await db.insert(schema.agentProfile).values({ id: `ap_l${tag}`, organizationId: org, name: "Sofía" });
      createdProfile = true;
    }
    srv = `srv_a${tag}`;
    await db.insert(schema.service).values({ id: srv, organizationId: org, name: `Limpieza Facial ${tag}`, priceCents: 8000, durationMinutes: 50, description: "Limpieza profunda" });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.adFlow).where(eq(schema.adFlow.organizationId, org));
    if (ids.convs.length) await db.delete(schema.conversation).where(inArray(schema.conversation.id, ids.convs));
    if (ids.contacts.length) await db.delete(schema.contact).where(inArray(schema.contact.id, ids.contacts));
    await db.delete(schema.service).where(eq(schema.service.id, srv));
    if (createdProfile) await db.delete(schema.agentProfile).where(eq(schema.agentProfile.id, `ap_l${tag}`));
  });

  /** Conversación de PRUEBA (sandbox) que llegó de un anuncio, con un mensaje del cliente por contestar. */
  async function adConversation(sourceId: string | null, text: string) {
    const n = ids.contacts.length;
    const contactId = `ct_a${tag}${n}`;
    const convId = `cv_a${tag}${n}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: `Cliente ${n}`, waIdentity: `agent-${tag}-${n}` });
    await db.insert(schema.conversation).values({ id: convId, organizationId: org, contactId, isTest: true, lastInboundAt: new Date() });
    ids.contacts.push(contactId);
    ids.convs.push(convId);
    if (sourceId) {
      await db.insert(schema.adAttribution).values({
        id: `att_a${tag}${n}`,
        organizationId: org,
        contactId,
        conversationId: convId,
        sourceId,
        sourceType: "ad",
        headline: "Limpieza facial con 20%",
        raw: { source_id: sourceId },
      });
    }
    await db.insert(schema.message).values({
      id: `msg_a${tag}${n}`,
      organizationId: org,
      conversationId: convId,
      direction: "in",
      type: "text",
      text,
      status: "delivered",
    });
    return { contactId, convId };
  }
  const systemPrompt = () => calls.at(-1)!.find((m) => m.role === "system")!.content;

  it("con flujo activo exclusivo, el prompt lleva la directiva con los datos oficiales y sin las reglas genéricas", async () => {
    await adFlow.upsertAdFlow(org, adFlowSchema.parse({ sourceId: SRC("ex"), serviceId: srv, exclusive: true, promptRules: "Menciona el domingo" }));
    const { convId } = await adConversation(SRC("ex"), "Hola, vi el anuncio");
    calls.length = 0;
    await pipeline.runAgentTurn(convId);

    expect(calls).toHaveLength(1);
    const p = systemPrompt();
    expect(p).toContain("ENRUTAMIENTO POR ANUNCIO");
    expect(p).toContain(`Limpieza Facial ${tag}`);
    expect(p).toMatch(/precio .*80/);
    expect(p).toContain("duración 50 min");
    expect(p).toContain("EXCLUSIVO");
    expect(p).toContain("Menciona el domingo");
    expect(p).not.toContain("FLEXIBILIDAD COMERCIAL");
    expect(p).not.toContain("REGLA DE INICIO POR ANUNCIO");
  });

  it("un anuncio sin flujo conserva el comportamiento genérico de siempre", async () => {
    const { convId } = await adConversation(SRC("sin"), "Hola");
    calls.length = 0;
    await pipeline.runAgentTurn(convId);
    const p = systemPrompt();
    expect(p).toContain("FLEXIBILIDAD COMERCIAL");
    expect(p).not.toContain("ENRUTAMIENTO POR ANUNCIO");
  });

  it("tráfico orgánico (sin anuncio) no cambia", async () => {
    const { convId } = await adConversation(null, "Hola");
    calls.length = 0;
    await pipeline.runAgentTurn(convId);
    const p = systemPrompt();
    expect(p).not.toContain("ENRUTAMIENTO POR ANUNCIO");
    expect(p).not.toContain("CONTEXTO DE ANUNCIO DE ORIGEN");
  });

  it("no exclusivo: fija el objetivo pero deja cotizar otros", async () => {
    await adFlow.upsertAdFlow(org, adFlowSchema.parse({ sourceId: SRC("ne"), serviceId: srv, exclusive: false }));
    const { convId } = await adConversation(SRC("ne"), "Hola");
    calls.length = 0;
    await pipeline.runAgentTurn(convId);
    const p = systemPrompt();
    expect(p).toContain("ENRUTAMIENTO POR ANUNCIO");
    expect(p).not.toContain("EXCLUSIVO");
    expect(p).toMatch(/puedes cotizárselo/);
  });

  it("un flujo apagado no enruta", async () => {
    await adFlow.upsertAdFlow(org, adFlowSchema.parse({ sourceId: SRC("off"), serviceId: srv, active: false }));
    const { convId } = await adConversation(SRC("off"), "Hola");
    calls.length = 0;
    await pipeline.runAgentTurn(convId);
    expect(systemPrompt()).not.toContain("ENRUTAMIENTO POR ANUNCIO");
  });

  it("la directiva vale en TODOS los turnos, no solo cuando el cliente nombra la oferta", async () => {
    await adFlow.upsertAdFlow(org, adFlowSchema.parse({ sourceId: SRC("t2"), serviceId: srv, exclusive: true }));
    const { convId } = await adConversation(SRC("t2"), "Hola");
    await pipeline.runAgentTurn(convId);
    // Segundo turno: un mensaje que no menciona ni la palabra clave ni el servicio.
    await db.insert(schema.message).values({
      id: `msg_a${tag}t2b`,
      organizationId: org,
      conversationId: convId,
      direction: "in",
      type: "text",
      text: "¿y cuánto cuesta?",
      status: "delivered",
    });
    calls.length = 0;
    await pipeline.runAgentTurn(convId);
    expect(systemPrompt()).toContain("ENRUTAMIENTO POR ANUNCIO");
  });

  it("con ATRIBUCION apagada no se consulta el flujo", async () => {
    await adFlow.upsertAdFlow(org, adFlowSchema.parse({ sourceId: SRC("flag"), serviceId: srv }));
    const { convId } = await adConversation(SRC("flag"), "Hola");
    process.env.ATRIBUCION = "off";
    try {
      calls.length = 0;
      await pipeline.runAgentTurn(convId);
      expect(systemPrompt()).not.toContain("ENRUTAMIENTO POR ANUNCIO");
    } finally {
      process.env.ATRIBUCION = "on";
    }
  });

  it("la cita que agenda el agente queda atribuida al servicio del flujo (con su duración)", async () => {
    const { bookSlot } = await import("@/server/agenda/agent");
    const { replaceOffers } = await import("@/server/agenda/offers");
    const { bookingTargetOf } = await import("@/lib/ad-flow");
    const { getAdFlowContext } = await import("@/server/ai/ad-flow-context");

    await adFlow.upsertAdFlow(org, adFlowSchema.parse({ sourceId: SRC("book"), serviceId: srv, exclusive: true }));
    const { convId } = await adConversation(SRC("book"), "Quiero agendar");
    const start = new Date(Date.now() + 3 * 86_400_000);
    start.setUTCHours(15, 0, 0, 0);
    const startUtc = start.toISOString();
    await replaceOffers(org, convId, [{ startUtc, label: "en 3 días" }]);

    const ctx = await getAdFlowContext(org, SRC("book"));
    const turn = await bookSlot({ organizationId: org, conversationId: convId, startUtc, ...bookingTargetOf(ctx) });
    expect(turn.ok).toBe(true);

    const [b] = await db.select().from(schema.booking).where(eq(schema.booking.conversationId, convId));
    expect(b).toMatchObject({ serviceId: srv, comboId: null, durationMinutes: 50, source: "ai", status: "agendada" });
    await db.delete(schema.booking).where(eq(schema.booking.conversationId, convId));
  });
});
