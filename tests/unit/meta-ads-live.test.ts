import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 038 contra PostgreSQL REAL (`pnpm test:db`): la cola de anuncios, la sincronización con la Marketing API (con un doble
 * de la Graph API: cada rama de error), el gasto diario y Resultados (jerarquía, filtros, costos, aislamiento, bandera).
 * Nada toca Meta. Crea y borra lo suyo; si la organización ya tiene una cuenta publicitaria conectada, se niega a
 * correr en vez de pisarla.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("Marketing API de Meta contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let and: (typeof import("drizzle-orm"))["and"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let catalog: typeof import("@/server/attribution/meta-ads/catalog");
  let settings: typeof import("@/server/attribution/meta-ads/settings");
  let sync: typeof import("@/server/attribution/meta-ads/sync");
  let worker: typeof import("@/server/attribution/meta-ads/worker");
  let analytics: typeof import("@/server/analytics/ads");
  let period: typeof import("@/server/analytics/period");
  let store: typeof import("@/server/attribution/store");
  let ads: typeof import("@/lib/meta/ads");
  let MetaApiError: (typeof import("@/lib/meta/client"))["MetaApiError"];
  let newId: (typeof import("@/lib/db/ids"))["newId"];
  let sql: (typeof import("drizzle-orm"))["sql"];
  let deleteMediaFileFn: (typeof import("@/server/whatsapp/media"))["deleteMediaFile"];
  let addDaysISO: (typeof import("@/lib/time/slots"))["addDaysISO"];

  const uid = Date.now().toString(36);
  const TOKEN = `EAAB${uid}SECRETOSECRETOSECRETOSECRETOSECRETO1234`;
  let org = "";
  let otherOrg = "";
  let seq = 0;
  const created = { contacts: [] as string[], adIds: [] as string[] };
  const ad = (n: string | number) => `ad-${uid}-${n}`;

  beforeAll(async () => {
    process.env.ATRIBUCION = "on";
    process.env.AGENDA = "on";
    ({ eq, and, inArray, sql } = await import("drizzle-orm"));
    ({ deleteMediaFile: deleteMediaFileFn } = await import("@/server/whatsapp/media"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    catalog = await import("@/server/attribution/meta-ads/catalog");
    settings = await import("@/server/attribution/meta-ads/settings");
    sync = await import("@/server/attribution/meta-ads/sync");
    worker = await import("@/server/attribution/meta-ads/worker");
    analytics = await import("@/server/analytics/ads");
    period = await import("@/server/analytics/period");
    store = await import("@/server/attribution/store");
    ads = await import("@/lib/meta/ads");
    ({ MetaApiError } = await import("@/lib/meta/client"));
    ({ newId } = await import("@/lib/db/ids"));
    ({ addDaysISO } = await import("@/lib/time/slots"));

    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    org = orgs[0]!.id;
    otherOrg = orgs[1]!.id;
    for (const o of [org, otherOrg]) {
      if (await settings.hasMetaAdsSettings(o)) {
        throw new Error(`La organización ${o} ya tiene una cuenta publicitaria conectada: el test no la pisa.`);
      }
    }
  });

  async function limpiar() {
    for (const o of [org, otherOrg]) {
      await db.delete(schema.metaAdSpend).where(eq(schema.metaAdSpend.organizationId, o));
      await db.delete(schema.metaAccountSpend).where(eq(schema.metaAccountSpend.organizationId, o));
      await db.delete(schema.metaAd).where(eq(schema.metaAd.organizationId, o));
      await db.delete(schema.metaAdsSettings).where(eq(schema.metaAdsSettings.organizationId, o));
    }
    // 040 — Las copias locales de creativos (archivo y fila).
    for (const o of [org, otherOrg]) {
      const copias = await db.select({ id: schema.mediaAsset.id }).from(schema.mediaAsset).where(and(eq(schema.mediaAsset.organizationId, o), sql`${schema.mediaAsset.payload}->>'origen' = 'catalogo'`));
      for (const c of copias) await deleteMediaFileFn(o, c.id).catch(() => {});
      if (copias.length) await db.delete(schema.mediaAsset).where(inArray(schema.mediaAsset.id, copias.map((c) => c.id)));
    }
    // Los contactos arrastran sus conversaciones, atribuciones y citas (cascada): cada prueba parte de cero.
    if (created.contacts.length) await db.delete(schema.contact).where(inArray(schema.contact.id, created.contacts));
    created.contacts = [];
  }

  afterAll(async () => {
    if (!db) return;
    await limpiar();
    if (created.contacts.length) await db.delete(schema.contact).where(inArray(schema.contact.id, created.contacts));
  });

  beforeEach(async () => {
    if (db) await limpiar();
  });

  /* ─── Constructores ─── */

  /**
   * Conecta una cuenta. Por defecto el listado de la cuenta (039) figura como YA hecho: así las pruebas de 038 siguen
   * mirando las consultas sueltas y el gasto sin que el listado se cruce. Las de 039 piden `catalogoAlDia: false`.
   */
  async function conectar(organizationId = org, token = TOKEN, opts: { catalogoAlDia?: boolean } = {}) {
    await settings.saveMetaAdsSettings({ organizationId, adAccountId: "act_1234567890", token, accountName: "Cuenta test", currency: "MXN" });
    if (opts.catalogoAlDia !== false) {
      await db.update(schema.metaAdsSettings).set({ catalogSyncedAt: T0 }).where(eq(schema.metaAdsSettings.organizationId, organizationId));
    }
  }

  const T0 = new Date("2026-11-14T12:00:00Z");
  const hoy = () => T0.toISOString().slice(0, 10);

  type AnuncioFalso = {
    id: string;
    name?: string;
    status?: string;
    adset?: [string, string];
    campaign?: [string, string];
    /** 040 — El creativo que devuelve el listado cuando se pide con `creative{…}`. */
    creative?: { id?: string; title?: string; body?: string; image?: string; thumb?: string };
    link?: string;
  };

  /**
   * Un doble de la Graph API: consultas sueltas por ids (038), listado de la cuenta, gasto por anuncio y gasto de la
   * cuenta (039). `spend` es el gasto diario por id; `account` los anuncios que lista la cuenta.
   */
  function fakeGraph(
    opts: {
      spend?: Record<string, number>;
      skipDay?: string;
      fail?: (path: string) => unknown;
      calls?: string[];
      account?: AnuncioFalso[];
      /** Gasto de la cuenta que ningún anuncio explica, por día. */
      extraAccount?: number;
      timezone?: string;
      /** 040 — Si se da, pedir el listado CON creativos falla con este error (sin creativos, bien). */
      failCreatives?: unknown;
      /** Páginas del gasto por anuncio: si se da, cada página trae este número de filas y siempre dice que hay otra. */
      endlessSpendPages?: number;
    } = {}
  ): import("@/server/attribution/meta-ads/sync").GraphCall {
    const nodoDe = (a: AnuncioFalso) => ({
      id: a.id,
      name: a.name ?? `Nombre ${a.id}`,
      effective_status: a.status ?? "ACTIVE",
      adset: { id: a.adset?.[0] ?? `as-${a.id}`, name: a.adset?.[1] ?? `Conjunto ${a.id}` },
      campaign: { id: a.campaign?.[0] ?? "camp-1", name: a.campaign?.[1] ?? "Campaña uno" },
    });
    return async (path, _token, onHeaders) => {
      opts.calls?.push(path);
      const failure = opts.fail?.(path);
      if (failure) throw failure;
      onHeaders(new Headers());
      const q = new URL(`http://x/${path}`).searchParams;
      const filtro = (JSON.parse(q.get("filtering") ?? "[]") as { value: string[] }[])[0]?.value ?? [];
      if (!path.includes("/ads?") && !path.includes("/insights?")) {
        return { name: "Cuenta test", currency: "MXN", timezone_name: opts.timezone ?? "America/Mexico_City" };
      }
      if (path.includes("/ads?")) {
        if (filtro.length === 0) {
          const conCreativo = (q.get("fields") ?? "").includes("creative{");
          if (conCreativo && opts.failCreatives) throw opts.failCreatives;
          return {
            data: (opts.account ?? []).map((a) => ({
              ...nodoDe(a),
              ...(conCreativo
                ? {
                    ...(a.link !== undefined ? { preview_shareable_link: a.link } : {}),
                    ...(a.creative
                      ? { creative: { id: a.creative.id, title: a.creative.title, body: a.creative.body, image_url: a.creative.image, thumbnail_url: a.creative.thumb } }
                      : {}),
                  }
                : {}),
            })),
          };
        }
        return {
          data: filtro
            .filter((id) => !id.includes("gone"))
            .map((id) => ({ id, name: `Nombre ${id}`, adset: { id: `as-${id}`, name: `Conjunto ${id}` }, campaign: { id: "camp-1", name: "Campaña uno" } })),
        };
      }
      const range = JSON.parse(q.get("time_range")!) as { since: string; until: string };
      const ids = Object.keys(opts.spend ?? {});
      const dias: string[] = [];
      for (let d = range.since; d <= range.until; d = addDaysISO(d, 1)) if (d !== opts.skipDay) dias.push(d);
      if (q.get("level") === "account") {
        const total = ids.reduce((t, id) => t + (opts.spend![id] ?? 0), 0) + (opts.extraAccount ?? 0);
        return { data: dias.map((d) => ({ spend: total.toFixed(2), account_currency: "MXN", date_start: d, date_stop: d })) };
      }
      const rows: unknown[] = [];
      for (const d of dias) {
        for (const id of ids) {
          const conocido = (opts.account ?? []).find((a) => a.id === id);
          const n = conocido ? nodoDe(conocido) : null;
          rows.push({
            ad_id: id,
            ...(n ? { ad_name: n.name, adset_id: n.adset.id, adset_name: n.adset.name, campaign_id: n.campaign.id, campaign_name: n.campaign.name } : {}),
            spend: String(opts.spend![id]),
            account_currency: "MXN",
            date_start: d,
            date_stop: d,
          });
        }
      }
      if (opts.endlessSpendPages) {
        // Una paginación que nunca termina: cada página dice que hay otra.
        return { data: rows.slice(0, opts.endlessSpendPages), paging: { cursors: { after: "SIGUE" }, next: "https://graph/next" } };
      }
      return { data: rows };
    };
  }

  /** Corre pasadas, una por minuto, hasta que no quede historial por rellenar. Devuelve cuántas hicieron falta. */
  async function completar(graph: () => import("@/server/attribution/meta-ads/sync").GraphCall, inicio = T0, maximo = 20) {
    let now = inicio;
    for (let pasadas = 1; pasadas <= maximo; pasadas++) {
      await sync.syncOrganization(org, deps(graph(), now));
      const cfg = (await settings.getMetaAdsSettings(org))!;
      if (!sync.hayRellenoPendiente(cfg, now)) return { pasadas, now };
      now = new Date(now.getTime() + 60_000);
    }
    throw new Error("el relleno no terminó");
  }

  const deps = (
    graph: import("@/server/attribution/meta-ads/sync").GraphCall,
    now = T0,
    descargar?: import("@/server/attribution/meta-ads/creatives").Descargador
  ): import("@/server/attribution/meta-ads/sync").SyncDeps => ({ now: () => now, graph, descargar });

  async function mkContactWithAd(adId: string | null, over: { organizationId?: string; isTest?: boolean; sourceType?: string } = {}) {
    const n = seq++;
    const organizationId = over.organizationId ?? org;
    const contactId = `ct_m${uid}${n}`;
    const conversationId = `cv_m${uid}${n}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId, name: "Cliente Meta", waIdentity: `ma-${uid}${n}`, phone: `52155588${String(n).padStart(4, "0")}` });
    await db.insert(schema.conversation).values({ id: conversationId, organizationId, contactId, isTest: over.isTest ?? false });
    created.contacts.push(contactId);
    if (adId) {
      await db.insert(schema.adAttribution).values({
        id: newId("adAttribution"),
        organizationId,
        contactId,
        conversationId,
        sourceId: adId,
        sourceType: over.sourceType ?? "ad",
        headline: `Titular ${adId}`,
        raw: {},
      });
    }
    return { contactId, conversationId };
  }

  const metaRow = async (organizationId: string, adId: string) =>
    (await db.select().from(schema.metaAd).where(and(eq(schema.metaAd.organizationId, organizationId), eq(schema.metaAd.adId, adId))))[0];

  /* ─── Credenciales ─── */

  describe("credenciales", () => {
    it("el token se guarda cifrado y a la vista solo salen sus últimos 4", async () => {
      await conectar();
      const raw = (await db.select().from(schema.metaAdsSettings).where(eq(schema.metaAdsSettings.organizationId, org)))[0]!;
      expect(JSON.stringify(raw)).not.toContain(TOKEN);
      expect(JSON.stringify(raw)).not.toContain("SECRETO");
      expect((await settings.getMetaAdsSettings(org))!.token).toBe(TOKEN);
      const view = await settings.getMetaAdsView(org, { pending: 0, failed: 0 });
      expect(view!.tokenLast4).toBe(TOKEN.slice(-4));
      expect(JSON.stringify(view)).not.toContain(TOKEN);
    });

    it("guardar de nuevo reinicia el error y la pausa", async () => {
      await conectar();
      await settings.markSettingsError(org, "token vencido");
      await settings.setPausedUntil(org, new Date(Date.now() + 3_600_000), 3, "límite");
      await conectar(org, TOKEN + "2");
      const s = (await settings.getMetaAdsSettings(org))!;
      expect(s).toMatchObject({ status: "connected", lastError: null, pausedUntil: null, rateHits: 0 });
    });

    it("cada organización ve solo lo suyo", async () => {
      await conectar(org);
      expect(await settings.getMetaAdsSettings(otherOrg)).toBeNull();
      expect(await settings.hasMetaAdsSettings(otherOrg)).toBe(false);
    });

    it("desconectar borra credenciales y consultas vacías, y CONSERVA catálogo y gasto", async () => {
      await conectar();
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("v"), sourceType: "ad" });
      await db.insert(schema.metaAd).values({ id: newId("metaAd"), organizationId: org, adId: ad("hist"), status: "synced", adName: "Histórico", syncedAt: new Date() });
      await db.insert(schema.metaAdSpend).values({ id: newId("metaAdSpend"), organizationId: org, adId: ad("hist"), day: hoy(), spend: "50.00", currency: "MXN" });
      await settings.deleteMetaAdsSettings(org);
      expect(await settings.hasMetaAdsSettings(org)).toBe(false);
      expect(await metaRow(org, ad("v"))).toBeUndefined();
      expect((await metaRow(org, ad("hist")))!.adName).toBe("Histórico");
      expect(await db.select().from(schema.metaAdSpend).where(eq(schema.metaAdSpend.adId, ad("hist")))).toHaveLength(1);
    });
  });

  /* ─── La cola ─── */

  describe("enqueueAdLookup", () => {
    it("sin credenciales no escribe nada (el CRM sigue como hoy)", async () => {
      expect(await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad(1), sourceType: "ad" })).toBe(false);
      expect(await metaRow(org, ad(1))).toBeUndefined();
    });

    it("una publicación (post) o un referral sin id no se encolan", async () => {
      await conectar();
      expect(await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad(1), sourceType: "post" })).toBe(false);
      expect(await catalog.enqueueAdLookup({ organizationId: org, sourceId: null, sourceType: "ad" })).toBe(false);
      expect(await metaRow(org, ad(1))).toBeUndefined();
    });

    it("con credenciales encola una fila pendiente, y repetirlo no duplica", async () => {
      await conectar();
      expect(await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad(1), sourceType: "ad" })).toBe(true);
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad(1), sourceType: "ad" });
      const filas = await db.select().from(schema.metaAd).where(and(eq(schema.metaAd.organizationId, org), eq(schema.metaAd.adId, ad(1))));
      expect(filas).toHaveLength(1);
      expect(filas[0]).toMatchObject({ status: "pending", attempts: 0 });
    });

    it("lo sincronizado hace poco NO vuelve a la cola; lo sincronizado hace más de 12 h, sí", async () => {
      await conectar();
      const now = new Date();
      await db.insert(schema.metaAd).values({ id: newId("metaAd"), organizationId: org, adId: ad("fresco"), status: "synced", syncedAt: new Date(now.getTime() - 3_600_000) });
      await db.insert(schema.metaAd).values({ id: newId("metaAd"), organizationId: org, adId: ad("viejo"), status: "synced", syncedAt: new Date(now.getTime() - 13 * 3_600_000) });
      expect(await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("fresco"), sourceType: "ad", now })).toBe(false);
      expect(await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("viejo"), sourceType: "ad", now })).toBe(true);
      expect((await metaRow(org, ad("fresco")))!.status).toBe("synced");
      expect((await metaRow(org, ad("viejo")))!.status).toBe("pending");
    });

    it("lo fallido o ausente sigue su propio calendario (un mensaje nuevo no lo adelanta)", async () => {
      await conectar();
      const futuro = new Date(Date.now() + 6 * 3_600_000);
      await db.insert(schema.metaAd).values({ id: newId("metaAd"), organizationId: org, adId: ad("fallo"), status: "failed", nextAttemptAt: futuro });
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("fallo"), sourceType: "ad" });
      expect((await metaRow(org, ad("fallo")))!.status).toBe("failed");
    });

    it("registrarAnuncioDeOrigen deja el anuncio en la cola con la bandera encendida y credenciales", async () => {
      await conectar();
      const { contactId, conversationId } = await mkContactWithAd(null);
      await store.registrarAnuncioDeOrigen({
        organizationId: org,
        contactId,
        conversationId,
        anuncio: { sourceId: ad("ing"), sourceType: "ad", sourceUrl: null, headline: "H", body: null, mediaType: null, ctwaClid: null, imageUrl: null, raw: {} },
      });
      expect((await metaRow(org, ad("ing")))!.status).toBe("pending");
    });

    it("con la bandera APAGADA la ingesta no encola nada", async () => {
      await conectar();
      process.env.ATRIBUCION = "off";
      try {
        const { contactId, conversationId } = await mkContactWithAd(null);
        await store.registrarAnuncioDeOrigen({
          organizationId: org,
          contactId,
          conversationId,
          anuncio: { sourceId: ad("apag"), sourceType: "ad", sourceUrl: null, headline: "H", body: null, mediaType: null, ctwaClid: null, imageUrl: null, raw: {} },
        });
        expect(await metaRow(org, ad("apag"))).toBeUndefined();
      } finally {
        process.env.ATRIBUCION = "on";
      }
    });

    it("enqueueAllFromAttributions recupera la historia (sin posts) y es idempotente", async () => {
      await conectar();
      await mkContactWithAd(ad("h1"));
      await mkContactWithAd(ad("h1"));
      await mkContactWithAd(ad("h2"));
      await mkContactWithAd(ad("post"), { sourceType: "post" });
      const n = await catalog.enqueueAllFromAttributions(org);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(await metaRow(org, ad("h1"))).toBeDefined();
      expect(await metaRow(org, ad("h2"))).toBeDefined();
      expect(await metaRow(org, ad("post"))).toBeUndefined();
      expect(await catalog.enqueueAllFromAttributions(org)).toBe(0);
    });

    it("claimDue: dos reclamos simultáneos reparten las filas sin repetirlas", async () => {
      await conectar();
      for (let i = 0; i < 10; i++) await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad(`c${i}`), sourceType: "ad" });
      const now = new Date(Date.now() + 1000);
      const [a, b] = await Promise.all([catalog.claimDue(org, 6, now), catalog.claimDue(org, 6, now)]);
      const ids = [...a, ...b].map((r) => r.adId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(10);
    });

    it("una toma perdida (proceso caído) se reclama pasados 10 minutos", async () => {
      await conectar();
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("toma"), sourceType: "ad" });
      const now = new Date(Date.now() + 1000);
      expect(await catalog.claimDue(org, 5, now)).toHaveLength(1);
      expect(await catalog.claimDue(org, 5, now)).toHaveLength(0);
      expect(await catalog.claimDue(org, 5, new Date(now.getTime() + 11 * 60_000))).toHaveLength(1);
    });
  });

  /* ─── La sincronización ─── */

  describe("syncOrganization", () => {
    it("resuelve la jerarquía, marca los ausentes y guarda el gasto diario", async () => {
      await conectar();
      for (const id of [ad("a"), ad("b"), ad("gone")]) await catalog.enqueueAdLookup({ organizationId: org, sourceId: id, sourceType: "ad", now: T0 });
      await mkContactWithAd(ad("a"));
      await mkContactWithAd(ad("b"));

      const r = await sync.syncOrganization(org, deps(fakeGraph({ spend: { [ad("a")]: 20 } })));
      expect(r).toMatchObject({ skipped: null, synced: 2, notFound: 1, stopped: null, windows: 4 });
      expect(await metaRow(org, ad("a"))).toMatchObject({ status: "synced", adName: `Nombre ${ad("a")}`, campaignName: "Campaña uno", adsetName: `Conjunto ${ad("a")}`, attempts: 0 });
      expect(await metaRow(org, ad("gone"))).toMatchObject({ status: "not_found" });

      const gasto = async () => db.select().from(schema.metaAdSpend).where(eq(schema.metaAdSpend.adId, ad("a")));
      // Una pasada trae a lo más 4 ventanas de 7 días (28 días): el historial entero llega en varias pasadas.
      expect(await gasto()).toHaveLength(28);
      expect((await settings.getMetaAdsSettings(org))!.lastSpendSyncAt).toEqual(T0);

      const fin = await completar(() => fakeGraph({ spend: { [ad("a")]: 20 } }), new Date(T0.getTime() + 60_000));
      expect(fin.pasadas).toBeLessThanOrEqual(4);
      const todo = await gasto();
      // Primera vez: 90 días de historia, a 20 por día.
      expect(todo).toHaveLength(90);
      expect(todo.every((g) => g.spend === "20.00" && g.currency === "MXN")).toBe(true);
    });

    it("el gasto es idempotente y Meta lo REVISA: se reemplaza la ventana, sin duplicar ni dejar días que ya no existen", async () => {
      await conectar();
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("r"), sourceType: "ad", now: T0 });
      await mkContactWithAd(ad("r"));
      await completar(() => fakeGraph({ spend: { [ad("r")]: 10 } }));
      const cuenta = async () => (await db.select().from(schema.metaAdSpend).where(eq(schema.metaAdSpend.adId, ad("r")))).length;
      expect(await cuenta()).toBe(90);

      // 4 h después: ventana de 7 días, el gasto cambia y un día desaparece de la respuesta.
      const later = new Date(T0.getTime() + 4 * 3_600_000);
      expect(await cuenta()).toBe(90);
      const ayer = addDaysISO(later.toISOString().slice(0, 10), -1);
      await sync.syncOrganization(org, deps(fakeGraph({ spend: { [ad("r")]: 15 }, skipDay: ayer }), later));
      expect(await cuenta()).toBe(90 - 1);
      const filas = await db.select().from(schema.metaAdSpend).where(eq(schema.metaAdSpend.adId, ad("r")));
      expect(filas.find((f) => f.day === ayer)).toBeUndefined();
      expect(filas.find((f) => f.day === later.toISOString().slice(0, 10))!.spend).toBe("15.00");
      // Fuera de la ventana de 7 días se conserva lo anterior.
      expect(filas.find((f) => f.day === addDaysISO(later.toISOString().slice(0, 10), -30))!.spend).toBe("10.00");
    });

    it("el gasto no se vuelve a pedir antes de 3 h, salvo a mano", async () => {
      await conectar();
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("p"), sourceType: "ad", now: T0 });
      await mkContactWithAd(ad("p"));
      const fin = await completar(() => fakeGraph({ spend: { [ad("p")]: 10 } }));
      const calls: string[] = [];
      const luego = new Date(fin.now.getTime() + 3_600_000);
      await sync.syncOrganization(org, deps(fakeGraph({ calls }), luego));
      expect(calls.filter((c) => c.includes("/insights"))).toHaveLength(0);
      await sync.syncOrganization(org, deps(fakeGraph({ calls }), luego), { forceSpend: true });
      // A mano: la ventana de refresco, por anuncio y de la cuenta.
      expect(calls.filter((c) => c.includes("/insights"))).toHaveLength(2);
    });

    it("sin credenciales no llama a nadie", async () => {
      const calls: string[] = [];
      expect(await sync.syncOrganization(org, deps(fakeGraph({ calls })))).toMatchObject({ skipped: "sin_credenciales" });
      expect(calls).toEqual([]);
    });

    it("más de 50 anuncios se consultan en lotes de 50", async () => {
      await conectar();
      for (let i = 0; i < 120; i++) await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad(`l${i}`), sourceType: "ad", now: T0 });
      const calls: string[] = [];
      const r = await sync.syncOrganization(org, deps(fakeGraph({ calls })));
      expect(r.synced).toBe(120);
      expect(calls.filter((c) => c.includes("/ads?") && c.includes("filtering"))).toHaveLength(3);
    });

    it("LÍMITE DE USO: pausa, no gasta intentos y las filas siguen pendientes; luego se recupera", async () => {
      await conectar();
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("rl"), sourceType: "ad", now: T0 });
      const limite = new MetaApiError("(#17) User request limit reached", { status: 400, code: 17 });

      const r1 = await sync.syncOrganization(org, deps(fakeGraph({ fail: () => limite })));
      expect(r1.stopped).toBe("rate_limit");
      const fila = (await metaRow(org, ad("rl")))!;
      expect(fila).toMatchObject({ status: "pending", attempts: 0, lockedAt: null });
      const s = (await settings.getMetaAdsSettings(org))!;
      expect(s.rateHits).toBe(1);
      expect(s.pausedUntil!.getTime()).toBeGreaterThanOrEqual(T0.getTime() + ads.rateLimitBackoffMs(1));
      expect(s.status).toBe("connected");

      // Mientras dura la pausa no se llama a Meta.
      const calls: string[] = [];
      expect((await sync.syncOrganization(org, deps(fakeGraph({ calls }), new Date(T0.getTime() + 60_000)))).skipped).toBe("pausa");
      expect(calls).toEqual([]);

      // Pasada la pausa, vuelve a intentar y, si sale bien, se acaba el castigo.
      const despues = new Date(T0.getTime() + 6 * 60_000);
      const r2 = await sync.syncOrganization(org, deps(fakeGraph(), despues));
      expect(r2).toMatchObject({ synced: 1, stopped: null });
      expect(await settings.getMetaAdsSettings(org)).toMatchObject({ rateHits: 0, pausedUntil: null, lastError: null });
    });

    it("golpes seguidos al límite alargan la espera", async () => {
      await conectar();
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("rl2"), sourceType: "ad", now: T0 });
      const limite = new MetaApiError("limit", { status: 400, code: 80004 });
      await sync.syncOrganization(org, deps(fakeGraph({ fail: () => limite })));
      const t1 = new Date(T0.getTime() + 6 * 60_000);
      await sync.syncOrganization(org, deps(fakeGraph({ fail: () => limite }), t1));
      const s = (await settings.getMetaAdsSettings(org))!;
      expect(s.rateHits).toBe(2);
      expect(s.pausedUntil!.getTime()).toBeGreaterThanOrEqual(t1.getTime() + ads.rateLimitBackoffMs(2));
    });

    it("FALLO TRANSITORIO: cuenta un intento con espera creciente y a los 6 pasa a «failed»", async () => {
      await conectar();
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("tr"), sourceType: "ad", now: T0 });
      const caida = new MetaApiError("Service unavailable", { status: 503 });
      let now = T0;
      for (let i = 1; i <= 5; i++) {
        const r = await sync.syncOrganization(org, deps(fakeGraph({ fail: () => caida }), now));
        expect(r.stopped).toBe("transient");
        const fila = (await metaRow(org, ad("tr")))!;
        expect(fila).toMatchObject({ status: "pending", attempts: i, lockedAt: null });
        expect(fila.nextAttemptAt.getTime()).toBe(now.getTime() + ads.transientBackoffMs(i));
        now = new Date(fila.nextAttemptAt.getTime() + 1000);
      }
      await sync.syncOrganization(org, deps(fakeGraph({ fail: () => caida }), now));
      const fin = (await metaRow(org, ad("tr")))!;
      expect(fin).toMatchObject({ status: "failed", attempts: 6 });
      expect(fin.nextAttemptAt.getTime()).toBe(now.getTime() + ads.RECHECK_FAILED_MS);
      // Y el conector sigue sano: un anuncio caído no apaga la cuenta.
      expect((await settings.getMetaAdsSettings(org))!.status).toBe("connected");
    });

    it("lo «failed» vuelve a intentarse cuando vence su plazo, y se cura solo", async () => {
      await conectar();
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("cura"), sourceType: "ad", now: T0 });
      await db.update(schema.metaAd).set({ status: "failed", attempts: 6, nextAttemptAt: new Date(T0.getTime() + 3_600_000) }).where(eq(schema.metaAd.adId, ad("cura")));
      expect((await sync.syncOrganization(org, deps(fakeGraph()))).synced).toBe(0);
      const r = await sync.syncOrganization(org, deps(fakeGraph(), new Date(T0.getTime() + 2 * 3_600_000)));
      expect(r.synced).toBe(1);
      expect((await metaRow(org, ad("cura")))!.status).toBe("synced");
    });

    it("TOKEN CAÍDO: marca el conector en error, suelta las tomas y se detiene sin tocar Meta de nuevo", async () => {
      await conectar();
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("au"), sourceType: "ad", now: T0 });
      const malo = new MetaApiError(`Invalid OAuth access token. access_token=${TOKEN}`, { status: 401, code: 190 });
      const r = await sync.syncOrganization(org, deps(fakeGraph({ fail: () => malo })));
      expect(r.stopped).toBe("auth");
      const s = (await settings.getMetaAdsSettings(org))!;
      expect(s.status).toBe("error");
      // El token NUNCA queda en el mensaje guardado.
      expect(s.lastError).not.toContain(TOKEN);
      expect(s.lastError).not.toContain("SECRETO");
      expect(await metaRow(org, ad("au"))).toMatchObject({ status: "pending", attempts: 0, lockedAt: null });

      const calls: string[] = [];
      expect((await sync.syncOrganization(org, deps(fakeGraph({ calls })))).skipped).toBe("error");
      expect(calls).toEqual([]);

      // El dueño guarda un token nuevo: todo vuelve a andar.
      await conectar(org, TOKEN + "nuevo");
      expect((await sync.syncOrganization(org, deps(fakeGraph()))).synced).toBe(1);
    });

    it("SIN PERMISO ads_read: error del conector con un mensaje que lo explica", async () => {
      await conectar();
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("pe"), sourceType: "ad", now: T0 });
      const r = await sync.syncOrganization(org, deps(fakeGraph({ fail: () => new MetaApiError("(#200) Permissions error", { status: 403, code: 200 }) })));
      expect(r.stopped).toBe("permission");
      expect((await settings.getMetaAdsSettings(org))!.lastError).toContain("ads_read");
    });

    it("ERROR PERMANENTE de un lote: ese lote queda «failed» pero la pasada sigue y no apaga el conector", async () => {
      await conectar();
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("pm"), sourceType: "ad", now: T0 });
      const r = await sync.syncOrganization(org, deps(fakeGraph({ fail: (p) => (p.includes("/ads?") ? new MetaApiError("(#100) Invalid parameter", { status: 400, code: 100 }) : null) })));
      expect(r.stopped).toBeNull();
      expect(await metaRow(org, ad("pm"))).toMatchObject({ status: "failed", attempts: 1 });
      expect((await settings.getMetaAdsSettings(org))!.status).toBe("connected");
    });

    it("USO ALTO (≥ 90 %): frena de forma preventiva, pero esa llamada sí se aprovecha", async () => {
      await conectar();
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("uso"), sourceType: "ad", now: T0 });
      const g = fakeGraph();
      const conUso: typeof g = async (path, token, onHeaders) => {
        const out = await g(path, token, () => {});
        onHeaders(new Headers({ "x-business-use-case-usage": JSON.stringify({ "1": [{ call_count: 95, estimated_time_to_regain_access: 3 }] }) }));
        return out;
      };
      const r = await sync.syncOrganization(org, deps(conUso));
      expect(r.stopped).toBe("uso_alto");
      expect((await metaRow(org, ad("uso")))!.status).toBe("synced");
      const s = (await settings.getMetaAdsSettings(org))!;
      expect(s.pausedUntil!.getTime()).toBe(T0.getTime() + 3 * 60_000);
    });

    it("una organización con problemas no frena a las demás (tick por todas)", async () => {
      await conectar(org);
      await conectar(otherOrg);
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("o1"), sourceType: "ad", now: T0 });
      await catalog.enqueueAdLookup({ organizationId: otherOrg, sourceId: ad("o2"), sourceType: "ad", now: T0 });
      const g = fakeGraph();
      let n = 0;
      // La primera organización recibe un error; la segunda, datos.
      const unaFalla: typeof g = async (p, t, h) => {
        if (n++ === 0) throw new MetaApiError("boom", { status: 503 });
        return g(p, t, h);
      };
      await worker.tickMetaAds(deps(unaFalla));
      const estados = [await metaRow(org, ad("o1")), await metaRow(otherOrg, ad("o2"))].map((f) => f?.status).sort();
      expect(estados).toEqual(["pending", "synced"]);
    });

    it("aislamiento: la sincronización de una organización jamás escribe en otra", async () => {
      await conectar(org);
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("ais"), sourceType: "ad", now: T0 });
      await mkContactWithAd(ad("ais"));
      await sync.syncOrganization(org, deps(fakeGraph()));
      expect(await metaRow(otherOrg, ad("ais"))).toBeUndefined();
      expect(await db.select().from(schema.metaAdSpend).where(eq(schema.metaAdSpend.organizationId, otherOrg))).toHaveLength(0);
    });

    it("sin la bandera, el tick no hace nada", async () => {
      await conectar();
      await catalog.enqueueAdLookup({ organizationId: org, sourceId: ad("off"), sourceType: "ad", now: T0 });
      process.env.ATRIBUCION = "off";
      try {
        expect(await worker.tickMetaAds(deps(fakeGraph()))).toBe(0);
      } finally {
        process.env.ATRIBUCION = "on";
      }
      expect((await metaRow(org, ad("off")))!.status).toBe("pending");
    });

    it("«Sincronizar ahora» tiene enfriamiento de 60 s", async () => {
      await conectar();
      const d = deps(fakeGraph());
      const a = await worker.syncNow(org, d);
      expect("summary" in a).toBe(true);
      const b = await worker.syncNow(org, d);
      expect(b).toMatchObject({ waitSeconds: expect.any(Number) });
      const c = await worker.syncNow(org, deps(fakeGraph(), new Date(T0.getTime() + 61_000)));
      expect("summary" in c).toBe(true);
    });
  });

  /* ─── Resultados ─── */

  describe("Resultados con jerarquía y gasto", () => {
    const rango = () => period.resolvePeriod({ from: addDaysISO(hoy(), -1), to: addDaysISO(hoy(), 1), timezone: "UTC", now: T0 });

    /** a1 y a2 de la campaña 1; a3 de la campaña 2; a4 sin catálogo. Gasto de hoy. */
    async function montar() {
      await conectar();
      const sync_ = new Date();
      for (const [id, camp, adset] of [
        [ad("a1"), "c1", "s1"],
        [ad("a2"), "c1", "s2"],
        [ad("a3"), "c2", "s3"],
      ] as const) {
        await db.insert(schema.metaAd).values({
          id: newId("metaAd"), organizationId: org, adId: id, status: "synced", adName: `Nombre ${id}`,
          adsetId: adset, adsetName: `Conjunto ${adset}`, campaignId: camp, campaignName: `Campaña ${camp}`, syncedAt: sync_,
        });
      }
      const gasto = async (id: string, amount: string, currency = "MXN") =>
        db.insert(schema.metaAdSpend).values({ id: newId("metaAdSpend"), organizationId: org, adId: id, day: hoy(), spend: amount, currency });
      await gasto(ad("a1"), "100.00");
      await gasto(ad("a2"), "50.00");
      await gasto(ad("a3"), "70.00");
      await gasto(ad("solo-gasto"), "30.00");

      const c1 = [await mkContactWithAd(ad("a1")), await mkContactWithAd(ad("a1")), await mkContactWithAd(ad("a1")), await mkContactWithAd(ad("a1"))];
      await mkContactWithAd(ad("a2"));
      await mkContactWithAd(ad("a2"));
      await mkContactWithAd(ad("a3"));
      await mkContactWithAd(ad("a4"));
      return { c1 };
    }

    const q = (over: Partial<import("@/server/analytics/ads-hierarchy").AdsQuery> = {}) => ({ group: "ad" as const, campaignId: null, adsetId: null, ...over });

    it("por anuncio: jerarquía, gasto y costos; el anuncio sin conversaciones aparece", async () => {
      await montar();
      const b = await analytics.adsBlock(org, rango(), q());
      const por = Object.fromEntries(b.ads.map((a) => [a.key, a]));
      expect(por[ad("a1")]).toMatchObject({ conversations: 4, campaignName: "Campaña c1", adsetName: "Conjunto s1", spend: 100, costPerConversation: 25, costPerLead: null });
      expect(por[ad("a4")]).toMatchObject({ conversations: 1, campaignId: null, spend: null, costPerConversation: null });
      expect(por[ad("solo-gasto")]).toMatchObject({ conversations: 0, spend: 30, costPerConversation: null });
      expect(b.hierarchy).toMatchObject({ connected: true, hasData: true, mixedCurrency: false, currency: "MXN", problem: null });
      expect(b.campaigns!.map((c) => c.id)).toEqual(["c1", "c2"]);
    });

    it("por campaña y por conjunto", async () => {
      await montar();
      const camp = await analytics.adsBlock(org, rango(), q({ group: "campaign" }));
      expect(camp.groups!.find((g) => g.key === "c1")).toMatchObject({ ads: 2, conversations: 6, spend: 150, costPerConversation: 25 });
      expect(camp.groups!.find((g) => g.key === "c2")).toMatchObject({ ads: 1, conversations: 1, spend: 70 });
      expect(camp.groups!.find((g) => g.key === "sin-identificar")).toMatchObject({ ads: 2 });
      const set = await analytics.adsBlock(org, rango(), q({ group: "adset" }));
      expect(set.groups!.map((g) => g.key)).toEqual(expect.arrayContaining(["s1", "s2", "s3"]));
      expect(set.groups!.find((g) => g.key === "s2")).toMatchObject({ campaignName: "Campaña c1", conversations: 2, spend: 50 });
    });

    it("filtra por campaña y por conjunto, y «sin identificar»", async () => {
      await montar();
      const c2 = await analytics.adsBlock(org, rango(), q({ campaignId: "c2" }));
      expect(c2.ads.map((a) => a.key)).toEqual([ad("a3")]);
      const s2 = await analytics.adsBlock(org, rango(), q({ adsetId: "s2" }));
      expect(s2.ads.map((a) => a.key)).toEqual([ad("a2")]);
      const sin = await analytics.adsBlock(org, rango(), q({ campaignId: "sin-identificar" }));
      expect(sin.ads.map((a) => a.key).sort()).toEqual([ad("a4"), ad("solo-gasto")].sort());
    });

    it("costo por cita: cuenta las citas del periodo de quienes llegaron del anuncio, sin canceladas ni pruebas", async () => {
      const { c1 } = await montar();
      const cita = (contactId: string, over: Record<string, unknown> = {}) =>
        db.insert(schema.booking).values({ id: newId("booking"), organizationId: org, contactId, scheduledAt: new Date(Date.now() + 86_400_000), durationMinutes: 30, ...over });
      await cita(c1[0]!.contactId);
      await cita(c1[1]!.contactId);
      await cita(c1[2]!.contactId, { status: "cancelada" });
      await cita(c1[3]!.contactId, { isTest: true });
      const b = await analytics.adsBlock(org, rango(), q());
      expect(b.ads.find((a) => a.key === ad("a1"))).toMatchObject({ bookings: 2, costPerBooking: 50 });
    });

    it("con la agenda APAGADA no hay citas ni costo por cita", async () => {
      await montar();
      process.env.AGENDA = "off";
      try {
        const b = await analytics.adsBlock(org, rango(), q());
        expect(b.ads.find((a) => a.key === ad("a1"))).toMatchObject({ bookings: null, costPerBooking: null });
      } finally {
        process.env.AGENDA = "on";
      }
    });

    it("el Laboratorio no cuenta: ni sus conversaciones ni su gasto atribuido", async () => {
      await montar();
      await mkContactWithAd(ad("a1"), { isTest: true });
      const b = await analytics.adsBlock(org, rango(), q());
      expect(b.ads.find((a) => a.key === ad("a1"))!.conversations).toBe(4);
    });

    it("el gasto se corta por las fechas del periodo", async () => {
      await montar();
      const fuera = period.resolvePeriod({ from: addDaysISO(hoy(), -20), to: addDaysISO(hoy(), -10), timezone: "UTC", now: T0 });
      const b = await analytics.adsBlock(org, fuera, q());
      expect(b.ads.find((a) => a.key === ad("a1"))).toBeUndefined();
      expect(b.ads.find((a) => a.key === ad("solo-gasto"))).toBeUndefined();
    });

    it("monedas mezcladas en el rango: no se suma y se avisa", async () => {
      await montar();
      await db.insert(schema.metaAdSpend).values({ id: newId("metaAdSpend"), organizationId: org, adId: ad("a2"), day: addDaysISO(hoy(), 1), spend: "9.00", currency: "USD" });
      const b = await analytics.adsBlock(org, rango(), q());
      expect(b.hierarchy!.mixedCurrency).toBe(true);
      expect(b.ads.every((a) => a.spend === null)).toBe(true);
    });

    it("AISLAMIENTO: otra organización no ve ni el catálogo ni el gasto de esta", async () => {
      await montar();
      const b = await analytics.adsBlock(otherOrg, rango(), q());
      expect(b.ads.find((a) => a.key.startsWith(`ad-${uid}`))).toBeUndefined();
      expect(b.campaigns ?? []).toEqual([]);
      expect(b.hierarchy).toMatchObject({ connected: false, hasData: false });
    });

    it("BANDERA APAGADA: el bloque es exactamente el de 019, sin una clave más", async () => {
      await montar();
      process.env.ATRIBUCION = "off";
      try {
        const b = await analytics.adsBlock(org, rango(), q({ group: "campaign" }));
        expect(Object.keys(b).sort()).toEqual(["ads", "adShare", "conversations", "empty", "period", "sources"].sort());
        expect(b.ads.find((a) => a.key === ad("a1"))).toBeDefined();
        expect("spend" in b.ads[0]!).toBe(false);
        expect("campaignName" in b.ads[0]!).toBe(false);
      } finally {
        process.env.ATRIBUCION = "on";
      }
    });

    it("SIN credenciales ni catálogo con la bandera encendida: conteos de 019 y nada de gasto", async () => {
      await mkContactWithAd(ad("x1"));
      const b = await analytics.adsBlock(org, rango(), q());
      expect(b.hierarchy).toMatchObject({ connected: false, hasData: false });
      const fila = b.ads.find((a) => a.key === ad("x1"))!;
      expect(fila).toMatchObject({ conversations: 1, spend: null, costPerConversation: null });
    });

    it("desconectar conserva lo traído: Resultados sigue mostrando el gasto histórico", async () => {
      await montar();
      await settings.deleteMetaAdsSettings(org);
      const b = await analytics.adsBlock(org, rango(), q());
      expect(b.hierarchy).toMatchObject({ connected: false, hasData: true });
      expect(b.ads.find((a) => a.key === ad("a1"))).toMatchObject({ spend: 100, campaignName: "Campaña c1" });
    });

    it("la tarjeta del contacto lleva Campaña › Conjunto › Anuncio solo si el anuncio está sincronizado", async () => {
      await montar();
      const { contactId } = await mkContactWithAd(ad("a2"));
      const dto = await store.anuncioDelContacto(org, contactId);
      expect(dto).toMatchObject({ campaignName: "Campaña c1", adsetName: "Conjunto s2", adName: `Nombre ${ad("a2")}` });
      const sinCat = await mkContactWithAd(ad("a4"));
      const dto2 = await store.anuncioDelContacto(org, sinCat.contactId);
      expect(dto2!.campaignName).toBeUndefined();
      process.env.ATRIBUCION = "off";
      try {
        expect((await store.anuncioDelContacto(org, contactId))!.campaignName).toBeUndefined();
      } finally {
        process.env.ATRIBUCION = "on";
      }
    });
  });

  /* ─── 039: la cuenta entera, no solo lo que ya escribió ─── */

  describe("039 — catálogo completo de la cuenta", () => {
    const CUENTA: AnuncioFalso[] = [
      { id: "c-1", name: "Anuncio Alfa 1", adset: ["s-1", "Conjunto Alfa"], campaign: ["k-a", "Campaña Alfa"] },
      { id: "c-2", name: "Anuncio Beta 1", status: "CAMPAIGN_PAUSED", adset: ["s-2", "Conjunto Beta"], campaign: ["k-b", "Campaña Beta (pausada)"] },
      { id: "c-3", name: "Anuncio sin gasto", status: "PAUSED", adset: ["s-2", "Conjunto Beta"], campaign: ["k-b", "Campaña Beta (pausada)"] },
    ];
    const id = (n: string) => `${n}-${uid}`;
    const cuenta = () => CUENTA.map((a) => ({ ...a, id: id(a.id) }));
    const gasto = () => ({ [id("c-1")]: 20, [id("c-2")]: 30, [id("gone")]: 7 });
    const rangoHoy = () => period.resolvePeriod({ from: addDaysISO(hoy(), -1), to: hoy(), timezone: "UTC", now: T0 });
    const consulta = { group: "campaign" as const, campaignId: null, adsetId: null };

    it("trae anuncios SIN conversaciones (también pausados) y el que gastó y ya no está en el listado", async () => {
      await conectar(org, TOKEN, { catalogoAlDia: false });
      // Nadie escribió desde ningún anuncio: antes de 039 esto no traía NADA.
      const r = await sync.syncOrganization(org, deps(fakeGraph({ account: cuenta(), spend: gasto() })));
      expect(r).toMatchObject({ skipped: null, stopped: null, catalogAds: 3 });

      expect(await metaRow(org, id("c-1"))).toMatchObject({ status: "synced", adName: "Anuncio Alfa 1", campaignName: "Campaña Alfa", effectiveStatus: "ACTIVE" });
      expect(await metaRow(org, id("c-2"))).toMatchObject({ effectiveStatus: "CAMPAIGN_PAUSED", campaignName: "Campaña Beta (pausada)" });
      expect((await metaRow(org, id("c-3")))!.listedAt).not.toBeNull();
      // El borrado no está en el listado pero gastó: entra por su gasto. Nombre y campaña vienen del gasto cuando los trae.
      expect(await metaRow(org, id("gone"))).toBeUndefined();

      const filas = await db.select().from(schema.metaAdSpend).where(and(eq(schema.metaAdSpend.organizationId, org), inArray(schema.metaAdSpend.adId, [id("c-1"), id("c-2"), id("gone")])));
      expect(new Set(filas.map((f) => f.adId))).toEqual(new Set([id("c-1"), id("c-2"), id("gone")]));
      const cfg = (await settings.getMetaAdsSettings(org))!;
      expect(cfg.catalogSyncedAt).toEqual(T0);
      expect(cfg.accountTimezone).toBe("America/Mexico_City");
    });

    it("un anuncio que gastó y ya no se lista entra al catálogo con la jerarquía que trae su gasto", async () => {
      await conectar(org, TOKEN, { catalogoAlDia: false });
      // `account` lo conoce solo para armar la fila de gasto con nombres; el listado de la cuenta no lo devuelve.
      const borrado: AnuncioFalso = { id: id("gone"), name: "Anuncio borrado", adset: ["s-1", "Conjunto Alfa"], campaign: ["k-a", "Campaña Alfa"] };
      const g = fakeGraph({ account: cuenta(), spend: gasto() });
      const sinListarlo: typeof g = async (path, token, h) => {
        const out = (await g(path, token, h)) as { data?: { id?: string }[] };
        return path.includes("/ads?") && !path.includes("filtering") ? { data: (out.data ?? []).filter((a) => a.id !== borrado.id) } : out;
      };
      // El gasto no sabe nombres del borrado en el doble (no está en `account`): se agrega con el mismo doble.
      const conBorrado = fakeGraph({ account: [...cuenta(), borrado], spend: gasto() });
      const mezcla: typeof g = async (path, token, h) => (path.includes("/insights?") ? conBorrado(path, token, h) : sinListarlo(path, token, h));
      await sync.syncOrganization(org, deps(mezcla));
      expect(await metaRow(org, id("gone"))).toMatchObject({ status: "synced", adName: "Anuncio borrado", campaignName: "Campaña Alfa", listedAt: null });
    });

    it("Resultados lista la campaña pausada con gasto y 0 conversaciones, y el total cuadra con la cuenta al centavo", async () => {
      await conectar(org, TOKEN, { catalogoAlDia: false });
      await sync.syncOrganization(org, deps(fakeGraph({ account: cuenta(), spend: gasto() })));
      const b = await analytics.adsBlock(org, rangoHoy(), consulta);
      const beta = b.groups!.find((g) => g.name === "Campaña Beta (pausada)")!;
      // 30/día en 2 días (ayer y hoy).
      expect(beta).toMatchObject({ conversations: 0, leads: 0, spend: 60, status: "paused", costPerConversation: null });
      expect(b.groups!.find((g) => g.name === "Campaña Alfa")).toMatchObject({ status: "active" });
      // Alfa: 20 + 7 (el borrado, sin jerarquía en este doble) por día; el total es la suma de TODO lo traído.
      expect(b.total!.spend).toBe(2 * (20 + 30 + 7));
      expect(b.hierarchy!.account).toEqual({ spend: 2 * (20 + 30 + 7), unattributed: null });
      expect(b.empty).toBe(false);
    });

    it("lo que la cuenta gastó y ningún anuncio explica sale como «sin desglosar», no se maquilla", async () => {
      await conectar(org, TOKEN, { catalogoAlDia: false });
      await sync.syncOrganization(org, deps(fakeGraph({ account: cuenta(), spend: gasto(), extraAccount: 3.25 })));
      const b = await analytics.adsBlock(org, rangoHoy(), consulta);
      expect(b.hierarchy!.account).toEqual({ spend: 2 * (57 + 3.25), unattributed: 6.5 });
    });

    it("el listado se vuelve a leer cada 12 h y actualiza el estado; no pisa un nombre con null", async () => {
      await conectar(org, TOKEN, { catalogoAlDia: false });
      await sync.syncOrganization(org, deps(fakeGraph({ account: cuenta(), spend: gasto() })));
      const calls: string[] = [];
      await sync.syncOrganization(org, deps(fakeGraph({ account: cuenta(), spend: gasto(), calls }), new Date(T0.getTime() + 3_600_000)));
      expect(calls.filter((c) => c.includes("/ads?"))).toHaveLength(0);

      // 13 h después el listado vuelve, ahora con el anuncio pausado y sin nombre.
      const luego = new Date(T0.getTime() + 13 * 3_600_000);
      const pausado = cuenta().map((a) => (a.id === id("c-1") ? { ...a, status: "PAUSED" } : a));
      const g = fakeGraph({ account: pausado, spend: gasto() });
      const sinNombre: typeof g = async (path, token, h) => {
        const out = (await g(path, token, h)) as { data?: Record<string, unknown>[] };
        if (path.includes("/ads?") && !path.includes("filtering")) {
          return { data: (out.data ?? []).map((a) => (a.id === id("c-1") ? { ...a, name: undefined } : a)) };
        }
        return out;
      };
      await sync.syncOrganization(org, deps(sinNombre, luego));
      expect(await metaRow(org, id("c-1"))).toMatchObject({ effectiveStatus: "PAUSED", adName: "Anuncio Alfa 1" });
    });

    it("una ventana de gasto TRUNCADA no se reemplaza: dinero a medias es peor que dinero viejo", async () => {
      await conectar(org, TOKEN, { catalogoAlDia: false });
      await db.insert(schema.metaAdSpend).values({ id: newId("metaAdSpend"), organizationId: org, adId: id("c-1"), day: hoy(), spend: "99.00", currency: "MXN" });
      const r = await sync.syncOrganization(org, deps(fakeGraph({ account: cuenta(), spend: gasto(), endlessSpendPages: 2 })));
      expect(r.stopped).toBe("ventana_incompleta");
      const fila = (await db.select().from(schema.metaAdSpend).where(and(eq(schema.metaAdSpend.organizationId, org), eq(schema.metaAdSpend.adId, id("c-1")))))[0]!;
      expect(fila.spend).toBe("99.00");
      expect((await settings.getMetaAdsSettings(org))!.lastError).toContain("demasiadas filas");
      // Y no se da por sincronizada ni cubierta: se reintenta pronto.
      const cfg = (await settings.getMetaAdsSettings(org))!;
      expect(cfg.lastSpendSyncAt).toBeNull();
      expect(cfg.spendCoveredSince).toBeNull();
    });

    it("un límite de uso a mitad del gasto detiene la pasada sin reemplazar nada ni cubrir el rango", async () => {
      await conectar(org, TOKEN, { catalogoAlDia: false });
      const limite = new MetaApiError("(#17) User request limit reached", { status: 400, code: 17 });
      const r = await sync.syncOrganization(org, deps(fakeGraph({ account: cuenta(), spend: gasto(), fail: (p) => (p.includes("/insights?") ? limite : null) })));
      expect(r.stopped).toBe("rate_limit");
      expect(await db.select().from(schema.metaAdSpend).where(eq(schema.metaAdSpend.organizationId, org))).toHaveLength(0);
      expect((await settings.getMetaAdsSettings(org))!.spendCoveredSince).toBeNull();
      // El listado, que ya había llegado, SÍ se conserva (es catálogo, no dinero).
      expect(await metaRow(org, id("c-1"))).toBeDefined();
    });

    it("un rango más viejo que lo cubierto ENCARGA el relleno (sin llamar a Meta) y se cubre en varias pasadas", async () => {
      await conectar(org, TOKEN, { catalogoAlDia: false });
      const fin0 = await completar(() => fakeGraph({ account: cuenta(), spend: gasto() }));
      expect((await settings.getMetaAdsSettings(org))!.spendCoveredSince).toBe(addDaysISO(hoy(), -89));

      const desde = addDaysISO(hoy(), -200);
      const rango = period.resolvePeriod({ from: desde, to: hoy(), timezone: "UTC", now: T0 });
      const calls: string[] = [];
      const antes = await analytics.adsBlock(org, rango, consulta);
      expect(calls).toEqual([]);
      expect(antes.hierarchy!.syncing).toBe(true);
      expect((await settings.getMetaAdsSettings(org))!.spendBackfillFrom).toBe(desde);

      // Pedirlo otra vez no cambia nada (solo adelanta, nunca borra un pedido más antiguo).
      await analytics.adsBlock(org, period.resolvePeriod({ from: addDaysISO(hoy(), -100), to: hoy(), timezone: "UTC", now: T0 }), consulta);
      expect((await settings.getMetaAdsSettings(org))!.spendBackfillFrom).toBe(desde);

      const fin = await completar(() => fakeGraph({ account: cuenta(), spend: gasto() }), new Date(fin0.now.getTime() + 60_000), 30);
      // 110 días más a 28 por pasada.
      expect(fin.pasadas).toBeGreaterThan(1);
      const cfg = (await settings.getMetaAdsSettings(org))!;
      expect(cfg.spendCoveredSince).toBe(desde);
      expect(cfg.spendBackfillFrom).toBeNull();
      expect((await analytics.adsBlock(org, rango, consulta)).hierarchy!.syncing).toBe(false);
    });

    it("el rango reciente (ya cubierto) no encarga nada", async () => {
      await conectar(org, TOKEN, { catalogoAlDia: false });
      await completar(() => fakeGraph({ account: cuenta(), spend: gasto() }));
      const b = await analytics.adsBlock(org, rangoHoy(), consulta);
      expect(b.hierarchy!.syncing).toBe(false);
      expect((await settings.getMetaAdsSettings(org))!.spendBackfillFrom).toBeNull();
    });

    it("aislamiento: el gasto de la cuenta de una organización nunca se mezcla con el de otra", async () => {
      await conectar(org, TOKEN, { catalogoAlDia: false });
      await conectar(otherOrg, TOKEN + "otra", { catalogoAlDia: false });
      await db.insert(schema.metaAccountSpend).values({ id: newId("metaAccountSpend"), organizationId: otherOrg, day: hoy(), spend: "1000.00", currency: "MXN" });
      await sync.syncOrganization(org, deps(fakeGraph({ account: cuenta(), spend: gasto() })));
      const ajeno = await db.select().from(schema.metaAccountSpend).where(eq(schema.metaAccountSpend.organizationId, otherOrg));
      expect(ajeno).toHaveLength(1);
      expect(ajeno[0]!.spend).toBe("1000.00");
      const b = await analytics.adsBlock(org, rangoHoy(), consulta);
      expect(b.hierarchy!.account!.spend).toBe(2 * 57);
    });

    it("sin la bandera el bloque es exactamente el de 019: ni una llave de 038 ni de 039", async () => {
      await conectar(org, TOKEN, { catalogoAlDia: false });
      await sync.syncOrganization(org, deps(fakeGraph({ account: cuenta(), spend: gasto() })));
      process.env.ATRIBUCION = "off";
      try {
        const b = await analytics.adsBlock(org, rangoHoy(), consulta);
        for (const k of ["hierarchy", "total", "groups", "groupBy", "campaigns", "adsets"]) expect(b).not.toHaveProperty(k);
      } finally {
        process.env.ATRIBUCION = "on";
      }
    });

    it("Ajustes → Anuncios: el enrutamiento muestra los nombres reales y el catálogo ofrece los anuncios de la cuenta", async () => {
      await conectar(org, TOKEN, { catalogoAlDia: false });
      await sync.syncOrganization(org, deps(fakeGraph({ account: cuenta(), spend: gasto() })));
      await mkContactWithAd(id("c-1"));
      const adFlow = await import("@/server/attribution/ad-flow");
      const lista = await adFlow.listAdFlows(org);
      const item = lista.items.find((i) => i.sourceId === id("c-1"))!;
      expect(item).toMatchObject({ adName: "Anuncio Alfa 1", adsetName: "Conjunto Alfa", campaignName: "Campaña Alfa", effectiveStatus: "ACTIVE" });

      const cat = await adFlow.listCatalogAds(org);
      const propios = cat.ads.filter((a) => a.adId.endsWith(`-${uid}`));
      // Los activos primero; la etiqueta es «Campaña › Conjunto › Anuncio».
      expect(propios[0]).toMatchObject({ adId: id("c-1"), label: "Campaña Alfa › Conjunto Alfa › Anuncio Alfa 1" });
      expect(propios.map((a) => a.adId)).toContain(id("c-3"));
    });

    it("el catálogo de otra organización no aparece en el enrutamiento", async () => {
      await conectar(org, TOKEN, { catalogoAlDia: false });
      await sync.syncOrganization(org, deps(fakeGraph({ account: cuenta(), spend: gasto() })));
      const adFlow = await import("@/server/attribution/ad-flow");
      expect((await adFlow.listCatalogAds(otherOrg)).ads.filter((a) => a.adId.endsWith(`-${uid}`))).toEqual([]);
    });
  });

  /* ─── 040: los creativos de los anuncios ─── */

  describe("040 — creativos", () => {
    // La copia local está APAGADA por defecto (AD_CREATIVE_LOCAL_COPY): estas pruebas la encienden; la de abajo la apaga.
    const copiaAntes = process.env.AD_CREATIVE_LOCAL_COPY;
    beforeEach(() => {
      process.env.AD_CREATIVE_LOCAL_COPY = "on";
    });
    afterAll(() => {
      if (copiaAntes === undefined) delete process.env.AD_CREATIVE_LOCAL_COPY;
      else process.env.AD_CREATIVE_LOCAL_COPY = copiaAntes;
    });
    const id = (n: string) => `${n}-${uid}`;
    const IMG = (n: string) => `https://scontent.xx.fbcdn.net/${uid}/${n}.jpg`;
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const consulta = { group: "ad" as const, campaignId: null, adsetId: null };
    const rangoHoy = () => period.resolvePeriod({ from: addDaysISO(hoy(), -1), to: hoy(), timezone: "UTC", now: T0 });

    /** Un descargador de mentira: cuenta llamadas y falla según el patrón de la URL. */
    function descargador(calls: string[] = [], reglas: { permanente?: RegExp; transitoria?: RegExp } = {}) {
      return async (url: string) => {
        calls.push(url);
        if (reglas.permanente?.test(url)) return { ok: false as const, falla: "permanente" as const };
        if (reglas.transitoria?.test(url)) return { ok: false as const, falla: "transitoria" as const };
        return { ok: true as const, data: PNG, mimeType: "image/png" };
      };
    }

    const CUENTA = (): AnuncioFalso[] => [
      { id: id("k-1"), name: "Con todo", link: "https://fb.me/e/uno", creative: { id: "cr-1", title: "Titular uno", body: "Texto uno", image: IMG("uno"), thumb: IMG("uno-t") } },
      { id: id("k-2"), name: "Sin nada", creative: undefined },
    ];
    const gasto = () => ({ [id("k-1")]: 10 });
    const conectarNuevo = () => conectar(org, TOKEN, { catalogoAlDia: false });
    const asset = async (assetId: string | null) =>
      assetId ? (await db.select().from(schema.mediaAsset).where(eq(schema.mediaAsset.id, assetId)))[0] : undefined;

    it("el listado guarda titular, texto, enlace y URLs del creativo, y la imagen se copia al volumen de la organización", async () => {
      await conectarNuevo();
      const calls: string[] = [];
      const r = await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), T0, descargador(calls)));
      expect(r.creatives).toBe(1);

      const fila = (await metaRow(org, id("k-1")))!;
      expect(fila).toMatchObject({ creativeId: "cr-1", creativeTitle: "Titular uno", creativeBody: "Texto uno", previewLink: "https://fb.me/e/uno" });
      expect(fila.creativeImageUrl).toBe(IMG("uno"));
      expect(fila.creativeSourceUrl).toBe(IMG("uno"));
      // La imagen completa primero; no se pidió la miniatura.
      expect(calls).toEqual([IMG("uno")]);

      const copia = (await asset(fila.creativeAssetId))!;
      expect(copia).toMatchObject({ organizationId: org, kind: "image", mimeType: "image/png", fetchStatus: "available" });
      expect((copia.payload as { origen?: string }).origen).toBe("catalogo");
      // Un anuncio sin creativo no genera copia.
      expect((await metaRow(org, id("k-2")))!.creativeAssetId).toBeNull();
    });

    it("con AD_CREATIVE_LOCAL_COPY apagada no se descarga ni se escribe nada, y las URL remotas se conservan", async () => {
      delete process.env.AD_CREATIVE_LOCAL_COPY;
      await conectarNuevo();
      const calls: string[] = [];
      const r = await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), T0, descargador(calls)));
      expect(r.creatives).toBe(0);
      expect(calls).toEqual([]);
      const fila = (await metaRow(org, id("k-1")))!;
      expect(fila).toMatchObject({ creativeTitle: "Titular uno", creativeAssetId: null, creativeSourceUrl: null });
      expect(fila.creativeImageUrl).toBe(IMG("uno"));
      expect(fila.creativeThumbUrl).toBe(IMG("uno-t"));
      const copias = await db.select().from(schema.mediaAsset).where(and(eq(schema.mediaAsset.organizationId, org), sql`${schema.mediaAsset.payload}->>'origen' = 'catalogo'`));
      expect(copias).toHaveLength(0);
    });

    it("una imagen que no baja de forma permanente (p. ej. pasa del tope) cae a la miniatura", async () => {
      await conectarNuevo();
      const calls: string[] = [];
      await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), T0, descargador(calls, { permanente: /uno\.jpg$/ })));
      const fila = (await metaRow(org, id("k-1")))!;
      expect(calls).toEqual([IMG("uno"), IMG("uno-t")]);
      expect(fila.creativeSourceUrl).toBe(IMG("uno-t"));
      expect(fila.creativeAssetId).not.toBeNull();
    });

    it("una copia al día no se vuelve a bajar (aunque venga de la miniatura)", async () => {
      await conectarNuevo();
      await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), T0, descargador([], { permanente: /uno\.jpg$/ })));
      const calls: string[] = [];
      const luego = new Date(T0.getTime() + 13 * 3_600_000);
      await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), luego, descargador(calls)));
      expect(calls).toEqual([]);
    });

    it("si el creativo CAMBIA de imagen se copia la nueva y se borra la vieja (fila y archivo)", async () => {
      await conectarNuevo();
      await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), T0, descargador()));
      const vieja = (await metaRow(org, id("k-1")))!.creativeAssetId!;

      const nueva = CUENTA().map((a) => (a.id === id("k-1") ? { ...a, creative: { ...a.creative!, image: IMG("dos") } } : a));
      const luego = new Date(T0.getTime() + 13 * 3_600_000);
      const r = await sync.syncOrganization(org, deps(fakeGraph({ account: nueva, spend: gasto() }), luego, descargador()));
      expect(r.creatives).toBe(1);
      const fila = (await metaRow(org, id("k-1")))!;
      expect(fila.creativeSourceUrl).toBe(IMG("dos"));
      expect(fila.creativeAssetId).not.toBe(vieja);
      expect(await asset(vieja)).toBeUndefined();
      expect(await asset(fila.creativeAssetId)).toBeDefined();
    });

    it("un fallo TRANSITORIO se reintenta en la siguiente pasada; uno PERMANENTE se anota y no se reintenta", async () => {
      await conectarNuevo();
      const calls: string[] = [];
      await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), T0, descargador(calls, { transitoria: /.*/ })));
      expect((await metaRow(org, id("k-1")))!).toMatchObject({ creativeAssetId: null, creativeSourceUrl: null });
      const intentos1 = calls.length;
      expect(intentos1).toBeGreaterThan(0);

      // La siguiente pasada vuelve a intentar y ahora sí baja.
      const r = await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), new Date(T0.getTime() + 60_000), descargador(calls)));
      expect(r.creatives).toBe(1);

      // Un permanente (host no permitido, 404…) se anota con su URL y se deja quieto.
      await limpiar();
      await conectarNuevo();
      const calls2: string[] = [];
      await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), T0, descargador(calls2, { permanente: /.*/ })));
      expect((await metaRow(org, id("k-1")))!.creativeSourceUrl).toBe(IMG("uno"));
      const antes = calls2.length;
      await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), new Date(T0.getTime() + 60_000), descargador(calls2, { permanente: /.*/ })));
      expect(calls2.length).toBe(antes);
    });

    it("máximo 25 copias por pasada: el resto llega en las siguientes", async () => {
      await conectarNuevo();
      const muchos: AnuncioFalso[] = Array.from({ length: 30 }, (_, i) => ({
        id: id(`m-${i}`), creative: { image: IMG(`m${i}`), thumb: IMG(`m${i}-t`) },
      }));
      const r1 = await sync.syncOrganization(org, deps(fakeGraph({ account: muchos, spend: {} }), T0, descargador()));
      expect(r1.creatives).toBe(25);
      const r2 = await sync.syncOrganization(org, deps(fakeGraph({ account: muchos, spend: {} }), new Date(T0.getTime() + 60_000), descargador()));
      expect(r2.creatives).toBe(5);
    });

    it("el listado CON creativos que Meta rechaza (error 1) se reintenta SIN ellos: catálogo y gasto siguen llegando", async () => {
      await conectarNuevo();
      const error1 = new MetaApiError("Please reduce the amount of data you are asking for", { status: 500, code: 1 });
      const r = await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto(), failCreatives: error1 }), T0, descargador()));
      expect(r).toMatchObject({ stopped: null, catalogAds: 2, creatives: 0 });
      expect(await metaRow(org, id("k-1"))).toMatchObject({ adName: "Con todo", creativeTitle: null, creativeAssetId: null });
      // El gasto llegó, y el aviso lo explica.
      expect(await db.select().from(schema.metaAdSpend).where(eq(schema.metaAdSpend.adId, id("k-1")))).not.toHaveLength(0);
      expect((await settings.getMetaAdsSettings(org))!.lastError).toContain("creativos");

      // En el siguiente listado (12 h) Meta ya responde bien: los creativos llegan y el aviso se limpia.
      const luego = new Date(T0.getTime() + 13 * 3_600_000);
      const r2 = await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), luego, descargador()));
      expect(r2.creatives).toBe(1);
      expect(await metaRow(org, id("k-1"))).toMatchObject({ creativeTitle: "Titular uno" });
    });

    it("un error de token en el listado con creativos NO se reintenta sin ellos: se detiene como siempre", async () => {
      await conectarNuevo();
      const malo = new MetaApiError("Invalid OAuth access token", { status: 401, code: 190 });
      const r = await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), failCreatives: malo, fail: () => null }), T0, descargador()));
      // `failCreatives` solo afecta al listado con creativos: con 190 el conector se marca en error, sin segundo intento.
      expect(r.stopped).toBe("auth");
      expect((await settings.getMetaAdsSettings(org))!.status).toBe("error");
    });

    it("un listado sin creativos NO borra los ya conocidos (no se pisa con null)", async () => {
      await conectarNuevo();
      await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), T0, descargador()));
      const error1 = new MetaApiError("reduce data", { status: 500, code: 1 });
      await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto(), failCreatives: error1 }), new Date(T0.getTime() + 13 * 3_600_000), descargador()));
      expect(await metaRow(org, id("k-1"))).toMatchObject({ creativeTitle: "Titular uno", previewLink: "https://fb.me/e/uno" });
      expect((await metaRow(org, id("k-1")))!.creativeAssetId).not.toBeNull();
    });

    it("un enlace de vista previa que no es de Meta no se guarda", async () => {
      await conectarNuevo();
      const cuenta = CUENTA().map((a) => (a.id === id("k-1") ? { ...a, link: "javascript:alert(1)" } : a));
      await sync.syncOrganization(org, deps(fakeGraph({ account: cuenta, spend: gasto() }), T0, descargador()));
      expect((await metaRow(org, id("k-1")))!.previewLink).toBeNull();
    });

    it("Resultados lleva el creativo en la fila (también de un anuncio con gasto y sin conversaciones)", async () => {
      await conectarNuevo();
      await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), T0, descargador()));
      const b = await analytics.adsBlock(org, rangoHoy(), consulta);
      const fila = b.ads.find((a) => a.key === id("k-1"))!;
      expect(fila.conversations).toBe(0);
      expect(fila.creative).toMatchObject({ title: "Titular uno", body: "Texto uno", previewLink: "https://fb.me/e/uno" });
      expect(fila.creative!.assetId).toMatch(/^ma_/);
    });

    it("aislamiento: el creativo de una organización no aparece en otra", async () => {
      await conectarNuevo();
      await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), T0, descargador()));
      expect(await metaRow(otherOrg, id("k-1"))).toBeUndefined();
      const ajenas = await db.select().from(schema.mediaAsset).where(and(eq(schema.mediaAsset.organizationId, otherOrg), sql`${schema.mediaAsset.payload}->>'origen' = 'catalogo'`));
      expect(ajenas).toHaveLength(0);
    });

    it("sin la bandera el bloque no trae el creativo ni ninguna llave nueva", async () => {
      await conectarNuevo();
      await sync.syncOrganization(org, deps(fakeGraph({ account: CUENTA(), spend: gasto() }), T0, descargador()));
      process.env.ATRIBUCION = "off";
      try {
        const b = await analytics.adsBlock(org, rangoHoy(), consulta);
        for (const k of ["hierarchy", "total", "selectedCount"]) expect(b).not.toHaveProperty(k);
        expect(JSON.stringify(b)).not.toContain("creative");
      } finally {
        process.env.ATRIBUCION = "on";
      }
    });

    it("la consulta con varias campañas y filas marcadas devuelve el Total de la selección (extremo a extremo)", async () => {
      await conectarNuevo();
      const cuenta: AnuncioFalso[] = [
        { id: id("p-1"), campaign: ["kc-1", "Camp 1"], adset: ["ks-1", "Conj 1"] },
        { id: id("p-2"), campaign: ["kc-2", "Camp 2"], adset: ["ks-2", "Conj 2"] },
        { id: id("p-3"), campaign: ["kc-3", "Camp 3"], adset: ["ks-3", "Conj 3"] },
      ];
      const g = { [id("p-1")]: 10, [id("p-2")]: 20, [id("p-3")]: 40 };
      await sync.syncOrganization(org, deps(fakeGraph({ account: cuenta, spend: g }), T0, descargador()));
      const r = rangoHoy();
      const dos = await analytics.adsBlock(org, r, { group: "ad", campaignId: null, adsetId: null, campaignIds: ["kc-1", "kc-2"] });
      expect(dos.ads.map((a) => a.key).sort()).toEqual([id("p-1"), id("p-2")]);
      expect(dos.total!.spend).toBe(2 * 30);
      const marcada = await analytics.adsBlock(org, r, { group: "campaign", campaignId: null, adsetId: null, selected: ["kc-3"] });
      expect(marcada.selectedCount).toBe(1);
      expect(marcada.total).toMatchObject({ ads: 1, spend: 2 * 40 });
    });
  });
});
