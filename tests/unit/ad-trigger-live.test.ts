import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 047 — El disparador «Llegó de un anuncio» por campaña, conjunto o anuncio, y el selector en árbol, contra
 * PostgreSQL REAL. Corre con `RUN_DB_TESTS=1`:
 *   RUN_DB_TESTS=1 corepack pnpm exec vitest run tests/unit/ad-trigger-live.test.ts
 * Crea dos organizaciones temporales (la propia y «otra», para probar el aislamiento) y las borra al terminar.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("Disparador por campaña/conjunto/anuncio contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let sql: (typeof import("drizzle-orm"))["sql"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let flows: typeof import("@/server/automation/flows");
  let options: typeof import("@/server/automation/ad-options");
  let schemas: typeof import("@/lib/automation-schemas");
  let attribution: typeof import("@/server/attribution/store");
  let catalog: typeof import("@/server/attribution/meta-ads/catalog");
  let referral: typeof import("@/server/automation/ad-referral");
  let deferred: typeof import("@/server/automation/ad-referral-deferred");

  const uid = Date.now().toString(36);
  const org = `org_adt${uid}`;
  const other = `org_adt${uid}x`;
  let seq = 0;
  const created = { flows: [] as string[], contacts: [] as string[], convs: [] as string[] };
  const NOW = () => new Date();

  type SeedAd = { adId: string; adName?: string; adsetId: string; adsetName?: string; campaignId: string; campaignName?: string; status?: string; asset?: string | null; org?: string; synced?: boolean };

  async function seedAd(a: SeedAd) {
    await db.insert(schema.metaAd).values({
      id: `mad_${uid}${seq++}`,
      organizationId: a.org ?? org,
      adId: a.adId,
      adName: a.adName ?? `Anuncio ${a.adId}`,
      adsetId: a.adsetId,
      adsetName: a.adsetName ?? `Conjunto ${a.adsetId}`,
      campaignId: a.campaignId,
      campaignName: a.campaignName ?? `Campaña ${a.campaignId}`,
      effectiveStatus: a.status ?? "ACTIVE",
      creativeAssetId: a.asset ?? null,
      // Las URLs de Meta existen en la tabla pero JAMÁS deben salir en las opciones.
      creativeThumbUrl: "https://scontent.fbcdn.net/secreto-thumb.jpg",
      creativeImageUrl: "https://scontent.fbcdn.net/secreto-image.jpg",
      previewLink: "https://fb.me/preview",
      status: a.synced === false ? "pending" : "synced",
      syncedAt: a.synced === false ? null : NOW(),
      listedAt: a.synced === false ? null : NOW(),
    });
  }
  const rename = (adId: string, set: Partial<{ adName: string; adsetName: string; campaignName: string }>) =>
    db.update(schema.metaAd).set(set).where(and(eq(schema.metaAd.organizationId, org), eq(schema.metaAd.adId, adId)));

  async function mkContact() {
    const n = seq++;
    const contactId = `ct_adt${uid}${n}`;
    const conversationId = `cv_adt${uid}${n}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId: org, name: "Cliente Ad", waIdentity: `adt-${uid}${n}`, phone: `52155577${String(n).padStart(4, "0")}` });
    await db.insert(schema.conversation).values({ id: conversationId, organizationId: org, contactId, lastInboundAt: new Date() });
    created.contacts.push(contactId);
    created.convs.push(conversationId);
    return { contactId, conversationId };
  }

  async function mkFlow(triggerConfig?: Record<string, unknown>, active = true) {
    const flow = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `Ad ${uid}${seq++}`, triggerType: "ad_referral", ...(triggerConfig ? { triggerConfig } : {}) }));
    created.flows.push(flow.id);
    await flows.createStep(org, flow.id, schemas.stepCreateSchema.parse({ stepType: "send_whatsapp", config: { content: "Hola" }, positionY: 0 }));
    if (active) await flows.updateFlow(org, flow.id, { active: true });
    return flow;
  }
  const runsOf = (flowId: string, contactId?: string) =>
    db
      .select()
      .from(schema.automationRun)
      .where(contactId ? and(eq(schema.automationRun.flowId, flowId), eq(schema.automationRun.contactId, contactId)) : eq(schema.automationRun.flowId, flowId));

  const anuncio = (sourceId: string) => ({ sourceId, sourceType: "ad", sourceUrl: null, headline: "Promo", body: null, mediaType: null, ctwaClid: null, imageUrl: null, raw: {} });
  const nodeOf = (a: SeedAd) => ({ adId: a.adId, adName: a.adName ?? `Anuncio ${a.adId}`, adsetId: a.adsetId, adsetName: a.adsetName ?? `Conjunto ${a.adsetId}`, campaignId: a.campaignId, campaignName: a.campaignName ?? `Campaña ${a.campaignId}`, effectiveStatus: "ACTIVE" });

  beforeAll(async () => {
    process.env.AUTOMATIONS = "on";
    process.env.ATRIBUCION = "on";
    ({ sql, eq, and, inArray } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    flows = await import("@/server/automation/flows");
    options = await import("@/server/automation/ad-options");
    schemas = await import("@/lib/automation-schemas");
    attribution = await import("@/server/attribution/store");
    catalog = await import("@/server/attribution/meta-ads/catalog");
    referral = await import("@/server/automation/ad-referral");
    deferred = await import("@/server/automation/ad-referral-deferred");
    await db.insert(schema.organization).values([
      { id: org, name: `Org Ad ${uid}`, createdAt: new Date() },
      { id: other, name: `Otra Org Ad ${uid}`, createdAt: new Date() },
    ]);
    // Catálogo de la organización:
    //  C1 Verano (activa): S1 Lima (A1 con miniatura, A2), S2 Cusco (A3 pausado)
    //  C2 Invierno (pausada): S3 Sur (A4 pausado)
    await seedAd({ adId: `A1${uid}`, adName: "Promo Mayo", adsetId: `S1${uid}`, adsetName: "Lima", campaignId: `C1${uid}`, campaignName: "Verano", asset: "med_thumb1" });
    await seedAd({ adId: `A2${uid}`, adName: "Descuento Ñandú", adsetId: `S1${uid}`, adsetName: "Lima", campaignId: `C1${uid}`, campaignName: "Verano" });
    await seedAd({ adId: `A3${uid}`, adName: "Cusco 2x1", adsetId: `S2${uid}`, adsetName: "Cusco", campaignId: `C1${uid}`, campaignName: "Verano", status: "PAUSED" });
    await seedAd({ adId: `A4${uid}`, adName: "Liquidación", adsetId: `S3${uid}`, adsetName: "Sur", campaignId: `C2${uid}`, campaignName: "Invierno", status: "PAUSED" });
    // Otra organización: nada de esto debe cruzar.
    await seedAd({ org: other, adId: `X1${uid}`, adsetId: `XS1${uid}`, campaignId: `XC1${uid}`, campaignName: "Campaña Ajena" });
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.automationFlow).where(inArray(schema.automationFlow.id, created.flows));
    await db.delete(schema.conversation).where(inArray(schema.conversation.id, created.convs));
    await db.delete(schema.contact).where(inArray(schema.contact.id, created.contacts));
    await db.delete(schema.organization).where(inArray(schema.organization.id, [org, other]));
  }, 60_000);

  it("0. la migración 0082 dejó el índice por conjunto", async () => {
    const idx = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where indexname = 'meta_ad_org_adset_idx'`);
    expect([...idx]).toHaveLength(1);
  });

  it("1. el árbol: campañas (activas primero) con conteos, y sus conjuntos y anuncios por nivel", async () => {
    const root = await options.loadRoot(org);
    expect(root.meta).toMatchObject({ hasCatalog: true });
    expect(root.meta.syncedAt).toBeTruthy();
    expect(root.loose).toEqual([]);
    expect(root.items.map((c) => (c.level === "campaign" ? [c.id, c.name, c.adCount, c.adsetCount, c.active] : null))).toEqual([
      [`C1${uid}`, "Verano", 3, 2, true],
      [`C2${uid}`, "Invierno", 1, 1, false],
    ]);
    const sets = await options.listAdsets(org, `C1${uid}`, null);
    expect(sets.items.map((s) => (s.level === "adset" ? [s.id, s.name, s.adCount, s.active] : null))).toEqual([
      [`S1${uid}`, "Lima", 2, true],
      [`S2${uid}`, "Cusco", 1, false],
    ]);
    const ads = await options.listAds(org, `S1${uid}`, null);
    expect(ads.items.map((a) => a.level === "ad" && [a.id, a.name, a.status])).toEqual([
      [`A2${uid}`, "Descuento Ñandú", "ACTIVE"], // por nombre: «descuento» antes que «promo»
      [`A1${uid}`, "Promo Mayo", "ACTIVE"],
    ]);
  });

  it("2. la miniatura es SIEMPRE la copia local; las URLs de Meta no salen jamás", async () => {
    const ads = await options.listAds(org, `S1${uid}`, null);
    const a1 = ads.items.find((a) => a.id === `A1${uid}`);
    expect(a1).toMatchObject({ thumbUrl: "/api/medios/med_thumb1/archivo" });
    expect(ads.items.find((a) => a.id === `A2${uid}`)).toMatchObject({ thumbUrl: null });
    const todo = JSON.stringify([await options.loadRoot(org), ads, await options.searchOptions(org, "promo"), await options.resolveOption(org, "ad", `A1${uid}`)]);
    expect(todo).not.toMatch(/fbcdn|scontent|secreto|fb\.me|preview/i);
  });

  it("3. cursor por nivel: 60 campañas se piden de 50 en 50, sin repetir ni saltar", async () => {
    const temp = `org_adt${uid}p`;
    await db.insert(schema.organization).values({ id: temp, name: "Paginación", createdAt: new Date() });
    try {
      for (let i = 0; i < 60; i++) {
        await seedAd({ org: temp, adId: `PA${i}`, adsetId: `PS${i}`, campaignId: `PC${String(i).padStart(2, "0")}`, campaignName: `Camp ${String(i).padStart(2, "0")}` });
      }
      const p1 = await options.loadRoot(temp);
      expect(p1.items).toHaveLength(50);
      expect(p1.nextCursor).toBeTruthy();
      const p2 = await options.listCampaigns(temp, p1.nextCursor);
      expect(p2.items).toHaveLength(10);
      expect(p2.nextCursor).toBeNull();
      const ids = [...p1.items, ...p2.items].map((c) => c.id);
      expect(new Set(ids).size).toBe(60);
      expect(ids).toEqual([...ids].sort());
    } finally {
      await db.delete(schema.organization).where(eq(schema.organization.id, temp));
    }
  });

  it("4. la búsqueda: sin acentos ni mayúsculas, por nombre o por ID; campañas, conjuntos y anuncios con su ruta", async () => {
    const r = await options.searchOptions(org, "NANDU");
    expect(r.map((n) => n.id)).toEqual([`A2${uid}`]);
    const verano = await options.searchOptions(org, "verano");
    expect(verano.filter((n) => n.level === "campaign").map((n) => n.id)).toEqual([`C1${uid}`]);
    expect(verano.filter((n) => n.level === "ad").length).toBe(3); // los anuncios cuya campaña coincide
    expect((await options.searchOptions(org, "lima")).some((n) => n.level === "adset" && n.id === `S1${uid}`)).toBe(true);
    expect((await options.searchOptions(org, `A3${uid}`)).map((n) => n.id)).toContain(`A3${uid}`);
    expect(await options.searchOptions(org, "x")).toEqual([]); // mínimo 2 letras
    expect(await options.searchOptions(org, "%")).toEqual([]); // los comodines de LIKE no listan todo
  });

  it("5. aislamiento: lo de otra organización no se ve, ni se resuelve", async () => {
    const todo = JSON.stringify([await options.loadRoot(org), await options.searchOptions(org, "ajena"), await options.listAds(org, `XS1${uid}`, null)]);
    expect(todo).not.toContain("Campaña Ajena");
    expect(await options.resolveOption(org, "campaign", `XC1${uid}`)).toBeNull();
    expect(await options.resolveOption(org, "ad", `X1${uid}`)).toBeNull();
    expect((await options.loadRoot(other)).items.map((c) => c.id)).toEqual([`XC1${uid}`]);
  });

  it("6. un renombre en el catálogo se ve al instante en las opciones, la resolución y los flujos, SIN tocar el flujo", async () => {
    const f = await mkFlow({ campaignId: `C1${uid}` });
    const antes = (await flows.listFlows(org)).find((x) => x.id === f.id);
    expect(antes?.triggerSummary).toBe("Cuando alguien llega de cualquier anuncio de la campaña «Verano»");
    await rename(`A1${uid}`, { campaignName: "Verano 2027" });
    await rename(`A2${uid}`, { campaignName: "Verano 2027" });
    await rename(`A3${uid}`, { campaignName: "Verano 2027" });
    expect((await options.loadRoot(org)).items[0]).toMatchObject({ name: "Verano 2027" });
    expect(await options.resolveOption(org, "campaign", `C1${uid}`)).toMatchObject({ name: "Verano 2027" });
    expect((await flows.listFlows(org)).find((x) => x.id === f.id)?.triggerSummary).toContain("«Verano 2027»");
    expect((await flows.getFlow(org, f.id)).flow.triggerSummary).toContain("«Verano 2027»");
    // el flujo guardado sigue con el MISMO ID (nunca un nombre)
    const [row] = await db.select().from(schema.automationFlow).where(eq(schema.automationFlow.id, f.id));
    expect(row!.triggerConfig).toEqual({ campaignId: `C1${uid}` });
    // y sigue disparando
    const { contactId } = await mkContact();
    expect(await referral.emitAdReferral({ organizationId: org, contactId, sourceId: `A1${uid}`, headline: null })).toBeGreaterThanOrEqual(1);
    expect(await runsOf(f.id, contactId)).toHaveLength(1);
    // se deja como estaba para el resto
    for (const a of ["A1", "A2", "A3"]) await rename(`${a}${uid}`, { campaignName: "Verano" });
  });

  it("7. al guardar: conjunto/campaña deben existir en el catálogo de ESTA organización; el anuncio sigue permisivo", async () => {
    await expect(flows.createFlow(org, schemas.flowCreateSchema.parse({ name: "x", triggerType: "ad_referral", triggerConfig: { campaignId: "no-existe" } }))).rejects.toMatchObject({ code: "unknown_ad_scope", status: 422 });
    await expect(flows.createFlow(org, schemas.flowCreateSchema.parse({ name: "x", triggerType: "ad_referral", triggerConfig: { adsetId: "no-existe" } }))).rejects.toMatchObject({ code: "unknown_ad_scope" });
    // el de OTRA organización tampoco vale
    await expect(flows.createFlow(org, schemas.flowCreateSchema.parse({ name: "x", triggerType: "ad_referral", triggerConfig: { campaignId: `XC1${uid}` } }))).rejects.toMatchObject({ code: "unknown_ad_scope" });
    // uno pendiente (aún sin sincronizar) tampoco cuenta como catálogo
    await seedAd({ adId: `P1${uid}`, adsetId: `PS1${uid}`, campaignId: `PC1${uid}`, synced: false });
    await expect(flows.createFlow(org, schemas.flowCreateSchema.parse({ name: "x", triggerType: "ad_referral", triggerConfig: { campaignId: `PC1${uid}` } }))).rejects.toMatchObject({ code: "unknown_ad_scope" });
    // un anuncio desconocido SÍ se acepta (puede llegar antes que el catálogo), como siempre
    const f = await flows.createFlow(org, schemas.flowCreateSchema.parse({ name: `Ad ${uid}libre`, triggerType: "ad_referral", triggerConfig: { sourceId: "123456789" } }));
    created.flows.push(f.id);
    expect(f.triggerSummary).toContain("aún sin sincronizar");
    // varias claves: 422 de Zod
    await expect(flows.createFlow(org, schemas.flowCreateSchema.parse({ name: "x", triggerType: "ad_referral", triggerConfig: { campaignId: `C1${uid}`, adsetId: `S1${uid}` } }))).rejects.toMatchObject({ code: "invalid_trigger_config" });
  });

  it("8. editar un flujo cuyo alcance YA no está en el catálogo no falla; cambiarlo a otro inexistente, sí", async () => {
    await seedAd({ adId: `G1${uid}`, adsetId: `GS1${uid}`, campaignId: `GC1${uid}`, campaignName: "Efímera" });
    const f = await mkFlow({ campaignId: `GC1${uid}` });
    await db.delete(schema.metaAd).where(and(eq(schema.metaAd.organizationId, org), eq(schema.metaAd.campaignId, `GC1${uid}`)));
    const ok = await flows.updateFlow(org, f.id, { name: `Renombrado ${uid}`, triggerConfig: { campaignId: `GC1${uid}` } });
    expect(ok.name).toBe(`Renombrado ${uid}`);
    expect(ok.triggerSummary).toContain(`GC1${uid}`); // sin catálogo: se muestra el ID
    await expect(flows.updateFlow(org, f.id, { triggerConfig: { campaignId: "otra-que-no-existe" } })).rejects.toMatchObject({ code: "unknown_ad_scope" });
  });

  it("9. disparo por anuncio, conjunto, campaña y cualquiera; los ajenos no", async () => {
    const porAnuncio = await mkFlow({ sourceId: `A1${uid}` });
    const porConjunto = await mkFlow({ adsetId: `S1${uid}` });
    const porCampania = await mkFlow({ campaignId: `C1${uid}` });
    const cualquiera = await mkFlow();
    const otraCampania = await mkFlow({ campaignId: `C2${uid}` });
    const otroConjunto = await mkFlow({ adsetId: `S2${uid}` });
    const { contactId } = await mkContact();
    // (los flujos de pruebas anteriores de esta organización también reaccionan: se afirma flujo por flujo)
    const started = await referral.emitAdReferral({ organizationId: org, contactId, sourceId: `A1${uid}`, headline: "Promo" });
    expect(started).toBeGreaterThanOrEqual(4);
    for (const f of [porAnuncio, porConjunto, porCampania, cualquiera]) expect(await runsOf(f.id, contactId), f.id).toHaveLength(1);
    for (const f of [otraCampania, otroConjunto]) expect(await runsOf(f.id, contactId), f.id).toHaveLength(0);
    const [r] = await runsOf(porCampania.id, contactId);
    expect(r!.dedupeKey).toBe(`ad_referral:campaign:C1${uid}`);
  });

  it("10. un contacto que pasa a OTRO anuncio de la misma campaña no arranca el flujo de campaña dos veces", async () => {
    const f = await mkFlow({ campaignId: `C1${uid}` });
    const { contactId } = await mkContact();
    const a = await referral.emitAdReferral({ organizationId: org, contactId, sourceId: `A1${uid}`, headline: null });
    const b = await referral.emitAdReferral({ organizationId: org, contactId, sourceId: `A2${uid}`, headline: null });
    expect(a).toBeGreaterThanOrEqual(1);
    expect(b).toBeGreaterThanOrEqual(0);
    // el flujo de CAMPAÑA corrió una sola vez aunque el contacto pasó a otro anuncio de la misma campaña
    expect(await runsOf(f.id, contactId)).toHaveLength(1);
  });

  it("11. anuncio NUEVO (jerarquía desconocida): campaña/conjunto esperan; anuncio y cualquiera arrancan ya; al sincronizar se evalúan UNA vez", async () => {
    const ad = { adId: `N1${uid}`, adsetId: `NS1${uid}`, campaignId: `NC1${uid}`, adName: "Nuevo", campaignName: "Nueva campaña" };
    // el catálogo todavía no lo conoce: la ingesta solo lo encola como pendiente
    const porAnuncio = await mkFlow({ sourceId: ad.adId });
    const cualquiera = await mkFlow();
    // lo que deja la ingesta con la cuenta conectada: el anuncio en cola, todavía sin jerarquía
    await seedAd({ adId: ad.adId, adsetId: ad.adsetId, campaignId: ad.campaignId, synced: false });
    // un flujo de campaña necesita la campaña en el catálogo para guardarse: se toma de otro anuncio que sí la tiene
    await seedAd({ adId: `N0${uid}`, adsetId: `NS0${uid}`, campaignId: ad.campaignId, campaignName: "Nueva campaña" });
    const porCampania = await mkFlow({ campaignId: ad.campaignId });
    const { contactId, conversationId } = await mkContact();

    await attribution.registrarAnuncioDeOrigen({ organizationId: org, contactId, conversationId, anuncio: anuncio(ad.adId) });
    expect((await runsOf(porAnuncio.id, contactId)).length).toBe(1);
    expect((await runsOf(cualquiera.id, contactId)).length).toBe(1);
    expect((await runsOf(porCampania.id, contactId)).length).toBe(0); // espera al catálogo

    // el worker resuelve el anuncio → el gancho lo evalúa
    await catalog.markSynced(org, [nodeOf(ad)], new Date());
    expect((await runsOf(porCampania.id, contactId)).length).toBe(1);
    // repetirlo (cada sincronización lo hace) no duplica nada
    await catalog.markSynced(org, [nodeOf(ad)], new Date());
    await deferred.emitDeferredAdReferrals(org, [ad.adId]);
    expect((await runsOf(porCampania.id, contactId)).length).toBe(1);
    // y los que ya habían arrancado no se repiten
    expect((await runsOf(porAnuncio.id, contactId)).length).toBe(1);
  });

  it("12. el listado de la cuenta también resuelve lo que esperaba (upsertAccountAds)", async () => {
    const ad = { adId: `L1${uid}`, adsetId: `LS1${uid}`, campaignId: `LC1${uid}`, adName: "Listado", campaignName: "Camp listada" };
    await seedAd({ adId: `L0${uid}`, adsetId: `LS0${uid}`, campaignId: ad.campaignId, campaignName: "Camp listada" });
    const f = await mkFlow({ campaignId: ad.campaignId });
    const { contactId, conversationId } = await mkContact();
    await attribution.registrarAnuncioDeOrigen({ organizationId: org, contactId, conversationId, anuncio: anuncio(ad.adId) });
    expect((await runsOf(f.id, contactId)).length).toBe(0);
    await catalog.upsertAccountAds(org, [nodeOf(ad)], new Date(), { listed: true });
    expect((await runsOf(f.id, contactId)).length).toBe(1);
  });

  it("13. lo de más de 48 h no se re-evalúa (ya no es un primer mensaje)", async () => {
    const ad = { adId: `V1${uid}`, adsetId: `VS1${uid}`, campaignId: `VC1${uid}`, adName: "Viejo", campaignName: "Camp vieja" };
    await seedAd({ adId: `V0${uid}`, adsetId: `VS0${uid}`, campaignId: ad.campaignId, campaignName: "Camp vieja" });
    const f = await mkFlow({ campaignId: ad.campaignId });
    const { contactId, conversationId } = await mkContact();
    await attribution.registrarAnuncioDeOrigen({ organizationId: org, contactId, conversationId, anuncio: anuncio(ad.adId) });
    await db.update(schema.adAttribution).set({ createdAt: new Date(Date.now() - 3 * 86_400_000) }).where(eq(schema.adAttribution.conversationId, conversationId));
    await catalog.markSynced(org, [nodeOf(ad)], new Date());
    expect((await runsOf(f.id, contactId)).length).toBe(0);
  });

  it("14. sin flujos de conjunto/campaña el gancho no consulta nada (y apagado, tampoco)", async () => {
    // Flujos de la organización «otra»: ninguno de alcance → 0 y sin error
    expect(await deferred.emitDeferredAdReferrals(other, [`X1${uid}`])).toBe(0);
    process.env.AUTOMATIONS = "off";
    try {
      expect(await deferred.emitDeferredAdReferrals(org, [`N1${uid}`])).toBe(0);
    } finally {
      process.env.AUTOMATIONS = "on";
    }
  });

  it("15. un flujo viejo { sourceId } sigue funcionando exactamente igual (sin catálogo, sin migrar)", async () => {
    const src = `legacy${uid}`;
    const f = await mkFlow({ sourceId: src });
    const { contactId } = await mkContact();
    expect(await referral.emitAdReferral({ organizationId: org, contactId, sourceId: src, headline: null })).toBeGreaterThanOrEqual(1);
    const [r] = await runsOf(f.id, contactId);
    expect(r).toBeTruthy();
    expect(r!.dedupeKey).toBe(`ad_referral:${src}`);
  });

  it("16. sin catálogo: connector/hasCatalog en falso y los anuncios que ya trajeron gente salen como «sueltos»", async () => {
    const vacia = `org_adt${uid}v`;
    await db.insert(schema.organization).values({ id: vacia, name: "Sin catálogo", createdAt: new Date() });
    try {
      const contactId = `ct_adt${uid}v`;
      const conversationId = `cv_adt${uid}v`;
      await db.insert(schema.contact).values({ id: contactId, organizationId: vacia, name: "C", waIdentity: `adt-v-${uid}`, phone: "5215550000001" });
      await db.insert(schema.conversation).values({ id: conversationId, organizationId: vacia, contactId, lastInboundAt: new Date() });
      await db.insert(schema.adAttribution).values({ id: `aat_${uid}v`, organizationId: vacia, contactId, conversationId, sourceId: "777888999", headline: "Corte 2x1", raw: {} });
      const root = await options.loadRoot(vacia);
      expect(root.meta).toMatchObject({ hasCatalog: false, connector: false, syncedAt: null });
      expect(root.items).toEqual([]);
      expect(root.loose).toEqual([{ adId: "777888999", headline: "Corte 2x1" }]);
    } finally {
      await db.delete(schema.organization).where(eq(schema.organization.id, vacia));
    }
  });

  it("17. Bloque 3 — el Laboratorio (is_test) jamás arranca flujos de anuncio: ni al registrar ni en la re-evaluación diferida", async () => {
    const ad = { adId: `T1${uid}`, adsetId: `TS1${uid}`, campaignId: `TC1${uid}`, adName: "Lab", campaignName: "Camp lab" };
    await seedAd({ adId: `T0${uid}`, adsetId: `TS0${uid}`, campaignId: ad.campaignId, campaignName: "Camp lab" });
    const porCampania = await mkFlow({ campaignId: ad.campaignId });
    const cualquiera = await mkFlow();
    // El contacto TIENE conversación real (así `hasRealConversation` no lo frena): lo que se prueba es el filtro
    // por la conversación de la atribución.
    const { contactId } = await mkContact();
    const convLab = `cv_adtlab${uid}`;
    await db.insert(schema.conversation).values({ id: convLab, organizationId: org, contactId, isTest: true, lastInboundAt: new Date() });
    created.convs.push(convLab);

    // a) registrar desde una conversación del Laboratorio: no deja fila ni arranca nada
    await attribution.registrarAnuncioDeOrigen({ organizationId: org, contactId, conversationId: convLab, anuncio: anuncio(ad.adId), isTest: true });
    const filas = await db.select().from(schema.adAttribution).where(eq(schema.adAttribution.conversationId, convLab));
    expect(filas).toHaveLength(0);
    expect((await runsOf(cualquiera.id, contactId)).length).toBe(0);

    // b) una fila de atribución de una conversación is_test (escrita por otro camino) no se re-evalúa al sincronizar
    await db.insert(schema.adAttribution).values({ id: `ada_lab${uid}`, organizationId: org, contactId, conversationId: convLab, sourceId: ad.adId, sourceType: "ad", raw: {} });
    await catalog.markSynced(org, [nodeOf(ad)], new Date());
    expect(await deferred.emitDeferredAdReferrals(org, [ad.adId])).toBe(0);
    expect((await runsOf(porCampania.id, contactId)).length).toBe(0);
  });
});
