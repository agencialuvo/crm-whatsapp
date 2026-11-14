import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Enrutamiento por anuncio contra PostgreSQL REAL (`pnpm test:db`): lista de anuncios detectados y
 * configurados, alta/edición idempotente, aislamiento entre organizaciones, el contexto del agente con los
 * datos oficiales del servicio, la degradación cuando el destino desaparece y la regla del segundo
 * anuncio. Necesita DOS organizaciones; crea y borra lo suyo.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("enrutamiento por anuncio contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let svc: typeof import("@/server/attribution/ad-flow");
  let ctxMod: typeof import("@/server/ai/ad-flow-context");
  let store: typeof import("@/server/attribution/store");
  let adFlowSchema: (typeof import("@/lib/ad-flow"))["adFlowSchema"];

  const tag = Date.now().toString(36);
  let orgA = "";
  let orgB = "";
  const ids = { services: [] as string[], combos: [] as string[], contacts: [] as string[], convs: [] as string[] };
  let srvA = "";
  let comboA = "";
  let srvB = "";
  const SRC = (n: string) => `live${tag}${n}`;
  const flow = (over: Record<string, unknown>) => adFlowSchema.parse({ sourceId: SRC("a"), ...over });

  beforeAll(async () => {
    process.env.ATRIBUCION = "on";
    ({ eq, inArray } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    svc = await import("@/server/attribution/ad-flow");
    ctxMod = await import("@/server/ai/ad-flow-context");
    store = await import("@/server/attribution/store");
    ({ adFlowSchema } = await import("@/lib/ad-flow"));

    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    expect(orgs.length, "hacen falta dos organizaciones").toBeGreaterThanOrEqual(2);
    orgA = orgs[0]!.id;
    orgB = orgs[1]!.id;

    const mkService = async (org: string, name: string, extra: Record<string, unknown> = {}) => {
      const id = `srv_l${tag}${ids.services.length}`;
      await db.insert(schema.service).values({ id, organizationId: org, name, priceCents: 4500, durationMinutes: 45, ...extra });
      ids.services.push(id);
      return id;
    };
    srvA = await mkService(orgA, `Corte Live ${tag}`, { description: "Corte clásico" });
    srvB = await mkService(orgB, `Servicio de B ${tag}`);
    comboA = `cmb_l${tag}`;
    await db.insert(schema.combo).values({ id: comboA, organizationId: orgA, name: `Combo Live ${tag}`, description: "Todo incluido", priceCents: 9000 });
    ids.combos.push(comboA);
  });

  afterAll(async () => {
    if (!db) return;
    // El orden importa: conversaciones y contactos arrastran sus atribuciones por cascada.
    await db.delete(schema.adFlow).where(inArray(schema.adFlow.organizationId, [orgA, orgB]));
    if (ids.convs.length) await db.delete(schema.conversation).where(inArray(schema.conversation.id, ids.convs));
    if (ids.contacts.length) await db.delete(schema.contact).where(inArray(schema.contact.id, ids.contacts));
    if (ids.combos.length) await db.delete(schema.combo).where(inArray(schema.combo.id, ids.combos));
    if (ids.services.length) await db.delete(schema.service).where(inArray(schema.service.id, ids.services));
  });

  /** Una conversación real con su anuncio de origen, vía el mismo camino que la ingesta. */
  async function conversationFromAd(org: string, sourceId: string, headline = "Anuncio de prueba") {
    const n = ids.contacts.length;
    const contactId = `ct_l${tag}${n}`;
    const convId = `cv_l${tag}${n}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: `Cliente ${n}`, waIdentity: `live-${tag}-${n}`, phone: `5215550${n}` });
    await db.insert(schema.conversation).values({ id: convId, organizationId: org, contactId });
    ids.contacts.push(contactId);
    ids.convs.push(convId);
    await registrar(org, contactId, convId, sourceId, headline);
    return { contactId, convId };
  }
  async function registrar(org: string, contactId: string, convId: string, sourceId: string, headline: string) {
    await store.registrarAnuncioDeOrigen({
      organizationId: org,
      contactId,
      conversationId: convId,
      anuncio: { sourceId, sourceType: "ad", sourceUrl: null, headline, body: null, mediaType: null, ctwaClid: null, imageUrl: null, raw: { source_id: sourceId } },
    });
  }

  it("alta idempotente por anuncio: la segunda vez actualiza, no duplica", async () => {
    const a = await svc.upsertAdFlow(orgA, flow({ serviceId: srvA, exclusive: true }));
    expect(a).toMatchObject({ sourceId: SRC("a"), serviceId: srvA, exclusive: true, active: true });
    expect(a.targetName).toContain("Corte Live");
    const b = await svc.upsertAdFlow(orgA, flow({ comboId: comboA, exclusive: false, promptRules: "Sé breve" }));
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ serviceId: null, comboId: comboA, exclusive: false, promptRules: "Sé breve" });
    expect(b.targetName).toContain("Combo Live");
  });

  it("no se puede vincular un servicio u oferta de otra organización ni inexistente", async () => {
    await expect(svc.upsertAdFlow(orgA, flow({ sourceId: SRC("x"), serviceId: srvB }))).rejects.toMatchObject({
      status: 422,
      code: "service_not_found",
    });
    await expect(svc.upsertAdFlow(orgA, flow({ sourceId: SRC("x"), comboId: "cmb_nope", exclusive: false }))).rejects.toMatchObject({
      status: 422,
      code: "combo_not_found",
    });
  });

  it("la lista mezcla detectados y configurados, y cada organización ve solo lo suyo", async () => {
    await conversationFromAd(orgA, SRC("d1"), "Detectado sin flujo");
    await conversationFromAd(orgA, SRC("d1"), "Detectado sin flujo");
    await svc.upsertAdFlow(orgA, flow({ sourceId: SRC("manual"), serviceId: srvA }));
    const list = await svc.listAdFlows(orgA);
    const by = new Map(list.items.map((i) => [i.sourceId, i]));
    expect(by.get(SRC("d1"))).toMatchObject({ conversations: 2, flow: null, headline: "Detectado sin flujo" });
    expect(by.get(SRC("manual"))).toMatchObject({ conversations: 0 });
    expect(by.get(SRC("manual"))?.flow?.serviceId).toBe(srvA);
    // Orden: lo detectado (más reciente primero) antes que lo configurado a mano sin conversaciones.
    expect(list.items.findIndex((i) => i.sourceId === SRC("d1"))).toBeLessThan(
      list.items.findIndex((i) => i.sourceId === SRC("manual"))
    );
    const other = await svc.listAdFlows(orgB);
    expect(other.items.some((i) => i.sourceId === SRC("d1") || i.sourceId === SRC("manual"))).toBe(false);
  });

  it("el contexto del agente trae los datos oficiales del servicio y respeta exclusive", async () => {
    await svc.upsertAdFlow(orgA, flow({ sourceId: SRC("ctx"), serviceId: srvA, exclusive: true }));
    const c = await ctxMod.getAdFlowContext(orgA, SRC("ctx"));
    expect(c).toMatchObject({ exclusive: true, target: { kind: "service", id: srvA, durationMinutes: 45, description: "Corte clásico" } });
    expect(c?.target?.priceLabel).toMatch(/45/);
    // Otra organización no resuelve el flujo de esta.
    expect(await ctxMod.getAdFlowContext(orgB, SRC("ctx"))).toBeNull();
  });

  it("un flujo apagado, o un anuncio sin flujo, no enruta", async () => {
    await svc.upsertAdFlow(orgA, flow({ sourceId: SRC("off"), serviceId: srvA, active: false }));
    expect(await ctxMod.getAdFlowContext(orgA, SRC("off"))).toBeNull();
    expect(await ctxMod.getAdFlowContext(orgA, SRC("none"))).toBeNull();
    expect(await ctxMod.getAdFlowContext(orgA, null)).toBeNull();
  });

  it("si el servicio se desactiva o se borra, degrada: sin reglas no enruta; con reglas, ya no es exclusivo", async () => {
    const tmp = `srv_l${tag}tmp`;
    await db.insert(schema.service).values({ id: tmp, organizationId: orgA, name: "Temporal", priceCents: 1000 });
    ids.services.push(tmp);
    await svc.upsertAdFlow(orgA, flow({ sourceId: SRC("deg1"), serviceId: tmp, exclusive: true }));
    await svc.upsertAdFlow(orgA, flow({ sourceId: SRC("deg2"), serviceId: tmp, exclusive: true, promptRules: "Regla" }));
    await db.delete(schema.service).where(eq(schema.service.id, tmp));

    // `on delete set null`: el flujo sobrevive sin destino.
    const [row] = await db.select().from(schema.adFlow).where(eq(schema.adFlow.sourceId, SRC("deg1")));
    expect(row?.serviceId).toBeNull();
    expect(await ctxMod.getAdFlowContext(orgA, SRC("deg1"))).toBeNull();
    const c2 = await ctxMod.getAdFlowContext(orgA, SRC("deg2"));
    expect(c2).toMatchObject({ exclusive: false, target: null, promptRules: "Regla" });
  });

  it("el CHECK de la base impide servicio y oferta a la vez", async () => {
    await expect(
      db.insert(schema.adFlow).values({ id: `adf_l${tag}chk`, organizationId: orgA, sourceId: SRC("chk"), serviceId: srvA, comboId: comboA })
    ).rejects.toThrow();
  });

  it("segundo anuncio: el primero gana si ya tenía flujo", async () => {
    await svc.upsertAdFlow(orgA, flow({ sourceId: SRC("w1"), serviceId: srvA }));
    await svc.upsertAdFlow(orgA, flow({ sourceId: SRC("w2"), comboId: comboA }));
    const { contactId, convId } = await conversationFromAd(orgA, SRC("w1"));
    await registrar(orgA, contactId, convId, SRC("w2"), "Segundo");
    const att = await store.getAttributionForConversation(orgA, convId);
    expect(att?.sourceId).toBe(SRC("w1"));
  });

  it("segundo anuncio: el primero gana si ninguno tiene flujo", async () => {
    const { contactId, convId } = await conversationFromAd(orgA, SRC("n1"));
    await registrar(orgA, contactId, convId, SRC("n2"), "Segundo sin flujo");
    expect((await store.getAttributionForConversation(orgA, convId))?.sourceId).toBe(SRC("n1"));
  });

  it("segundo anuncio: reemplaza si el primero NO tenía flujo y el nuevo SÍ", async () => {
    await svc.upsertAdFlow(orgA, flow({ sourceId: SRC("r2"), comboId: comboA }));
    const { contactId, convId } = await conversationFromAd(orgA, SRC("r1"), "Primero sin flujo");
    await registrar(orgA, contactId, convId, SRC("r2"), "Segundo con flujo");
    const att = await store.getAttributionForConversation(orgA, convId);
    expect(att).toMatchObject({ sourceId: SRC("r2"), headline: "Segundo con flujo" });
    // Y sigue siendo UNA sola fila por conversación.
    const rows = await db.select().from(schema.adAttribution).where(eq(schema.adAttribution.conversationId, convId));
    expect(rows).toHaveLength(1);
  });

  it("quitar el flujo: 404 en otra organización y desaparece en la propia", async () => {
    const f = await svc.upsertAdFlow(orgA, flow({ sourceId: SRC("del"), serviceId: srvA }));
    await expect(svc.deleteAdFlow(orgB, f.id)).rejects.toMatchObject({ status: 404 });
    await svc.deleteAdFlow(orgA, f.id);
    await expect(svc.deleteAdFlow(orgA, f.id)).rejects.toMatchObject({ status: 404 });
    expect(await ctxMod.getAdFlowContext(orgA, SRC("del"))).toBeNull();
  });
});
